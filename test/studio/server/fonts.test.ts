import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ColorFontExportError,
  type FontBuild as CompiledFontBuild,
  type FontBuildOptions,
} from "../../../src/font/build.ts";
import { decodeGlyphSource } from "../../../src/font/source/document.ts";
import { FONT_WEIGHTS, type FontWeightFiles } from "../../../src/font/weights.ts";
import { atomicWrite } from "../../../src/shared/atomic-file.ts";
import type {
  ColorFontPackageJob,
  ColorFontStatusResponse,
  FontPreparation,
  SessionResponse,
  StudioSnapshot,
} from "../../../src/studio/protocol.ts";
import type { FontEngine } from "../../../src/studio/server/fonts.ts";
import { type StudioServerOptions, startStudioServer } from "../../../src/studio/server/server.ts";
import { StudioStore } from "../../../src/studio/server/store.ts";
import { studioFixture } from "../../helpers/studio.ts";

const fonts = Object.fromEntries(
  FONT_WEIGHTS.map(({ id, value }) => [id, new Uint8Array([0x77, 0x4f, 0x46, 0x32, value / 100])]),
) as FontWeightFiles;
const compiled = (id = "immutable-build"): CompiledFontBuild => ({
  id,
  fonts,
  glyphCount: 11223,
  slotCount: 20,
});
function engine(overrides: Partial<FontEngine> = {}): FontEngine {
  return {
    status: async () => ({
      ready: true,
      code: "ready",
      message: "Ready",
      setupCommand: "bun run setup:font",
    }),
    build: async () => compiled(),
    package: async (input) => ({
      zip: new TextEncoder().encode(
        JSON.stringify({ buildId: input.build.id, project: input.project, palette: input.palette }),
      ),
      fonts: input.build.fonts,
      filename: `hangul-palette-rev-${input.project.revision}.zip`,
      manifest: {} as never,
      glyphCount: 11223,
      slotCount: 20,
    }),
    ...overrides,
  };
}
type Instance = Awaited<ReturnType<typeof startStudioServer>>;
async function usingServer(
  fontEngine: FontEngine,
  run: (
    instance: Instance,
    base: string,
    session: SessionResponse,
    fixture: Awaited<ReturnType<typeof studioFixture>>,
  ) => Promise<void>,
  options: Partial<StudioServerOptions> = {},
) {
  const fixture = await studioFixture();
  let instance: Instance | undefined;
  try {
    instance = await startStudioServer({ ...fixture, port: 0, fontEngine, ...options });
    const base = `http://127.0.0.1:${instance.server.port}`;
    const session = (await (await fetch(`${base}/api/session`)).json()) as SessionResponse;
    await run(instance, base, session, fixture);
  } finally {
    await instance?.stop();
    await fixture.cleanup();
  }
}
function get(base: string, path: string, token: string) {
  return fetch(base + path, { headers: { "X-Studio-Token": token } });
}
function post(base: string, path: string, token: string, value: unknown = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: { "X-Studio-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
async function prepare(base: string, token: string): Promise<FontPreparation> {
  const response = await post(base, "/api/color-font/prepare", token);
  expect(response.status).toBe(202);
  return (await response.json()).build;
}
async function finished<T extends FontPreparation | ColorFontPackageJob>(
  base: string,
  token: string,
  group: "builds" | "packages",
  id: string,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await get(base, `/api/color-font/${group}/${id}`, token);
    expect(response.status).toBe(200);
    const body = await response.json();
    const value = (group === "builds" ? body.build : body.job) as T;
    if (value.status !== "building") return value;
    await Bun.sleep(1);
  }
  throw new Error("Font test job did not finish");
}
async function readyBuild(base: string, token: string): Promise<FontPreparation> {
  return finished<FontPreparation>(base, token, "builds", (await prepare(base, token)).id);
}
function packageBody(snapshot: StudioSnapshot, buildId: string | null) {
  return { buildId, projectId: snapshot.projectId, expectedRevision: snapshot.revision };
}
async function packageJob(
  base: string,
  session: SessionResponse,
  build: FontPreparation,
  snapshot = session.snapshot,
) {
  const response = await post(
    base,
    "/api/color-font/packages",
    session.token,
    packageBody(snapshot, build.buildId),
  );
  expect(response.status).toBe(202);
  return finished<ColorFontPackageJob>(base, session.token, "packages", (await response.json()).job.id);
}
async function savePalette(
  base: string,
  session: SessionResponse,
  snapshot: StudioSnapshot,
  color = "#abcdef",
) {
  await post(base, "/api/lease", session.token, { clientId: "font-test" });
  const response = await post(base, "/api/command", session.token, {
    type: "palette",
    colors: snapshot.fontPalette.map(() => color),
    projectId: snapshot.projectId,
    expectedRevision: snapshot.revision,
    commandId: crypto.randomUUID(),
    clientId: "font-test",
  });
  expect(response.status).toBe(200);
  return (await response.json()).snapshot as StudioSnapshot;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("font preparation and packages require the local session and status does not compile", async () => {
  let builds = 0;
  await usingServer(
    engine({
      build: async () => {
        builds++;
        return compiled();
      },
    }),
    async (_instance, base, session) => {
      for (const path of [
        "/api/color-font/status",
        "/api/color-font/builds/missing",
        "/api/color-font/packages/missing",
      ])
        expect((await fetch(base + path)).status).toBe(401);
      for (const path of ["/api/color-font/prepare", "/api/color-font/packages"])
        expect((await post(base, path, "wrong")).status).toBe(401);
      const status = (await (
        await get(base, "/api/color-font/status", session.token)
      ).json()) as ColorFontStatusResponse;
      expect(status).toMatchObject({
        sourceId: expect.any(String),
        build: null,
        coverage: { glyphCount: 2, expectedGlyphs: 11223 },
      });
      expect(status.slots).toHaveLength(20);
      expect(builds).toBe(0);
      expect((await post(base, "/api/color-font/jobs", session.token)).status).toBe(404);
    },
  );
});

test("read-only preparation needs no palette revision, editing lease or workspace files", async () => {
  let input: FontBuildOptions | undefined;
  await usingServer(
    engine({
      build: async (value) => {
        input = value;
        return compiled();
      },
    }),
    async (_instance, base, session, fixture) => {
      const build = await readyBuild(base, session.token);
      expect(build.status).toBe("ready");
      expect(build.buildId).toBe("immutable-build");
      expect(input!.raw).toEqual(decodeGlyphSource(JSON.parse(fixture.dataText)).raw);
      expect(input!.classifications).toEqual(decodeGlyphSource(JSON.parse(fixture.dataText)).classifications);
      expect(Object.hasOwn(input!, "project")).toBe(false);
      expect(Object.hasOwn(input!, "palette")).toBe(false);
      expect(existsSync(fixture.workspacePath)).toBe(false);
      expect((await packageJob(base, session, build)).status).toBe("ready");
      expect(existsSync(fixture.workspacePath)).toBe(false);
      expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
    },
    { readOnly: true },
  );
});

test("simultaneous tabs share one build and palette saving continues during preparation", async () => {
  const compiling = gate(),
    entered = gate(),
    runtime = gate();
  let calls = 0;
  try {
    await usingServer(
      engine({
        status: async () => {
          await runtime.promise;
          return { ready: true, code: "ready", message: "Ready", setupCommand: "bun run setup:font" };
        },
        build: async (input) => {
          calls++;
          input.onProgress?.("compiling", "extra-bold");
          entered.release();
          await compiling.promise;
          return compiled();
        },
      }),
      async (_instance, base, session) => {
        try {
          const pending = [prepare(base, session.token), prepare(base, session.token)];
          runtime.release();
          const [first, second] = await Promise.all(pending);
          await entered.promise;
          expect(first.id).toBe(second.id);
          expect(first.status).toBe("building");
          expect(calls).toBe(1);
          const snapshot = await savePalette(base, session, session.snapshot);
          expect(snapshot.revision).toBe(1);
          const progress = await (
            await get(base, `/api/color-font/builds/${first.id}`, session.token)
          ).json();
          expect(progress.build).toMatchObject({
            stage: "compiling",
            currentWeight: "extra-bold",
            sourceId: first.sourceId,
          });
          compiling.release();
          const complete = await finished<FontPreparation>(base, session.token, "builds", first.id);
          expect((await prepare(base, session.token)).id).toBe(first.id);
          expect(calls).toBe(1);
          expect((await packageJob(base, session, complete, snapshot)).palette).toEqual(snapshot.fontPalette);
        } finally {
          runtime.release();
          compiling.release();
        }
      },
    );
  } finally {
    runtime.release();
    compiling.release();
  }
});

test("palette packages reuse stable font URLs and each captures its saved colors and revision", async () => {
  let builds = 0;
  await usingServer(
    engine({
      build: async () => {
        builds++;
        return compiled();
      },
    }),
    async (_instance, base, session) => {
      const build = await readyBuild(base, session.token);
      let snapshot = session.snapshot;
      for (let index = 0; index < 5; index++) {
        snapshot = await savePalette(base, session, snapshot, `#12345${index}`);
        expect((await prepare(base, session.token)).buildId).toBe(build.buildId);
        const packaged = await packageJob(base, session, build, snapshot);
        expect(packaged).toMatchObject({
          buildId: build.buildId,
          sourceId: build.sourceId,
          revision: snapshot.revision,
          palette: snapshot.fontPalette,
          status: "ready",
        });
        expect(await (await get(base, packaged.artifact!.downloadUrl, session.token)).json()).toMatchObject({
          buildId: build.buildId,
          project: { revision: snapshot.revision },
          palette: snapshot.fontPalette,
        });
      }
      expect(builds).toBe(1);
      for (const face of build.fonts!) {
        expect((await fetch(base + face.fontUrl)).status).toBe(401);
        const response = await get(base, face.fontUrl, session.token);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(fonts[face.id]));
        expect(face.fontUrl).toContain(`/builds/${build.buildId}/fonts/`);
      }
    },
  );
});

test("packages reject malformed, foreign, stale or unprepared inputs before packaging", async () => {
  let packages = 0;
  const real = engine();
  await usingServer(
    engine({
      package: async (input) => {
        packages++;
        return real.package(input);
      },
    }),
    async (_instance, base, session) => {
      expect(
        (
          await post(
            base,
            "/api/color-font/packages",
            session.token,
            packageBody(session.snapshot, "unknown"),
          )
        ).status,
      ).toBe(409);
      const build = await readyBuild(base, session.token);
      for (const value of [
        {},
        { ...packageBody(session.snapshot, build.buildId), expectedRevision: -1 },
        { ...packageBody(session.snapshot, build.buildId), expectedRevision: "0" },
      ])
        expect((await post(base, "/api/color-font/packages", session.token, value)).status).toBe(400);
      expect(
        (
          await post(base, "/api/color-font/packages", session.token, {
            ...packageBody(session.snapshot, build.buildId),
            projectId: "foreign",
          })
        ).status,
      ).toBe(409);
      await savePalette(base, session, session.snapshot);
      const stale = await post(
        base,
        "/api/color-font/packages",
        session.token,
        packageBody(session.snapshot, build.buildId),
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: { code: "revision_conflict" },
        snapshot: { revision: 1 },
      });
      expect(packages).toBe(0);
    },
  );
});

