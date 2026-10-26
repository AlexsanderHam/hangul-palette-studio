import { HANGUL_BASE, HANGUL_END, JAMO_END, JAMO_START } from "./hangul.ts";
import { expectedRegions, isRegionId } from "./regions.ts";

export interface Diagnostic {
  code: string;
  message: string;
  char?: string;
}
export interface ValidationReport {
  valid: boolean;
  complete: boolean;
  expectedGlyphs: number;
  sourceGlyphs: number;
  validGlyphs: number;
  contours: number;
  diagnostics: Diagnostic[];
}
const EXPECTED = HANGUL_END - HANGUL_BASE + 1 + JAMO_END - JAMO_START + 1;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function supportedChar(char: string): boolean {
  if (Array.from(char).length !== 1) return false;
  const code = char.codePointAt(0)!;
  return (code >= HANGUL_BASE && code <= HANGUL_END) || (code >= JAMO_START && code <= JAMO_END);
}

/** Accept only the absolute closed outlines emitted by the source extractor. */
function validPath(path: string): boolean {
  const tokens = path.match(/[MLCQZ]|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/gi);
  if (!tokens || tokens.join("") !== path.replace(/[\s,]/g, "") || tokens[0] !== "M") return false;
  let cursor = 0,
    open = false;
  while (cursor < tokens.length) {
    const command = tokens[cursor++]!;
    if (command === "Z") {
      if (!open) return false;
      open = false;
      continue;
    }
    if (command === "M") {
      if (open) return false;
      open = true;
    } else if (!open) return false;
    const count = command === "M" || command === "L" ? 2 : command === "Q" ? 4 : command === "C" ? 6 : -1;
    if (count < 0 || cursor + count > tokens.length) return false;
    for (let index = 0; index < count; index++) if (!Number.isFinite(Number(tokens[cursor++]!))) return false;
  }
  return !open;
}

/** Check every contour, including its final semantic region. */
export function validateContourAssignments(value: unknown, shapeCount: number): string[] {
  if (!Array.isArray(value)) return ["classification must be an array"];
  const issues: string[] = [];
  const seen = new Set<number>();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      issues.push("invalid [contourId, regionId] pair");
      continue;
    }
    const [index, region] = pair;
    if (!Number.isInteger(index) || index < 0 || index >= shapeCount) {
      issues.push(`invalid shape index ${index}`);
      continue;
    }
    if (seen.has(index)) issues.push(`duplicate shape ${index}`);
    seen.add(index);
    if (!isRegionId(region)) issues.push(`shape ${index} has invalid or unassigned region ${region}`);
  }
  for (let index = 0; index < shapeCount; index++) {
    if (!seen.has(index)) issues.push(`missing shape ${index}`);
  }
  return issues;
}

/** Strict font check: every contour and exactly the character's required final regions. */
export function validateGlyphAssignment(char: string, value: unknown, shapeCount: number): string[] {
  const issues = validateContourAssignments(value, shapeCount);
  const expected = expectedRegions(char);
  if (!expected.length) return [...issues, "unsupported glyph character"];
  if (!Array.isArray(value)) return issues;
  const assigned = new Set(
    value.filter((pair) => Array.isArray(pair) && pair.length === 2).map((pair) => pair[1]),
  );
  for (const region of expected) if (!assigned.has(region)) issues.push(`missing required region ${region}`);
  for (const region of assigned)
    if (isRegionId(region) && !expected.includes(region)) issues.push(`unexpected region ${region}`);
  return issues;
}

