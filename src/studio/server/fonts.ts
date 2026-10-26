import { createHash, randomUUID } from "node:crypto";
import {
  buildFont,
  ColorFontExportError,
  type ColorFontExportResult,
  type ColorFontRuntimeStatus,
  type FontBuild as CompiledFontBuild,
  type FontBuildOptions,
  fontBuildId,
  getColorFontStatus,
  loadFontBuild,
  packageFont,
} from "../../font/build.ts";
import { FONT_WEIGHTS, type FontWeightFiles } from "../../font/weights.ts";
import type { ColorFontPackageJob, FontPreparation } from "../protocol.ts";
import { type FontSourceSnapshot, type PaletteSnapshot, StudioError } from "./store.ts";

/** Tests can replace the compiler without changing the server's job or cache behavior. */
export interface FontEngine {
  status(): Promise<ColorFontRuntimeStatus>;
  build(input: FontBuildOptions): Promise<CompiledFontBuild>;
  load?(input: FontBuildOptions): Promise<CompiledFontBuild | null>;
  identity?(input: FontBuildOptions): Promise<string>;
  package: typeof packageFont;
}

interface BuildRecord {
  build: FontPreparation;
  completion: Promise<void>;
}
interface PackageRecord {
  job: ColorFontPackageJob;
  bytes: Uint8Array | null;
  completion: Promise<void>;
}
interface BuildAsset {
  build: CompiledFontBuild;
  fonts: FontWeightFiles;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function failure(error: unknown): { code: string; message: string } {
  const detail = error as { code?: unknown; message?: unknown } | null;
  const message = typeof detail?.message === "string" ? detail.message : "폰트를 준비하지 못했습니다.";
  const diagnostics =
    error instanceof ColorFontExportError
      ? error.diagnostics
          .slice(0, 4)
          .map(
            (item) => `${item.weight ? `${item.weight} · ` : ""}${item.char ?? item.code}: ${item.message}`,
          )
      : [];
  return {
    code: typeof detail?.code === "string" ? detail.code : "font_export_failed",
    message: [message, ...diagnostics].join("\n"),
  };
}

/** Shared source-only preparation; palette packages capture their own saved revisions. */
export class StudioFonts {
  private readonly engine: FontEngine;
  private readonly builds = new Map<string, BuildRecord>();
  private readonly artifacts = new Map<string, BuildAsset>();
  private readonly packages = new Map<string, PackageRecord>();
  private currentId: string | null = null;
  private activePackageId: string | null = null;
  private preparation: Promise<FontPreparation> | null = null;
  private restoring: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly root: string,
    readonly source: FontSourceSnapshot,
    engine?: FontEngine,
  ) {
    this.engine = engine ?? {
      status: () => getColorFontStatus(root),
      build: buildFont,
      load: loadFontBuild,
      identity: fontBuildId,
      package: packageFont,
    };
  }

  private input(): FontBuildOptions {
    return { root: this.root, raw: this.source.raw, classifications: this.source.classifications };
  }

  private assertOpen(): void {
    if (this.closing) throw new StudioError("closed", "Studio가 종료 중입니다.", 503);
  }

  private current(): BuildRecord | null {
    return this.currentId ? (this.builds.get(this.currentId) ?? null) : null;
  }

  async status() {
    const runtime = await this.engine.status();
    if (runtime.ready) await this.restore();
    return {
      runtime,
      sourceId: this.source.sourceId,
      build: this.current() ? structuredClone(this.current()!.build) : null,
    };
  }

  /** All tabs share one preparation; no palette revision or editing lease participates. */
  async prepare(): Promise<FontPreparation> {
    this.assertOpen();
    if (this.preparation) return this.preparation;
    const work = (async () => {
      const runtime = await this.engine.status();
      if (!runtime.ready) throw new StudioError("font_runtime_unavailable", runtime.message, 503);
      await this.restore(true);
      this.assertOpen();
      const current = this.current();
      if (current && current.build.status !== "failed") return structuredClone(current.build);
      return this.launchBuild();
    })();
    this.preparation = work;
    try {
      return await work;
    } finally {
      if (this.preparation === work) this.preparation = null;
    }
  }

