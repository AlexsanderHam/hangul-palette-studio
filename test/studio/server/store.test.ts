import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeGlyphSource } from "../../../src/font/source/document.ts";
import { atomicWrite } from "../../../src/shared/atomic-file.ts";
import { StudioStore, type StudioStoreOptions } from "../../../src/studio/server/store.ts";
import { command, studioFixture } from "../../helpers/studio.ts";

const FIRST_PALETTE = { type: "palette", colors: Array.from({ length: 20 }, () => "#123456") };
const SECOND_PALETTE = { type: "palette", colors: Array.from({ length: 20 }, () => "#abcdef") };

async function usingStore(
  run: (store: StudioStore, fixture: Awaited<ReturnType<typeof studioFixture>>) => Promise<void>,
  options: Partial<StudioStoreOptions> = {},
) {
  const fixture = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open({ ...fixture, ...options });
    store.claimLease("test-client");
    await run(store, fixture);
  } finally {
    await store?.close();
    await fixture.cleanup();
  }
}

test("opening and palette saves retain immutable source data outside the workspace", async () => {
  await usingStore(async (store, f) => {
    const original = store.snapshot();
    expect(Object.hasOwn(original, "classifications")).toBe(false);
    expect(Object.hasOwn(original, "issues")).toBe(false);
    expect(Object.hasOwn(original, "changedGlyphs")).toBe(false);
    const saved = await store.execute(command(store, FIRST_PALETTE));
    expect(saved.revision).toBe(1);
    expect(saved.history.canUndo).toBe(true);
    expect(saved.backups[0]?.revision).toBe(0);
    const project = JSON.parse(await readFile(join(f.workspacePath, "project.json"), "utf8"));
    expect(project.version).toBe(1);
    expect(project.revision).toBe(1);
    expect(Object.hasOwn(project, "classifications")).toBe(false);
    expect(project.history).toEqual([
      { label: "폰트 색상 수정", palette: { before: original.fontPalette, after: FIRST_PALETTE.colors } },
    ]);
    const captured = await store.capturePalette(store.projectId, store.revision);
    expect(store.fontSourceSnapshot().classifications).toEqual(
      decodeGlyphSource(JSON.parse(f.dataText)).classifications,
    );
    expect(captured.fontPalette).toEqual(saved.fontPalette);
    expect(await readFile(f.dataPath, "utf8")).toBe(f.dataText);
  });
});

test("a unified source opens a saved version 1 workspace without rewriting its bytes or history", async () => {
  const f = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(f);
    store.claimLease("test-client");
    await store.execute(command(store, FIRST_PALETTE));
    await store.execute(command(store, SECOND_PALETTE));
    await store.execute(command(store, { type: "undo" }));
    const snapshot = store.snapshot();
    await store.close();
    store = undefined;
    const projectPath = join(f.workspacePath, "project.json");
    const original = JSON.parse(await readFile(projectPath, "utf8"));
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(original.rawDigest).toBe(sha(f.rawText));
    expect(original.baselineDigest).toBe(sha(f.baselineText));
    // Whitespace belongs to the saved workspace and must survive reopening.
    const projectBytes = `${JSON.stringify(original, null, 2)}\n`;
    await writeFile(projectPath, projectBytes);
    const backupPath = join(f.workspacePath, "backups");
    const backupNames = (await readdir(backupPath)).sort();
    const backups = await Promise.all(backupNames.map((name) => readFile(join(backupPath, name), "utf8")));
    store = await StudioStore.open(f);
    expect(store.snapshot()).toEqual({ ...snapshot, lease: { ownerId: null, expiresAt: null } });
    expect(await readFile(projectPath, "utf8")).toBe(projectBytes);
    expect((await readdir(backupPath)).sort()).toEqual(backupNames);
    expect(await Promise.all(backupNames.map((name) => readFile(join(backupPath, name), "utf8")))).toEqual(
      backups,
    );
    expect(await readFile(f.dataPath, "utf8")).toBe(f.dataText);
  } finally {
    await store?.close();
    await f.cleanup();
  }
});