/** Validate source geometry, full character coverage, and assignments without reading or changing files. */
export function validateDataset(rawValue: unknown, classificationValue: unknown): ValidationReport {
  const diagnostics: Diagnostic[] = [];
  const issue = (code: string, message: string, char?: string) =>
    diagnostics.push({ code, message, ...(char ? { char } : {}) });
  let sourceGlyphs = 0,
    validGlyphs = 0,
    contours = 0;
  const seen = new Set<string>();
  const raw = object(rawValue) ? rawValue : {};
  if (raw.version !== undefined && raw.version !== 1) issue("raw.version", "raw schema version must be 1");
  if (typeof raw.upm !== "number" || !Number.isFinite(raw.upm) || raw.upm <= 0)
    issue("raw.metrics", "raw upm must be a positive finite number");
  if (typeof raw.asc !== "number" || !Number.isFinite(raw.asc))
    issue("raw.metrics", "raw asc must be a finite viewport origin");
  if (raw.provenance !== undefined) {
    const provenance = raw.provenance;
    const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (
      !object(provenance) ||
      typeof provenance.repository !== "string" ||
      typeof provenance.ref !== "string" ||
      typeof provenance.revision !== "string" ||
      !/^[a-f0-9]{40}$/.test(provenance.revision) ||
      !hash(provenance.sourceFingerprint) ||
      !hash(provenance.fontInfoSha256) ||
      !hash(provenance.licenseSha256) ||
      provenance.fingerprintAlgorithm !== "sha256-path-length-content-v1" ||
      provenance.geometryBounds !== "control-points" ||
      provenance.viewportAscender !== raw.asc ||
      !object(provenance.master) ||
      typeof provenance.master.id !== "string" ||
      typeof provenance.master.weight !== "number" ||
      !Number.isFinite(provenance.master.weight) ||
      !object(provenance.fontMetrics) ||
      provenance.fontMetrics.unitsPerEm !== raw.upm ||
      ![provenance.fontMetrics.ascender, provenance.fontMetrics.descender].every(
        (metric) => metric === null || (typeof metric === "number" && Number.isFinite(metric)),
      )
    ) {
      issue("raw.provenance", "optional source provenance has malformed hashes, master, or metrics");
    }
  }
  const classes = object(classificationValue) ? classificationValue : {};
  if (classes.version !== 1 || !object(classes.classifications))
    issue("classification.schema", "expected schema v1 envelope { version, classifications }");
  const assignments: Record<string, unknown> = object(classes.classifications) ? classes.classifications : {};
  const sets = Array.isArray(raw.sets) ? raw.sets : [];
  if (!Array.isArray(raw.sets)) issue("raw.sets", "raw sets must be an array");
  const setKeys = new Set<string>();
  for (const set of sets) {
    if (
      !Array.isArray(set) ||
      set.length !== 3 ||
      !Number.isInteger(set[0]) ||
      !Number.isInteger(set[1]) ||
      !Array.isArray(set[2])
    ) {
      issue("raw.set", "invalid [medial, final, glyphs] set");
      continue;
    }
    const [medial, final, glyphs] = set as [number, number, unknown[]];
    if (
      !(
        (medial === -1 && (final === 0 || final === 1)) ||
        (medial >= 0 && medial < 21 && final >= 0 && final < 28)
      )
    )
      issue("raw.set", `invalid set indices ${medial},${final}`);
    const setKey = `${medial}:${final}`;
    if (setKeys.has(setKey)) issue("raw.set", `duplicate set ${setKey}`);
    setKeys.add(setKey);
    for (const glyph of glyphs) {
      if (
        !Array.isArray(glyph) ||
        glyph.length !== 3 ||
        typeof glyph[0] !== "string" ||
        !supportedChar(glyph[0])
      ) {
        issue("raw.glyph", "invalid or unsupported [character, width, contours] glyph");
        continue;
      }
      const char = glyph[0],
        before = diagnostics.length;
      if (seen.has(char)) {
        issue("raw.duplicate", "duplicate source glyph", char);
        continue;
      }
      seen.add(char);
      sourceGlyphs++;
      const code = char.codePointAt(0)!;
      const expectedMedial = code >= HANGUL_BASE ? Math.floor(((code - HANGUL_BASE) % 588) / 28) : -1;
      const expectedFinal = code >= HANGUL_BASE ? (code - HANGUL_BASE) % 28 : code < 0x314f ? 0 : 1;
      if (medial !== expectedMedial || final !== expectedFinal)
        issue("raw.group", `glyph belongs to set ${expectedMedial},${expectedFinal}`, char);
      const width = glyph[1];
      if (typeof width !== "number" || !Number.isFinite(width) || width <= 0)
        issue("raw.width", "advance width must be a positive finite number", char);
      const shapes = glyph[2];
      if (!Array.isArray(shapes) || shapes.length === 0) {
        issue("raw.contours", "glyph must have contours", char);
        continue;
      }
      contours += shapes.length;
      for (let index = 0; index < shapes.length; index++) {
        const shape = shapes[index];
        if (
          !Array.isArray(shape) ||
          shape.length !== 5 ||
          typeof shape[0] !== "string" ||
          !validPath(shape[0]) ||
          shape.slice(1).some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
          shape[1] < 0 ||
          shape[2] < 0
        )
          issue("raw.contour", `contour ${index} has invalid outline path or control-point bounds`, char);
      }
      const assignment = assignments[char];
      if (assignment === undefined) {
        issue("classification.missing", "no classification", char);
        continue;
      }
      for (const message of validateGlyphAssignment(char, assignment, shapes.length))
        issue("classification.glyph", message, char);
      if (before !== diagnostics.length) continue;
      validGlyphs++;
    }
  }
  for (const char of Object.keys(assignments))
    if (!seen.has(char)) issue("classification.extra", "classification has no matching source glyph", char);
  for (const [start, end] of [
    [HANGUL_BASE, HANGUL_END],
    [JAMO_START, JAMO_END],
  ])
    for (let code = start!; code <= end!; code++) {
      const char = String.fromCodePoint(code);
      if (!seen.has(char)) issue("coverage.missing", "missing source glyph", char);
    }
  const complete = sourceGlyphs === EXPECTED && !diagnostics.some((item) => item.code === "coverage.missing");
  return {
    valid: diagnostics.length === 0,
    complete,
    expectedGlyphs: EXPECTED,
    sourceGlyphs,
    validGlyphs,
    contours,
    diagnostics,
  };
}