  private restore(refresh = false): Promise<void> {
    if (this.restoring) return this.restoring;
    const work = (async () => {
      this.assertOpen();
      const current = this.current();
      if (current?.build.status === "building" || current?.build.status === "failed") return;
      if (
        current &&
        (!refresh ||
          !this.engine.identity ||
          current.build.buildId === (await this.engine.identity(this.input())))
      )
        return;
      if (current) this.currentId = null;
      const cached = await this.engine.load?.(this.input());
      this.assertOpen();
      if (cached) {
        const record = this.createBuild();
        try {
          this.acceptBuild(record, cached);
        } catch (error) {
          Object.assign(record.build, {
            status: "failed",
            error: failure(error),
            finishedAt: new Date().toISOString(),
          });
        }
      }
    })();
    this.restoring = work;
    void work
      .finally(() => {
        if (this.restoring === work) this.restoring = null;
      })
      .catch(() => {});
    return work;
  }

  private createBuild(): BuildRecord {
    const build: FontPreparation = {
      id: randomUUID(),
      buildId: null,
      sourceId: this.source.sourceId,
      status: "building",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stage: "preparing",
      error: null,
      fonts: null,
    };
    const record = { build, completion: Promise.resolve() };
    this.builds.set(build.id, record);
    this.currentId = build.id;
    return record;
  }