test("a package keeps captured colors while subsequent palette changes save normally", async () => {
  const packaging = gate(),
    entered = gate();
  const real = engine();
  try {
    await usingServer(
      engine({
        package: async (input) => {
          entered.release();
          await packaging.promise;
          return real.package(input);
        },
      }),
      async (_instance, base, session) => {
        try {
          const build = await readyBuild(base, session.token);
          const response = await post(
            base,
            "/api/color-font/packages",
            session.token,
            packageBody(session.snapshot, build.buildId),
          );
          const pending = (await response.json()).job as ColorFontPackageJob;
          await entered.promise;
          const saved = await savePalette(base, session, session.snapshot);
          expect(saved.revision).toBe(1);
          expect(
            (await get(base, `/api/color-font/packages/${pending.id}/download`, session.token)).status,
          ).toBe(409);
          expect(
            (await post(base, "/api/color-font/packages", session.token, packageBody(saved, build.buildId)))
              .status,
          ).toBe(409);
          packaging.release();
          const result = await finished<ColorFontPackageJob>(base, session.token, "packages", pending.id);
          expect(result.revision).toBe(0);
          expect(result.palette).toEqual(session.snapshot.fontPalette);
          expect(await (await get(base, result.artifact!.downloadUrl, session.token)).json()).toMatchObject({
            palette: session.snapshot.fontPalette,
          });
        } finally {
          packaging.release();
        }
      },
    );
  } finally {
    packaging.release();
  }
});

