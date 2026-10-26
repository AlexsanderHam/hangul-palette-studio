/** Recreate production glyph data or internal weight geometry from pinned sources. */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { serializeGlyphSource } from "../src/font/source/document.ts";
import { createExtractedGlyphSource, extractGlyphGeometry } from "../src/font/source/extraction.ts";
import { FONT_WEIGHTS } from "../src/font/weights.ts";
import { atomicWrite } from "../src/shared/atomic-file.ts";

const DEFAULT_SOURCE = ".cache/pretendard-src";
const weightNames = FONT_WEIGHTS.map(({ id }) => id).join(", ");

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      source: { type: "string", short: "s", default: DEFAULT_SOURCE },
      output: { type: "string", short: "o" },
      format: { type: "string", default: "glyphs" },
      weight: { type: "string", short: "w", default: "regular" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`Usage: bun run extract [options]
  -s, --source <path>   Pretendard repo path (default: ${DEFAULT_SOURCE})
  -o, --output <path>   Output JSON path (default: data/glyphs.json)
      --format <name>  glyphs (default), or raw for internal weight caches
  -w, --weight <name>   ${weightNames} (default: regular)
      --force           Explicitly replace an existing output
  -h, --help            Show this help

Requires the pinned v1.3.9 source revision with unmodified font inputs.
Glyph source reuses semantic regions and paint order from the existing output, or from
data/glyphs.json for a new output, only when every source contour matches.
Without a reference file, every contour starts unassigned.
The raw format defaults to .cache/raw-shapes.json and contains no assignments.
All weights select named instances at CSS weights 100–900.
Thin/Black interpolate from source masters at 45/930; they do not export those masters.`);
  } else {
    const format = values.format!;
    if (format !== "glyphs" && format !== "raw")
      throw new Error(`Unknown format: ${format}. Allowed: glyphs, raw`);
    const weight = FONT_WEIGHTS.find(({ id }) => id === values.weight!.toLowerCase());
    if (!weight) throw new Error(`Unknown weight: ${values.weight}. Allowed: ${weightNames}`);
    const output = values.output ?? (format === "raw" ? ".cache/raw-shapes.json" : "data/glyphs.json");
    if (existsSync(output) && !values.force)
      throw new Error(
        `Output already exists: ${output}. Choose a new --output, or use --force after reviewing the impact on existing workspaces.`,
      );
    console.log(`Source: ${values.source}`);
    console.log(`Weight: ${weight.id} (${weight.value})`);
    const geometry = await extractGlyphGeometry({
      sourcePath: values.source!,
      weight,
      onProgress: (message) => console.log(message),
    });
    let json: string;
    if (format === "raw") json = JSON.stringify(geometry);
    else {
      const referencePath = existsSync(output) ? output : "data/glyphs.json";
      const reference = existsSync(referencePath)
        ? JSON.parse(readFileSync(referencePath, "utf8"))
        : undefined;
      json = serializeGlyphSource(createExtractedGlyphSource(geometry, reference));
    }
    await atomicWrite(output, json);
    console.log(
      `Saved ${output} (${(Buffer.byteLength(json) / 1024 / 1024).toFixed(1)} MB, ${geometry.sets.length} sets)`,
    );
  }
} catch (error) {
  console.error(`Extraction: ${(error as Error).message}`);
  process.exitCode = 1;
}
