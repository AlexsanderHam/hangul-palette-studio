import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  expectedRegions,
  glyphComponents,
  isRegionId,
  REGION_IDS,
  SEMANTIC_REGIONS,
  UNASSIGNED_REGION,
} from "../../../src/font/source/regions.ts";

const root = resolve(import.meta.dir, "../../..");
const chars = [
  ...Array.from({ length: 11172 }, (_, i) => String.fromCodePoint(0xac00 + i)),
  ...Array.from({ length: 51 }, (_, i) => String.fromCodePoint(0x3131 + i)),
];

test("all supported characters have unique canonical regions contained in the shared twenty-slot contract", () => {
  expect(REGION_IDS).toHaveLength(20);
  expect(new Set(REGION_IDS).size).toBe(20);
  expect(SEMANTIC_REGIONS.map(({ index }) => index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  for (const char of chars) {
    const regions = expectedRegions(char);
    expect(regions.length).toBeGreaterThan(0);
    expect(new Set(regions).size).toBe(regions.length);
    expect(regions.every(isRegionId)).toBe(true);
  }
  for (const invalid of [UNASSIGNED_REGION, 0, 1, "initial", "unknown", null])
    expect(isRegionId(invalid)).toBe(false);
  for (const invalid of ["", "가나", "A", "ᄀ", "😀"]) {
    expect(expectedRegions(invalid)).toEqual([]);
    expect(glyphComponents(invalid)).toEqual({});
  }
});

test("canonical visual constituents include three-part vowels, doubled consonants and standalone clusters", () => {
  expect(glyphComponents("괘")).toEqual({
    initial: { value: "ㄱ", components: [{ index: 1, value: "ㄱ" }] },
    medial: {
      value: "ㅙ",
      components: [
        { index: 1, value: "ㅗ" },
        { index: 2, value: "ㅏ" },
        { index: 3, value: "ㅣ" },
      ],
    },
  });
  expect(expectedRegions("괘")).toEqual([
    "initial.part1.body",
    "medial.part1.vertical",
    "medial.part1.horizontal",
    "medial.part2.vertical",
    "medial.part2.right-bar",
    "medial.part3.vertical",
  ]);
  expect(expectedRegions("까")).toContain("initial.part2.body");
  expect(expectedRegions("갂")).toContain("final.part2.body");
  expect(expectedRegions("ㄳ")).toEqual(["final.part1.body", "final.part2.body"]);
  expect(expectedRegions("ㅋ")).toEqual(["initial.part1.body", "initial.part1.added-bar"]);
  expect(expectedRegions("컼")).toContain("final.part1.added-bar");
  expect(expectedRegions("ㅒ")).toEqual([
    "medial.part1.vertical",
    "medial.part2.vertical",
    "medial.part1.right-upper-bar",
    "medial.part1.right-lower-bar",
  ]);
});

const python = join(
  root,
  ".cache/font-export-venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
test.skipIf(!existsSync(python))(
  "browser and compiler agree on all 11223 canonical region sets and components",
  () => {
    const script = `import json,sys\nsys.path.insert(0,sys.argv[1])\nfrom regions import expected_regions,semantics\nchars=[chr(i) for i in range(0xac00,0xd7a4)]+[chr(i) for i in range(0x3131,0x3164)]\nprint(json.dumps([[c,expected_regions(c),semantics(c)] for c in chars],ensure_ascii=False))`;
    const result = Bun.spawnSync([python, "-c", script, join(root, "src/font/compiler")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(
      chars.map((char) => [char, expectedRegions(char), glyphComponents(char)]),
    );
  },
  30_000,
);
