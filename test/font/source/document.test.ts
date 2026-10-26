import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createGlyphSource,
  decodeGlyphSource,
  serializeGlyphSource,
} from "../../../src/font/source/document.ts";
import type {
  GlyphAssignments,
  GlyphGeometry,
  GlyphSourceDocument,
  SourceProvenance,
} from "../../../src/font/source/types.ts";
import { validateDataset } from "../../../src/font/source/validation.ts";

const root = resolve(import.meta.dir, "../../..");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture(): { raw: GlyphGeometry; classifications: GlyphAssignments } {
  return {
    raw: {
      version: 1,
      upm: 2896,
      asc: 2259,
      sets: [
        [-1, 0, [["ㄱ", 2000, [["M0 0L10 0L10 -10Z", 10, 10, 5, 5]]]]],
        [
          0,
          0,
          [
            [
              "가",
              2504,
              [
                ["M20 0L30 0L30 -10Z", 10, 10, 25, 5],
                ["M40 0L50 0L50 -10Z", 10, 10, 45, 5],
                ["M60 0L70 0L70 -10Z", 10, 10, 65, 5],
              ],
            ],
          ],
        ],
      ],
    },
    // Baseline order deliberately differs from geometry grouping.
    classifications: {
      가: [
        [1, "medial.part1.vertical"],
        [0, "initial.part1.body"],
        [2, "medial.part1.right-bar"],
      ],
      ㄱ: [[0, "initial.part1.body"]],
    },
  };
}

function source(): GlyphSourceDocument {
  const { raw, classifications } = fixture();
  return createGlyphSource(raw, classifications);
}

function provenance(): SourceProvenance {
  return {
    repository: "https://example.test/font",
    ref: "v1",
    revision: "a".repeat(40),
    sourceFingerprint: "b".repeat(64),
    fingerprintAlgorithm: "sha256-path-length-content-v1",
    fontInfoSha256: "c".repeat(64),
    licenseSha256: "d".repeat(64),
    master: { id: "regular", name: "Regular", weight: 400 },
    instance: {
      name: "Light",
      weight: 300,
      masters: [
        { id: "thin", weight: 100, factor: 1 / 3 },
        { id: "regular", weight: 400, factor: 2 / 3 },
      ],
    },
    fontMetrics: { unitsPerEm: 2896, ascender: 2259, descender: -637 },
    geometryBounds: "control-points",
    viewportAscender: 2259,
    extractorVersion: 1,
  };
}

test("glyph data preserves original contour indices, paint order, bounds, and compact source bytes", () => {
  const { raw, classifications } = fixture();
  const data = createGlyphSource(raw, classifications);
  expect(Object.keys(data.glyphs)).toEqual(["가", "ㄱ"]);
  expect(data.version).toBe(1);
  expect(data.metrics.defaultAdvanceWidth).toBe(2000);
  expect(data.glyphs.가!.advanceWidth).toBe(2504);
  expect(Object.hasOwn(data.glyphs.ㄱ!, "advanceWidth")).toBe(false);
  expect(data.glyphs.가!.contours.map(({ id, region }) => [id, region])).toEqual([
    [1, "medial.part1.vertical"],
    [0, "initial.part1.body"],
    [2, "medial.part1.right-bar"],
  ]);
  expect(data.glyphs.가!.contours[0]).toEqual({
    id: 1,
    region: "medial.part1.vertical",
    path: "M40 0L50 0L50 -10Z",
    bounds: { width: 10, height: 10, centerX: 45, centerY: 5 },
  });
  const decoded = decodeGlyphSource(data);
  expect(decoded.rawText).toBe(JSON.stringify(raw));
  expect(decoded.baselineText).toBe(JSON.stringify({ version: 1, classifications }));
  expect(decoded.data.provenance).toBeUndefined();
  const serialized = serializeGlyphSource(data);
  expect(JSON.parse(serialized)).toEqual(data);
  expect(serialized).toContain(`        ${JSON.stringify(data.glyphs.가!.contours[0])},\n`);
  expect(serializeGlyphSource(JSON.parse(serializeGlyphSource(data)))).toBe(serializeGlyphSource(data));
});

