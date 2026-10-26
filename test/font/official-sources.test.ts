import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import officialSources from "../../src/font/compiler/official-sources.json";
import { prepareOfficialFontSources, verifiedOfficialFontSource } from "../../src/font/inputs.ts";
import { PRETENDARD_SOURCE, sha256 } from "../../src/font/source/pretendard.ts";
import { FONT_WEIGHTS } from "../../src/font/weights.ts";

const root = resolve(import.meta.dir, "../..");

test("official binary pins cover exactly the nine CSS weights at the calibrated source revision", () => {
  expect(officialSources).toMatchObject({ schemaVersion: 1, ...PRETENDARD_SOURCE });
  expect(Object.keys(officialSources.files)).toEqual(FONT_WEIGHTS.map(({ id }) => id));
  for (const profile of FONT_WEIGHTS) {
    const pin = officialSources.files[profile.id];
    expect(pin.path).toBe(`packages/pretendard/dist/public/static/Pretendard-${profile.label}.otf`);
    expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pin.bytes).toBeGreaterThan(1_000_000);
  }
  expect(new Set(Object.values(officialSources.files).map(({ sha256 }) => sha256)).size).toBe(9);
});

test("official source snapshot rejects truncation, a substituted weight, and a one-byte modification", async () => {
  const original = await readFile(join(root, "data/Pretendard-Regular.otf"));
  const captured = verifiedOfficialFontSource("regular", original);
  expect(captured.sha256).toBe(officialSources.files.regular.sha256);
  expect(Buffer.from(captured.data, "base64")).toEqual(original);
  expect(() => verifiedOfficialFontSource("regular", original.subarray(1))).toThrow("does not match");
  expect(() => verifiedOfficialFontSource("bold", original)).toThrow("does not match");
  const altered = Buffer.from(original);
  altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  expect(() => verifiedOfficialFontSource("regular", altered)).toThrow("does not match");
  original[original.length - 1] = original[original.length - 1]! ^ 1;
  expect(sha256(Buffer.from(captured.data, "base64"))).toBe(officialSources.files.regular.sha256);
});

// The pinned checkout is prepared by setup:font. Unit tests remain offline when
// it is absent; this additionally exercises the complete on-disk capture path.
test.skipIf(!existsSync(join(root, ".cache/pretendard-src")))(
  "capture all nine verified binaries once for concurrent exports",
  async () => {
    const [first, second] = await Promise.all([
      prepareOfficialFontSources(root),
      prepareOfficialFontSources(root),
    ]);
    expect(first).toBe(second);
    expect(Object.keys(first)).toEqual(FONT_WEIGHTS.map(({ id }) => id));
    for (const { id } of FONT_WEIGHTS) {
      const bytes = Buffer.from(first[id].data, "base64");
      expect(bytes.length).toBe(officialSources.files[id].bytes);
      expect(sha256(bytes)).toBe(officialSources.files[id].sha256);
      expect(first[id].sha256).toBe(officialSources.files[id].sha256);
    }
  },
  30_000,
);
