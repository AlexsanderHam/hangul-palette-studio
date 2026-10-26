import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { ColorFontExportResult } from "./font/build.ts";
import { sha256 } from "./font/source/pretendard.ts";
import { FONT_VERSION, FONT_WEIGHTS } from "./font/weights.ts";

export interface ReleaseProvenance {
  studio: {
    name: "hangul-palette-studio";
    version: string;
    revision: string | null;
    sourceSha256: string;
    files: Record<string, string>;
  };
  inputs: { dataFileSha256: string; palette: "contract-default" };
}
export interface ReleaseFiles {
  [path: string]: Uint8Array;
}

const text = (value: string) => new TextEncoder().encode(value);
const json = (value: unknown) => text(JSON.stringify(value, null, 2) + "\n");
const fontPath = (id: string) => `fonts/hangul-palette-${id}.woff2`;
export const GENERATED_RELEASE_PATHS = [
  ...FONT_WEIGHTS.map(({ id }) => fontPath(id)),
  "css/hangul-palette.css",
  "metadata/manifest.json",
  "metadata/validation.json",
  "LICENSE",
  "NOTICE",
] as const;

/** The release manifest describes the public paths, never the ZIP's original layout. */
export function createReleaseFiles(
  result: Pick<ColorFontExportResult, "fonts" | "manifest">,
  validation: unknown,
  license: Uint8Array,
  notice: string,
  version: string,
  provenance: ReleaseProvenance,
): ReleaseFiles {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid release version");
  if (version !== FONT_VERSION || result.manifest.fontVersion !== version)
    throw new Error("Release and compiled font versions must match");
  const manifest = structuredClone(result.manifest);
  if (
    manifest.family !== "Hangul Palette" ||
    manifest.schemaVersion !== 1 ||
    manifest.format !== "hangul-palette-color-font-v1" ||
    !manifest.complete
  )
    throw new Error("Release requires a complete Hangul Palette export");
  if (manifest.weights.length !== 9 || manifest.counts.weights !== 9 || manifest.slots.length !== 20)
    throw new Error("Release requires nine weights and twenty palette slots");
  const report = validation as {
    schemaVersion?: number;
    passed?: boolean;
    weights?: Record<string, { passed?: boolean; fontSha256?: string }>;
  };
  if (
    report?.schemaVersion !== 1 ||
    !report.passed ||
    Object.keys(report.weights ?? {}).length !== 9 ||
    FONT_WEIGHTS.some(({ id }) => !report.weights?.[id])
  )
    throw new Error("Release requires all nine validated fonts");
  const files: ReleaseFiles = {};
  for (const expected of FONT_WEIGHTS) {
    const record = manifest.weights.find(({ id }) => id === expected.id);
    const bytes = result.fonts[expected.id];
    if (!record || record.weight !== expected.value || !bytes?.length)
      throw new Error(`Missing or inconsistent ${expected.id} font`);
    const source = manifest.files[record.fontFile];
    if (!source || source.bytes !== bytes.length || source.sha256 !== sha256(bytes))
      throw new Error(`Font digest mismatch: ${expected.id}`);
    if (
      report.weights?.[expected.id]?.passed !== true ||
      report.weights[expected.id]?.fontSha256 !== sha256(bytes)
    )
      throw new Error(`Font validation mismatch: ${expected.id}`);
    record.fontFile = fontPath(expected.id);
    files[record.fontFile] = bytes;
  }
  const faces = FONT_WEIGHTS.map(
    ({ id, value }) =>
      `@font-face {\n  font-family: "Hangul Palette";\n  src: url("../${fontPath(id)}") format("woff2");\n  font-weight: ${value};\n  font-style: normal;\n  font-display: swap;\n}`,
  ).join("\n\n");
  const palette = (name: string, colors: string[]) =>
    `@font-palette-values ${name} {\n  font-family: "Hangul Palette";\n  base-palette: 0;\n  override-colors:\n${colors.map((color, index) => `    ${index} ${color}`).join(",\n")};\n}`;
  files["css/hangul-palette.css"] = text(
    [
      `/* Font faces */\n${faces}`,
      '/* Default appearance */\n.hangul-palette {\n  font-family: "Hangul Palette", sans-serif;\n  font-synthesis: none;\n  font-palette: normal;\n}',
      `/* Example palettes */\n${palette(
        "--hangul-palette",
        manifest.slots.map(({ color }) => color),
      )}`,
      palette(
        "--hangul-palette-gray",
        manifest.slots.map(() => "#64748b"),
      ),
      palette(
        "--hangul-palette-roles",
        manifest.slots.map(
          ({ role }) => ({ initial: "#ee7a8a", medial: "#e8b476", final: "#87cbb5" })[role] ?? "#000000",
        ),
      ),
      "/* Palette slots */\n" +
        manifest.slots.map(({ index, id, label }) => `/* ${index}: ${id} — ${label} */`).join("\n"),
      "/* Add this class to use the example colors. */\n.hangul-palette--colored {\n  font-palette: --hangul-palette;\n}",
    ].join("\n\n") + "\n",
  );
  files["metadata/validation.json"] = json(validation);
  files.LICENSE = license;
  files.NOTICE = text(notice.replaceAll("LICENSE-OFL", "LICENSE"));
  manifest.inputs.selection = "checked-in-baseline";
  for (const weight of manifest.weights) weight.inputs.selection = "checked-in-baseline";
  manifest.version = version;
  manifest.provenance = provenance;
  manifest.license = { spdx: "OFL-1.1", file: "LICENSE", sha256: sha256(license) };
  manifest.files = Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [path, { bytes: bytes.length, sha256: sha256(bytes) }]),
  );
  files["metadata/manifest.json"] = json(manifest);
  return files;
}