test("reordering painted contours never changes which geometry a stable id identifies", () => {
  const data = source();
  const before = decodeGlyphSource(data);
  data.glyphs.가!.contours.reverse();
  const after = decodeGlyphSource(data);
  expect(after.rawText).toBe(before.rawText);
  expect(after.classifications.가).toEqual([
    [2, "medial.part1.right-bar"],
    [0, "initial.part1.body"],
    [1, "medial.part1.vertical"],
  ]);
  expect(after.baselineText).not.toBe(before.baselineText);
  expect(after.data.glyphs.가!.contours.map(({ id, path }) => [id, path])).toEqual([
    [2, "M60 0L70 0L70 -10Z"],
    [0, "M20 0L30 0L30 -10Z"],
    [1, "M40 0L50 0L50 -10Z"],
  ]);
});

test("partial source and unassigned regions remain editable but cannot be exported as complete fonts", () => {
  const { raw } = fixture();
  const data = createGlyphSource(raw, { ㄱ: [[0, "unassigned"]] });
  expect(Object.keys(data.glyphs)).toEqual(["ㄱ", "가"]);
  expect(data.glyphs.가!.contours.map(({ id, region }) => [id, region])).toEqual([
    [0, "unassigned"],
    [1, "unassigned"],
    [2, "unassigned"],
  ]);
  const decoded = decodeGlyphSource(data);
  expect(decoded.classifications).toEqual({
    ㄱ: [[0, "unassigned"]],
    가: [
      [0, "unassigned"],
      [1, "unassigned"],
      [2, "unassigned"],
    ],
  });
  expect(createGlyphSource(raw, {}).glyphs.가!.contours.every(({ region }) => region === "unassigned")).toBe(
    true,
  );
  const report = validateDataset(decoded.raw, { version: 1, classifications: decoded.classifications });
  expect(report.valid).toBe(false);
  expect(report.complete).toBe(false);
  expect(report.diagnostics.some(({ code }) => code === "classification.glyph")).toBe(true);
});

test("malformed existing assignments are rejected instead of reindexing or replacing them", () => {
  const { raw } = fixture();
  for (const value of [
    null,
    undefined,
    [[0, "initial.part1.body"]],
    [
      [0, 1],
      [0, 2],
    ],
    [
      [0, 1],
      [2, 2],
    ],
    [
      [0, 1],
      [1, 6],
    ],
    [
      [0, 1, 9],
      [1, 2],
    ],
  ]) {
    expect(() => createGlyphSource(raw, { 가: value } as unknown as GlyphAssignments)).toThrow(
      "Invalid glyph data:",
    );
  }
  expect(() => createGlyphSource(raw, { 나: [[0, "initial.part1.body"]] })).toThrow(
    "no matching source glyph",
  );
  expect(() => createGlyphSource(raw, [] as unknown as GlyphAssignments)).toThrow(
    "classifications must be an object",
  );
});

test("document schemas reject unknown fields, unsupported characters, and unknown region IDs", () => {
  for (const modify of [
    (data: GlyphSourceDocument) => Object.assign(data, { extra: true }),
    (data: GlyphSourceDocument) => Object.assign(data.metrics, { asc: 2259 }),
    (data: GlyphSourceDocument) => Object.assign(data.glyphs.가!, { shapes: [] }),
    (data: GlyphSourceDocument) => Object.assign(data.glyphs.가!.contours[0]!, { color: "red" }),
    (data: GlyphSourceDocument) => Object.assign(data.glyphs.가!.contours[0]!.bounds, { x: 1 }),
  ]) {
    const data = source();
    modify(data);
    expect(() => decodeGlyphSource(data)).toThrow("unknown field");
  }
  for (const region of ["none", "vowel", "2", 2, null]) {
    const data = source();
    Object.assign(data.glyphs.가!.contours[0]!, { region });
    expect(() => decodeGlyphSource(data)).toThrow("region is unknown");
  }
  const wrongVersion = source();
  Object.assign(wrongVersion, { version: 99 });
  expect(() => decodeGlyphSource(wrongVersion)).toThrow("version 1");
  const wrongFormat = source();
  Object.assign(wrongFormat, { format: "other" });
  expect(() => decodeGlyphSource(wrongFormat)).toThrow("version 1");
  const latin = source();
  latin.glyphs.A = latin.glyphs.가!;
  expect(() => decodeGlyphSource(latin)).toThrow("unsupported glyph character");
  const empty = source();
  empty.glyphs = {};
  expect(() => decodeGlyphSource(empty)).toThrow("nonempty object");
});