test("duplicate delivery is idempotent and a reused command id cannot change content", async () => {
  await usingStore(async (store) => {
    const edit = command(store, FIRST_PALETTE);
    await store.execute(edit);
    expect((await store.execute(edit)).revision).toBe(1);
    expect(store.snapshot().backups).toHaveLength(1);
    await expect(store.execute({ ...edit, type: "undo" })).rejects.toMatchObject({
      code: "command_conflict",
    });
  });
});

test("queued commands retain compare-and-swap revision checks", async () => {
  await usingStore(async (store) => {
    const first = command(store, FIRST_PALETTE),
      second = command(store, SECOND_PALETTE);
    const result = await Promise.allSettled([store.execute(first), store.execute(second)]);
    expect(result[0]!.status).toBe("fulfilled");
    expect(result[1]!.status).toBe("rejected");
    expect(store.revision).toBe(1);
  });
});

test("exclusive tab lease and project identity reject stale writers", async () => {
  await usingStore(async (store) => {
    expect(() => store.claimLease("another-tab")).toThrow();
    store.claimLease("another-tab", true);
    await expect(store.execute(command(store, FIRST_PALETTE))).rejects.toMatchObject({
      code: "lease_conflict",
    });
    await expect(
      store.execute({ ...command(store, FIRST_PALETTE, "another-tab"), projectId: "wrong-project" }),
    ).rejects.toMatchObject({ code: "project_conflict" });
    expect((await store.execute(command(store, FIRST_PALETTE, "another-tab"))).revision).toBe(1);
  });
});

test("removed source-edit commands cannot mutate classifications, project bytes or history", async () => {
  await usingStore(async (store, f) => {
    const before = store.snapshot();
    const disk = await readFile(join(f.workspacePath, "project.json"), "utf8");
    for (const entry of [
      [],
      [[0, 1]],
      [
        [0, "initial.part1.body"],
        [1, "medial.part1.vertical"],
        [2, "medial.part1.right-bar"],
      ],
    ]) {
      await expect(store.execute(command(store, { type: "edit", char: "가", entry }))).rejects.toMatchObject({
        code: "invalid_command",
      });
    }
    expect(store.snapshot()).toEqual(before);
    expect(await readFile(join(f.workspacePath, "project.json"), "utf8")).toBe(disk);
  });
});

test("unsupported commands cannot create revisions, history or backups", async () => {
  await usingStore(async (store, fixture) => {
    const before = store.snapshot();
    const disk = await readFile(join(fixture.workspacePath, "project.json"), "utf8");
    await expect(
      store.execute(command(store, { type: "unsupported-action", char: "가" })),
    ).rejects.toMatchObject({ code: "invalid_command" });
    expect(store.snapshot()).toEqual(before);
    expect(await readFile(join(fixture.workspacePath, "project.json"), "utf8")).toBe(disk);
  });
});

test("palette undo and redo retain their saved history across restarts", async () => {
  await usingStore(async (store, f) => {
    await store.execute(command(store, FIRST_PALETTE));
    await store.execute(command(store, SECOND_PALETTE));
    const undone = await store.execute(command(store, { type: "undo" }));
    expect(undone.fontPalette).toEqual(FIRST_PALETTE.colors);
    expect(undone.history.canRedo).toBe(true);
    await store.close();
    const reopened = await StudioStore.open(f);
    try {
      reopened.claimLease("test-client");
      expect(reopened.snapshot().history.canRedo).toBe(true);
      const redone = await reopened.execute(command(reopened, { type: "redo" }));
      expect(redone.fontPalette).toEqual(SECOND_PALETTE.colors);
      expect(redone.revision).toBe(4);
      expect(redone.history.canRedo).toBe(false);
      expect(JSON.parse(await readFile(join(f.workspacePath, "project.json"), "utf8")).fontPalette).toEqual(
        SECOND_PALETTE.colors,
      );
      expect(await readFile(f.dataPath, "utf8")).toBe(f.dataText);
    } finally {
      await reopened.close();
    }
  });
});

