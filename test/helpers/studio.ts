import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGlyphSource,
  decodeGlyphSource,
  serializeGlyphSource,
} from "../../src/font/source/document.ts";
import type { CompactShape, GlyphAssignments, GlyphGeometry } from "../../src/font/source/types.ts";
import type { StudioCommand } from "../../src/studio/protocol.ts";
import type { StudioStore } from "../../src/studio/server/store.ts";

export async function studioFixture() {
  const directory = await mkdtemp(join(tmpdir(), "hangul-studio-test-"));
  const shape = (x: number): CompactShape => [`M${x} 0L${x + 10} 0L${x + 10} -10Z`, 10, 10, x + 5, 5];
  const raw: GlyphGeometry = {
    version: 1,
    upm: 2896,
    asc: 2259,
    sets: [
      [0, 0, [["가", 2504, [shape(0), shape(20), shape(40)]]]],
      [0, 1, [["각", 2504, [shape(0), shape(20), shape(40), shape(60)]]]],
    ],
  };
  const classifications: GlyphAssignments = {
    가: [
      [0, "initial.part1.body"],
      [1, "medial.part1.vertical"],
      [2, "medial.part1.right-bar"],
    ],
    각: [
      [0, "initial.part1.body"],
      [1, "medial.part1.vertical"],
      [2, "medial.part1.right-bar"],
      [3, "final.part1.body"],
    ],
  };
  const dataPath = join(directory, "glyphs.json");
  const workspacePath = join(directory, "workspace");
  const data = createGlyphSource(raw, classifications);
  const dataText = serializeGlyphSource(data);
  const { rawText, baselineText } = decodeGlyphSource(data);
  await writeFile(dataPath, dataText);
  return {
    directory,
    dataPath,
    workspacePath,
    dataText,
    rawText,
    baselineText,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function command(
  store: StudioStore,
  action: Record<string, unknown>,
  clientId = "test-client",
): StudioCommand {
  return {
    projectId: store.projectId,
    clientId,
    expectedRevision: store.revision,
    commandId: crypto.randomUUID(),
    ...action,
  } as StudioCommand;
}