async function rejectSymlinks(path: string): Promise<void> {
  const full = resolve(path);
  const root = parse(full).root;
  const pieces = relative(root, full).split(sep).filter(Boolean);
  let current = root;
  for (const piece of pieces) {
    current = join(current, piece);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink output refused: ${current}`);
      if (current !== full && !stat.isDirectory()) throw new Error(`Invalid output parent: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Preflight happens before compilation, and is repeated immediately before writing. */
export async function inspectReleaseDestination(output: string, studioRoot?: string): Promise<void> {
  const destination = resolve(output);
  function contains(parent: string, child: string): boolean {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
  }
  if (
    studioRoot &&
    (contains(resolve(studioRoot), destination) || contains(destination, resolve(studioRoot)))
  )
    throw new Error("Release output must be separate from the Studio repository and its parents");
  await rejectSymlinks(destination);
  let exists = false;
  try {
    if (!(await lstat(destination)).isDirectory()) throw new Error("Release output must be a directory");
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists || (await readdir(destination)).length === 0)
    throw new Error("Release output must be an existing hangul-palette distribution repository");
  if (exists && (await readdir(destination)).length) {
    let recognized = false;
    const path = join(destination, "metadata/manifest.json");
    await rejectSymlinks(path);
    try {
      const marker = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> | null;
      recognized =
        marker?.family === "Hangul Palette" &&
        marker?.schemaVersion === 1 &&
        marker?.format === "hangul-palette-color-font-v1";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (!recognized)
      throw new Error("Nonempty output must identify itself as the hangul-palette distribution repository");
  }
  for (const name of GENERATED_RELEASE_PATHS) {
    const target = join(destination, name);
    await rejectSymlinks(target);
    try {
      if (!(await lstat(target)).isFile()) throw new Error(`Output file refused: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Only fixed generated files are replaced; authored website files, docs and Git metadata are preserved. */
export async function writeReleaseFiles(output: string, files: ReleaseFiles): Promise<void> {
  const destination = resolve(output);
  const names = Object.keys(files).sort();
  if (
    names.length !== GENERATED_RELEASE_PATHS.length ||
    names.some((name) => !GENERATED_RELEASE_PATHS.includes(name as (typeof GENERATED_RELEASE_PATHS)[number]))
  )
    throw new Error("Unexpected generated release paths");
  await inspectReleaseDestination(destination);
  await rejectSymlinks(destination);
  for (const name of names) {
    const target = resolve(destination, name);
    if (relative(destination, target).startsWith("..")) throw new Error("Output path traversal refused");
    await rejectSymlinks(target);
    try {
      if (!(await lstat(target)).isFile()) throw new Error(`Output file refused: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(join(destination, ".release-stage-"));
  try {
    for (const name of names) {
      await mkdir(dirname(join(stage, name)), { recursive: true });
      await writeFile(join(stage, name), files[name]!);
    }
    // Publish the manifest last so an interrupted release fails hash verification.
    for (const name of [
      ...names.filter((name) => name !== "metadata/manifest.json"),
      "metadata/manifest.json",
    ]) {
      await mkdir(dirname(join(destination, name)), { recursive: true });
      await rename(join(stage, name), join(destination, name));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function releaseProvenance(root: string, data: Uint8Array): Promise<ReleaseProvenance> {
  const names = ["package.json", "bun.lock"];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && /\.(ts|py|json|txt|html|css)$/.test(entry.name)) names.push(path);
    }
  }
  await collect("src");
  await collect("bin");
  const entries = await Promise.all(
    names.sort().map(async (name) => [name, sha256(await readFile(join(root, name)))] as const),
  );
  const files = Object.fromEntries(entries);
  const studio = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  if (studio.name !== "hangul-palette-studio" || typeof studio.version !== "string")
    throw new Error("Release requires Hangul Palette Studio package metadata");
  const revision = Bun.spawnSync(["git", "-C", root, "rev-parse", "--verify", "HEAD"], { stderr: "pipe" });
  return {
    studio: {
      name: "hangul-palette-studio",
      version: studio.version,
      revision: revision.exitCode === 0 ? revision.stdout.toString().trim() : null,
      sourceSha256: sha256(JSON.stringify(files)),
      files,
    },
    inputs: {
      dataFileSha256: sha256(data),
      palette: "contract-default",
    },
  };
}