test("inconsistent palette history and duplicate command receipts refuse startup without rewriting files", async () => {
  await usingStore(async (store, fixture) => {
    const initialPalette = store.snapshot().fontPalette;
    await store.execute(command(store, FIRST_PALETTE));
    await store.execute(command(store, SECOND_PALETTE));
    await store.execute(command(store, { type: "undo" }));
    await store.close();
    const projectPath = join(fixture.workspacePath, "project.json");
    const valid = JSON.parse(await readFile(projectPath, "utf8"));
    const disconnected = structuredClone(valid);
    disconnected.history[1].palette.before = initialPalette;
    const wrongCursor = { ...valid, cursor: 0 };
    const wrongPalette = { ...valid, fontPalette: SECOND_PALETTE.colors };
    const duplicateReceipt = structuredClone(valid);
    duplicateReceipt.recentCommands[1].id = duplicateReceipt.recentCommands[0].id;
    const backupsPath = join(fixture.workspacePath, "backups");
    const backupNames = (await readdir(backupsPath)).sort();
    const backupBytes = await Promise.all(
      backupNames.map((name) => readFile(join(backupsPath, name), "utf8")),
    );
    for (const damaged of [disconnected, wrongCursor, wrongPalette, duplicateReceipt]) {
      const bytes = JSON.stringify(damaged);
      await writeFile(projectPath, bytes);
      await expect(StudioStore.open(fixture)).rejects.toMatchObject({ code: "project_load_failed" });
      expect(await readFile(projectPath, "utf8")).toBe(bytes);
      expect((await readdir(backupsPath)).sort()).toEqual(backupNames);
      expect(await Promise.all(backupNames.map((name) => readFile(join(backupsPath, name), "utf8")))).toEqual(
        backupBytes,
      );
    }
    expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
  });
});

