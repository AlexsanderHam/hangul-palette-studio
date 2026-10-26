/** Actual WOFF2 faces and the interactive nine-weight font comparison. */
import { FONT_WEIGHTS, type FontWeightId } from "../../font/weights.ts";
import type { FontPreparation } from "../protocol.ts";
import { el } from "./browser.ts";
import type { PaletteController } from "./palette.ts";
import type { WorkspaceController } from "./workspace.ts";

interface PreviewOptions {
  workspace: Pick<WorkspaceController, "token">;
  palette: Pick<PaletteController, "colors" | "invalid">;
  buildState(): { build: FontPreparation | null; sourceId: string | null; preparing: boolean };
  onChange(): void;
}
export interface FontPreviewController {
  readonly build: FontPreparation | null;
  readonly loading: boolean;
  readonly error: string;
  isCurrent(): boolean;
  load(build: FontPreparation): Promise<void>;
  clear(): void;
  render(): void;
}
export function createFontPreview(options: PreviewOptions): FontPreviewController {
  const { workspace, palette } = options;
  let faces: FontFace[] = [];
  let shownBuild: FontPreparation | null = null;
  let family = "";
  let loadingRequest: { jobId: string; controller: AbortController } | null = null;
  let error = "";
  let theme: "dark" | "light" = "dark";
  let size = 48;
  let weight: FontWeightId | "all" = "all";
  let paletteKey = "";
  let paletteVersion = 0;
  const style = document.createElement("style");
  document.head.append(style);
  function isCurrent(): boolean {
    return Boolean(
      shownBuild?.buildId &&
        shownBuild.buildId === options.buildState().build?.buildId &&
        shownBuild.sourceId === options.buildState().sourceId,
    );
  }

  function render(): void {
    const loaded = Boolean(faces.length === FONT_WEIGHTS.length && family && shownBuild);
    const currentSource = isCurrent();
    let message = "현재 소스의 폰트를 자동으로 준비합니다.";
    if (loadingRequest) {
      message = "생성된 WOFF2를 브라우저에 불러오는 중…";
    } else if (error) {
      message = error;
    } else if (loaded) {
      message = currentSource
        ? `Thin 100부터 Black 900까지 실제 WOFF2 ${FONT_WEIGHTS.length}종입니다. 색상 CSS가 모든 굵기에 함께 적용됩니다.`
        : "현재 소스에 맞는 폰트를 준비하고 있습니다.";
    } else if (options.buildState().preparing) {
      message = "전체 한글 폰트의 생성과 검증이 끝나면 미리보기가 표시됩니다.";
    }
    if (loaded && palette.invalid) message += " 잘못된 HEX 입력은 마지막 유효한 색상으로 표시합니다.";
    el("font-preview-status").textContent = message;
    el("font-preview-canvas").dataset.theme = theme;
    el("font-preview-canvas").setAttribute("aria-busy", String(Boolean(loadingRequest)));
    const preview = el("font-preview-text");
    if (!preview.children.length) {
      const select = el<HTMLSelectElement>("font-preview-weight");
      for (const { id, label, value } of FONT_WEIGHTS) {
        const row = document.createElement("div");
        row.className = "font-preview-weight-row";
        row.dataset.previewWeight = id;
        const name = document.createElement("span");
        name.className = "font-preview-weight-label";
        name.append(label);
        const number = document.createElement("span");
        number.textContent = String(value);
        name.append(number);
        const line = document.createElement("div");
        line.className = "font-preview-line";
        line.dataset.fontWeight = String(value);
        line.style.fontWeight = String(value);
        row.append(name, line);
        preview.append(row);
        const option = document.createElement("option");
        option.value = id;
        option.textContent = `${label} · ${value}`;
        select.append(option);
      }
    }
    preview.dataset.mode = weight === "all" ? "all" : "single";
    preview.setAttribute(
      "aria-label",
      weight === "all"
        ? `선택한 색상의 실제 컬러 폰트 ${FONT_WEIGHTS.length}개 굵기 비교`
        : `선택한 색상의 실제 컬러 폰트 ${FONT_WEIGHTS.find(({ id }) => id === weight)?.label} 미리보기`,
    );
    for (const row of preview.querySelectorAll<HTMLElement>("[data-preview-weight]"))
      row.hidden = weight !== "all" && row.dataset.previewWeight !== weight;
    preview.hidden = !loaded || !currentSource;
    el("font-preview-placeholder").hidden = loaded && currentSource;
    for (const line of preview.querySelectorAll<HTMLElement>("[data-font-weight]")) {
      line.textContent = el<HTMLTextAreaElement>("font-preview-input").value;
      line.style.fontSize = `${size}px`;
    }
    if (loaded && palette.colors) {
      const key = `${family}:${palette.colors.join(",")}`;
      if (key !== paletteKey) {
        paletteKey = key;
        paletteVersion++;
        const paletteName = `--studio-preview-${paletteVersion}`;
        style.textContent = `@font-palette-values ${paletteName} { font-family: "${family}"; base-palette: 0; override-colors: ${palette.colors.map((color, index) => `${index} ${color}`).join(", ")}; }`;
        preview.style.fontFamily = `"${family}", Pretendard, sans-serif`;
        preview.style.fontPalette = paletteName;
      }
    }
    el("font-preview-size-value").textContent = `${size} px`;
    el("font-preview-size").setAttribute("aria-valuetext", `${size} 픽셀`);
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-font-theme]")) {
      button.setAttribute("aria-pressed", String(button.dataset.fontTheme === theme));
    }
  }

  async function load(build: FontPreparation): Promise<void> {
    const fonts = build.status === "ready" ? build.fonts : null;
    if (!build.buildId || !fonts || shownBuild?.id === build.id || loadingRequest?.jobId === build.id) return;
    loadingRequest?.controller.abort();
    loadingRequest = null;
    // A restarted server can hydrate the same validated disk build with a new
    // job identity. Keep faces when their immutable build and bytes still match.
    if (
      faces.length === FONT_WEIGHTS.length &&
      shownBuild?.buildId === build.buildId &&
      shownBuild.sourceId === build.sourceId &&
      FONT_WEIGHTS.every(({ id, value }) => {
        const previous = shownBuild?.fonts?.find((item) => item.id === id);
        const next = fonts.find((item) => item.id === id);
        return previous && next && next.weight === value && previous.sha256 === next.sha256;
      })
    ) {
      shownBuild = build;
      error = "";
      options.onChange();
      return;
    }
    const request = { jobId: build.id, controller: new AbortController() };
    loadingRequest = request;
    error = "";
    render();
    const { controller } = request;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      if (!CSS.supports("font-palette", "--studio-preview")) {
        throw new Error(
          "이 브라우저는 영역별 폰트 색상 변경을 지원하지 않습니다. 이 기능을 지원하는 최신 브라우저에서 열어 주세요.",
        );
      }
      const nextFamily = `StudioPreview-${build.buildId.replace(/[^\da-z-]/gi, "")}`;
      const nextFaces = await Promise.all(
        FONT_WEIGHTS.map(async ({ id, value }) => {
          const font = fonts.find((item) => item.id === id && item.weight === value);
          if (!font) throw new Error(`${id} 폰트가 패키지에 없습니다.`);
          const response = await fetch(font.fontUrl, {
            headers: { "X-Studio-Token": workspace.token },
            signal: controller.signal,
            cache: "no-store",
          });
          if (!response.ok) throw new Error(`${font.label} 폰트를 불러오지 못했습니다 (${response.status}).`);
          const face = new FontFace(nextFamily, await response.arrayBuffer(), {
            weight: String(value),
            style: "normal",
          });
          return face.load();
        }),
      );
      if (loadingRequest !== request || options.buildState().build?.id !== build.id) return;
      for (const face of nextFaces) document.fonts.add(face);
      for (const face of faces) document.fonts.delete(face);
      faces = nextFaces;
      family = nextFamily;
      shownBuild = build;
      paletteKey = "";
    } catch (cause) {
      controller.abort();
      if (loadingRequest === request) {
        error = `미리보기 로딩 실패: ${cause instanceof Error ? cause.message : "연결을 확인하고 상태를 다시 확인해 주세요."}`;
      }
    } finally {
      clearTimeout(timeout);
      if (loadingRequest === request) loadingRequest = null;
      options.onChange();
    }
  }

  el("font-preview-input").addEventListener("input", render);
  el("font-glyph-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = el<HTMLInputElement>("font-glyph-search-input").value.trim().normalize("NFC");
    const code = value.codePointAt(0) ?? 0;
    const supported =
      [...value].length === 1 && ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3131 && code <= 0x3163));
    const message = el("font-glyph-search-message");
    el("font-glyph-search-input").setAttribute("aria-invalid", String(!supported));
    message.dataset.error = String(!supported);
    if (!supported) {
      message.textContent = "지원하는 한글 한 글자를 입력하세요.";
      return;
    }
    el<HTMLTextAreaElement>("font-preview-input").value = value;
    weight = "all";
    el<HTMLSelectElement>("font-preview-weight").value = "all";
    render();
    message.textContent = `‘${value}’ 글자를 모든 굵기에서 비교합니다.`;
  });
  el("font-preview-weight").addEventListener("change", () => {
    const value = el<HTMLSelectElement>("font-preview-weight").value;
    weight = FONT_WEIGHTS.find(({ id }) => id === value)?.id ?? "all";
    render();
  });
  el("font-preview-size").addEventListener("input", () => {
    size = Number(el<HTMLInputElement>("font-preview-size").value);
    render();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-font-theme]")) {
    button.addEventListener("click", () => {
      theme = button.dataset.fontTheme === "light" ? "light" : "dark";
      render();
    });
  }

  return {
    get build() {
      return shownBuild;
    },
    get loading() {
      return Boolean(loadingRequest);
    },
    get error() {
      return error;
    },
    isCurrent,
    load,
    render,
    clear() {
      loadingRequest?.controller.abort();
      loadingRequest = null;
      for (const face of faces) document.fonts.delete(face);
      faces = [];
      shownBuild = null;
      family = "";
      paletteKey = "";
      error = "";
      style.textContent = "";
    },
  };
}