test("invalid or duplicated ids cannot silently move a contour into another original index", () => {
  for (const id of [-1, 0.5, 3, Number.NaN, "0", null]) {
    const data = source();
    Object.assign(data.glyphs.가!.contours[0]!, { id });
    expect(() => decodeGlyphSource(data)).toThrow("original contour index");
  }
  const duplicated = source();
  duplicated.glyphs.가!.contours[0]!.id = 0;
  expect(() => decodeGlyphSource(duplicated)).toThrow("duplicate contour id");
  const missing = source();
  missing.glyphs.가!.contours.shift();
  expect(() => decodeGlyphSource(missing)).toThrow("original contour index");
});

test("malformed geometry and metrics are rejected before compilation", () => {
  for (const path of ["MNaN 0Z", "M0 0L1e999 0Z", "M0 0L10 10", "M0 0A10 10 0 0 0 20 20Z"]) {
    const data = source();
    data.glyphs.가!.contours[0]!.path = path;
    expect(() => decodeGlyphSource(data)).toThrow("invalid outline path");
  }
  const width = source();
  width.glyphs.가!.advanceWidth = 0;
  expect(() => decodeGlyphSource(width)).toThrow("advanceWidth must be positive");
  const bounds = source();
  bounds.glyphs.가!.contours[0]!.bounds.width = -1;
  expect(() => decodeGlyphSource(bounds)).toThrow("control-point bounds");
  const nan = source();
  nan.glyphs.가!.contours[0]!.bounds.centerX = Number.NaN;
  expect(() => decodeGlyphSource(nan)).toThrow("must be finite");
  const upm = source();
  upm.metrics.unitsPerEm = -1;
  expect(() => decodeGlyphSource(upm)).toThrow("must be positive");
  const { raw, classifications } = fixture();
  raw.sets[1]![0] = 1;
  expect(() => createGlyphSource(raw, classifications)).toThrow("belongs to set");
});

test("the most frequent advance width is stored once while paths, bounds, and differing widths stay inline", () => {
  const { raw, classifications } = fixture();
  const consonants = raw.sets[0]![2];
  consonants.push(["ㄴ", 2504, structuredClone(consonants[0]![2])]);
  const assignments: GlyphAssignments = { ...classifications, ㄴ: [[0, "initial.part1.body"]] };
  const data = createGlyphSource(raw, assignments);
  expect(data.metrics.defaultAdvanceWidth).toBe(2504);
  expect(data.glyphs.ㄱ!.advanceWidth).toBe(2000);
  expect(Object.hasOwn(data.glyphs.가!, "advanceWidth")).toBe(false);
  expect(Object.hasOwn(data.glyphs.ㄴ!, "advanceWidth")).toBe(false);
  expect(data.glyphs.가!.contours[0]!.path).toBe("M40 0L50 0L50 -10Z");
  expect(data.glyphs.가!.contours[0]!.bounds).toEqual({ width: 10, height: 10, centerX: 45, centerY: 5 });
  const decoded = decodeGlyphSource(data);
  expect(decoded.rawText).toBe(JSON.stringify(raw));
  expect(decoded.baselineText).toBe(JSON.stringify({ version: 1, classifications: assignments }));
  const text = serializeGlyphSource(data);
  expect(text.match(/"advanceWidth"/g)).toHaveLength(1);
  expect(text).toContain('"defaultAdvanceWidth": 2504');
});

test("equal-frequency width selection is stable and uses the smaller width", () => {
  const { raw, classifications } = fixture();
  const first = createGlyphSource(raw, classifications);
  const second = createGlyphSource(
    { ...raw, sets: [...raw.sets].reverse() },
    {
      ㄱ: [[0, "initial.part1.body"]],
      가: [
        [0, "initial.part1.body"],
        [1, "medial.part1.vertical"],
        [2, "medial.part1.right-bar"],
      ],
    },
  );
  expect(first.metrics.defaultAdvanceWidth).toBe(2000);
  expect(second.metrics.defaultAdvanceWidth).toBe(2000);
  expect(second.glyphs.가!.advanceWidth).toBe(2504);
  expect(Object.hasOwn(second.glyphs.ㄱ!, "advanceWidth")).toBe(false);
});

