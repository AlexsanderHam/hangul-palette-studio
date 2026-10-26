/** Prepare the source fonts automatically; package the saved palette only on request. */
import { FONT_WEIGHTS } from "../../font/weights.ts";
import type {
  ColorFontPackageJob,
  ColorFontStatusResponse,
  FontPreparation,
  StudioErrorResponse,
} from "../protocol.ts";
import { announce, downloadBlob, el } from "./browser.ts";
import { type PaletteController, palettesEqual } from "./palette.ts";
import type { FontPreviewController } from "./preview.ts";
import { ApiError, type WorkspaceController } from "./workspace.ts";

interface FontsOptions {
  workspace: WorkspaceController;
  palette: PaletteController;
  preview: FontPreviewController;
  onChange(): void;
}
export interface FontsController {
  readonly build: FontPreparation | null;
  readonly sourceId: string | null;
  readonly preparing: boolean;
  connect(): Promise<void>;
  render(): void;
}
interface DownloadIntent {
  sourceId: string;
  buildId: string;
  projectId: string;
  colors: string[];
}

function buildPaletteCss(
  colors: readonly string[],
  slots: Readonly<ColorFontStatusResponse["slots"]>,
): string {
  const faces = FONT_WEIGHTS.map(
    ({ value, file }) => `@font-face {
  font-family: "Hangul Palette";
  src: url("./${file}") format("woff2");
  font-weight: ${value};
  font-style: normal;
  font-display: swap;
}`,
  ).join("\n\n");
  const overrides = slots
    .map((slot) => `    ${slot.index} ${colors[slot.index]} /* ${slot.id} */`)
    .join(",\n");
  return `${faces}

@font-palette-values --hangul-palette {
  font-family: "Hangul Palette";
  base-palette: 0;
  override-colors:
${overrides};
}

.hangul-palette {
  font-family: "Hangul Palette", sans-serif;
  font-synthesis: none;
  font-palette: --hangul-palette;
}
`;
}

