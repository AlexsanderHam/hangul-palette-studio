import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ColorFontManifest } from "../src/font/build.ts";
import { FONT_COLOR_SLOTS } from "../src/font/palette.ts";
import { sha256 } from "../src/font/source/pretendard.ts";
import { FONT_VERSION, FONT_WEIGHTS, type FontWeightFiles } from "../src/font/weights.ts";
import {
  createReleaseFiles,
  GENERATED_RELEASE_PATHS,
  inspectReleaseDestination,
  type ReleaseProvenance,
  releaseProvenance,
  writeReleaseFiles,
} from "../src/release.ts";

const directories: string[] = [];
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), "hangul-palette-release-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("release provenance follows the font compiler and source in the unified source tree", async () => {
  const root = await temporary();
  await mkdir(join(root, "src/font/compiler"), { recursive: true });
  await mkdir(join(root, "src/font/source"), { recursive: true });
  await mkdir(join(root, "src/studio/client"), { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "hangul-palette-studio", version: "1.0.0" }),
  );
  await writeFile(join(root, "bun.lock"), "locked dependencies");
  await writeFile(join(root, "src/font/compiler/export.py"), "compiler version one");
  await writeFile(join(root, "src/font/source/document.ts"), "source document loader");
  await writeFile(join(root, "src/studio/client/index.html"), "Studio page");
  await writeFile(join(root, "src/studio/client/studio.css"), "Studio styles");
  await writeFile(join(root, "bin/release.ts"), "release command");
  const data = new TextEncoder().encode("production glyph source");
  const first = await releaseProvenance(root, data);
  expect(first.inputs.dataFileSha256).toBe(sha256(data));
  expect(Object.keys(first.studio.files)).toEqual([
    "bin/release.ts",
    "bun.lock",
    "package.json",
    "src/font/compiler/export.py",
    "src/font/source/document.ts",
    "src/studio/client/index.html",
    "src/studio/client/studio.css",
  ]);
  await writeFile(join(root, "src/font/compiler/export.py"), "compiler version two");
  const changed = await releaseProvenance(root, data);
  expect(changed.studio.sourceSha256).not.toBe(first.studio.sourceSha256);
  expect(changed.inputs).toEqual(first.inputs);
});

const bytes = (value: string) => new TextEncoder().encode(value);
function fixture() {
  const fonts = Object.fromEntries(
    FONT_WEIGHTS.map(({ id }) => [id, bytes(`validated-font-${id}`)]),
  ) as FontWeightFiles;
  const manifest = {
    schemaVersion: 1,
    family: "Hangul Palette",
    format: "hangul-palette-color-font-v1",
    fontFormat: "WOFF2 / CFF / COLR v1 with v0 fallback / CPAL v0",
    fontVersion: FONT_VERSION,
    complete: true,
    project: { projectId: "baseline", revision: 0 },
    counts: { weights: 9, characters: 11223 },
    slots: structuredClone(FONT_COLOR_SLOTS),
    inputs: { selection: "studio-working-snapshot" },
    weights: FONT_WEIGHTS.map(({ id, label, value, file }) => ({
      id,
      label,
      weight: value,
      fontFile: file,
      inputs: { selection: "studio-working-snapshot" },
    })),
    files: Object.fromEntries(
      FONT_WEIGHTS.map(({ id, file }) => [file, { bytes: fonts[id].length, sha256: sha256(fonts[id]) }]),
    ),
  } as unknown as ColorFontManifest;
  const validation = {
    schemaVersion: 1,
    passed: true,
    weights: Object.fromEntries(
      FONT_WEIGHTS.map(({ id }) => [id, { passed: true, fontSha256: sha256(fonts[id]) }]),
    ),
  };
  const provenance: ReleaseProvenance = {
    studio: {
      name: "hangul-palette-studio",
      version: "1.0.0",
      revision: null,
      sourceSha256: "a".repeat(64),
      files: {},
    },
    inputs: { dataFileSha256: "b".repeat(64), palette: "contract-default" },
  };
  const build = () =>
    createReleaseFiles(
      { fonts, manifest },
      validation,
      bytes("license\n"),
      "See LICENSE-OFL.\n",
      FONT_VERSION,
      provenance,
    );
  return { fonts, manifest, validation, build };
}