test("uncertain palette writes block packages but never source-only preparation", async () => {
  let armed = false;
  const write: typeof atomicWrite = async (path, bytes) => {
    await atomicWrite(path, bytes);
    if (armed && path.endsWith("project.json")) throw new Error("uncertain sync");
  };
  await usingServer(
    engine(),
    async (_instance, base, session) => {
      await post(base, "/api/lease", session.token, { clientId: "font-test" });
      armed = true;
      const response = await post(base, "/api/command", session.token, {
        type: "palette",
        colors: session.snapshot.fontPalette.map(() => "#abcdef"),
        projectId: session.snapshot.projectId,
        expectedRevision: 0,
        commandId: "uncertain",
        clientId: "font-test",
      });
      expect(response.status).toBe(503);
      const snapshot = (await response.json()).snapshot as StudioSnapshot;
      expect(snapshot.saveConfirmed).toBe(false);
      const build = await readyBuild(base, session.token);
      expect(
        (await post(base, "/api/color-font/packages", session.token, packageBody(snapshot, build.buildId)))
          .status,
      ).toBe(503);
      armed = false;
    },
    { write },
  );
});

test("preparation bypasses an in-flight palette save while packaging still waits for its revision", async () => {
  const writing = gate(),
    entered = gate();
  let armed = false,
    packages = 0;
  const real = engine();
  const write: typeof atomicWrite = async (path, bytes) => {
    if (armed && path.endsWith("project.json")) {
      entered.release();
      await writing.promise;
    }
    await atomicWrite(path, bytes);
  };
  try {
    await usingServer(
      engine({
        package: async (input) => {
          packages++;
          return real.package(input);
        },
      }),
      async (_instance, base, session) => {
        try {
          await post(base, "/api/lease", session.token, { clientId: "font-test" });
          armed = true;
          const saving = savePalette(base, session, session.snapshot);
          await entered.promise;
          const build = await Promise.race([
            readyBuild(base, session.token),
            Bun.sleep(2000).then(() => {
              throw new Error("Font preparation waited for the palette writer");
            }),
          ]);
          expect(build.status).toBe("ready");
          const packaging = post(
            base,
            "/api/color-font/packages",
            session.token,
            packageBody(session.snapshot, build.buildId),
          );
          writing.release();
          expect((await saving).revision).toBe(1);
          const response = await packaging;
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({ error: { code: "revision_conflict" } });
          expect(packages).toBe(0);
        } finally {
          writing.release();
        }
      },
      { write },
    );
  } finally {
    writing.release();
  }
});

