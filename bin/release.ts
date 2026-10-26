import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildFont, packageFont } from "../src/font/build.ts";
import { defaultFontPalette } from "../src/font/palette.ts";
import { decodeGlyphSource } from "../src/font/source/document.ts";
import { sha256 } from "../src/font/source/pretendard.ts";
import { FONT_VERSION } from "../src/font/weights.ts";
import {
  createReleaseFiles,
  inspectReleaseDestination,
  releaseProvenance,
  writeReleaseFiles,
} from "../src/release.ts";

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: false,
    options: {
      output: { type: "string", short: "o" },
      version: { type: "string", default: FONT_VERSION },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: bun run release [--output ../hangul-palette] [--version ${FONT_VERSION}]

Build all nine fonts from data/glyphs.json and
the contract's default CSS palette. Saved Studio workspaces are never read.
Publish fonts/, css/, metadata/, LICENSE and NOTICE only.
The destination must be an existing hangul-palette distribution repository.
Website pages, assets, README and Git metadata in the destination are preserved.
Requires bun run setup:font. No GitHub or network publication is performed.`);
    process.exit(0);
  }
  const root = resolve(import.meta.dir, "..");
  if (values.version !== FONT_VERSION)
    throw new Error(`Release version must match the compiled font version (${FONT_VERSION})`);
  const output = resolve(values.output ?? join(root, "../hangul-palette"));
  await inspectReleaseDestination(output, root);
  const dataBytes = await readFile(join(root, "data/glyphs.json"));
  const { raw, classifications, rawText, baselineText } = decodeGlyphSource(JSON.parse(dataBytes.toString()));
  const provenance = await releaseProvenance(root, dataBytes);
  const build = await buildFont({
    root,
    raw,
    classifications,
    onProgress(stage, weight) {
      console.log(`${stage}${weight ? `: ${weight}` : ""}`);
    },
  });
  const result = await packageFont({
    root,
    build,
    palette: defaultFontPalette(),
    project: {
      projectId: "hangul-palette-baseline",
      revision: 0,
      rawDigest: sha256(rawText),
      baselineDigest: sha256(baselineText),
    },
    onProgress(stage, weight) {
      console.log(`${stage}${weight ? `: ${weight}` : ""}`);
    },
  });
  const afterBytes = await readFile(join(root, "data/glyphs.json"));
  if (sha256(afterBytes) !== sha256(dataBytes))
    throw new Error(
      "Glyph data changed during compilation; no release files were published. Run release again.",
    );
  const after = await releaseProvenance(root, afterBytes);
  if (after.studio.sourceSha256 !== provenance.studio.sourceSha256)
    throw new Error(
      "Studio source changed during compilation; no release files were published. Run release again.",
    );
  const temporary = await mkdtemp(join(tmpdir(), "hangul-palette-release-"));
  try {
    const zipPath = join(temporary, "package.zip");
    await writeFile(zipPath, result.zip);
    const python = join(
      root,
      ".cache/font-export-venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const script =
      "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({'validation':json.loads(z.read('validation.json')),'notice':z.read('NOTICE.txt').decode('utf-8')}))";
    const child = Bun.spawn([python, "-c", script, zipPath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Cannot read validated export: ${stderr.trim()}`);
    const detail = JSON.parse(stdout) as { validation: unknown; notice: string };
    const files = createReleaseFiles(
      result,
      detail.validation,
      await readFile(join(root, "LICENSE-OFL")),
      detail.notice,
      values.version!,
      provenance,
    );
    await writeReleaseFiles(output, files);
    console.log(
      `Released Hangul Palette ${values.version}: ${output} (${Object.keys(files).length} generated files)`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