test("history validation preserves valid hex color casing and redo state on disk", async () => {
  await usingStore(async (store, fixture) => {
    await store.execute(command(store, FIRST_PALETTE));
    await store.execute(command(store, SECOND_PALETTE));
    await store.execute(command(store, { type: "undo" }));
    await store.close();
    const path = join(fixture.workspacePath, "project.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    original.fontPalette = original.fontPalette.map((color: string) => color.toUpperCase());
    for (const item of original.history) {
      item.palette.before = item.palette.before.map((color: string) => color.toUpperCase());
      item.palette.after = item.palette.after.map((color: string) => color.toUpperCase());
    }
    const bytes = JSON.stringify(original, null, 2);
    await writeFile(path, bytes);
    const reopened = await StudioStore.open(fixture);
    try {
      expect(await readFile(path, "utf8")).toBe(bytes);
      expect(reopened.snapshot().fontPalette).toEqual(FIRST_PALETTE.colors);
      reopened.claimLease("test-client");
      expect((await reopened.execute(command(reopened, { type: "redo" }))).fontPalette).toEqual(
        SECOND_PALETTE.colors,
      );
      expect((await reopened.execute(command(reopened, { type: "undo" }))).fontPalette).toEqual(
        FIRST_PALETTE.colors,
      );
    } finally {
      await reopened.close();
    }
  });
});

test("a new palette after undo replaces only the redo branch", async () => {
  await usingStore(async (store) => {
    const initialPalette = store.snapshot().fontPalette;
    await store.execute(command(store, FIRST_PALETTE));
    await store.execute(command(store, { type: "undo" }));
    await store.execute(command(store, SECOND_PALETTE));
    expect(store.snapshot().history.canRedo).toBe(false);
    await store.execute(command(store, { type: "undo" }));
    expect(store.snapshot().fontPalette).toEqual(initialPalette);
  });
});

test("write failure leaves the last acknowledged project intact and retry keeps command id", async () => {
  const f = await studioFixture();
  let fail = false;
  let store: StudioStore | undefined;
  const write: typeof atomicWrite = async (path, value) => {
    if (fail && path.endsWith("project.json")) throw new Error("injected disk failure");
    await atomicWrite(path, value);
  };
  try {
    store = await StudioStore.open({ ...f, write });
    store.claimLease("test-client");
    const before = await readFile(join(f.workspacePath, "project.json"), "utf8");
    const edit = command(store, FIRST_PALETTE);
    fail = true;
    await expect(store.execute(edit)).rejects.toMatchObject({ code: "storage_error" });
    expect(store.revision).toBe(0);
    expect(await readFile(join(f.workspacePath, "project.json"), "utf8")).toBe(before);
    fail = false;
    expect((await store.execute(edit)).revision).toBe(1);
  } finally {
    await store?.close();
    await f.cleanup();
  }
});

test("a failure after rename must be durably retried before duplicate delivery is acknowledged", async () => {
  const f = await studioFixture();
  let armed = false;
  let writes = 0;
  let store: StudioStore | undefined;
  const write: typeof atomicWrite = async (path, value) => {
    await atomicWrite(path, value);
    if (armed && path.endsWith("project.json")) {
      writes++;
      throw new Error("injected directory sync failure");
    }
  };
  try {
    store = await StudioStore.open({ ...f, write });
    store.claimLease("test-client");
    const edit = command(store, FIRST_PALETTE);
    armed = true;
    await expect(store.execute(edit)).rejects.toMatchObject({ code: "storage_error" });
    expect(store.snapshot().saveConfirmed).toBe(false);
    expect(store.revision).toBe(1);
    await expect(store.capturePalette(store.projectId, store.revision)).rejects.toMatchObject({
      code: "storage_error",
    });
    await expect(store.execute(edit)).rejects.toMatchObject({ code: "storage_error" });
    expect(writes).toBe(2);
    armed = false;
    const saved = await store.execute(edit);
    expect(saved.revision).toBe(1);
    expect(saved.saveConfirmed).toBe(true);
  } finally {
    await store?.close();
    await f.cleanup();
  }
});

test("uncertain-save retry refuses to replace externally changed project bytes", async () => {
  const f = await studioFixture();
  let armed = false;
  let store: StudioStore | undefined;
  const write: typeof atomicWrite = async (path, value) => {
    await atomicWrite(path, value);
    if (armed && path.endsWith("project.json")) throw new Error("uncertain save");
  };
  try {
    store = await StudioStore.open({ ...f, write });
    store.claimLease("test-client");
    const edit = command(store, FIRST_PALETTE);
    armed = true;
    await expect(store.execute(edit)).rejects.toMatchObject({ code: "storage_error" });
    await writeFile(join(f.workspacePath, "project.json"), "external contents");
    armed = false;
    await expect(store.execute(edit)).rejects.toMatchObject({ code: "external_change" });
    expect(await readFile(join(f.workspacePath, "project.json"), "utf8")).toBe("external contents");
  } finally {
    await store?.close();
    await f.cleanup();
  }
});

test("source changes during a session cannot silently mix glyph projects", async () => {
  await usingStore(async (store, f) => {
    await writeFile(f.dataPath, f.dataText + "\n");
    await expect(store.execute(command(store, FIRST_PALETTE))).rejects.toMatchObject({
      code: "source_mismatch",
    });
    await expect(store.capturePalette(store.projectId, store.revision)).rejects.toMatchObject({
      code: "source_mismatch",
    });
    expect(store.revision).toBe(0);
  });
});

test("backup restoration is a new undoable revision", async () => {
  await usingStore(async (store) => {
    const initialPalette = store.snapshot().fontPalette;
    await store.execute(command(store, FIRST_PALETTE));
    const backup = store.snapshot().backups[0]!;
    await store.execute(command(store, { type: "restore", backupId: backup.id }));
    expect(store.revision).toBe(2);
    expect(store.snapshot().fontPalette).toEqual(initialPalette);
    await store.execute(command(store, { type: "undo" }));
    expect(store.snapshot().fontPalette).toEqual(FIRST_PALETTE.colors);
    await expect(
      store.execute(command(store, { type: "restore", backupId: "../../outside" })),
    ).rejects.toMatchObject({ code: "invalid_backup" });
  });
});

test("corrupt project refuses startup, explicit recovery preserves damaged bytes", async () => {
  const f = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(f);
    store.claimLease("test-client");
    const oldId = store.projectId;
    const initialPalette = store.snapshot().fontPalette;
    await store.execute(command(store, FIRST_PALETTE));
    await store.close();
    await writeFile(join(f.workspacePath, "project.json"), "damaged contents");
    await expect(StudioStore.open(f)).rejects.toMatchObject({ code: "project_load_failed" });
    store = await StudioStore.open({ ...f, recover: "latest" });
    expect(store.projectId).not.toBe(oldId);
    expect(store.snapshot().fontPalette).toEqual(initialPalette);
    const damaged = (await readdir(f.workspacePath)).find((file) => file.startsWith("damaged-"))!;
    expect(await readFile(join(f.workspacePath, damaged), "utf8")).toBe("damaged contents");
    expect(await readFile(f.dataPath, "utf8")).toBe(f.dataText);
  } finally {
    await store?.close();
    await f.cleanup();
  }
});

