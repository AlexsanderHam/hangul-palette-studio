import { expect, test } from "bun:test";
import { validateContourAssignments, validateGlyphAssignment } from "../../../src/font/source/validation.ts";

const INITIAL = "initial.part1.body";
const VERTICAL = "medial.part1.vertical";
const BAR = "medial.part1.right-bar";

test("valid reordered final region assignments are retained", () => {
  expect(
    validateContourAssignments(
      [
        [1, VERTICAL],
        [0, INITIAL],
        [2, BAR],
      ],
      3,
    ),
  ).toEqual([]);
  expect(
    validateGlyphAssignment(
      "가",
      [
        [1, VERTICAL],
        [0, INITIAL],
        [2, BAR],
      ],
      3,
    ),
  ).toEqual([]);
});

test("a missing contour cannot hide behind another contour in the same region", () => {
  expect(
    validateContourAssignments(
      [
        [0, INITIAL],
        [2, VERTICAL],
      ],
      3,
    ),
  ).toContain("missing shape 1");
});

test("reject duplicate, out-of-range, numeric legacy and unassigned regions", () => {
  expect(
    validateContourAssignments(
      [
        [0, INITIAL],
        [0, VERTICAL],
      ],
      2,
    ),
  ).toContain("duplicate shape 0");
  expect(validateContourAssignments([[9, INITIAL]], 1)).toContain("invalid shape index 9");
  expect(validateContourAssignments([[0, "unassigned"]], 1)).toContain(
    "shape 0 has invalid or unassigned region unassigned",
  );
  expect(validateContourAssignments([[0, 1]], 1)).toContain("shape 0 has invalid or unassigned region 1");
  expect(validateContourAssignments(null, 1)).toContain("classification must be an array");
});

test("strict final regions follow components and feature strokes rather than old role numbers", () => {
  expect(
    validateGlyphAssignment(
      "가",
      [
        [0, INITIAL],
        [1, VERTICAL],
      ],
      2,
    ),
  ).toContain(`missing required region ${BAR}`);
  expect(
    validateGlyphAssignment(
      "가",
      [
        [0, INITIAL],
        [1, VERTICAL],
        [2, BAR],
        [3, "final.part1.body"],
      ],
      4,
    ),
  ).toContain("unexpected region final.part1.body");
  expect(
    validateGlyphAssignment(
      "ㄳ",
      [
        [0, "final.part1.body"],
        [1, "final.part2.body"],
      ],
      2,
    ),
  ).toEqual([]);
  expect(
    validateGlyphAssignment(
      "까",
      [
        [0, INITIAL],
        [1, "initial.part2.body"],
        [2, VERTICAL],
        [3, BAR],
      ],
      4,
    ),
  ).toEqual([]);
  expect(
    validateGlyphAssignment(
      "ㅋ",
      [
        [0, INITIAL],
        [1, "initial.part1.added-bar"],
      ],
      2,
    ),
  ).toEqual([]);
  expect(
    validateGlyphAssignment(
      "ㄱ",
      [
        [0, INITIAL],
        [1, "initial.part1.added-bar"],
      ],
      2,
    ),
  ).toContain("unexpected region initial.part1.added-bar");
});
