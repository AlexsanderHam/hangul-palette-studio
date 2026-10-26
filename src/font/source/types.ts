/**
 * Production glyph source formats, independent of the Studio workspace.
 *
 * data/glyphs.json stores contours, final semantic regions and paint order by
 * character. Compact geometry and assignments below are compiler inputs;
 * data/.studio/project.json stores only palette history and workspace state.
 */

export interface GlyphContour {
  /** Stable index in the original source, independent of paint order. */
  id: number;
  region: string;
  path: string;
  /** Control-point bounds in the original source coordinate system. */
  bounds: { width: number; height: number; centerX: number; centerY: number };
}

export interface SourceGlyph {
  /** Override only when different from metrics.defaultAdvanceWidth. */
  advanceWidth?: number;
  /** Bottom-most first. Reordering contours changes paint order, never their ids. */
  contours: GlyphContour[];
}

/** Human-readable source document used for extraction and font releases. */
export interface GlyphSourceDocument {
  format: "hangul-palette-source";
  version: 1;
  metrics: { unitsPerEm: number; viewportAscender: number; defaultAdvanceWidth: number };
  provenance?: SourceProvenance;
  glyphs: Record<string, SourceGlyph>;
}

/** One contour with its pre-computed bounding-box metadata. */
export type CompactShape = [d: string, w: number, h: number, cx: number, cy: number];

/** A glyph: char + advance width + its contours. */
export type CompactSyllable = [char: string, width: number, shapes: CompactShape[]];

/**
 * A group of glyphs sharing the same medial/final pair.
 * Standalone jamo use medialIdx = -1, with finalIdx encoding the subgroup:
 * `0` = consonants (ㄱ..ㅎ), `1` = vowels (ㅏ..ㅣ).
 */
export type CompactSet = [medialIdx: number, finalIdx: number, syllables: CompactSyllable[]];

/** Internal compact geometry consumed by extraction and the font compiler. */
export interface GlyphGeometry {
  /** Schema version. Current: 1. */
  version?: number;
  /** Pretendard units-per-em (font metric). */
  upm: number;
  /** Source-mask viewport origin in upm units. */
  asc: number;
  /** All 588 syllable sets (21 medials × 28 finals) plus the 2 standalone-jamo sets. */
  sets: CompactSet[];
  /** Optional provenance recorded by verified extraction. */
  provenance?: SourceProvenance;
}

/** Ordered source contour IDs and final semantic region IDs; unassigned is a draft value. */
export type ContourAssignments = [contourId: number, regionId: string][];

/** Final semantic assignments keyed by character. Array order is paint order. */
export type GlyphAssignments = Record<string, ContourAssignments>;

/** Recorded only when extraction verifies the actual source checkout. */
export interface SourceProvenance {
  repository: string;
  ref: string;
  revision: string;
  sourceFingerprint: string;
  fingerprintAlgorithm: "sha256-path-length-content-v1";
  fontInfoSha256: string;
  licenseSha256: string;
  master: { id: string; weight: number; name: string };
  /** Named static instance, interpolated from the exact source axis coordinates.
   * `master` remains the Regular reference master for compatible contour indexes. */
  instance?: {
    name: string;
    weight: number;
    masters: { id: string; weight: number; factor: number }[];
  };
  fontMetrics: { unitsPerEm: number; ascender: number | null; descender: number | null };
  geometryBounds: "control-points";
  viewportAscender: number;
  extractorVersion: number;
}