test("explicit preparation refreshes producer identity while status polling reuses the ready build", async () => {
  let identity = "producer-v1",
    builds = 0,
    checks = 0;
  await usingServer(
    engine({
      identity: async () => {
        checks++;
        return identity;
      },
      build: async () => {
        builds++;
        return compiled(identity);
      },
    }),
    async (_instance, base, session) => {
      const first = await readyBuild(base, session.token);
      const project = session.snapshot.projectId;
      for (let index = 0; index < 3; index++) await get(base, "/api/color-font/status", session.token);
      expect(checks).toBe(0);
      identity = "producer-v2";
      const next = await readyBuild(base, session.token);
      expect(next.buildId).not.toBe(first.buildId);
      expect(next.sourceId).toBe(first.sourceId);
      expect(builds).toBe(2);
      expect(
        (
          await post(
            base,
            "/api/color-font/packages",
            session.token,
            packageBody(session.snapshot, first.buildId),
          )
        ).status,
      ).toBe(409);
      expect((await packageJob(base, session, next)).projectId).toBe(project);
    },
  );
});

test("a missing or empty weight rejects the whole build and cannot expose partial fonts", async () => {
  let calls = 0;
  await usingServer(
    engine({
      build: async () => {
        const profile = FONT_WEIGHTS[calls++];
        if (!profile) return compiled();
        const incomplete: Partial<FontWeightFiles> = { ...fonts };
        if (profile.value % 200) incomplete[profile.id] = new Uint8Array();
        else delete incomplete[profile.id];
        return { ...compiled(), fonts: incomplete as FontWeightFiles };
      },
    }),
    async (_instance, base, session) => {
      for (const _weight of FONT_WEIGHTS) {
        expect((await readyBuild(base, session.token)).status).toBe("failed");
        for (const { id } of FONT_WEIGHTS)
          expect(
            (await get(base, `/api/color-font/builds/immutable-build/fonts/${id}.woff2`, session.token))
              .status,
          ).toBe(404);
      }
      expect((await readyBuild(base, session.token)).status).toBe("ready");
    },
  );
});

test("failed preparation retains diagnostics and can be retried", async () => {
  let calls = 0;
  await usingServer(
    engine({
      build: async () => {
        if (!calls++)
          throw new ColorFontExportError("semantic_classification", "영역을 확인하세요.", [
            { weight: "bold", char: "가", code: "region", message: "가로획 누락" },
          ]);
        return compiled();
      },
    }),
    async (_instance, base, session) => {
      expect(await readyBuild(base, session.token)).toMatchObject({
        status: "failed",
        fonts: null,
        error: { code: "semantic_classification", message: "영역을 확인하세요.\nbold · 가: 가로획 누락" },
      });
      expect((await readyBuild(base, session.token)).status).toBe("ready");
    },
  );
});