test("unsupported workspace versions refuse startup without changing the project or backups", async () => {
  const f = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(f);
    store.claimLease("test-client");
    await store.execute(command(store, FIRST_PALETTE));
    await store.close();
    store = undefined;

    const projectPath = join(f.workspacePath, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.version = 99;
    const unsupportedBytes = JSON.stringify(project);
    await writeFile(projectPath, unsupportedBytes);
    const backupPath = join(f.workspacePath, "backups");
    const backupNames = (await readdir(backupPath)).sort();
    const backupBytes = await Promise.all(
      backupNames.map((name) => readFile(join(backupPath, name), "utf8")),
    );

    await expect(StudioStore.open(f)).rejects.toMatchObject({
      code: "project_load_failed",
      message: expect.stringContaining("version 1 형식만 지원"),
    });
    expect(await readFile(projectPath, "utf8")).toBe(unsupportedBytes);
    expect((await readdir(backupPath)).sort()).toEqual(backupNames);
    expect(await Promise.all(backupNames.map((name) => readFile(join(backupPath, name), "utf8")))).toEqual(
      backupBytes,
    );
    expect(await readFile(f.dataPath, "utf8")).toBe(f.dataText);
  } finally {
    await store?.close();
    await f.cleanup();
  }
});

test("read-only mode never creates runtime files and follows a writable server", async () => {
  const f = await studioFixture();
  let reader: StudioStore | undefined, writer: StudioStore | undefined;
  try {
    reader = await StudioStore.open({ ...f, readOnly: true });
    expect(existsSync(f.workspacePath)).toBe(false);
    expect(() => reader!.claimLease("test-client")).toThrow();
    await expect(reader.execute(command(reader, FIRST_PALETTE))).rejects.toMatchObject({ code: "read_only" });
    await reader.close();
    writer = await StudioStore.open(f);
    writer.claimLease("test-client");
    reader = await StudioStore.open({ ...f, readOnly: true });
    await writer.execute(command(writer, FIRST_PALETTE));
    await reader.refreshReadOnly();
    expect(reader.revision).toBe(1);
  } finally {
    await reader?.close();
    await writer?.close();
    await f.cleanup();
  }
});

