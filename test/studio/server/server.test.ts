import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../../../src/shared/atomic-file.ts";
import type { SessionResponse, StudioSnapshot } from "../../../src/studio/protocol.ts";
import { startStudioServer } from "../../../src/studio/server/server.ts";
import { StudioStore } from "../../../src/studio/server/store.ts";
import { studioFixture } from "../../helpers/studio.ts";

type Instance = Awaited<ReturnType<typeof startStudioServer>>;
async function usingServer(
  run: (
    s: Instance,
    base: string,
    session: SessionResponse,
    f: Awaited<ReturnType<typeof studioFixture>>,
  ) => Promise<void>,
  readOnly = false,
) {
  const f = await studioFixture();
  let instance: Instance | undefined;
  try {
    instance = await startStudioServer({ ...f, port: 0, readOnly });
    const base = `http://127.0.0.1:${instance.server.port}`;
    const response = await fetch(`${base}/api/session`);
    expect(response.status).toBe(200);
    const session = (await response.json()) as SessionResponse;
    await run(instance, base, session, f);
  } finally {
    await instance?.stop();
    await f.cleanup();
  }
}
function post(base: string, route: string, token: string, value: unknown) {
  return fetch(base + route, {
    method: "POST",
    headers: { "X-Studio-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
function paletteCommand(snapshot: StudioSnapshot, overrides: Record<string, unknown> = {}) {
  return {
    type: "palette",
    projectId: snapshot.projectId,
    expectedRevision: snapshot.revision,
    clientId: "browser-tab",
    commandId: crypto.randomUUID(),
    colors: snapshot.fontPalette.map(() => "#123456"),
    ...overrides,
  };
}

test("local session serves the palette UI and fonts without exposing source geometry", async () => {
  await usingServer(async (_server, base, session) => {
    expect(session.token).toHaveLength(64);
    expect(session.snapshot.glyphCount).toBe(2);
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Hangul Palette Studio</title>");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const client = await fetch(`${base}/studio.js`);
    expect(client.status).toBe(200);
    expect(client.headers.get("content-type")).toContain("text/javascript");
    expect((await client.text()).length).toBeGreaterThan(0);
    const stylesheet = await fetch(`${base}/studio.css`);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    for (const route of [
      "/glyphs.json",
      "/raw-shapes.json",
      "/api/export",
      "/editor.js",
      "/editor.css",
      "/editor.html",
      "/favicon.svg",
    ]) {
      expect((await fetch(base + route, { headers: { "X-Studio-Token": session.token } })).status).toBe(404);
    }
    for (const key of ["classifications", "classificationDigest", "issues", "changedGlyphs"])
      expect(Object.hasOwn(session.snapshot, key)).toBe(false);
    expect(Object.keys(session.snapshot.source).sort()).toEqual(["baselineDigest", "rawDigest"]);
    const font = await fetch(`${base}/font.otf`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/otf");
    expect(Buffer.from(await font.arrayBuffer())).toEqual(
      await readFile(join(import.meta.dir, "../../../data/Pretendard-Regular.otf")),
    );
    expect((await fetch(`${base}/.env`)).status).toBe(404);
  });
});

test("mutation requires token, local Origin, and valid JSON", async () => {
  await usingServer(async (_server, base, session) => {
    expect((await post(base, "/api/lease", "wrong-token", { clientId: "browser-tab" })).status).toBe(401);
    expect((await post(base, "/api/lease", "é".repeat(64), { clientId: "browser-tab" })).status).toBe(401);
    const foreign = await fetch(`${base}/api/session`, { headers: { Origin: "https://outside.example" } });
    expect(foreign.status).toBe(403);
    expect((await fetch(base, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(200);
    expect((await fetch(`${base}/api/session`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(
      403,
    );
    const mutation = await fetch(`${base}/api/lease`, {
      method: "POST",
      headers: { Origin: "https://outside.example", "X-Studio-Token": session.token },
      body: JSON.stringify({ clientId: "browser-tab" }),
    });
    expect(mutation.status).toBe(403);
    expect(
      (
        await fetch(`${base}/api/lease`, {
          method: "POST",
          headers: { "X-Studio-Token": session.token },
          body: "invalid JSON",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(base, "/api/lease", session.token, { clientId: "browser-tab", takeover: "true" })).status,
    ).toBe(400);
  });
});

test("HTTP palette updates acknowledge durable state without a mutable source API", async () => {
  await usingServer(async (_server, base, session, f) => {
    expect((await post(base, "/api/lease", session.token, { clientId: "browser-tab" })).status).toBe(200);
    const request = paletteCommand(session.snapshot);
    const response = await post(base, "/api/command", session.token, request);
    expect(response.status).toBe(200);
    const saved = ((await response.json()) as { snapshot: StudioSnapshot }).snapshot;
    expect(saved.revision).toBe(1);
    expect(saved.saveConfirmed).toBe(true);
    expect(saved.fontPalette).toEqual(request.colors);
    const project = JSON.parse(await readFile(join(f.workspacePath, "project.json"), "utf8"));
    expect(project).toMatchObject({ version: 1, revision: 1, fontPalette: request.colors });
    expect(Object.hasOwn(project, "classifications")).toBe(false);
    const duplicate = await post(base, "/api/command", session.token, request);
    expect(((await duplicate.json()) as { snapshot: StudioSnapshot }).snapshot.revision).toBe(1);
    const removed = await post(base, "/api/command", session.token, {
      ...paletteCommand(saved),
      type: "edit",
      char: "가",
      entry: [],
    });
    expect(removed.status).toBe(400);
    expect(await removed.json()).toMatchObject({ error: { code: "invalid_command" } });
    expect(await readFile(f.dataPath, "utf8")).toBe(f.dataText);
  });
});

test("poll compares both project identity and revision", async () => {
  await usingServer(async (_server, base, session) => {
    const headers = { "X-Studio-Token": session.token };
    const exact = await fetch(`${base}/api/project?revision=0&projectId=${session.snapshot.projectId}`, {
      headers,
    });
    expect(((await exact.json()) as { snapshot: null }).snapshot).toBeNull();
    const different = await fetch(`${base}/api/project?revision=0&projectId=old-project`, { headers });
    expect(((await different.json()) as { snapshot: StudioSnapshot }).snapshot.projectId).toBe(
      session.snapshot.projectId,
    );
  });
});

test("stale writes return conflict plus latest snapshot and a second tab cannot write", async () => {
  await usingServer(async (_server, base, session) => {
    await post(base, "/api/lease", session.token, { clientId: "browser-tab" });
    await post(base, "/api/command", session.token, paletteCommand(session.snapshot));
    const response = await post(base, "/api/command", session.token, paletteCommand(session.snapshot));
    expect(response.status).toBe(409);
    const value = (await response.json()) as { error: { code: string }; snapshot: StudioSnapshot };
    expect(value.error.code).toBe("revision_conflict");
    expect(value.snapshot.revision).toBe(1);
    expect((await post(base, "/api/lease", session.token, { clientId: "second-tab" })).status).toBe(409);
    await post(base, "/api/lease", session.token, { clientId: "second-tab", takeover: true });
    expect((await post(base, "/api/command", session.token, paletteCommand(value.snapshot))).status).toBe(
      409,
    );
  });
});

test("read-only HTTP server previews without runtime files or mutation rights", async () => {
  await usingServer(async (_server, base, session, f) => {
    expect(session.snapshot.readOnly).toBe(true);
    expect(existsSync(f.workspacePath)).toBe(false);
    expect((await post(base, "/api/lease", session.token, { clientId: "browser-tab" })).status).toBe(403);
    expect((await post(base, "/api/command", session.token, paletteCommand(session.snapshot))).status).toBe(
      403,
    );
    expect((await fetch(`${base}/api/export`, { headers: { "X-Studio-Token": session.token } })).status).toBe(
      404,
    );
    expect(existsSync(f.workspacePath)).toBe(false);
  }, true);
});

test("shutdown drains an accepted durable write before releasing its workspace lock", async () => {
  const f = await studioFixture();
  let instance: Instance | undefined;
  let armed = false,
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const write: typeof atomicWrite = async (path, value) => {
    if (armed && path.endsWith("project.json")) {
      entered();
      await gate;
    }
    await atomicWrite(path, value);
  };
  try {
    instance = await startStudioServer({ ...f, port: 0, write });
    const base = `http://127.0.0.1:${instance.server.port}`;
    const session = (await (await fetch(`${base}/api/session`)).json()) as SessionResponse;
    await post(base, "/api/lease", session.token, { clientId: "browser-tab" });
    armed = true;
    const request = post(base, "/api/command", session.token, paletteCommand(session.snapshot));
    await writing;
    const stopping = instance.stop();
    await expect(StudioStore.open(f)).rejects.toMatchObject({ code: "workspace_locked" });
    release();
    expect((await request).status).toBe(200);
    await stopping;
    const reopened = await StudioStore.open(f);
    try {
      expect(reopened.revision).toBe(1);
    } finally {
      await reopened.close();
    }
  } finally {
    release();
    await instance?.stop();
    await f.cleanup();
  }
});