test("failed packages and altered font bytes cannot replace a previous successful download", async () => {
  let calls = 0;
  const real = engine();
  await usingServer(
    engine({
      package: async (input) => {
        calls++;
        if (calls === 2) throw new Error("Package failed");
        const result = await real.package(input);
        return calls === 3 ? { ...result, fonts: { ...result.fonts, bold: new Uint8Array([1]) } } : result;
      },
    }),
    async (_instance, base, session) => {
      const build = await readyBuild(base, session.token);
      const first = await packageJob(base, session, build);
      for (let index = 0; index < 2; index++) {
        const failed = await packageJob(base, session, build);
        expect(failed).toMatchObject({ status: "failed", artifact: null });
        expect(
          (await get(base, `/api/color-font/packages/${failed.id}/download`, session.token)).status,
        ).toBe(409);
        expect((await get(base, first.artifact!.downloadUrl, session.token)).status).toBe(200);
        expect((await get(base, build.fonts![0]!.fontUrl, session.token)).status).toBe(200);
      }
      expect((await packageJob(base, session, build)).status).toBe("ready");
    },
  );
});

test("source changes block preparation and packages instead of using stale source inputs", async () => {
  await usingServer(engine(), async (_instance, base, session, fixture) => {
    const build = await readyBuild(base, session.token);
    await writeFile(fixture.dataPath, fixture.dataText + "\n");
    for (const path of ["/api/color-font/prepare", "/api/color-font/packages"])
      expect(
        (await post(base, path, session.token, packageBody(session.snapshot, build.buildId))).status,
      ).toBe(409);
    expect((await get(base, "/api/color-font/status", session.token)).status).toBe(409);
  });
});

test("status restores the same cached build after restart and a different palette workspace", async () => {
  let cached: CompiledFontBuild | null = null;
  let builds = 0;
  const cachedEngine = engine({
    load: async () => cached,
    build: async () => {
      builds++;
      cached = compiled();
      return cached;
    },
  });
  await usingServer(cachedEngine, async (instance, base, session, fixture) => {
    const first = await readyBuild(base, session.token);
    await savePalette(base, session, session.snapshot);
    const projectBytes = await readFile(join(fixture.workspacePath, "project.json"), "utf8");
    await instance.stop();
    const restarted = await startStudioServer({
      ...fixture,
      workspacePath: join(fixture.directory, "other-workspace"),
      port: 0,
      fontEngine: cachedEngine,
    });
    try {
      const nextBase = `http://127.0.0.1:${restarted.server.port}`;
      const nextSession = (await (await fetch(`${nextBase}/api/session`)).json()) as SessionResponse;
      const status = (await (
        await get(nextBase, "/api/color-font/status", nextSession.token)
      ).json()) as ColorFontStatusResponse;
      expect(status.build).toMatchObject({
        status: "ready",
        buildId: first.buildId,
        sourceId: first.sourceId,
        fonts: first.fonts,
      });
      expect(status.build!.id).not.toBe(first.id);
      expect(nextSession.snapshot.projectId).not.toBe(session.snapshot.projectId);
      expect((await packageJob(nextBase, nextSession, status.build!)).status).toBe("ready");
      expect(builds).toBe(1);
      expect(await readFile(join(fixture.workspacePath, "project.json"), "utf8")).toBe(projectBytes);
      expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
    } finally {
      await restarted.stop();
    }
  });
});

test.each([
  "build",
  "package",
] as const)("shutdown drains an accepted %s before releasing the workspace lock", async (operation) => {
  const running = gate(),
    entered = gate();
  const real = engine();
  try {
    await usingServer(
      engine({
        build: async (input) => {
          if (operation === "build") {
            entered.release();
            await running.promise;
          }
          return real.build(input);
        },
        package: async (input) => {
          if (operation === "package") {
            entered.release();
            await running.promise;
          }
          return real.package(input);
        },
      }),
      async (instance, base, session, fixture) => {
        try {
          if (operation === "build") await prepare(base, session.token);
          else {
            const build = await readyBuild(base, session.token);
            expect(
              (
                await post(
                  base,
                  "/api/color-font/packages",
                  session.token,
                  packageBody(session.snapshot, build.buildId),
                )
              ).status,
            ).toBe(202);
          }
          await entered.promise;
          const stopping = instance.stop();
          await expect(StudioStore.open(fixture)).rejects.toMatchObject({ code: "workspace_locked" });
          running.release();
          await stopping;
          const reopened = await StudioStore.open(fixture);
          await reopened.close();
        } finally {
          running.release();
        }
      },
    );
  } finally {
    running.release();
  }
});
