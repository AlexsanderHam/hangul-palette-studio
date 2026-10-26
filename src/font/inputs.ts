import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import officialSources from "./compiler/official-sources.json";
import { ASC, HANGUL_BASE, HANGUL_END, JAMO_END, JAMO_START, UPM } from "./source/hangul.ts";
import {
  ensureSourceRepository,
  PRETENDARD_SOURCE,
  sha256,
  verifySourceRepository,
} from "./source/pretendard.ts";
import type { GlyphGeometry } from "./source/types.ts";
import {
  FONT_WEIGHTS,
  type FontWeightId,
  type FontWeightSources,
  type OfficialFontSource,
  type OfficialFontSources,
} from "./weights.ts";

const EXTRACTOR_FILES = [
  "bin/extract.ts",
  "src/font/source/parser.ts",
  "src/font/source/document.ts",
  "src/font/source/extraction.ts",
  "src/font/source/validation.ts",
  "src/font/source/hangul.ts",
  "src/font/source/pretendard.ts",
  "src/shared/atomic-file.ts",
  "src/font/source/types.ts",
  "src/font/source/regions.ts",
  "src/font/compiler/contract.json",
  "src/font/weights.ts",
] as const;
const NORMAL = "CD0E3B44-F66A-4791-B84C-A1128DC61275";
type Weight = Exclude<FontWeightId, "regular">;
const INSTANCE_WEIGHTS = FONT_WEIGHTS.filter((weight) => weight.id !== "regular");
const WEIGHTS = INSTANCE_WEIGHTS.map((weight) => weight.id);
const PROFILES = Object.fromEntries(
  INSTANCE_WEIGHTS.map((weight) => {
    const lower =
      weight.value < 400
        ? { id: "B1F27B51-9973-4381-9301-4FE46FE1CA59", weight: 45 }
        : { id: NORMAL, weight: 400 };
    const upper =
      weight.value < 400
        ? { id: NORMAL, weight: 400 }
        : { id: "5C20EF92-B63D-42A8-8878-93C2863E0093", weight: 930 };
    const factor = (weight.value - lower.weight) / (upper.weight - lower.weight);
    return [
      weight.id,
      {
        name: weight.label,
        weight: weight.value,
        masters: [
          { ...lower, factor: 1 - factor },
          { ...upper, factor },
        ],
      },
    ];
  }),
) as Record<
  Weight,
  { name: string; weight: number; masters: { id: string; weight: number; factor: number }[] }
>;
interface CacheManifest {
  version: 1;
  key: string;
  sourceRevision: string;
  files: FontWeightSources<{ bytes: number; sha256: string }>;
}
const pending = new Map<string, Promise<FontWeightSources<GlyphGeometry>>>();

function verifyWeightGeometry(text: string, weight: Weight): GlyphGeometry {
  const raw = JSON.parse(text) as GlyphGeometry;
  const provenance = raw.provenance,
    instance = provenance?.instance,
    profile = PROFILES[weight];
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (
    raw.version !== 1 ||
    raw.upm !== UPM ||
    raw.asc !== ASC ||
    provenance?.repository !== PRETENDARD_SOURCE.repository ||
    provenance.ref !== PRETENDARD_SOURCE.ref ||
    provenance.revision !== PRETENDARD_SOURCE.revision ||
    provenance.fingerprintAlgorithm !== "sha256-path-length-content-v1" ||
    !hash(provenance.sourceFingerprint) ||
    !hash(provenance.fontInfoSha256) ||
    !hash(provenance.licenseSha256) ||
    provenance.geometryBounds !== "control-points" ||
    provenance.viewportAscender !== ASC ||
    provenance.master?.id !== NORMAL ||
    provenance.master.weight !== 400 ||
    provenance.fontMetrics?.unitsPerEm !== UPM ||
    instance?.name !== profile.name ||
    instance.weight !== profile.weight ||
    !Array.isArray(instance.masters) ||
    instance.masters.length !== profile.masters.length ||
    instance.masters.some(
      (master, index) =>
        master.id !== profile.masters[index]!.id ||
        master.weight !== profile.masters[index]!.weight ||
        !Number.isFinite(master.factor) ||
        Math.abs(master.factor - profile.masters[index]!.factor) > 1e-12,
    ) ||
    !Array.isArray(raw.sets)
  )
    throw new Error(`Invalid ${weight} extraction provenance`);
  const seen = new Set<string>();
  for (const set of raw.sets) {
    if (!Array.isArray(set) || !Array.isArray(set[2])) throw new Error(`Invalid ${weight} glyph sets`);
    for (const glyph of set[2]) {
      const char = glyph?.[0],
        code = typeof char === "string" && char.length === 1 ? char.charCodeAt(0) : 0;
      if (
        !((code >= HANGUL_BASE && code <= HANGUL_END) || (code >= JAMO_START && code <= JAMO_END)) ||
        seen.has(char) ||
        !Number.isFinite(glyph[1]) ||
        glyph[1] <= 0 ||
        !Array.isArray(glyph[2]) ||
        !glyph[2].length
      )
        throw new Error(`Invalid ${weight} glyph coverage`);
      seen.add(char);
    }
  }
  if (seen.size !== HANGUL_END - HANGUL_BASE + 1 + JAMO_END - JAMO_START + 1)
    throw new Error(`Incomplete ${weight} glyph coverage`);
  return raw;
}

