import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGlyphSource, decodeGlyphSource } from "./document.ts";
import {
  ASC,
  FINAL_COUNT,
  HANGUL_BASE,
  HANGUL_END,
  JAMO_END,
  JAMO_START,
  JAMO_VOWEL_START,
  MEDIAL_COUNT,
  UPM,
} from "./hangul.ts";
import { type ParsedContour, parseGlyphFile, parseInterpolatedGlyphFile } from "./parser.ts";
import {
  ensureSourceRepository,
  fingerprintSource,
  PRETENDARD_SOURCE,
  parseSourcePlist,
  sha256,
  sourceObject,
} from "./pretendard.ts";
import type {
  CompactSet,
  CompactShape,
  CompactSyllable,
  GlyphGeometry,
  GlyphSourceDocument,
  SourceProvenance,
} from "./types.ts";

interface GlyphExtractionOptions {
  sourcePath: string;
  weight: { label: string; value: number };
  onProgress?: (message: string) => void;
}

/** Extract semantic-mask contours from verified source masters or named instances.
 * Compiled OTFs merge adjacent strokes; source contours preserve their identities. */
export async function extractGlyphGeometry({
  sourcePath: source,
  weight,
  onProgress,
}: GlyphExtractionOptions): Promise<GlyphGeometry> {
  await ensureSourceRepository(source);
  const glyphsDirectory = join(source, "src/Pretendard.glyphspackage/glyphs");
  const fontInfoPath = join(glyphsDirectory, "../fontinfo.plist");
  const fontInfo = readFileSync(fontInfoPath, "utf8");

  const targetWeight = weight.value;
  const font = parseSourcePlist(fontInfo);
  if (font[".formatVersion"] !== 3) throw new Error("Only Glyphs source format version 3 is supported");
  if (!Array.isArray(font.fontMaster)) throw new Error("Source fontMaster must be an array");
  const masters = font.fontMaster.map((entry) => sourceObject(entry, "font master"));
  let instance: SourceProvenance["instance"];
  if (targetWeight !== 400) {
    if (!Array.isArray(font.instances)) throw new Error("Source instances must be an array");
    const instances = font.instances
      .map((entry) => sourceObject(entry, "font instance"))
      .filter(
        (entry) =>
          entry.name === weight.label &&
          Array.isArray(entry.axesValues) &&
          entry.axesValues[0] === targetWeight,
      );
    if (instances.length !== 1) throw new Error(`Expected exactly one named ${weight.label} instance`);
    const namedInstance = instances[0]!;
    if (namedInstance.manualInterpolation === 1)
      throw new Error("Manually interpolated source instances are unsupported");
    const coordinates = masters.map((master) => {
      if (
        typeof master.id !== "string" ||
        !Array.isArray(master.axesValues) ||
        master.axesValues.length !== 1 ||
        typeof master.axesValues[0] !== "number" ||
        !Number.isFinite(master.axesValues[0])
      )
        throw new Error("Expected one finite weight axis per source master");
      return { id: master.id, weight: master.axesValues[0] };
    });
    const lower = coordinates
      .filter((master) => master.weight < targetWeight)
      .sort((a, b) => b.weight - a.weight)[0];
    const upper = coordinates
      .filter((master) => master.weight > targetWeight)
      .sort((a, b) => a.weight - b.weight)[0];
    if (!lower || !upper) throw new Error(`Cannot bracket source instance ${weight.label}`);
    const upperFactor = (targetWeight - lower.weight) / (upper.weight - lower.weight);
    const interpolation = [
      { ...lower, factor: 1 - upperFactor },
      { ...upper, factor: upperFactor },
    ];
    // Glyphs stores automatically calculated coefficients rounded to five decimals.
    // Use exact axis ratios, but refuse an instance that describes a different model.
    const declared = sourceObject(namedInstance.instanceInterpolations!, "instance interpolations");
    if (
      Object.keys(declared).length !== interpolation.length ||
      interpolation.some(
        (master) =>
          typeof declared[master.id] !== "number" ||
          Math.abs(Number(declared[master.id]) - master.factor) > 0.0000051,
      )
    )
      throw new Error(`Named ${weight.label} instance coefficients disagree with source axes`);
    instance = { name: String(namedInstance.name), weight: targetWeight, masters: interpolation };
  }
  const matches = masters.filter(
    (master) => Array.isArray(master.axesValues) && master.axesValues[0] === (instance ? 400 : targetWeight),
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected exactly one master for weight ${weight.label} (${targetWeight}); found ${matches.length}`,
    );
  const targetMaster = matches[0]!;
  if (typeof targetMaster.id !== "string") throw new Error("Master id is missing");
  const layerId = targetMaster.id;
  const sourceUpm = font.unitsPerEm;
  if (typeof sourceUpm !== "number" || !Number.isFinite(sourceUpm) || sourceUpm <= 0)
    throw new Error("Source unitsPerEm is unavailable or invalid");
  if (sourceUpm !== UPM) throw new Error(`Source unitsPerEm ${sourceUpm} differs from supported ${UPM}`);
  const masterParameters = Array.isArray(targetMaster.customParameters)
    ? targetMaster.customParameters.map((entry) => sourceObject(entry, "master parameter"))
    : [];
  function metric(name: string): number | null {
    const value = masterParameters.find((parameter) => parameter.name === name)?.value;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  const provenance: SourceProvenance = {
    ...PRETENDARD_SOURCE,
    sourceFingerprint: fingerprintSource(source, [
      "LICENSE",
      "src/Pretendard.glyphspackage/fontinfo.plist",
      ...readdirSync(glyphsDirectory)
        .filter((file) => file.endsWith(".glyph"))
        .map((file) => `src/Pretendard.glyphspackage/glyphs/${file}`),
    ]),
    fingerprintAlgorithm: "sha256-path-length-content-v1",
    fontInfoSha256: sha256(fontInfo),
    licenseSha256: sha256(readFileSync(join(source, "LICENSE"))),
    master: {
      id: layerId,
      weight: instance ? 400 : targetWeight,
      name: String(targetMaster.name ?? ""),
    },
    ...(instance ? { instance } : {}),
    fontMetrics: {
      unitsPerEm: sourceUpm,
      ascender: metric("hheaAscender"),
      descender: metric("hheaDescender"),
    },
    geometryBounds: "control-points",
    // The semantic-mask viewport origin is independent of official font metrics.
    viewportAscender: ASC,
    extractorVersion: 1,
  };

  // ── Parse all .glyph files ──
  const files = readdirSync(glyphsDirectory)
    .filter((f: string) => f.endsWith("-ko.glyph"))
    .sort();
  onProgress?.(`Found ${files.length} Korean glyph files`);
  if (files.length === 0) {
    throw new Error(
      "No Korean glyph files (*-ko.glyph) found. Pretendard source structure may have changed.",
    );
  }

  interface ParsedSyllable {
    char: string;
    initialIdx: number;
    medialIdx: number;
    finalIdx: number;
    width: number;
    shapes: ParsedContour[];
  }
  interface ParsedJamo {
    char: string;
    width: number;
    shapes: ParsedContour[];
  }

  const syllables: ParsedSyllable[] = [];
  const jamoList: ParsedJamo[] = [];

  // Read in batches: Bun.file() is async and each batch's I/O overlaps at the
  // kernel level. Batch size caps in-flight file descriptors so we don't trip
  // the soft FD limit on systems that set it low.
  const FILE_READ_BATCH = 256;
  for (let batchStart = 0; batchStart < files.length; batchStart += FILE_READ_BATCH) {
    const batch = files.slice(batchStart, batchStart + FILE_READ_BATCH);
    const contents = await Promise.all(batch.map((f) => Bun.file(join(glyphsDirectory, f)).text()));
    for (let i = 0; i < batch.length; i++) {
      const unicodeMatch = contents[i]!.match(/\bunicode\s*=\s*(?:\(\s*(\d+)|(\d+))/);
      const code = Number(unicodeMatch?.[1] ?? unicodeMatch?.[2] ?? 0);
      if (!((code >= JAMO_START && code <= JAMO_END) || (code >= HANGUL_BASE && code <= HANGUL_END)))
        continue;
      let parsed: ReturnType<typeof parseGlyphFile>;
      try {
        parsed = instance
          ? parseInterpolatedGlyphFile(
              contents[i]!,
              instance.masters.map((master) => ({ layerId: master.id, factor: master.factor })),
              glyphsDirectory,
            )
          : parseGlyphFile(contents[i]!, layerId, glyphsDirectory);
      } catch (error) {
        throw new Error(`${batch[i]}: ${(error as Error).message}`);
      }
      const { shapes, width, unicode } = parsed;
      if (shapes.length === 0) continue;

      const isJamo = unicode >= JAMO_START && unicode <= JAMO_END;
      if (isJamo) {
        jamoList.push({ char: String.fromCharCode(unicode), width, shapes });
      } else if (unicode >= HANGUL_BASE && unicode <= HANGUL_END) {
        const offset = unicode - HANGUL_BASE;
        syllables.push({
          char: String.fromCharCode(unicode),
          initialIdx: Math.floor(offset / (MEDIAL_COUNT * FINAL_COUNT)),
          medialIdx: Math.floor((offset % (MEDIAL_COUNT * FINAL_COUNT)) / FINAL_COUNT),
          finalIdx: offset % FINAL_COUNT,
          width,
          shapes,
        });
      }
    }
  }
  onProgress?.(`Parsed ${syllables.length} syllables, ${jamoList.length} jamo`);

  if (syllables.length !== HANGUL_END - HANGUL_BASE + 1 || jamoList.length !== JAMO_END - JAMO_START + 1) {
    throw new Error("Incomplete supported glyph coverage; extraction will not replace the output.");
  }

  const unique = new Set([...syllables, ...jamoList].map((glyph) => glyph.char));
  if (unique.size !== syllables.length + jamoList.length)
    throw new Error("Duplicate supported Unicode glyphs in source");

  // ── Group into 588 sets + jamo ──
  const setMap = new Map<string, ParsedSyllable[]>();
  for (const syllable of syllables) {
    const key = `${syllable.medialIdx}-${syllable.finalIdx}`;
    if (!setMap.has(key)) setMap.set(key, []);
    setMap.get(key)!.push(syllable);
  }

  const sets: CompactSet[] = [];

  // Keep standalone jamo first in the canonical compact grouping order.
  //   m=-1, f=0: consonants (자음, U+3131..U+314E)
  //   m=-1, f=1: vowels (모음, U+314F..U+3163)
  jamoList.sort((a, b) => a.char.charCodeAt(0) - b.char.charCodeAt(0));
  const consonants = jamoList.filter((j) => j.char.charCodeAt(0) < JAMO_VOWEL_START);
  const vowels = jamoList.filter((j) => j.char.charCodeAt(0) >= JAMO_VOWEL_START);

  function jamoToCompact(jamo: ParsedJamo): CompactSyllable {
    return [
      jamo.char,
      jamo.width,
      jamo.shapes.map((shape) => [shape.pathData, shape.w, shape.h, shape.cx, shape.cy] as CompactShape),
    ];
  }

  if (consonants.length > 0) sets.push([-1, 0, consonants.map(jamoToCompact)]);
  if (vowels.length > 0) sets.push([-1, 1, vowels.map(jamoToCompact)]);

  // Then all syllables, ordered by medial × final.
  for (let m = 0; m < MEDIAL_COUNT; m++) {
    for (let f = 0; f < FINAL_COUNT; f++) {
      const group = setMap.get(`${m}-${f}`);
      if (!group) continue;
      group.sort((a, b) => a.initialIdx - b.initialIdx);
      sets.push([
        m,
        f,
        group.map((syllable) => [
          syllable.char,
          syllable.width,
          syllable.shapes.map(
            (shape) => [shape.pathData, shape.w, shape.h, shape.cx, shape.cy] as CompactShape,
          ),
        ]),
      ]);
    }
  }

  return { version: 1, upm: sourceUpm, asc: ASC, sets, provenance };
}

/** Reuse assignments only when every source contour retains its original identity. */
export function createExtractedGlyphSource(raw: GlyphGeometry, reference?: unknown): GlyphSourceDocument {
  if (reference === undefined) return createGlyphSource(raw, {});
  const previous = decodeGlyphSource(reference);
  const incompatible = (detail: string): never => {
    throw new Error(
      `Extracted geometry differs from the existing glyph data (${detail}). Contour regions and paint order cannot be reused. The output was not replaced.`,
    );
  };
  if (previous.raw.upm !== raw.upm || previous.raw.asc !== raw.asc) incompatible("font metrics");
  const glyphs = (data: GlyphGeometry) =>
    new Map(data.sets.flatMap((set) => set[2]).map((glyph) => [glyph[0], glyph]));
  const oldGlyphs = glyphs(previous.raw),
    newGlyphs = glyphs(raw);
  if (oldGlyphs.size !== newGlyphs.size) incompatible("character coverage");
  for (const [char, glyph] of newGlyphs) {
    const old = oldGlyphs.get(char);
    if (!old) incompatible(`missing ${char}`);
    if (!sameGlyph(old!, glyph)) incompatible(char);
  }
  return createGlyphSource(raw, previous.classifications);
}

function sameGlyph(a: CompactSyllable, b: CompactSyllable): boolean {
  return (
    a[1] === b[1] &&
    a[2].length === b[2].length &&
    a[2].every((shape, index) => {
      const other = b[2][index]!;
      return shape.every((value, field) => value === other[field]);
    })
  );
}