  private acceptBuild(record: BuildRecord, result: CompiledFontBuild): void {
    const fonts = result.fonts;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(result.id) || FONT_WEIGHTS.some(({ id }) => !fonts?.[id]?.length))
      throw new Error("전체 굵기의 폰트 준비 결과가 올바르지 않습니다.");
    this.artifacts.set(result.id, { build: result, fonts });
    Object.assign(record.build, {
      buildId: result.id,
      status: "ready",
      finishedAt: new Date().toISOString(),
      fonts: FONT_WEIGHTS.map(({ id, label, value }) => ({
        id,
        label,
        weight: value,
        bytes: fonts[id].byteLength,
        sha256: sha256(fonts[id]),
        fontUrl: `/api/color-font/builds/${result.id}/fonts/${id}.woff2`,
      })),
    });
    this.prune();
  }

  private launchBuild(): FontPreparation {
    const record = this.createBuild();
    record.completion = (async () => {
      try {
        this.acceptBuild(
          record,
          await this.engine.build({
            ...this.input(),
            onProgress: (stage, weight) => {
              record.build.stage = stage;
              record.build.currentWeight = weight;
            },
          }),
        );
      } catch (error) {
        Object.assign(record.build, { status: "failed", error: failure(error), fonts: null, buildId: null });
      } finally {
        record.build.finishedAt = new Date().toISOString();
        this.prune();
      }
    })();
    return structuredClone(record.build);
  }

  getBuild(id: string): FontPreparation {
    const record = this.builds.get(id);
    if (!record)
      throw new StudioError("font_build_missing", "폰트 준비 기록이 없습니다. 다시 확인하세요.", 404);
    return structuredClone(record.build);
  }

  getFont(buildId: string, weight: string): Uint8Array<ArrayBuffer> {
    const build = this.artifacts.get(buildId);
    const profile = FONT_WEIGHTS.find(({ id }) => id === weight);
    if (!profile) throw new StudioError("font_weight_missing", "지원하지 않는 폰트 굵기입니다.", 404);
    if (!build) throw new StudioError("font_build_missing", "폰트를 다시 준비하세요.", 404);
    return new Uint8Array(build.fonts[profile.id]);
  }

  startPackage(buildId: unknown, palette: PaletteSnapshot): ColorFontPackageJob {
    this.assertOpen();
    if (this.activePackageId)
      throw new StudioError("font_package_busy", "이미 다운로드를 준비하고 있습니다.", 409);
    const current = this.current()?.build;
    const asset = typeof buildId === "string" ? this.artifacts.get(buildId) : undefined;
    if (!asset || current?.status !== "ready" || current.buildId !== buildId)
      throw new StudioError("font_not_ready", "현재 제작 데이터의 폰트를 먼저 준비하세요.", 409);
    const build = asset.build;
    const job: ColorFontPackageJob = {
      id: randomUUID(),
      buildId: build.id,
      sourceId: this.source.sourceId,
      projectId: palette.projectId,
      revision: palette.revision,
      palette: [...palette.fontPalette],
      status: "building",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      artifact: null,
    };
    const record: PackageRecord = { job, bytes: null, completion: Promise.resolve() };
    this.packages.set(job.id, record);
    this.activePackageId = job.id;
    record.completion = (async () => {
      try {
        const result: ColorFontExportResult = await this.engine.package({
          root: this.root,
          build,
          palette: [...job.palette],
          project: { projectId: palette.projectId, revision: palette.revision, ...palette.source },
        });
        const fonts = result.fonts;
        if (
          !result.zip.length ||
          !/^[a-zA-Z0-9_.-]+\.zip$/.test(result.filename) ||
          FONT_WEIGHTS.some(
            ({ id }) => !fonts?.[id] || !Buffer.from(fonts[id]).equals(Buffer.from(asset.fonts[id])),
          )
        )
          throw new Error("다운로드 구성 중 검증된 폰트 데이터가 변경되었습니다.");
        record.bytes = new Uint8Array(result.zip);
        job.artifact = {
          filename: result.filename,
          bytes: record.bytes.byteLength,
          sha256: sha256(record.bytes),
          downloadUrl: `/api/color-font/packages/${job.id}/download`,
        };
        job.status = "ready";
      } catch (error) {
        job.status = "failed";
        job.error = failure(error);
      } finally {
        job.finishedAt = new Date().toISOString();
        this.activePackageId = null;
        this.prune();
      }
    })();
    return structuredClone(job);
  }

  getPackage(id: string): ColorFontPackageJob {
    const record = this.packages.get(id);
    if (!record)
      throw new StudioError("font_package_missing", "다운로드 기록이 없습니다. 다시 준비하세요.", 404);
    return structuredClone(record.job);
  }

  getDownload(id: string): { filename: string; bytes: Uint8Array<ArrayBuffer> } {
    const record = this.packages.get(id);
    if (!record)
      throw new StudioError("font_package_missing", "다운로드 기록이 없습니다. 다시 준비하세요.", 404);
    if (!record.bytes || !record.job.artifact || record.job.status !== "ready")
      throw new StudioError("font_not_ready", "아직 다운로드를 준비하고 있습니다.", 409);
    return { filename: record.job.artifact.filename, bytes: new Uint8Array(record.bytes) };
  }

  private prune(): void {
    const completed = [...this.packages].filter(([, { job }]) => job.status !== "building");
    const retained = new Set(
      [
        ...completed.filter(([, { job }]) => job.status === "ready").slice(-3),
        ...completed.filter(([, { job }]) => job.status === "failed").slice(-1),
      ].map(([id]) => id),
    );
    for (const [id] of completed) if (!retained.has(id)) this.packages.delete(id);
    const previous = [...this.builds].filter(
      ([id, { build }]) => id !== this.currentId && build.status !== "building",
    );
    for (const [id] of previous.slice(0, -2)) this.builds.delete(id);
    const referenced = new Set([...this.builds.values()].map(({ build }) => build.buildId));
    for (const { job } of this.packages.values()) referenced.add(job.buildId);
    for (const id of this.artifacts.keys()) if (!referenced.has(id)) this.artifacts.delete(id);
  }

  close(): Promise<void> {
    if (!this.closing)
      this.closing = (async () => {
        await Promise.allSettled([this.preparation, this.restoring]);
        await Promise.allSettled(
          [...this.builds.values(), ...this.packages.values()].map(({ completion }) => completion),
        );
      })();
    return this.closing;
  }
}