async function loadCache(directory: string, key: string): Promise<FontWeightSources<GlyphGeometry> | null> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as CacheManifest;
    if (
      manifest.version !== 1 ||
      manifest.key !== key ||
      manifest.sourceRevision !== PRETENDARD_SOURCE.revision ||
      !manifest.files ||
      Object.keys(manifest.files).sort().join(",") !== [...WEIGHTS].sort().join(",")
    )
      return null;
    const values = await Promise.all(
      WEIGHTS.map(async (weight) => {
        const bytes = await readFile(join(directory, `${weight}.json`));
        if (manifest.files[weight].bytes !== bytes.length || manifest.files[weight].sha256 !== sha256(bytes))
          throw new Error("Weight source cache checksum mismatch");
        return [weight, verifyWeightGeometry(bytes.toString("utf8"), weight)] as const;
      }),
    );
    return Object.fromEntries(values) as FontWeightSources<GlyphGeometry>;
  } catch {
    return null;
  }
}

async function prepare(root: string): Promise<FontWeightSources<GlyphGeometry>> {
  const source = join(root, ".cache/pretendard-src");
  if (existsSync(source)) verifySourceRepository(source);
  const fingerprints = await Promise.all(
    EXTRACTOR_FILES.map(async (file) => [file, sha256(await readFile(join(root, file)))]),
  );
  const key = sha256(
    JSON.stringify({ source: PRETENDARD_SOURCE, runtime: Bun.version, files: fingerprints }),
  );
  const cacheRoot = join(root, ".cache/color-font-sources"),
    directory = join(cacheRoot, key);
  const cached = await loadCache(directory, key);
  if (cached) return cached;
  await mkdir(cacheRoot, { recursive: true });
  const staging = await mkdtemp(join(cacheRoot, ".extract-"));
  try {
    const files = {} as CacheManifest["files"];
    // Sequential extraction also makes the first-time source clone unambiguous.
    for (const weight of WEIGHTS) {
      const output = join(staging, `${weight}.json`);
      const child = Bun.spawn(
        [
          process.execPath,
          join(root, "bin/extract.ts"),
          "--source",
          source,
          "--weight",
          weight,
          "--format",
          "raw",
          "--output",
          output,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 180_000, killSignal: "SIGKILL" },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0)
        throw new Error(
          `${PROFILES[weight].name} source extraction failed: ${stderr.trim() || stdout.trim()}`,
        );
      const bytes = await readFile(output);
      verifyWeightGeometry(bytes.toString("utf8"), weight);
      files[weight] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
    const manifest: CacheManifest = { version: 1, key, sourceRevision: PRETENDARD_SOURCE.revision, files };
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest));
    await mkdir(directory, { recursive: true });
    // Each rename is atomic; publishing the checksum manifest last prevents any
    // interrupted or mixed generation from being accepted as a complete cache.
    for (const file of [...WEIGHTS.map((weight) => `${weight}.json`), "manifest.json"])
      await rename(join(staging, file), join(directory, file));
    const result = await loadCache(directory, key);
    if (!result) throw new Error("Weight source cache did not pass integrity validation after extraction");
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Prepare all eight non-Regular instances without changing the Studio workspace. */
export async function prepareFontWeightSources(root: string): Promise<FontWeightSources<GlyphGeometry>> {
  const path = resolve(root);
  const existing = pending.get(path);
  if (existing) return existing;
  const work = prepare(path);
  pending.set(path, work);
  try {
    return await work;
  } finally {
    if (pending.get(path) === work) pending.delete(path);
  }
}

/** Accept only the exact upstream OTF binary pinned for this CSS weight. */
export function verifiedOfficialFontSource(weight: FontWeightId, bytes: Uint8Array): OfficialFontSource {
  const pin = officialSources.files[weight];
  if (!pin || bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256)
    throw new Error(
      `The official ${weight} OTF does not match the pinned Pretendard ${PRETENDARD_SOURCE.ref} release.`,
    );
  return { sha256: pin.sha256, data: Buffer.from(bytes).toString("base64") };
}

const pendingOfficial = new Map<string, Promise<OfficialFontSources>>();

/** Capture verified bytes in the export snapshot; the compiler never trusts a mutable source path. */
export async function prepareOfficialFontSources(root: string): Promise<OfficialFontSources> {
  const directory = resolve(root);
  const pending = pendingOfficial.get(directory);
  if (pending) return pending;
  const work = (async () => {
    if (
      officialSources.schemaVersion !== 1 ||
      officialSources.repository !== PRETENDARD_SOURCE.repository ||
      officialSources.ref !== PRETENDARD_SOURCE.ref ||
      officialSources.revision !== PRETENDARD_SOURCE.revision ||
      Object.keys(officialSources.files).sort().join(",") !==
        FONT_WEIGHTS.map(({ id }) => id)
          .sort()
          .join(",")
    )
      throw new Error("The official font pins do not match the calibrated Pretendard source revision.");
    const source = join(directory, ".cache/pretendard-src");
    await ensureSourceRepository(source);
    const fonts = await Promise.all(
      FONT_WEIGHTS.map(
        async ({ id }) =>
          [
            id,
            verifiedOfficialFontSource(id, await readFile(join(source, officialSources.files[id].path))),
          ] as const,
      ),
    );
    return Object.fromEntries(fonts) as OfficialFontSources;
  })();
  pendingOfficial.set(directory, work);
  try {
    return await work;
  } finally {
    if (pendingOfficial.get(directory) === work) pendingOfficial.delete(directory);
  }
}