describe("public distribution", () => {
  test("public paths and hashes describe the rewritten CSS and all nine untouched fonts", () => {
    const { fonts, manifest: original, build } = fixture();
    const files = build();
    const manifest = JSON.parse(new TextDecoder().decode(files["metadata/manifest.json"]));
    expect(manifest.version).toBe(FONT_VERSION);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.format).toBe("hangul-palette-color-font-v1");
    expect(manifest.fontFormat).toBe("WOFF2 / CFF / COLR v1 with v0 fallback / CPAL v0");
    expect(manifest.provenance.studio.version).toBe("1.0.0");
    expect(manifest.inputs.selection).toBe("checked-in-baseline");
    expect(original.inputs.selection).toBe("studio-working-snapshot");
    expect(manifest.license.file).toBe("LICENSE");
    const expectedPaths = [
      ...FONT_WEIGHTS.map(({ id }) => `fonts/hangul-palette-${id}.woff2`),
      "css/hangul-palette.css",
      "metadata/manifest.json",
      "metadata/validation.json",
      "LICENSE",
      "NOTICE",
    ];
    expect(Object.keys(files).sort()).toEqual([...expectedPaths].sort());
    expect([...GENERATED_RELEASE_PATHS].sort()).toEqual([...expectedPaths].sort());
    expect(Object.keys(files)).toHaveLength(14);
    expect(Object.keys(manifest.files)).toHaveLength(13);
    expect(files["manifest.json"]).toBeUndefined();
    expect(files["validation.json"]).toBeUndefined();
    expect(manifest.files["validation.json"]).toBeUndefined();
    expect(files["css/palettes.css"]).toBeUndefined();
    expect(manifest.files["css/palettes.css"]).toBeUndefined();
    for (const [name, entry] of Object.entries(manifest.files) as [
      string,
      { bytes: number; sha256: string },
    ][]) {
      expect(files[name]?.length).toBe(entry.bytes);
      expect(sha256(files[name]!)).toBe(entry.sha256);
    }
    for (const { id } of FONT_WEIGHTS) expect(files[`fonts/hangul-palette-${id}.woff2`]).toEqual(fonts[id]);
    const css = new TextDecoder().decode(files["css/hangul-palette.css"]);
    expect([...css.matchAll(/@font-face\s*\{/g)]).toHaveLength(9);
    expect([...css.matchAll(/url\(/g)]).toHaveLength(9);
    for (const { id, value } of FONT_WEIGHTS) {
      expect(css).toContain(`../fonts/hangul-palette-${id}.woff2`);
      expect(css).toMatch(new RegExp(`font-weight:\\s*${value}\\s*;`));
    }
    expect(css).toContain("../fonts/hangul-palette-regular.woff2");
    const baseClass = css.match(/\.hangul-palette\s*\{([^}]+)\}/)?.[1];
    expect(baseClass).toMatch(/font-family:\s*"Hangul Palette"\s*,\s*sans-serif\s*;/);
    expect(baseClass).toMatch(/font-synthesis:\s*none\s*;/);
    expect(baseClass).toMatch(/font-palette:\s*normal\s*;/);
    expect([...css.matchAll(/@font-palette-values\s+/g)]).toHaveLength(3);
    for (const name of ["--hangul-palette", "--hangul-palette-gray", "--hangul-palette-roles"]) {
      expect(css).toMatch(new RegExp(`@font-palette-values\\s+${name}\\s*\\{`));
    }
    for (const [, , body] of css.matchAll(/@font-palette-values\s+([-\w]+)\s*\{([^}]+)\}/g)) {
      expect(body).toMatch(/font-family:\s*"Hangul Palette"\s*;/);
      expect(body).toMatch(/base-palette:\s*0\s*;/);
      const colors = body!.match(/override-colors:\s*([^;]+);/)?.[1];
      expect([...colors!.matchAll(/\b\d+\s+#[a-f0-9]+/gi)]).toHaveLength(20);
    }
    expect(css).toMatch(/\.hangul-palette--colored\s*\{\s*font-palette:\s*--hangul-palette\s*;\s*\}/);
    expect(css.indexOf(".hangul-palette--colored")).toBeGreaterThan(css.search(/\.hangul-palette\s*\{/));
    expect(css).not.toContain("palettes.css");
    for (const { index, id, label } of FONT_COLOR_SLOTS)
      expect(css).toContain(`/* ${index}: ${id} — ${label} */`);
    expect([...css.matchAll(/\/\* \d+: /g)]).toHaveLength(20);
    expect(new TextDecoder().decode(files.NOTICE)).toBe("See LICENSE.\n");
    expect(build()).toEqual(files);
  });

  test("refuses missing, corrupted or unvalidated fonts and mismatched internal versions", () => {
    const wrongSchema = fixture();
    Object.assign(wrongSchema.manifest, { schemaVersion: 2 });
    expect(wrongSchema.build).toThrow("complete Hangul Palette export");
    const wrongReportSchema = fixture();
    wrongReportSchema.validation.schemaVersion = 2;
    expect(wrongReportSchema.build).toThrow("all nine validated fonts");
    const missing = fixture();
    delete missing.validation.weights.black;
    expect(missing.build).toThrow("all nine validated fonts");
    const failed = fixture();
    failed.validation.weights.light!.passed = false;
    expect(failed.build).toThrow("Font validation mismatch");
    const wrongReport = fixture();
    wrongReport.validation.weights.light!.fontSha256 = "0".repeat(64);
    expect(wrongReport.build).toThrow("Font validation mismatch");
    const corrupted = fixture();
    corrupted.fonts.bold = bytes("damaged");
    expect(corrupted.build).toThrow("Font digest mismatch");
    const wrongVersion = fixture();
    wrongVersion.manifest.fontVersion = "2.0.0";
    expect(wrongVersion.build).toThrow("versions must match");
  });

  test("refuses unrelated or overlapping output directories before replacing any files", async () => {
    const base = await temporary();
    const studio = join(base, "studio");
    await mkdir(studio);
    await expect(inspectReleaseDestination(studio, studio)).rejects.toThrow("separate");
    await expect(inspectReleaseDestination(join(studio, "nested"), studio)).rejects.toThrow("separate");
    await expect(inspectReleaseDestination(base, studio)).rejects.toThrow("separate");
    await expect(inspectReleaseDestination(join(base, "absent"), studio)).rejects.toThrow("existing");
    const empty = join(base, "empty");
    await mkdir(empty);
    await expect(inspectReleaseDestination(empty, studio)).rejects.toThrow("existing");
    const unrelated = join(base, "unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "LICENSE"), "do not overwrite");
    await writeFile(join(unrelated, "package.json"), JSON.stringify({ name: "hangul-palette" }));
    const files = fixture().build();
    await expect(writeReleaseFiles(unrelated, files)).rejects.toThrow("Nonempty output");
    await writeFile(join(unrelated, "manifest.json"), files["metadata/manifest.json"]!);
    await expect(writeReleaseFiles(unrelated, files)).rejects.toThrow("Nonempty output");
    await mkdir(join(unrelated, "metadata"));
    for (const marker of [
      { schemaVersion: 1, family: "Other Font", format: "hangul-palette-color-font-v1" },
      { schemaVersion: 1, family: "Hangul Palette", format: "other-format" },
      { schemaVersion: 2, family: "Hangul Palette", format: "hangul-palette-color-font-v1" },
      { family: "Hangul Palette", format: "hangul-palette-color-font-v1" },
    ]) {
      const content = JSON.stringify(marker);
      await writeFile(join(unrelated, "metadata/manifest.json"), content);
      await expect(writeReleaseFiles(unrelated, files)).rejects.toThrow("Nonempty output");
      expect(await readFile(join(unrelated, "metadata/manifest.json"), "utf8")).toBe(content);
    }
    expect(await readFile(join(unrelated, "LICENSE"), "utf8")).toBe("do not overwrite");
  });

  test("preserves the authored website and documentation and rejects unsafe output paths", async () => {
    const base = await temporary();
    const output = join(base, "hangul-palette");
    await mkdir(join(output, "metadata"), { recursive: true });
    const files = fixture().build();
    await writeFile(join(output, "metadata/manifest.json"), files["metadata/manifest.json"]!);
    const authored = {
      "README.md": "authored docs",
      "index.html": "authored website homepage",
      "glyphs.html": "authored glyph browser",
      "assets/site.css": "authored website styles",
      "assets/site.js": "authored website behavior",
      ".github/workflows/pages.yml": "authored Pages deployment workflow",
      ".git/config": "repository configuration",
    };
    for (const [name, contents] of Object.entries(authored)) {
      await mkdir(dirname(join(output, name)), { recursive: true });
      await writeFile(join(output, name), contents);
    }
    await writeReleaseFiles(output, files);
    await writeReleaseFiles(output, files);
    await expect(readFile(join(output, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const [name, contents] of Object.entries(authored))
      expect(await readFile(join(output, name), "utf8")).toBe(contents);
    expect(await readFile(join(output, "metadata/manifest.json"))).toEqual(
      Buffer.from(files["metadata/manifest.json"]!),
    );
    await expect(readFile(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(output, "validation.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(writeReleaseFiles(output, { ...files, "../escaped": bytes("no") })).rejects.toThrow(
      "Unexpected generated",
    );
    const target = join(base, "target");
    await mkdir(target);
    await symlink(output, join(base, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(inspectReleaseDestination(join(base, "linked"))).rejects.toThrow("Symlink");
    await rm(join(output, "fonts"), { recursive: true });
    await symlink(target, join(output, "fonts"), process.platform === "win32" ? "junction" : "dir");
    await expect(writeReleaseFiles(output, files)).rejects.toThrow("Symlink");
  });

  test("refuses metadata directory and file symlinks without changing their targets", async () => {
    const base = await temporary();
    const output = join(base, "hangul-palette");
    const target = join(base, "target");
    const files = fixture().build();
    await mkdir(output);
    await mkdir(target);
    const targetManifest = join(target, "manifest.json");
    const targetValidation = join(target, "validation.json");
    await writeFile(targetManifest, files["metadata/manifest.json"]!);
    await writeFile(targetValidation, "do not overwrite");

    await symlink(target, join(output, "metadata"), process.platform === "win32" ? "junction" : "dir");
    await expect(writeReleaseFiles(output, files)).rejects.toThrow("Symlink");
    await rm(join(output, "metadata"));
    await mkdir(join(output, "metadata"));

    await symlink(targetManifest, join(output, "metadata/manifest.json"), "file");
    await expect(writeReleaseFiles(output, files)).rejects.toThrow("Symlink");
    await rm(join(output, "metadata/manifest.json"));
    await writeFile(join(output, "metadata/manifest.json"), files["metadata/manifest.json"]!);

    await symlink(targetValidation, join(output, "metadata/validation.json"), "file");
    await expect(writeReleaseFiles(output, files)).rejects.toThrow("Symlink");
    expect(await readFile(targetManifest)).toEqual(Buffer.from(files["metadata/manifest.json"]!));
    expect(await readFile(targetValidation, "utf8")).toBe("do not overwrite");
    await expect(readFile(join(output, "LICENSE"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
