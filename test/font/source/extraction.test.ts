import { expect, test } from "bun:test";
import { createGlyphSource, decodeGlyphSource } from "../../../src/font/source/document.ts";
import { createExtractedGlyphSource } from "../../../src/font/source/extraction.ts";
import type { GlyphGeometry } from "../../../src/font/source/types.ts";

function raw(): GlyphGeometry {
  return {
    version: 1,
    upm: 2896,
    asc: 2259,
    sets: [
      [
        0,
        0,
        [
          [
            "가",
            100,
            [
              ["M0 0L10 0L10 -10Z", 10, 10, 5, 5],
              ["M20 0L30 0L30 -10Z", 10, 10, 25, 5],
            ],
          ],
        ],
      ],
    ],
  };
}

test("verified re-extraction retains regions and paint order without changing the reference", () => {
  const source = raw(),
    reference = createGlyphSource(source, {
      가: [
        [1, "medial.part1.vertical"],
        [0, "initial.part1.body"],
      ],
    });
  const before = JSON.stringify(reference);
  const result = createExtractedGlyphSource(source, reference);
  expect(result.glyphs.가!.contours.map(({ id, region }) => [id, region])).toEqual([
    [1, "medial.part1.vertical"],
    [0, "initial.part1.body"],
  ]);
  expect(decodeGlyphSource(result).raw).toEqual(source);
  expect(JSON.stringify(reference)).toBe(before);
});

test("new extraction without a reference starts with explicit unassigned regions", () => {
  expect(createExtractedGlyphSource(raw()).glyphs.가!.contours.map(({ id, region }) => [id, region])).toEqual(
    [
      [0, "unassigned"],
      [1, "unassigned"],
    ],
  );
});

test("re-extraction refuses any changed source metric, contour identity or geometry", () => {
  const reference = createGlyphSource(raw(), {
    가: [
      [1, "medial.part1.vertical"],
      [0, "initial.part1.body"],
    ],
  });
  const mutations: ((source: GlyphGeometry) => void)[] = [
    (source) => {
      source.upm++;
    },
    (source) => {
      source.asc++;
    },
    (source) => {
      source.sets[0]![2][0]![1]++;
    },
    (source) => {
      source.sets[0]![2][0]![2][0]![0] = "M0 0L11 0L10 -10Z";
    },
    (source) => {
      source.sets[0]![2][0]![2][0]![1]++;
    },
    (source) => {
      source.sets[0]![2][0]![2][0]![2]++;
    },
    (source) => {
      source.sets[0]![2][0]![2][0]![3]++;
    },
    (source) => {
      source.sets[0]![2][0]![2][0]![4]++;
    },
    (source) => {
      source.sets[0]![2][0]![2].reverse();
    },
    (source) => {
      source.sets[0]![2][0]![2].pop();
    },
    (source) => {
      source.sets[0]![2] = [];
    },
    (source) => {
      source.sets[0]![2][0]![0] = "나";
    },
  ];
  for (const mutate of mutations) {
    const source = raw();
    mutate(source);
    expect(() => createExtractedGlyphSource(source, reference)).toThrow("Extracted geometry differs");
  }
});
