import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ColorFontExportError,
  type ColorFontExportOptions,
  type ColorFontExportResult,
  type ColorFontManifest,
  type ColorFontRuntimeStatus,
  createFontEngine,
  type FontBuildOptions,
  type FontCompiler,
} from "../../src/font/build.ts";
import { FONT_COLOR_SLOTS } from "../../src/font/palette.ts";
import { decodeGlyphSource } from "../../src/font/source/document.ts";
import { sha256 } from "../../src/font/source/pretendard.ts";
import { FONT_WEIGHTS, type FontWeightFiles } from "../../src/font/weights.ts";

const source = decodeGlyphSource(
  JSON.parse(await readFile(resolve(import.meta.dir, "../../data/glyphs.json"), "utf8")),
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "hangul-font-build-"));
  directories.push(root);
  const options: FontBuildOptions = { root, raw: source.raw, classifications: source.classifications };
  let producer = "compiler-one";
  let compiled = 0;
  let verified = 0;
  let drift = false;
  const captured: ColorFontExportOptions[] = [];
  const sourceHash = (input: ColorFontExportOptions) =>
    sha256(JSON.stringify({ raw: input.raw, classifications: input.classifications }));
  const faces = {} as FontWeightFiles;
  for (const { id } of FONT_WEIGHTS) faces[id] = new Uint8Array(Buffer.from(`validated-${id}`));
  function result(input: ColorFontExportOptions): ColorFontExportResult {
    const manifest = {
      project: input.project,
      slots: FONT_COLOR_SLOTS.map((slot, index) => ({
        ...slot,
        color: input.palette?.[index] ?? slot.color,
      })),
      counts: { characters: 11223, slots: 20, weights: 9 },
    } as ColorFontManifest;
    const zip = Buffer.from(JSON.stringify({ source: sourceHash(input), manifest }));
    return {
      zip,
      manifest,
      fonts: Object.fromEntries(
        FONT_WEIGHTS.map(({ id }) => [id, new Uint8Array(faces[id])]),
      ) as FontWeightFiles,
      filename: `hangul-palette-rev-${input.project.revision}.zip`,
      glyphCount: 11223,
      slotCount: 20,
    };
  }
  const compiler: FontCompiler = {
    status: async () =>
      ({
        ready: true,
        code: "ready",
        message: "ready",
        setupCommand: "bun run setup:font",
      }) as ColorFontRuntimeStatus,
    fingerprint: async () => producer,
    compile: async (input) => {
      compiled++;
      captured.push(input);
      if (input.weightSources)
        throw new ColorFontExportError("invalid_weight_source", "custom geometry rejected");
      if (drift) producer = "compiler-changed-during-build";
      return result(input);
    },
    package: async (input) => {
      verified++;
      try {
        const previous = JSON.parse(Buffer.from(input.previous.zip).toString());
        if (previous.source !== sourceHash(input)) throw new Error("source mismatch");
      } catch {
        throw new ColorFontExportError("invalid_package", "corrupt cached package");
      }
      return result(input);
    },
  };
  return {
    root,
    options,
    compiler,
    captured,
    engine: createFontEngine(compiler),
    compiled: () => compiled,
    verified: () => verified,
    changeProducer: () => {
      producer = "compiler-two";
    },
    driftDuringBuild: () => {
      drift = true;
    },
  };
}

