import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeGlyphSource } from "../../../src/font/source/document.ts";
import { fingerprintSource } from "../../../src/font/source/pretendard.ts";
import type {
  CompactShape,
  GlyphAssignments,
  GlyphGeometry,
  SourceProvenance,
} from "../../../src/font/source/types.ts";
import { validateDataset } from "../../../src/font/source/validation.ts";

const root = resolve(import.meta.dir, "../../..");
const shape: CompactShape = ["M0 0L10 0L10 -10Z", 10, 10, 5, 5];

function fixture(): {
  raw: GlyphGeometry;
  classes: { version: number; classifications: GlyphAssignments };
} {
  return {
    raw: {
      version: 1,
      upm: 2896,
      asc: 2259,
      sets: [[0, 0, [["가", 2504, [[...shape], [...shape], [...shape]]]]]],
    },
    classes: {
      version: 1,
      classifications: {
        가: [
          [0, "initial.part1.body"],
          [1, "medial.part1.vertical"],
          [2, "medial.part1.right-bar"],
        ],
      },
    },
  };
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
    fontMetrics: { unitsPerEm: 2896, ascender: 2259, descender: -637 },
    geometryBounds: "control-points",
    viewportAscender: 2259,
    extractorVersion: 1,
  };
}

test("partial coverage remains invalid even when the provided glyph is fully assigned", () => {
  const { raw, classes } = fixture();
  const report = validateDataset(raw, classes);
  expect(report.complete).toBe(false);
  expect(report.valid).toBe(false);
  expect(report.validGlyphs).toBe(1);
  expect(report.diagnostics.filter((item) => item.code === "coverage.missing")).toHaveLength(11222);
  expect(report.diagnostics.some((item) => item.code.startsWith("classification."))).toBe(false);
});

test("dataset validation rejects unsupported schemas and malformed source groups", () => {
  const a = fixture();
  a.raw.version = 7;
  expect(validateDataset(a.raw, a.classes).diagnostics.some((item) => item.code === "raw.version")).toBe(
    true,
  );
  expect(validateDataset(a.raw, {}).diagnostics.some((item) => item.code === "classification.schema")).toBe(
    true,
  );

  const b = fixture();
  b.raw.sets[0]![0] = 1;
  expect(validateDataset(b.raw, b.classes).diagnostics.some((item) => item.code === "raw.group")).toBe(true);

  const c = fixture();
  c.raw.sets.push(c.raw.sets[0]!);
  expect(validateDataset(c.raw, c.classes).diagnostics.some((item) => item.code === "raw.duplicate")).toBe(
    true,
  );
});

test("invalid outlines are rejected before they reach the font compiler", () => {
  for (const path of ["MNaN 0Z", "M0 0L1e999 0Z", "M0 0L10 10", "M0 0A10 10 0 0 0 20 20Z"]) {
    const { raw, classes } = fixture();
    raw.sets[0]![2][0]![2][0]![0] = path;
    expect(validateDataset(raw, classes).diagnostics.some((item) => item.code === "raw.contour")).toBe(true);
  }
});

test("source metrics must be finite and advances positive without requiring uniform widths", () => {
  const { raw, classes } = fixture();
  raw.upm = 0;
  raw.asc = Number.NaN;
  raw.sets[0]![2][0]![1] = -1;
  const invalid = validateDataset(raw, classes);
  expect(invalid.diagnostics.filter((item) => item.code === "raw.metrics")).toHaveLength(2);
  expect(invalid.diagnostics.some((item) => item.code === "raw.width")).toBe(true);

  const second = fixture();
  second.raw.sets.push([-1, 0, [["ㄱ", 2000, [[...shape]]]]]);
  second.classes.classifications.ㄱ = [[0, "initial.part1.body"]];
  const differentWidths = validateDataset(second.raw, second.classes);
  expect(differentWidths.validGlyphs).toBe(2);
  expect(differentWidths.diagnostics.some((item) => item.code === "raw.width")).toBe(false);
});

test("missing, incomplete, and unmatched assignments prevent a valid font dataset", () => {
  const missing = fixture();
  delete missing.classes.classifications.가;
  expect(
    validateDataset(missing.raw, missing.classes).diagnostics.some(
      (item) => item.code === "classification.missing",
    ),
  ).toBe(true);

  const incomplete = fixture();
  incomplete.classes.classifications.가 = [[0, "initial.part1.body"]];
  const diagnostics = validateDataset(incomplete.raw, incomplete.classes).diagnostics;
  expect(diagnostics.some((item) => item.message === "missing shape 1")).toBe(true);
  expect(diagnostics.some((item) => item.message === "missing required region medial.part1.vertical")).toBe(
    true,
  );

  const unmatched = fixture();
  unmatched.classes.classifications.나 = [[0, "initial.part1.body"]];
  expect(
    validateDataset(unmatched.raw, unmatched.classes).diagnostics.some(
      (item) => item.code === "classification.extra",
    ),
  ).toBe(true);
});

test("optional extraction provenance must contain valid hashes and matching metrics", () => {
  const { raw, classes } = fixture();
  raw.provenance = provenance();
  expect(validateDataset(raw, classes).diagnostics.some((item) => item.code === "raw.provenance")).toBe(
    false,
  );
  raw.provenance.sourceFingerprint = "invalid";
  expect(validateDataset(raw, classes).diagnostics.some((item) => item.code === "raw.provenance")).toBe(true);
  raw.provenance = provenance();
  raw.provenance.fontMetrics.unitsPerEm = 1000;
  expect(validateDataset(raw, classes).diagnostics.some((item) => item.code === "raw.provenance")).toBe(true);
});

test("source fingerprints are deterministic, path-aware, and sensitive to input content", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-source-"));
  try {
    writeFileSync(join(directory, "a"), "one");
    writeFileSync(join(directory, "b"), "two");
    expect(fingerprintSource(directory, ["b", "a"])).toBe(fingerprintSource(directory, ["a", "b"]));
    const original = fingerprintSource(directory, ["a", "b"]);
    writeFileSync(join(directory, "b"), "changed");
    expect(fingerprintSource(directory, ["a", "b"])).not.toBe(original);
    writeFileSync(join(directory, "c"), "one");
    expect(fingerprintSource(directory, ["a"])).not.toBe(fingerprintSource(directory, ["c"]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the complete checked-in glyph data remains valid", () => {
  const { raw, classifications } = decodeGlyphSource(
    JSON.parse(readFileSync(join(root, "data/glyphs.json"), "utf8")),
  );
  const report = validateDataset(raw, { version: 1, classifications });
  expect(report).toEqual({
    valid: true,
    complete: true,
    expectedGlyphs: 11223,
    sourceGlyphs: 11223,
    validGlyphs: 11223,
    contours: 104276,
    diagnostics: [],
  });
});
