import type { ColorFontRuntimeStatus, ColorFontStage } from "../font/build.ts";
import type { PaletteSlot } from "../font/palette.ts";
import type { FontWeightId } from "../font/weights.ts";

/** Shared browser/server contract. A successful mutation is durably saved. */
export interface LeaseInfo {
  ownerId: string | null;
  expiresAt: number | null;
}

export interface StudioSnapshot {
  projectId: string;
  readOnly: boolean;
  saveConfirmed: boolean;
  revision: number;
  fontPalette: string[];
  glyphCount: number;
  source: { rawDigest: string; baselineDigest: string };
  history: { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
  lease: LeaseInfo;
  backups: { id: string; revision: number; savedAt: string }[];
  savedAt: string;
}

export interface SessionResponse {
  token: string;
  snapshot: StudioSnapshot;
}

export interface ProjectResponse {
  snapshot: StudioSnapshot | null;
  revision: number;
  saveConfirmed: boolean;
  lease: LeaseInfo;
}

export interface CommandBase {
  projectId: string;
  clientId: string;
  expectedRevision: number;
  commandId: string;
}

export type StudioCommand = CommandBase &
  (
    | { type: "palette"; colors: string[] }
    | { type: "undo" }
    | { type: "redo" }
    | { type: "restore"; backupId: string }
  );

export interface StudioErrorResponse {
  error: { code: string; message: string };
  snapshot?: StudioSnapshot;
}

export interface FontPreparation {
  id: string;
  buildId: string | null;
  sourceId: string;
  status: "building" | "ready" | "failed";
  startedAt: string;
  finishedAt: string | null;
  stage?: ColorFontStage;
  currentWeight?: FontWeightId;
  error: { code: string; message: string } | null;
  fonts:
    | {
        id: FontWeightId;
        label: string;
        weight: number;
        fontUrl: string;
        bytes: number;
        sha256: string;
      }[]
    | null;
}

/** A package captures one saved palette and references an immutable font build. */
export interface ColorFontPackageJob {
  id: string;
  buildId: string;
  sourceId: string;
  projectId: string;
  revision: number;
  palette: string[];
  status: "building" | "ready" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: { code: string; message: string } | null;
  artifact: {
    filename: string;
    bytes: number;
    sha256: string;
    downloadUrl: string;
  } | null;
}

export interface ColorFontStatusResponse {
  runtime: ColorFontRuntimeStatus;
  sourceId: string;
  build: FontPreparation | null;
  coverage: { glyphCount: number; expectedGlyphs: number };
  slots: PaletteSlot[];
}