test("font builds deduplicate, survive engine restart and package across palettes and workspaces", async () => {
  const fixture = await setup();
  const [first, concurrent] = await Promise.all([
    fixture.engine.buildFont(fixture.options),
    fixture.engine.buildFont(fixture.options),
  ]);
  expect(first).toBe(concurrent);
  expect(fixture.compiled()).toBe(1);
  expect(fixture.captured[0]!.project.projectId).toBe("hangul-palette-font-build");
  expect(first.id).toMatch(/^[a-f0-9]{64}$/);
  const exposed = first.fonts;
  exposed.regular.fill(0);
  expect(first.fonts.regular).not.toEqual(exposed.regular);
  const restarted = createFontEngine(fixture.compiler);
  const restored = await restarted.loadFontBuild(fixture.options);
  expect(restored?.id).toBe(first.id);
  expect(fixture.verified()).toBe(1);
  const project = {
    projectId: "another-palette-workspace",
    revision: 99,
    rawDigest: "new",
    baselineDigest: "new",
  };
  const packaged = await restarted.packageFont({
    root: fixture.root,
    build: restored!,
    project,
    palette: Array(20).fill("#123456"),
  });
  expect(packaged.manifest.project).toEqual(project);
  expect(packaged.manifest.slots.every(({ color }) => color === "#123456")).toBe(true);
  expect(packaged.fonts).toEqual(first.fonts);
  expect(fixture.compiled()).toBe(1);
  expect((await restarted.buildFont(fixture.options)).id).toBe(first.id);
  expect(fixture.compiled()).toBe(1);
});

test("checksum damage and forged cache contents rebuild instead of bypassing the verifier", async () => {
  const fixture = await setup();
  const first = await fixture.engine.buildFont(fixture.options);
  const directory = join(fixture.root, ".cache/font-builds");
  const zipPath = join(directory, `${first.id}.zip`);
  const metadataPath = join(directory, `${first.id}.json`);
  await writeFile(zipPath, "truncated");
  expect(await fixture.engine.loadFontBuild(fixture.options)).toBeNull();
  await fixture.engine.buildFont(fixture.options);
  expect(fixture.compiled()).toBe(2);
  const forged = Buffer.from(JSON.stringify({ source: "another source" }));
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.bytes = forged.length;
  metadata.sha256 = sha256(forged);
  await writeFile(zipPath, forged);
  await writeFile(metadataPath, JSON.stringify(metadata));
  expect(await fixture.engine.loadFontBuild(fixture.options)).toBeNull();
  await fixture.engine.buildFont(fixture.options);
  expect(fixture.compiled()).toBe(3);
  await writeFile(metadataPath, "null");
  expect(await fixture.engine.loadFontBuild(fixture.options)).toBeNull();
  expect((await readdir(directory)).some((name) => name.startsWith(".build-"))).toBe(false);
});

test("producer changes invalidate a build and source order participates in build identity", async () => {
  const fixture = await setup();
  const first = await fixture.engine.buildFont(fixture.options);
  const changed = structuredClone(source.classifications);
  changed.가!.reverse();
  expect(await fixture.engine.fontBuildId({ ...fixture.options, classifications: changed })).not.toBe(
    first.id,
  );
  fixture.changeProducer();
  expect(await fixture.engine.loadFontBuild(fixture.options)).toBeNull();
  expect((await fixture.engine.buildFont(fixture.options)).id).not.toBe(first.id);
  expect(fixture.compiled()).toBe(2);
  await expect(
    fixture.engine.packageFont({ root: fixture.root, build: first, project: fixture.captured[0]!.project }),
  ).rejects.toMatchObject({ code: "font_producer_changed" });
});

test("producer drift cannot publish a cache and custom weight geometry cannot use one", async () => {
  const fixture = await setup();
  await fixture.engine.buildFont(fixture.options);
  const custom = { ...fixture.options, weightSources: {} as NonNullable<FontBuildOptions["weightSources"]> };
  expect(await fixture.engine.loadFontBuild(custom)).toBeNull();
  await expect(fixture.engine.buildFont(custom)).rejects.toMatchObject({ code: "invalid_weight_source" });
  expect(fixture.compiled()).toBe(2);
  const drifting = await setup();
  drifting.driftDuringBuild();
  await expect(drifting.engine.buildFont(drifting.options)).rejects.toMatchObject({
    code: "font_producer_changed",
  });
  await mkdir(join(drifting.root, ".cache/font-builds"), { recursive: true });
  expect(await readdir(join(drifting.root, ".cache/font-builds"))).toEqual([]);
});