export function createFonts(options: FontsOptions): FontsController {
  const { workspace, palette, preview } = options;
  let runtime: ColorFontStatusResponse["runtime"] | null = null;
  let sourceId: string | null = null;
  let build: FontPreparation | null = null;
  let checking = false;
  let starting = false;
  let downloading = false;
  let downloadIntent: DownloadIntent | null = null;
  let packageJob: ColorFontPackageJob | null = null;
  let pollTimer = 0;
  let polling = false;
  let pollFailures = 0;
  let connection = 0;
  let preparation = 0;
  let error = "";
  let downloadFailed = false;

  function isReady(): boolean {
    return Boolean(
      runtime?.ready && build?.status === "ready" && build.buildId && build.sourceId === sourceId,
    );
  }

  function render(): void {
    const preparing = starting || build?.status === "building";
    const failure = error || preview.error || (build?.status === "failed" ? build.error?.message : "");
    let status = "폰트를 준비하고 있습니다…";
    if (!workspace.online) status = "서버 연결 대기 중";
    else if (failure) status = downloadFailed ? "다운로드를 다시 시도해 주세요" : "폰트 준비를 확인해 주세요";
    else if (downloading) status = "다운로드 준비 중…";
    else if (checking) status = "폰트 확인 중…";
    else if (preparing) {
      const weight = FONT_WEIGHTS.find(({ id }) => id === build?.currentWeight);
      status =
        build?.stage === "validating"
          ? "폰트 확인 중…"
          : weight
            ? `폰트 준비 중 · ${weight.label} ${weight.value}`
            : "폰트 준비 중…";
    } else if (preview.loading) status = "미리보기 불러오는 중…";
    else if (isReady() && preview.isCurrent()) status = `폰트 준비됨 · ${FONT_WEIGHTS.length}개 굵기`;
    else if (runtime && !runtime.ready) status = "폰트 준비 환경을 확인해 주세요";
    el("font-status").textContent = status;
    el("font-status").dataset.state = failure || (runtime && !runtime.ready) ? "error" : "ready";
    el("font-status").setAttribute(
      "aria-busy",
      String(checking || preparing || preview.loading || downloading),
    );
    const retry = el<HTMLButtonElement>("font-retry-btn");
    retry.hidden = !(failure || (runtime && !runtime.ready));
    retry.disabled = !workspace.online || checking || starting || polling || downloading;
    el("font-notice").hidden = !(failure || (runtime && !runtime.ready));
    el("font-notice-message").textContent = failure || runtime?.message || "";
    el("font-export-setup").hidden = !runtime || runtime.ready;
    el("font-export-setup-command").textContent = runtime?.setupCommand ?? "bun run setup:font";
    const download = el<HTMLButtonElement>("font-download-btn");
    download.disabled =
      !isReady() ||
      !preview.isCurrent() ||
      preview.loading ||
      !workspace.canExport() ||
      checking ||
      starting ||
      downloading;
    download.textContent = downloading ? "다운로드 준비 중…" : "폰트 다운로드";
    download.title = !workspace.canExport()
      ? palette.invalid
        ? "잘못된 HEX 색상을 수정하거나 변경을 버려 주세요"
        : "색상 저장과 서버 연결을 확인해 주세요"
      : "현재 색상의 CSS와 아홉 굵기의 WOFF2를 ZIP으로 받습니다";
    el<HTMLButtonElement>("font-css-download-btn").disabled = !workspace.canExport() || !palette.slots.length;
    el("font-export-snapshot").textContent = workspace.snapshot
      ? new Date(workspace.snapshot.savedAt).toLocaleString("ko-KR")
      : "작업본을 불러오는 중입니다.";
  }

  function schedulePoll(): void {
    clearTimeout(pollTimer);
    if (
      pollFailures < 3 &&
      (build?.status === "building" || (downloading && packageJob?.status === "building"))
    )
      pollTimer = window.setTimeout(() => void poll(), 1200);
  }

  async function acceptBuild(next: FontPreparation | null): Promise<void> {
    build = next;
    if (next?.status === "ready" && next.sourceId === sourceId) await preview.load(next);
    else if (!next || next.sourceId !== sourceId) preview.clear();
    schedulePoll();
  }

  async function prepare(): Promise<void> {
    if (starting || !workspace.online || !runtime?.ready) return;
    const currentPreparation = ++preparation;
    const preparedSource = sourceId;
    starting = true;
    error = "";
    downloadFailed = false;
    options.onChange();
    try {
      const result = await workspace.request<{ build: FontPreparation }>("/api/color-font/prepare", {
        method: "POST",
        body: "{}",
      });
      if (currentPreparation !== preparation || preparedSource !== sourceId) return;
      pollFailures = 0;
      await acceptBuild(result.build);
    } catch (cause) {
      if (currentPreparation === preparation)
        error = `폰트 준비 실패: ${cause instanceof Error ? cause.message : "서버 연결을 확인해 주세요."}`;
    } finally {
      if (currentPreparation === preparation) {
        starting = false;
        options.onChange();
      }
    }
  }

  async function connect(): Promise<void> {
    const currentConnection = ++connection;
    const interruptedDownload = downloading;
    downloadIntent = null;
    packageJob = null;
    downloading = false;
    downloadFailed = interruptedDownload;
    preparation++;
    starting = false;
    clearTimeout(pollTimer);
    checking = true;
    error = interruptedDownload ? "서버 연결을 갱신했습니다. 폰트 다운로드를 다시 눌러 주세요." : "";
    options.onChange();
    try {
      const result = await workspace.request<ColorFontStatusResponse>("/api/color-font/status");
      if (currentConnection !== connection) return;
      runtime = result.runtime;
      sourceId = result.sourceId;
      palette.setSlots(result.slots);
      el("font-export-coverage").textContent =
        `한글 세부 색칠 ${result.coverage.glyphCount.toLocaleString()}자 · ${FONT_WEIGHTS.length}개 굵기 · 20개 색상 영역 · 원본 영문·숫자·기호 포함`;
      pollFailures = 0;
      await acceptBuild(result.build);
      if (currentConnection !== connection) return;
      if (runtime.ready && (!build || build.sourceId !== sourceId)) await prepare();
    } catch (cause) {
      if (currentConnection === connection) {
        runtime = null;
        error = `폰트 확인 실패: ${cause instanceof Error ? cause.message : "서버 연결을 확인해 주세요."}`;
      }
    } finally {
      if (currentConnection === connection) {
        checking = false;
        options.onChange();
      }
    }
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    const buildJobId = build?.status === "building" ? build.id : null;
    const capturedPackage = downloading && packageJob?.status === "building" ? packageJob : null;
    const currentConnection = connection;
    try {
      if (buildJobId) {
        const result = await workspace.request<{ build: FontPreparation }>(
          `/api/color-font/builds/${encodeURIComponent(buildJobId)}`,
        );
        if (currentConnection !== connection || build?.id !== buildJobId) return;
        await acceptBuild(result.build);
      } else if (capturedPackage) {
        const result = await workspace.request<{ job: ColorFontPackageJob }>(
          `/api/color-font/packages/${encodeURIComponent(capturedPackage.id)}`,
        );
        if (currentConnection !== connection || packageJob?.id !== capturedPackage.id) return;
        packageJob = result.job;
        await finishPackage();
      }
      if (currentConnection !== connection) return;
      pollFailures = 0;
      error = "";
    } catch (cause) {
      if (currentConnection !== connection) return;
      pollFailures++;
      error = `진행 상태 확인 실패: ${cause instanceof Error ? cause.message : "서버 연결을 확인해 주세요."}`;
      if (capturedPackage && (packageJob?.status !== "building" || pollFailures >= 3)) {
        downloading = false;
        downloadFailed = true;
        downloadIntent = null;
      }
    } finally {
      polling = false;
      schedulePoll();
      options.onChange();
    }
  }

  function matchesIntent(intent: DownloadIntent): boolean {
    return Boolean(
      workspace.snapshot?.projectId === intent.projectId &&
        workspace.canExport() &&
        build?.buildId === intent.buildId &&
        sourceId === intent.sourceId &&
        preview.isCurrent() &&
        palette.colors &&
        palettesEqual(palette.colors, intent.colors),
    );
  }

  async function finishPackage(): Promise<void> {
    if (!packageJob || !downloadIntent || packageJob.status === "building") return;
    const job = packageJob;
    const intent = downloadIntent;
    if (job.status === "failed") throw new Error(job.error?.message ?? "파일을 준비하지 못했습니다.");
    if (
      !job.artifact ||
      job.buildId !== intent.buildId ||
      job.projectId !== intent.projectId ||
      !palettesEqual(job.palette, intent.colors) ||
      !matchesIntent(intent)
    )
      throw new Error("색상이나 작업본이 바뀌었습니다. 미리보기를 확인한 뒤 다시 다운로드해 주세요.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(job.artifact.downloadUrl, {
        headers: { "X-Studio-Token": workspace.token },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        let detail = `서버 응답 오류 (${response.status})`;
        try {
          detail = ((await response.json()) as StudioErrorResponse).error.message;
        } catch {
          /* Keep HTTP status. */
        }
        throw new Error(detail);
      }
      const bytes = await response.arrayBuffer();
      if (downloadIntent !== intent || !matchesIntent(intent))
        throw new Error("색상이나 작업본이 바뀌었습니다. 미리보기를 확인한 뒤 다시 다운로드해 주세요.");
      downloadBlob(new Blob([bytes], { type: "application/zip" }), job.artifact.filename);
      announce("미리보기의 폰트와 현재 색상 CSS를 내려받았습니다.");
      downloadIntent = null;
      downloading = false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function download(): Promise<void> {
    if (
      !isReady() ||
      !build?.buildId ||
      !sourceId ||
      !preview.isCurrent() ||
      preview.loading ||
      !workspace.snapshot ||
      !workspace.canExport() ||
      !palette.colors ||
      downloading ||
      checking ||
      starting
    )
      return;
    const intent: DownloadIntent = {
      sourceId,
      buildId: build.buildId,
      projectId: workspace.snapshot.projectId,
      colors: [...palette.colors],
    };
    const currentConnection = connection;
    downloadIntent = intent;
    downloading = true;
    downloadFailed = false;
    error = "";
    options.onChange();
    try {
      const result = await workspace.request<{ job: ColorFontPackageJob }>("/api/color-font/packages", {
        method: "POST",
        body: JSON.stringify({
          buildId: intent.buildId,
          projectId: intent.projectId,
          expectedRevision: workspace.snapshot.revision,
        }),
      });
      if (downloadIntent !== intent || currentConnection !== connection) return;
      packageJob = result.job;
      pollFailures = 0;
      await finishPackage();
      schedulePoll();
    } catch (cause) {
      if (downloadIntent !== intent || currentConnection !== connection) return;
      if (cause instanceof ApiError && cause.response.snapshot)
        workspace.applySnapshot(cause.response.snapshot);
      error = `다운로드 실패: ${cause instanceof Error ? cause.message : "서버 연결을 확인해 주세요."}`;
      downloadFailed = true;
      downloading = false;
      downloadIntent = null;
    } finally {
      options.onChange();
    }
  }

  async function retry(): Promise<void> {
    const retryDownload = downloadFailed;
    await connect();
    if (!runtime?.ready) return;
    if (retryDownload || build?.status === "failed") await prepare();
    if (retryDownload && isReady()) await download();
  }

  function downloadCss(): void {
    if (!workspace.canExport() || !palette.colors || !palette.slots.length) return;
    downloadBlob(
      new Blob([buildPaletteCss(palette.colors, palette.slots)], { type: "text/css;charset=utf-8" }),
      "hangul-palette.css",
    );
    announce("현재 색상의 CSS를 내려받았습니다. WOFF2 파일과 같은 폴더에서 사용하세요.");
  }
  el("font-retry-btn").addEventListener("click", () => void retry());
  el("font-download-btn").addEventListener("click", () => void download());
  el("font-css-download-btn").addEventListener("click", downloadCss);
  return {
    get build() {
      return build;
    },
    get sourceId() {
      return sourceId;
    },
    get preparing() {
      return checking || starting || build?.status === "building";
    },
    connect,
    render,
  };
}
