import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ColorFontExportError,
  type ColorFontExportOptions,
  type ColorFontExportResult,
  type ColorFontRepackageOptions,
  type ColorFontRuntimeStatus,
  type ColorFontStage,
  colorFontFingerprint,
  exportColorFont,
  getColorFontStatus,
  repackageColorFont,
} from "./compiler/bridge.ts";
import { defaultFontPalette } from "./palette.ts";
import { sha256 } from "./source/pretendard.ts";
import type { GlyphAssignments, GlyphGeometry } from "./source/types.ts";
import { validateDataset } from "./source/validation.ts";
import { FONT_WEIGHTS, type FontWeightFiles, type FontWeightId, type FontWeightSources } from "./weights.ts";

export {
  ColorFontExportError,
  type ColorFontExportOptions,
  type ColorFontExportResult,
  type ColorFontManifest,
  type ColorFontRuntimeStatus,
  type ColorFontStage,
  getColorFontStatus,
} from "./compiler/bridge.ts";

export interface FontBuildOptions {
  root: string;
  raw: GlyphGeometry;
  classifications: GlyphAssignments;
  weightSources?: FontWeightSources<GlyphGeometry>;
  onProgress?: (stage: ColorFontStage, weight?: FontWeightId) => void;
}

/** Font identity and validated bytes are independent of palettes and workspaces. */
export interface FontBuild {
  readonly id: string;
  readonly fonts: FontWeightFiles;
  readonly glyphCount: number;
  readonly slotCount: number;
}

export interface FontPackageOptions {
  root: string;
  build: FontBuild;
  project: ColorFontExportOptions["project"];
  palette?: string[];
  onProgress?: FontBuildOptions["onProgress"];
}

/** The production bridge is replaceable for focused cache and lifecycle tests. */
export interface FontCompiler {
  status(root: string): Promise<ColorFontRuntimeStatus>;
  fingerprint(root: string, runtime: ColorFontRuntimeStatus): Promise<string>;
  compile(options: ColorFontExportOptions): Promise<ColorFontExportResult>;
  package(options: ColorFontRepackageOptions): Promise<ColorFontExportResult>;
}

interface BuildContext extends FontBuildOptions {
  id: string;
  producer: string;
  inputs: { raw: string; assignments: string; weights: string | null };
  project: ColorFontExportOptions["project"];
}

interface BuildRecord {
  context: BuildContext;
  result: ColorFontExportResult;
}