test("default widths are inherited and redundant explicit overrides are omitted when creating an export", () => {
  const data = source();
  const inherited = decodeGlyphSource(data);
  const consonant = inherited.raw.sets[0]![2][0]!;
  expect(consonant[0]).toBe("ㄱ");
  expect(consonant[1]).toBe(2000);
  data.glyphs.ㄱ!.advanceWidth = data.metrics.defaultAdvanceWidth;
  const explicit = decodeGlyphSource(data);
  expect(Object.hasOwn(explicit.data.glyphs.ㄱ!, "advanceWidth")).toBe(false);
  expect(explicit.rawText).toBe(inherited.rawText);
  expect(explicit.baselineText).toBe(inherited.baselineText);
  const exported = createGlyphSource(explicit.raw, explicit.classifications);
  expect(Object.hasOwn(exported.glyphs.ㄱ!, "advanceWidth")).toBe(false);
  expect(exported.glyphs.가!.advanceWidth).toBe(2504);
});

test("defaults and explicit width overrides must be positive finite numbers without silent fallback", () => {
  for (const value of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "2504",
    null,
    undefined,
    false,
  ]) {
    const invalidDefault = source();
    Object.assign(invalidDefault.metrics, { defaultAdvanceWidth: value });
    expect(() => decodeGlyphSource(invalidDefault)).toThrow("defaultAdvanceWidth");
    const invalidOverride = source();
    Object.assign(invalidOverride.glyphs.ㄱ!, { advanceWidth: value });
    expect(() => decodeGlyphSource(invalidOverride)).toThrow("advanceWidth");
  }
  const missingDefault = source();
  Reflect.deleteProperty(missingDefault.metrics, "defaultAdvanceWidth");
  expect(() => decodeGlyphSource(missingDefault)).toThrow("defaultAdvanceWidth");
  const emptySource = fixture().raw;
  emptySource.sets = [];
  expect(() => createGlyphSource(emptySource, {})).toThrow("nonempty object");
});

test("verified optional provenance is preserved, independently cloned, and strictly checked", () => {
  const { raw, classifications } = fixture();
  raw.provenance = provenance();
  const data = createGlyphSource(raw, classifications);
  expect(data.provenance).toEqual(raw.provenance);
  expect(data.provenance).not.toBe(raw.provenance);
  expect(decodeGlyphSource(data).rawText).toBe(JSON.stringify(raw));
  const unknown = structuredClone(data);
  Object.assign(unknown.provenance!.instance!.masters[0]!, { extra: true });
  expect(() => decodeGlyphSource(unknown)).toThrow("unknown field");
  const mismatch = structuredClone(data);
  mismatch.provenance!.fontMetrics.unitsPerEm = 1000;
  expect(() => decodeGlyphSource(mismatch)).toThrow("source provenance");
  const hash = structuredClone(data);
  hash.provenance!.sourceFingerprint = "invalid";
  expect(() => decodeGlyphSource(hash)).toThrow("source provenance");
  const factor = structuredClone(data);
  factor.provenance!.instance!.masters[0]!.factor = Number.NaN;
  expect(() => decodeGlyphSource(factor)).toThrow("must be finite");
});

test("the complete source round-trip preserves the original geometry fingerprint and 11223 glyphs", () => {
  const source = JSON.parse(readFileSync(join(root, "data/glyphs.json"), "utf8"));
  const decoded = decodeGlyphSource(source);
  expect(Object.keys(decoded.data.glyphs)).toHaveLength(11223);
  expect(decoded.data.version).toBe(1);
  expect(decoded.data.metrics.defaultAdvanceWidth).toBe(2504);
  expect(Object.values(decoded.data.glyphs).every((glyph) => !Object.hasOwn(glyph, "advanceWidth"))).toBe(
    true,
  );
  expect(Object.values(decoded.data.glyphs).reduce((sum, glyph) => sum + glyph.contours.length, 0)).toBe(
    104276,
  );
  expect(hash(decoded.rawText)).toBe("d57655dbf07c576d7ae769d79f27b4d9178c6ce63460f8ef1cab90dca913889f");
  expect(hash(decoded.baselineText)).toBe("5c26c450806ae7ef40f5dc1768377117f57d0537a049fb1a56f5edfedca20100");
  const after = decodeGlyphSource(createGlyphSource(decoded.raw, decoded.classifications));
  expect(after.rawText).toBe(decoded.rawText);
  expect(after.baselineText).toBe(decoded.baselineText);
  expect(validateDataset(after.raw, { version: 1, classifications: after.classifications }).valid).toBe(true);
});
