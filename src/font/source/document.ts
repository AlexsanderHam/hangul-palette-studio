import { HANGUL_BASE, HANGUL_END, JAMO_END, JAMO_START } from "./hangul.ts";
import { isRegionId, UNASSIGNED_REGION } from "./regions.ts";
import type {
  CompactSet,
  CompactShape,
  CompactSyllable,
  ContourAssignments,
  GlyphAssignments,
  GlyphContour,
  GlyphGeometry,
  GlyphSourceDocument,
  SourceGlyph,
  SourceProvenance,
} from "./types.ts";
import { validateDataset } from "./validation.ts";

function fail(message: string): never {
  throw new Error(`Invalid glyph data: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
  if (!record(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name} has unknown field ${key}`);
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${name} must be finite`);
  return value;
}

function supported(char: string): boolean {
  if ([...char].length !== 1) return false;
  const code = char.codePointAt(0)!;
  return (code >= HANGUL_BASE && code <= HANGUL_END) || (code >= JAMO_START && code <= JAMO_END);
}

function provenance(value: unknown): SourceProvenance {
  const source = fields(
    value,
    [
      "repository",
      "ref",
      "revision",
      "sourceFingerprint",
      "fingerprintAlgorithm",
      "fontInfoSha256",
      "licenseSha256",
      "master",
      "instance",
      "fontMetrics",
      "geometryBounds",
      "viewportAscender",
      "extractorVersion",
    ],
    "provenance",
  );
  const master = fields(source.master, ["id", "weight", "name"], "provenance.master");
  fields(source.fontMetrics, ["unitsPerEm", "ascender", "descender"], "provenance.fontMetrics");
  if (typeof master.name !== "string") fail("provenance.master.name must be a string");
  if (!Number.isSafeInteger(source.extractorVersion) || Number(source.extractorVersion) < 1)
    fail("provenance.extractorVersion must be a positive integer");
  if (Object.hasOwn(source, "instance")) {
    const instance = fields(source.instance, ["name", "weight", "masters"], "provenance.instance");
    if (typeof instance.name !== "string") fail("provenance.instance.name must be a string");
    finite(instance.weight, "provenance.instance.weight");
    if (!Array.isArray(instance.masters) || !instance.masters.length)
      fail("provenance.instance.masters must be a nonempty array");
    for (const entry of instance.masters) {
      const master = fields(entry, ["id", "weight", "factor"], "provenance.instance.masters entry");
      if (typeof master.id !== "string") fail("provenance.instance master id must be a string");
      finite(master.weight, "provenance.instance master weight");
      finite(master.factor, "provenance.instance master factor");
    }
  }
  return structuredClone(source) as unknown as SourceProvenance;
}

function validateGeometry(raw: GlyphGeometry, classifications: GlyphAssignments): void {
  const issue = validateDataset(raw, { version: 1, classifications }).diagnostics.find((item) =>
    item.code.startsWith("raw."),
  );
  if (issue) fail(`${issue.char ? `${issue.char}: ` : ""}${issue.message}`);
}

/** Restore source grouping without deriving paint order from object order. */
function compactSets(glyphs: Record<string, SourceGlyph>, defaultAdvanceWidth: number): CompactSet[] {
  const grouped = new Map<string, CompactSyllable[]>();
  for (const [char, glyph] of Object.entries(glyphs)) {
    const code = char.codePointAt(0)!;
    const medial = code >= HANGUL_BASE ? Math.floor(((code - HANGUL_BASE) % 588) / 28) : -1;
    const final = code >= HANGUL_BASE ? (code - HANGUL_BASE) % 28 : code < 0x314f ? 0 : 1;
    const key = `${medial}:${final}`;
    const shapes: CompactShape[] = [...glyph.contours]
      .sort((a, b) => a.id - b.id)
      .map(({ path, bounds }) => [path, bounds.width, bounds.height, bounds.centerX, bounds.centerY]);
    const entry: CompactSyllable = [char, glyph.advanceWidth ?? defaultAdvanceWidth, shapes];
    const group = grouped.get(key);
    if (group) group.push(entry);
    else grouped.set(key, [entry]);
  }
  const sets: CompactSet[] = [];
  const add = (medial: number, final: number) => {
    const group = grouped.get(`${medial}:${final}`);
    if (group) {
      group.sort((a, b) => a[0].codePointAt(0)! - b[0].codePointAt(0)!);
      sets.push([medial, final, group]);
    }
  };
  add(-1, 0);
  add(-1, 1);
  for (let medial = 0; medial < 21; medial++) for (let final = 0; final < 28; final++) add(medial, final);
  return sets;
}

/** Validate the document before converting stable contour ids into compact indices. */
export function decodeGlyphSource(value: unknown): {
  data: GlyphSourceDocument;
  raw: GlyphGeometry;
  classifications: GlyphAssignments;
  rawText: string;
  baselineText: string;
} {
  const input = fields(value, ["format", "version", "metrics", "provenance", "glyphs"], "document");
  if (input.format !== "hangul-palette-source" || input.version !== 1)
    fail("expected hangul-palette-source version 1");
  const metrics = fields(input.metrics, ["unitsPerEm", "viewportAscender", "defaultAdvanceWidth"], "metrics");
  const unitsPerEm = finite(metrics.unitsPerEm, "metrics.unitsPerEm");
  if (unitsPerEm <= 0) fail("metrics.unitsPerEm must be positive");
  const viewportAscender = finite(metrics.viewportAscender, "metrics.viewportAscender");
  const defaultAdvanceWidth = finite(metrics.defaultAdvanceWidth, "metrics.defaultAdvanceWidth");
  if (defaultAdvanceWidth <= 0) fail("metrics.defaultAdvanceWidth must be positive");
  if (!record(input.glyphs) || !Object.keys(input.glyphs).length) fail("glyphs must be a nonempty object");
  const glyphs: Record<string, SourceGlyph> = {};
  const classifications: GlyphAssignments = {};
  for (const [char, value] of Object.entries(input.glyphs)) {
    if (!supported(char)) fail(`unsupported glyph character ${char}`);
    const glyph = fields(value, ["advanceWidth", "contours"], char);
    const advanceWidth = Object.hasOwn(glyph, "advanceWidth")
      ? finite(glyph.advanceWidth, `${char}.advanceWidth`)
      : defaultAdvanceWidth;
    if (advanceWidth <= 0) fail(`${char}.advanceWidth must be positive`);
    if (!Array.isArray(glyph.contours) || !glyph.contours.length) fail(`${char}.contours must be nonempty`);
    const sourceContours = glyph.contours;
    const seen = new Set<number>();
    const contours = sourceContours.map((value, position): GlyphContour => {
      const name = `${char}.contours[${position}]`;
      const contour = fields(value, ["id", "region", "path", "bounds"], name);
      const id = contour.id;
      if (!Number.isSafeInteger(id) || Number(id) < 0 || Number(id) >= sourceContours.length)
        fail(`${name}.id must be an original contour index`);
      if (seen.has(id as number)) fail(`${char} has duplicate contour id ${id}`);
      seen.add(id as number);
      if (contour.region !== UNASSIGNED_REGION && !isRegionId(contour.region))
        fail(`${name}.region is unknown`);
      if (typeof contour.path !== "string") fail(`${name}.path must be a string`);
      const bounds = fields(contour.bounds, ["width", "height", "centerX", "centerY"], `${name}.bounds`);
      return {
        id: id as number,
        region: contour.region as string,
        path: contour.path,
        bounds: {
          width: finite(bounds.width, `${name}.bounds.width`),
          height: finite(bounds.height, `${name}.bounds.height`),
          centerX: finite(bounds.centerX, `${name}.bounds.centerX`),
          centerY: finite(bounds.centerY, `${name}.bounds.centerY`),
        },
      };
    });
    glyphs[char] = { ...(advanceWidth !== defaultAdvanceWidth ? { advanceWidth } : {}), contours };
    classifications[char] = contours.map(({ id, region }) => [id, region]);
  }
  const data: GlyphSourceDocument = {
    format: "hangul-palette-source",
    version: 1,
    metrics: { unitsPerEm, viewportAscender, defaultAdvanceWidth },
    ...(Object.hasOwn(input, "provenance") ? { provenance: provenance(input.provenance) } : {}),
    glyphs,
  };
  const raw: GlyphGeometry = {
    version: 1,
    upm: unitsPerEm,
    asc: viewportAscender,
    sets: compactSets(glyphs, defaultAdvanceWidth),
    ...(data.provenance ? { provenance: data.provenance } : {}),
  };
  validateGeometry(raw, classifications);
  return {
    data,
    raw,
    classifications,
    rawText: JSON.stringify(raw),
    baselineText: JSON.stringify({ version: 1, classifications }),
  };
}

/** Combine geometry and final regions without renumbering source contours or sorting paint order. */
export function createGlyphSource(
  raw: GlyphGeometry,
  classifications: GlyphAssignments,
): GlyphSourceDocument {
  if (!record(classifications)) fail("classifications must be an object");
  validateGeometry(raw, classifications);
  const source = new Map(raw.sets.flatMap((set) => set[2].map((glyph) => [glyph[0], glyph] as const)));
  if (!source.size) fail("glyphs must be a nonempty object");
  const widths = new Map<number, number>();
  for (const glyph of source.values()) widths.set(glyph[1], (widths.get(glyph[1]) ?? 0) + 1);
  const defaultAdvanceWidth = [...widths].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
  const glyphs: Record<string, SourceGlyph> = {};
  // Preserve baseline insertion order so existing workspace fingerprints remain valid.
  const characters = [
    ...Object.keys(classifications),
    ...[...source.keys()].filter((char) => !Object.hasOwn(classifications, char)),
  ];
  for (const char of characters) {
    const glyph = source.get(char);
    if (!glyph) fail(`${char}: classification has no matching source glyph`);
    const entry: ContourAssignments = Object.hasOwn(classifications, char)
      ? classifications[char]
      : glyph[2].map((_, id) => [id, UNASSIGNED_REGION]);
    if (!Array.isArray(entry) || entry.length !== glyph[2].length)
      fail(`${char}: every contour must appear exactly once`);
    const seen = new Set<number>();
    const contours = entry.map((pair): GlyphContour => {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !Number.isSafeInteger(pair[0]) ||
        pair[0] < 0 ||
        pair[0] >= glyph[2].length ||
        seen.has(pair[0]) ||
        (pair[1] !== UNASSIGNED_REGION && !isRegionId(pair[1]))
      )
        fail(`${char}: invalid contour index or region`);
      seen.add(pair[0]);
      const [path, width, height, centerX, centerY] = glyph[2][pair[0]]!;
      return { id: pair[0], region: pair[1], path, bounds: { width, height, centerX, centerY } };
    });
    glyphs[char] = { ...(glyph[1] !== defaultAdvanceWidth ? { advanceWidth: glyph[1] } : {}), contours };
  }
  const data: GlyphSourceDocument = {
    format: "hangul-palette-source",
    version: 1,
    metrics: { unitsPerEm: raw.upm, viewportAscender: raw.asc, defaultAdvanceWidth },
    ...(raw.provenance ? { provenance: structuredClone(raw.provenance) } : {}),
    glyphs,
  };
  return decodeGlyphSource(data).data;
}

/** Keep glyph blocks readable, with one complete contour per line. */
export function serializeGlyphSource(data: GlyphSourceDocument): string {
  const { glyphs, ...metadata } = decodeGlyphSource(data).data;
  const entries = Object.entries(glyphs).map(
    ([char, glyph]) =>
      `    ${JSON.stringify(char)}: {\n` +
      (Object.hasOwn(glyph, "advanceWidth") ? `      "advanceWidth": ${glyph.advanceWidth},\n` : "") +
      `      "contours": [\n` +
      glyph.contours.map((contour) => `        ${JSON.stringify(contour)}`).join(",\n") +
      "\n      ]\n    }",
  );
  // Leave the root object open to append the glyph blocks.
  const header = JSON.stringify(metadata, null, 2).slice(0, -2);
  return `${header},\n  "glyphs": {\n${entries.join(",\n")}\n  }\n}\n`;
}
