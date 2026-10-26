import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareFontWeightSources, prepareOfficialFontSources } from "../inputs.ts";
import { FONT_COLOR_SLOTS, normalizeFontPalette, type PaletteSlot } from "../palette.ts";
import { verifySourceRepository } from "../source/pretendard.ts";
import type { GlyphAssignments, GlyphGeometry } from "../source/types.ts";
import { validateDataset } from "../source/validation.ts";
import { FONT_WEIGHTS, type FontWeightFiles, type FontWeightId, type FontWeightSources } from "../weights.ts";

export type ColorFontStage = "preparing" | "compiling" | "validating" | "packaging";
export interface ColorFontDiagnostic {
  char?: string;
  weight?: string;
  code: string;
  message: string;
}
export interface ColorFontRuntimeStatus {
  ready: boolean;
  code: "ready" | "missing_runtime" | "missing_dependencies" | "incompatible_runtime";
  message: string;
  setupCommand: "bun run setup:font";
  toolchain?: { python: string; fontTools: string; brotli: string; pathops?: string };
}
export interface ColorFontExportOptions {
  root: string;
  raw: GlyphGeometry;
  classifications: GlyphAssignments;
  project: { projectId: string; revision: number; rawDigest: string; baselineDigest: string };
  palette?: string[];
  weightSources?: FontWeightSources<GlyphGeometry>;
  onProgress?: (stage: ColorFontStage, weight?: FontWeightId) => void;
}
export interface ColorFontManifest {
  schemaVersion: 1;
  format: "hangul-palette-color-font-v1";
  family: "Hangul Palette";
  fontVersion: string;
  complete: true;
  project: ColorFontExportOptions["project"];
  counts: {
    characters: number;
    modernSyllables: number;
    compatibilityJamo: number;
    slots: number;
    weights: number;
  };
  inputs: {
    rawCanonicalSha256: string;
    classificationsSha256: string;
    paletteSha256: string;
    selection: "studio-working-snapshot" | "checked-in-baseline";
  };
  files: Record<string, { bytes: number; sha256: string }>;
  slots: PaletteSlot[];
  colorPolicy: { fontDefault: "#000000"; selectedPalette: "css-only" };
  weights: {
    id: FontWeightId;
    label: string;
    weight: number;
    fontFile: string;
    counts: {
      characters: number;
      modernSyllables: number;
      compatibilityJamo: number;
      slots: number;
      regions: number;
      sourceContours: number;
    };
    sourceProfile: Record<string, unknown>;
    inputs: Record<string, unknown>;
    corrections: { char: string; semantic: unknown[]; geometry: unknown[] }[];
  }[];
  [key: string]: unknown;
}
export interface ColorFontRepackageOptions extends ColorFontExportOptions {
  previous: Pick<ColorFontExportResult, "zip">;
}
export interface ColorFontExportResult {
  zip: Uint8Array;
  fonts: FontWeightFiles;
  filename: string;
  manifest: ColorFontManifest;
  glyphCount: number;
  slotCount: number;
}
export class ColorFontExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: ColorFontDiagnostic[] = [],
  ) {
    super(message);
    this.name = "ColorFontExportError";
  }
}

