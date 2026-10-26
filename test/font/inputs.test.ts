import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareFontWeightSources } from "../../src/font/inputs.ts";
import { ASC, UPM } from "../../src/font/source/hangul.ts";
import { PRETENDARD_SOURCE, sha256 } from "../../src/font/source/pretendard.ts";
import type { CompactSyllable, GlyphGeometry } from "../../src/font/source/types.ts";
import { FONT_WEIGHTS, type FontWeightId } from "../../src/font/weights.ts";

const normal = "CD0E3B44-F66A-4791-B84C-A1128DC61275";
type Weight = Exclude<FontWeightId, "regular">;
const weights = FONT_WEIGHTS.filter((weight) => weight.id !== "regular");
const identities = weights.map((weight) => weight.id);
function raw(weight: Weight): GlyphGeometry {
  const profile = weights.find((profile) => profile.id === weight)!;
  const lower =
    profile.value < 400
      ? { id: "B1F27B51-9973-4381-9301-4FE46FE1CA59", weight: 45 }
      : { id: normal, weight: 400 };
  const upper =
    profile.value < 400
      ? { id: normal, weight: 400 }
      : { id: "5C20EF92-B63D-42A8-8878-93C2863E0093", weight: 930 };
  const factor = (profile.value - lower.weight) / (upper.weight - lower.weight);
  const glyph = (code: number): CompactSyllable => [
    String.fromCharCode(code),
    100,
    [["M0 0L1 0L1 -1Z", 1, 1, 0.5, 0.5]],
  ];
  const sets: GlyphGeometry["sets"] = [
    [-1, 0, Array.from({ length: 30 }, (_, i) => glyph(0x3131 + i))],
    [-1, 1, Array.from({ length: 21 }, (_, i) => glyph(0x314f + i))],
  ];
  for (let medial = 0; medial < 21; medial++)
    for (let final = 0; final < 28; final++)
      sets.push([
        medial,
        final,
        Array.from({ length: 19 }, (_, initial) => glyph(0xac00 + initial * 588 + medial * 28 + final)),
      ]);
  return {
    version: 1,
    upm: UPM,
    asc: ASC,
    sets,
    provenance: {
      ...PRETENDARD_SOURCE,
      sourceFingerprint: "0".repeat(64),
      fontInfoSha256: "1".repeat(64),
      licenseSha256: "2".repeat(64),
      fingerprintAlgorithm: "sha256-path-length-content-v1",
      master: { id: normal, weight: 400, name: "Normal" },
      instance: {
        name: profile.label,
        weight: profile.value,
        masters: [
          { ...lower, factor: 1 - factor },
          { ...upper, factor },
        ],
      },
      fontMetrics: { unitsPerEm: UPM, ascender: 2757, descender: -699 },
      geometryBounds: "control-points",
      viewportAscender: ASC,
      extractorVersion: 1,
    },
  };
}
const extractor = `import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
const args=process.argv.slice(2), weight=args[args.indexOf("--weight")+1], output=args[args.indexOf("--output")+1];
if(args[args.indexOf("--format")+1]!=="raw") throw new Error("weight cache requires raw extraction");
appendFileSync("calls.txt",weight+"\\n");
if(existsSync("FAIL")) throw new Error("fixture extraction failed");
writeFileSync(output,JSON.stringify(JSON.parse(readFileSync("fixture.json","utf8"))[weight]));`;
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "studio-weight-cache-"));
  try {
    await mkdir(join(root, "bin"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "bin/extract.ts"), extractor);
    for (const file of [
      "src/font/source/parser.ts",
      "src/font/source/document.ts",
      "src/font/source/extraction.ts",
      "src/font/source/validation.ts",
      "src/font/source/hangul.ts",
      "src/font/source/pretendard.ts",
      "src/shared/atomic-file.ts",
      "src/font/source/types.ts",
      "src/font/source/regions.ts",
      "src/font/weights.ts",
      "src/font/compiler/contract.json",
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "// fixture dependency");
    }
    await writeFile(
      join(root, "fixture.json"),
      JSON.stringify(Object.fromEntries(identities.map((weight) => [weight, raw(weight)]))),
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function calls(root: string) {
  return (await readFile(join(root, "calls.txt"), "utf8")).trim().split("\n");
}
async function cache(root: string) {
  const base = join(root, ".cache/color-font-sources");
  const entries = (await readdir(base)).filter((name) => !name.startsWith("."));
  expect(entries).toHaveLength(1);
  return join(base, entries[0]!);
}

test(
  "source cache shares concurrent extraction and repairs checksum or profile corruption",
  async () =>
    fixture(async (root) => {
      const results = await Promise.all(Array.from({ length: 4 }, () => prepareFontWeightSources(root)));
      for (const result of results) {
        expect(Object.keys(result)).toEqual(identities);
        for (const profile of weights)
          expect(result[profile.id].provenance?.instance).toMatchObject({
            name: profile.label,
            weight: profile.value,
          });
      }
      expect(await calls(root)).toEqual(identities);
      await prepareFontWeightSources(root);
      expect(await calls(root)).toHaveLength(8);
      const directory = await cache(root);
      await writeFile(join(directory, "light.json"), "{}");
      await prepareFontWeightSources(root);
      expect(await calls(root)).toHaveLength(16);
      const wrong = raw("bold");
      wrong.provenance!.instance!.weight = 300;
      const bytes = JSON.stringify(wrong),
        manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      await writeFile(join(directory, "bold.json"), bytes);
      manifest.files.bold = { bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
      await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
      expect((await prepareFontWeightSources(root)).bold.provenance?.instance?.weight).toBe(700);
      expect(await calls(root)).toHaveLength(24);
      const missing = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      delete missing.files["extra-bold"];
      await writeFile(join(directory, "manifest.json"), JSON.stringify(missing));
      expect(Object.keys(await prepareFontWeightSources(root))).toEqual(identities);
      expect(await calls(root)).toHaveLength(32);
    }),
  30_000,
);

test(
  "failed extraction keeps published files intact, retries, and extractor changes use a new cache",
  async () =>
    fixture(async (root) => {
      await prepareFontWeightSources(root);
      const directory = await cache(root),
        manifest = await readFile(join(directory, "manifest.json"), "utf8"),
        bold = await readFile(join(directory, "bold.json"), "utf8");
      await writeFile(join(directory, "light.json"), "{}");
      await writeFile(join(root, "FAIL"), "");
      await expect(prepareFontWeightSources(root)).rejects.toThrow("fixture extraction failed");
      expect(await readFile(join(directory, "manifest.json"), "utf8")).toBe(manifest);
      expect(await readFile(join(directory, "bold.json"), "utf8")).toBe(bold);
      expect(
        (await readdir(join(root, ".cache/color-font-sources"))).filter((name) =>
          name.startsWith(".extract-"),
        ),
      ).toHaveLength(0);
      await rm(join(root, "FAIL"));
      expect((await prepareFontWeightSources(root)).light.provenance?.instance?.weight).toBe(300);
      await appendFile(join(root, "src/font/source/parser.ts"), "\n// changed extractor");
      await prepareFontWeightSources(root);
      expect(
        (await readdir(join(root, ".cache/color-font-sources"))).filter((name) => !name.startsWith(".")),
      ).toHaveLength(2);
      await appendFile(join(root, "src/shared/atomic-file.ts"), "\n// changed atomic output dependency");
      await prepareFontWeightSources(root);
      expect(
        (await readdir(join(root, ".cache/color-font-sources"))).filter((name) => !name.startsWith(".")),
      ).toHaveLength(3);
      await appendFile(join(root, "src/font/source/document.ts"), "\n// changed glyph data conversion");
      await prepareFontWeightSources(root);
      expect(
        (await readdir(join(root, ".cache/color-font-sources"))).filter((name) => !name.startsWith(".")),
      ).toHaveLength(4);
      await appendFile(join(root, "src/font/source/regions.ts"), "\n// changed semantic region contract");
      await prepareFontWeightSources(root);
      expect(
        (await readdir(join(root, ".cache/color-font-sources"))).filter((name) => !name.startsWith(".")),
      ).toHaveLength(5);
      await appendFile(join(root, "src/font/compiler/contract.json"), "\n ");
      await prepareFontWeightSources(root);
      expect(
        (await readdir(join(root, ".cache/color-font-sources"))).filter((name) => !name.startsWith(".")),
      ).toHaveLength(6);
      await mkdir(join(root, ".cache/pretendard-src"));
      const before = await calls(root);
      await expect(prepareFontWeightSources(root)).rejects.toThrow("Source verification failed");
      expect(await calls(root)).toEqual(before);
    }),
  30_000,
);