test("same workspace rejects a second writer and releases lock on close", async () => {
  const f = await studioFixture();
  let store: StudioStore | undefined;
  try {
    store = await StudioStore.open(f);
    await expect(StudioStore.open(f)).rejects.toMatchObject({ code: "workspace_locked" });
    await store.close();
    store = await StudioStore.open(f);
    expect(store.revision).toBe(0);
  } finally {
    await store?.close();
    await f.cleanup();
  }
});

test("OS-owned workspace lock is released after SIGKILL without deleting any lock file", async () => {
  const f = await studioFixture();
  let child: ReturnType<typeof Bun.spawn> | undefined, store: StudioStore | undefined;
  try {
    const script = `
import {StudioStore} from ${JSON.stringify(resolve(import.meta.dir, "../../../src/studio/server/store.ts"))};
const store = await StudioStore.open(JSON.parse(process.argv[1]));
// Keep the owning store alive, as the HTTP server's request handler does.
setInterval(() => store.leaseInfo(), 1000);
Bun.gc(true);
console.log('locked');
`;
    child = Bun.spawn(
      [
        process.execPath,
        "-e",
        script,
        JSON.stringify({ dataPath: f.dataPath, workspacePath: f.workspacePath }),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    reader.releaseLock();
    await expect(StudioStore.open(f)).rejects.toMatchObject({ code: "workspace_locked" });
    child.kill("SIGKILL");
    await child.exited;
    child = undefined;
    expect(existsSync(join(f.workspacePath, ".write-lock.sqlite"))).toBe(true);
    store = await StudioStore.open(f);
    expect(store.revision).toBe(0);
  } finally {
    child?.kill("SIGKILL");
    if (child) await child.exited;
    await store?.close();
    await f.cleanup();
  }
}, 10_000);

test("compiler captures are isolated copies of the immutable baseline", async () => {
  await usingStore(async (store, fixture) => {
    const before = store.snapshot();
    const captured = store.fontSourceSnapshot();
    const palette = await store.capturePalette(store.projectId, store.revision);
    const baseline = decodeGlyphSource(JSON.parse(fixture.dataText)).classifications;
    expect(captured.classifications).toEqual(baseline);
    captured.classifications.가![0]![1] = "unassigned";
    palette.fontPalette[0] = "#000000";
    const next = store.fontSourceSnapshot();
    expect(next.classifications).toEqual(baseline);
    expect((await store.capturePalette(store.projectId, store.revision)).fontPalette).toEqual(
      before.fontPalette,
    );
    expect(store.snapshot()).toEqual(before);
    expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
  });
});

test("version 1 workspaces reject mutable classification fields and shape history", async () => {
  await usingStore(async (store, fixture) => {
    const original = JSON.parse(await readFile(join(fixture.workspacePath, "project.json"), "utf8"));
    expect(() => store.validateProject({ ...original, classifications: {} })).toThrow();
    expect(() =>
      store.validateProject({ ...original, history: [{ label: "old edit", changes: {} }], cursor: 1 }),
    ).toThrow();
    expect(() =>
      store.validateProject({
        ...original,
        history: [
          {
            label: "old mixed edit",
            changes: {},
            palette: { before: original.fontPalette, after: FIRST_PALETTE.colors },
          },
        ],
        cursor: 1,
      }),
    ).toThrow();
  });
});

test("palette-only Studio refuses incomplete or incorrect immutable source regions before creating runtime files", async () => {
  for (const region of ["unassigned", "final.part1.body"]) {
    const fixture = await studioFixture();
    try {
      const data = JSON.parse(fixture.dataText);
      data.glyphs.가.contours[0].region = region;
      const bytes = JSON.stringify(data);
      await writeFile(fixture.dataPath, bytes);
      await expect(StudioStore.open(fixture)).rejects.toMatchObject({ code: "invalid_data" });
      expect(await readFile(fixture.dataPath, "utf8")).toBe(bytes);
      expect(existsSync(fixture.workspacePath)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }
});