function paths(root: string) {
  return {
    executable: join(
      root,
      ".cache/font-export-venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    ),
    compiler: join(root, "src/font/compiler/export.py"),
  };
}

export async function getColorFontStatus(root: string): Promise<ColorFontRuntimeStatus> {
  const { executable, compiler } = paths(resolve(root));
  const setupCommand = "bun run setup:font";
  if (!existsSync(executable))
    return {
      ready: false,
      code: "missing_runtime",
      message: "컬러 폰트 도구를 한 번 준비해야 합니다.",
      setupCommand,
    };
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([executable, compiler, "--check"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return {
      ready: false,
      code: "missing_runtime",
      message: "Python 실행 환경을 찾지 못했습니다. 폰트 도구를 다시 준비하세요.",
      setupCommand,
    };
  }
  const timeout = setTimeout(() => child.kill(), 5_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code === 0) {
      const checked = JSON.parse(stdout) as {
        ready: boolean;
        toolchain: ColorFontRuntimeStatus["toolchain"];
      };
      if (checked.ready)
        return {
          ready: true,
          code: "ready",
          message: "전체 한글 컬러 폰트를 만들 수 있습니다.",
          setupCommand,
          toolchain: checked.toolchain,
        };
    }
    let incompatible = false;
    try {
      incompatible = JSON.parse(stderr.trim()).error?.code === "incompatible_runtime";
    } catch {
      // Missing Python dependencies report an import traceback before the CLI starts.
    }
    return {
      ready: false,
      code: incompatible ? "incompatible_runtime" : "missing_dependencies",
      message: incompatible
        ? "폰트 도구 버전이 맞지 않습니다. 다시 준비하세요."
        : "폰트 도구 설치를 완료해야 합니다.",
      setupCommand,
    };
  } catch {
    return {
      ready: false,
      code: "missing_dependencies",
      message: "폰트 도구를 확인하지 못했습니다. 다시 준비하세요.",
      setupCommand,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Bind reusable font bytes to the calibrated source and the complete producer contract. */
export async function colorFontFingerprint(root: string, runtime: ColorFontRuntimeStatus): Promise<string> {
  const directory = resolve(root);
  const source = join(directory, ".cache/pretendard-src");
  if (existsSync(source)) verifySourceRepository(source);
  const files = [
    "src/font/compiler/export.py",
    "src/font/compiler/repackage.py",
    "src/font/compiler/regions.py",
    "src/font/compiler/weights.py",
    "src/font/compiler/official.py",
    "src/font/compiler/official-sources.json",
    "src/font/compiler/contract.json",
    "src/font/compiler/requirements.txt",
    "bin/extract.ts",
    "src/font/source/parser.ts",
    "src/font/source/document.ts",
    "src/font/source/extraction.ts",
    "src/font/source/validation.ts",
    "src/font/source/hangul.ts",
    "src/font/source/pretendard.ts",
    "src/shared/atomic-file.ts",
    "src/font/source/types.ts",
    "src/font/source/regions.ts",
    "src/font/weights.ts",
    "src/font/palette.ts",
    "src/font/inputs.ts",
    "src/font/compiler/bridge.ts",
    "src/font/build.ts",
    "LICENSE-OFL",
  ];
  const fingerprints = await Promise.all(
    files.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(join(directory, file)))
        .digest("hex"),
    ]),
  );
  return createHash("sha256")
    .update(JSON.stringify({ files: fingerprints, toolchain: runtime.toolchain, bun: Bun.version }))
    .digest("hex");
}

function normalizedPalette(colors: string[] | undefined): string[] | undefined {
  if (colors === undefined) return;
  if (!Array.isArray(colors) || colors.length !== FONT_COLOR_SLOTS.length)
    throw new ColorFontExportError("invalid_palette", "색상은 영역 20개에 각각 지정해야 합니다.");
  try {
    return normalizeFontPalette(colors);
  } catch {
    throw new ColorFontExportError("invalid_palette", "색상은 #rrggbb 형식의 불투명 색상이어야 합니다.");
  }
}

/** Change package CSS and provenance while retaining all nine validated font binaries. */
export async function repackageColorFont(options: ColorFontRepackageOptions): Promise<ColorFontExportResult> {
  const palette = normalizedPalette(options.palette);
  const ready = await getColorFontStatus(options.root);
  if (!ready.ready) throw new ColorFontExportError(ready.code, `${ready.message} ${ready.setupCommand}`);
  const payload = JSON.stringify({
    classificationFormat: "semantic-regions-v1",
    raw: options.raw,
    classifications: options.classifications,
    project: options.project,
    ...(palette ? { palette } : {}),
  });
  return runColorFontTool(options, payload, options.previous.zip);
}

export async function exportColorFont(options: ColorFontExportOptions): Promise<ColorFontExportResult> {
  const root = resolve(options.root);
  const project = structuredClone(options.project);
  const palette = normalizedPalette(options.palette);
  const validation = validateDataset(options.raw, { version: 1, classifications: options.classifications });
  if (!validation.valid || !validation.complete)
    throw new ColorFontExportError(
      "invalid_classifications",
      "전체 한글의 분류를 확인한 후 폰트를 만들 수 있습니다.",
      validation.diagnostics,
    );
  const ready = await getColorFontStatus(root);
  if (!ready.ready) throw new ColorFontExportError(ready.code, `${ready.message} ${ready.setupCommand}`);
  options.onProgress?.("preparing");
  const weightSources = options.weightSources ?? (await prepareFontWeightSources(root));
  const expectedSources = FONT_WEIGHTS.filter(({ id }) => id !== "regular");
  if (
    !weightSources ||
    typeof weightSources !== "object" ||
    Array.isArray(weightSources) ||
    Object.keys(weightSources).length !== expectedSources.length ||
    expectedSources.some(({ id }) => !Object.hasOwn(weightSources, id))
  )
    throw new ColorFontExportError("invalid_weight_source", "모든 굵기의 검증된 원본이 필요합니다.");
  for (const [weight, raw] of Object.entries(weightSources)) {
    const checked = validateDataset(raw, { version: 1, classifications: options.classifications });
    if (!checked.valid || !checked.complete)
      throw new ColorFontExportError(
        "invalid_weight_source",
        `${weight} 굵기의 원본과 분류가 일치하지 않습니다.`,
        checked.diagnostics,
      );
  }
  const officialFonts = await prepareOfficialFontSources(root);
  const payload = JSON.stringify({
    classificationFormat: "semantic-regions-v1",
    raw: options.raw,
    weightSources,
    officialFonts,
    classifications: options.classifications,
    project,
    ...(palette ? { palette } : {}),
  });
  return runColorFontTool({ ...options, root }, payload);
}

async function runColorFontTool(
  options: ColorFontExportOptions,
  payload: string,
  previousZip?: Uint8Array,
): Promise<ColorFontExportResult> {
  const root = resolve(options.root);
  const project = structuredClone(options.project);
  const directory = await mkdtemp(join(tmpdir(), "hangul-font-export-"));
  try {
    const input = join(directory, "snapshot.json"),
      output = join(directory, "font.zip");
    await writeFile(input, payload, { mode: 0o600 });
    const { executable, compiler } = paths(root);
    const reuse = join(directory, "previous.zip");
    if (previousZip) await writeFile(reuse, previousZip, { mode: 0o600 });
    const child = Bun.spawn(
      [
        executable,
        previousZip ? join(root, "src/font/compiler/repackage.py") : compiler,
        ...(previousZip ? ["--reuse", reuse] : []),
        "--input",
        input,
        "--output",
        output,
        "--font-directory",
        directory,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        cwd: root,
      },
    );
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      previousZip ? 60_000 : 1_200_000,
    );
    let result: { complete?: boolean; manifest?: ColorFontManifest } | undefined;
    async function consumeProgress(): Promise<void> {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      function line(text: string): void {
        const value = JSON.parse(text) as {
          stage?: ColorFontStage;
          weight?: FontWeightId;
          complete?: boolean;
          manifest?: ColorFontManifest;
        };
        if (value.stage)
          options.onProgress?.(
            value.stage,
            FONT_WEIGHTS.some(({ id }) => id === value.weight) ? value.weight : undefined,
          );
        if (value.complete) result = value;
      }
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        let end = pending.indexOf("\n");
        while (end >= 0) {
          const text = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (text) line(text);
          end = pending.indexOf("\n");
        }
        if (done) break;
      }
      if (pending.trim()) line(pending);
    }
    let exitCode: number, stderr: string;
    try {
      [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        consumeProgress(),
      ]).then(([code, error]) => [code, error]);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
    if (timedOut)
      throw new ColorFontExportError("font_timeout", "폰트 생성 시간이 초과되었습니다. 다시 시도하세요.");
    if (exitCode !== 0) {
      let detail: { code: string; message: string; diagnostics?: ColorFontDiagnostic[] } | undefined;
      for (const line of stderr.trim().split("\n").reverse()) {
        try {
          detail = JSON.parse(line).error;
          if (detail) break;
        } catch {
          /* FontTools may emit a diagnostic before the structured error. */
        }
      }
      throw new ColorFontExportError(
        detail?.code ?? "compiler_error",
        detail?.message ?? "컬러 폰트를 만들지 못했습니다.",
        detail?.diagnostics,
      );
    }
    if (!result?.manifest)
      throw new ColorFontExportError("compiler_error", "생성된 폰트 정보를 받지 못했습니다.");
    const [zip, ...compiledFonts] = await Promise.all([
      readFile(output),
      ...FONT_WEIGHTS.map((weight) => readFile(join(directory, weight.file))),
    ]);
    const fonts = Object.fromEntries(
      FONT_WEIGHTS.map((weight, index) => [weight.id, new Uint8Array(compiledFonts[index]!)]),
    ) as FontWeightFiles;
    return {
      zip: new Uint8Array(zip),
      fonts,
      filename: `hangul-palette-rev-${project.revision}.zip`,
      manifest: result.manifest,
      glyphCount: result.manifest.counts.characters,
      slotCount: result.manifest.counts.slots,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