interface CacheMetadata {
  format: "hangul-palette-font-build-cache-v1";
  id: string;
  producer: string;
  inputs: BuildContext["inputs"];
  bytes: number;
  sha256: string;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

function copyFonts(fonts: FontWeightFiles): FontWeightFiles {
  return Object.fromEntries(FONT_WEIGHTS.map(({ id }) => [id, new Uint8Array(fonts[id])])) as FontWeightFiles;
}

function copyResult(result: ColorFontExportResult): ColorFontExportResult {
  return {
    ...result,
    zip: new Uint8Array(result.zip),
    manifest: structuredClone(result.manifest),
    fonts: copyFonts(result.fonts),
  };
}

function requireFonts(result: ColorFontExportResult): void {
  if (
    !result.zip.length ||
    FONT_WEIGHTS.some(({ id }) => !result.fonts?.[id]?.length) ||
    result.glyphCount !== 11223 ||
    result.slotCount !== 20
  )
    throw new ColorFontExportError("invalid_font_build", "검증된 전체 한글 폰트가 필요합니다.");
}

function requireSameFonts(previous: ColorFontExportResult, next: ColorFontExportResult): void {
  requireFonts(next);
  if (FONT_WEIGHTS.some(({ id }) => !Buffer.from(previous.fonts[id]).equals(Buffer.from(next.fonts[id]))))
    throw new ColorFontExportError(
      "font_bytes_changed",
      "CSS 패키지를 만드는 중 폰트 데이터가 변경되었습니다.",
    );
}

export function createFontEngine(
  compiler: FontCompiler = {
    status: getColorFontStatus,
    fingerprint: colorFontFingerprint,
    compile: exportColorFont,
    package: repackageColorFont,
  },
) {
  const records = new WeakMap<FontBuild, BuildRecord>();
  const pending = new Map<string, Promise<FontBuild>>();

  async function context(options: FontBuildOptions): Promise<BuildContext> {
    // Capture the complete source before checking runtime or touching the disk.
    const source = structuredClone({
      raw: options.raw,
      classifications: options.classifications,
      ...(options.weightSources ? { weightSources: options.weightSources } : {}),
    });
    const checked = validateDataset(source.raw, { version: 1, classifications: source.classifications });
    if (!checked.valid || !checked.complete)
      throw new ColorFontExportError(
        "invalid_classifications",
        "전체 한글의 분류를 확인한 후 폰트를 만들 수 있습니다.",
        checked.diagnostics,
      );
    const root = resolve(options.root);
    const runtime = await compiler.status(root);
    if (!runtime.ready)
      throw new ColorFontExportError(runtime.code, `${runtime.message} ${runtime.setupCommand}`);
    const producer = await compiler.fingerprint(root, runtime);
    const inputs = {
      raw: sha256(canonical(source.raw)),
      assignments: sha256(canonical(source.classifications)),
      weights: source.weightSources ? sha256(canonical(source.weightSources)) : null,
    };
    const id = sha256(canonical({ format: "hangul-palette-font-build-v1", producer, inputs }));
    return {
      ...source,
      root,
      id,
      producer,
      inputs,
      project: {
        projectId: "hangul-palette-font-build",
        revision: 0,
        rawDigest: inputs.raw,
        baselineDigest: inputs.assignments,
      },
      onProgress: options.onProgress,
    };
  }

  async function unchanged(value: BuildContext): Promise<void> {
    const runtime = await compiler.status(value.root);
    if (!runtime.ready || (await compiler.fingerprint(value.root, runtime)) !== value.producer)
      throw new ColorFontExportError(
        "font_producer_changed",
        "폰트 제작 코드나 도구가 바뀌었습니다. 다시 시도하세요.",
      );
  }

  function build(value: BuildContext, result: ColorFontExportResult): FontBuild {
    requireFonts(result);
    const retained = copyResult(result);
    const item: FontBuild = Object.freeze({
      id: value.id,
      get fonts() {
        return copyFonts(retained.fonts);
      },
      glyphCount: retained.glyphCount,
      slotCount: retained.slotCount,
    });
    records.set(item, { context: value, result: retained });
    return item;
  }

  function cacheFiles(value: BuildContext) {
    const directory = join(value.root, ".cache/font-builds");
    return {
      directory,
      zip: join(directory, `${value.id}.zip`),
      metadata: join(directory, `${value.id}.json`),
    };
  }

  async function cached(value: BuildContext): Promise<FontBuild | null> {
    // Explicit test/custom weight geometry always takes the complete compiler
    // validation path, even if a cache with the same claimed identity exists.
    if (value.weightSources) return null;
    let zip: Uint8Array;
    try {
      const files = cacheFiles(value);
      const metadata = JSON.parse(await readFile(files.metadata, "utf8")) as CacheMetadata | null;
      zip = new Uint8Array(await readFile(files.zip));
      if (
        !metadata ||
        metadata.format !== "hangul-palette-font-build-cache-v1" ||
        metadata.id !== value.id ||
        metadata.producer !== value.producer ||
        canonical(metadata.inputs) !== canonical(value.inputs) ||
        metadata.bytes !== zip.length ||
        metadata.sha256 !== sha256(zip)
      )
        return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    let result: ColorFontExportResult;
    try {
      // The Python verifier checks every archive member, official pins, source
      // hashes, decoded-validation reports and all nine font containers.
      result = await compiler.package({
        ...value,
        palette: defaultFontPalette(),
        onProgress: undefined,
        previous: { zip },
      });
    } catch (error) {
      if (error instanceof ColorFontExportError && ["invalid_package", "reuse_mismatch"].includes(error.code))
        return null;
      throw error;
    }
    await unchanged(value);
    return build(value, result);
  }

  async function publish(value: BuildContext, result: ColorFontExportResult): Promise<void> {
    if (value.weightSources) return;
    const files = cacheFiles(value);
    await mkdir(files.directory, { recursive: true });
    const temporary = await mkdtemp(join(files.directory, ".build-"));
    try {
      const metadata: CacheMetadata = {
        format: "hangul-palette-font-build-cache-v1",
        id: value.id,
        producer: value.producer,
        inputs: value.inputs,
        bytes: result.zip.length,
        sha256: sha256(result.zip),
      };
      await writeFile(join(temporary, "build.zip"), result.zip, { mode: 0o600 });
      await writeFile(join(temporary, "metadata.json"), JSON.stringify(metadata) + "\n", { mode: 0o600 });
      await unchanged(value);
      await rename(join(temporary, "build.zip"), files.zip);
      // Publish the checksum record last; interrupted or mixed generations
      // cannot pass the cache reader's ZIP checksum.
      await rename(join(temporary, "metadata.json"), files.metadata);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function loadFontBuild(options: FontBuildOptions): Promise<FontBuild | null> {
    return cached(await context(options));
  }

  async function buildFont(options: FontBuildOptions): Promise<FontBuild> {
    const value = await context(options);
    const key = `${value.root}:${value.id}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const work = (async () => {
      const previous = await cached(value);
      if (previous) return previous;
      const result = await compiler.compile({ ...value, palette: defaultFontPalette() });
      requireFonts(result);
      await unchanged(value);
      await publish(value, result);
      return build(value, result);
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      if (pending.get(key) === work) pending.delete(key);
    }
  }

  async function packageFont(options: FontPackageOptions): Promise<ColorFontExportResult> {
    const project = structuredClone(options.project);
    const palette = options.palette ? [...options.palette] : undefined;
    const record = records.get(options.build);
    if (!record || record.context.root !== resolve(options.root))
      throw new ColorFontExportError("invalid_font_build", "현재 제작 엔진의 검증된 폰트가 필요합니다.");
    await unchanged(record.context);
    const result = await compiler.package({
      ...record.context,
      project,
      palette,
      onProgress: options.onProgress,
      previous: record.result,
    });
    requireSameFonts(record.result, result);
    await unchanged(record.context);
    return copyResult(result);
  }

  return {
    fontBuildId: async (options: FontBuildOptions) => (await context(options)).id,
    buildFont,
    loadFontBuild,
    packageFont,
  };
}

const engine = createFontEngine();
export const { fontBuildId, buildFont, loadFontBuild, packageFont } = engine;
