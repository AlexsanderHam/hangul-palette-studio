import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StudioStore } from "../../../src/studio/server/store.ts";
import { command, studioFixture } from "../../helpers/studio.ts";

test("palette saves, survives restart and undoes without changing the immutable font source", async () => {
  const fixture = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(fixture);
    store.claimLease("test-client");
    const before = store.snapshot();
    expect(before.fontPalette).toHaveLength(20);
    expect(before.fontPalette.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
    const colors = before.fontPalette.map((_, index) => (index % 2 ? "#ABCDEF" : "#123456"));
    const saved = await store.execute(command(store, { type: "palette", colors }));
    expect(saved.fontPalette).toEqual(colors.map((color) => color.toLowerCase()));
    expect(saved.source).toEqual(before.source);
    expect(saved.history.canUndo).toBe(true);
    const disk = JSON.parse(await readFile(join(fixture.workspacePath, "project.json"), "utf8"));
    expect(disk.fontPalette).toEqual(saved.fontPalette);
    expect(Object.hasOwn(disk, "classifications")).toBe(false);
    await store.close();
    store = await StudioStore.open(fixture);
    store.claimLease("test-client");
    expect(store.snapshot().fontPalette).toEqual(saved.fontPalette);
    expect((await store.execute(command(store, { type: "undo" }))).fontPalette).toEqual(before.fontPalette);
    expect(store.snapshot().source).toEqual(before.source);
    expect((await store.execute(command(store, { type: "redo" }))).fontPalette).toEqual(saved.fontPalette);
    expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

test("invalid palette commands cannot change the saved project", async () => {
  const fixture = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(fixture);
    store.claimLease("test-client");
    const before = store.snapshot();
    const disk = await readFile(join(fixture.workspacePath, "project.json"), "utf8");
    const colors = Array.from({ length: 20 }, () => "#123456");
    for (const invalid of [
      null,
      "#123456",
      colors.slice(1),
      [...colors, "#123456"],
      ["#123", ...colors.slice(1)],
      ["#12345678", ...colors.slice(1)],
      ["red", ...colors.slice(1)],
      ["#GG1234", ...colors.slice(1)],
      [123456, ...colors.slice(1)],
    ]) {
      await expect(store.execute(command(store, { type: "palette", colors: invalid }))).rejects.toMatchObject(
        { code: "invalid_palette" },
      );
    }
    expect(store.snapshot()).toEqual(before);
    expect(await readFile(join(fixture.workspacePath, "project.json"), "utf8")).toBe(disk);
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

test("saved version 1 projects require an explicit palette and preserve damaged bytes on failure", async () => {
  const fixture = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(fixture);
    await store.close();
    store = undefined;
    const path = join(fixture.workspacePath, "project.json");
    const project = JSON.parse(await readFile(path, "utf8"));
    expect(project.version).toBe(1);
    delete project.fontPalette;
    const originalBytes = JSON.stringify(project);
    await writeFile(path, originalBytes);
    await expect(StudioStore.open(fixture)).rejects.toMatchObject({ code: "project_load_failed" });
    expect(await readFile(path, "utf8")).toBe(originalBytes);
    expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

test("restoring a backup restores its palette as one undoable action", async () => {
  const fixture = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(fixture);
    store.claimLease("test-client");
    const original = store.snapshot();
    const colors = original.fontPalette.map((_, index) => (index % 2 ? "#123456" : "#abcdef"));
    await store.execute(command(store, { type: "palette", colors }));
    const backup = store.snapshot().backups.find((item) => item.revision === original.revision)!;
    const restored = await store.execute(command(store, { type: "restore", backupId: backup.id }));
    expect(restored.fontPalette).toEqual(original.fontPalette);
    expect(restored.source).toEqual(original.source);
    expect((await store.execute(command(store, { type: "undo" }))).fontPalette).toEqual(colors);
    const redone = await store.execute(command(store, { type: "redo" }));
    expect(redone.fontPalette).toEqual(original.fontPalette);
    expect(redone.source).toEqual(original.source);
    expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});

test("a malformed saved palette is reported rather than silently replaced by defaults", async () => {
  const fixture = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(fixture);
    await store.close();
    store = undefined;
    const path = join(fixture.workspacePath, "project.json");
    const project = JSON.parse(await readFile(path, "utf8"));
    project.fontPalette = ["#123456"];
    const damaged = JSON.stringify(project);
    await writeFile(path, damaged);
    await expect(StudioStore.open(fixture)).rejects.toMatchObject({ code: "project_load_failed" });
    expect(await readFile(path, "utf8")).toBe(damaged);
    expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
});
