import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGlyphFile, parseInterpolatedGlyphFile } from "../../../src/font/source/parser.ts";
import { parseSourcePlist } from "../../../src/font/source/pretendard.ts";

const master = "MASTER";
const contour = (nodes: string) => `{closed=1;nodes=(${nodes});}`;
const glyph = (shapes: string, extra = "", width = 500) =>
  `{glyphname=fixture;layers=({layerId="${master}";shapes=(${shapes});width=${width};${extra}});unicode=44032;}`;

function temporary(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "studio-parser-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("cubic closing segment preserves controls and SVG coordinate conversion", () => {
  const result = parseGlyphFile(glyph(contour("(0,0,c),(10,0,l),(10,10,o),(0,10,o)")), master, "");
  expect(result.shapes[0]).toEqual({
    pathData: "M0 0L10 0C10 -10 0 -10 0 0Z",
    minX: 0,
    maxX: 10,
    minY: 0,
    maxY: 10,
    cx: 5,
    cy: 5,
    w: 10,
    h: 10,
  });
});

test("quadratic and fractional geometry is represented exactly", () => {
  const result = parseGlyphFile(glyph(contour("(0.5,0,l),(10,0,o),(10,20,q),(0.5,20,l)")), master, "");
  expect(result.shapes[0]?.pathData).toBe("M0.5 0Q10 0 10 -20L0.5 -20Z");
  expect(result.shapes[0]?.w).toBe(9.5);
});

test("component translation and reflection transform paths and swap bounds", () =>
  temporary((directory) => {
    writeFileSync(join(directory, "piece.part.glyph"), glyph(contour("(0,0,l),(10,0,l),(10,20,l),(0,20,l)")));
    const result = parseGlyphFile(glyph('{ref="piece.part";pos=(100,30);scale=(-2,-3);}'), master, directory);
    expect(result.shapes[0]).toEqual({
      pathData: "M100 -30L80 -30L80 30L100 30Z",
      minX: 80,
      maxX: 100,
      minY: -30,
      maxY: 30,
      cx: 90,
      cy: 0,
      w: 20,
      h: 60,
    });
  }));

test("other masters and nested background contours never leak into selected layer", () => {
  const source = `{glyphname=test; layers=({layerId=OTHER;shapes=(${contour("(100,100,l),(200,100,l)")});width=99;},{background={shapes=(${contour("(900,900,l),(999,999,l)")});};layerId=MASTER;shapes=(${contour("(0,0,l),(10,0,l)")});width=50;},{layerId=LAST;shapes=(${contour("(200,200,l),(300,300,l)")});width=100;});}`;
  const result = parseGlyphFile(source, master, "");
  expect(result.width).toBe(50);
  expect(result.shapes.map((shape) => shape.pathData)).toEqual(["M0 0L10 0Z"]);
});

test("component transforms preserve coordinates written in scientific notation", () =>
  temporary((directory) => {
    writeFileSync(
      join(directory, "small.glyph"),
      glyph(contour("(0.0000001,0,l),(0.0000002,0,l),(0.0000002,0.0000001,l),(0.0000001,0.0000001,l)")),
    );
    const result = parseGlyphFile(glyph("{ref=small;scale=(2,-2);}"), master, directory);
    expect(result.shapes[0]?.pathData).toBe("M2e-7 0L4e-7 0L4e-7 2e-7L2e-7 2e-7Z");
    expect(result.shapes[0]?.w).toBe(2e-7);
    expect(result.shapes[0]?.h).toBe(2e-7);
  }));

test("same component names in separate source directories do not share cached geometry", () =>
  temporary((first) =>
    temporary((second) => {
      writeFileSync(join(first, "part.glyph"), glyph(contour("(0,0,l),(10,0,l)")));
      writeFileSync(join(second, "part.glyph"), glyph(contour("(0,0,l),(99,0,l)")));
      expect(parseGlyphFile(glyph("{ref=part;}"), master, first).shapes[0]?.w).toBe(10);
      expect(parseGlyphFile(glyph("{ref=part;}"), master, second).shapes[0]?.w).toBe(99);
    }),
  ));

test("missing references, missing masters, cycles and unsupported transforms fail with useful errors", () =>
  temporary((directory) => {
    expect(() => parseGlyphFile(glyph("{ref=missing;}"), master, directory)).toThrow(
      "missing referenced component 'missing'",
    );
    expect(() => parseGlyphFile(glyph(""), "ABSENT", directory)).toThrow("expected exactly one master layer");
    writeFileSync(join(directory, "loop.glyph"), glyph("{ref=loop;}"));
    expect(() => parseGlyphFile(glyph("{ref=loop;}"), master, directory)).toThrow(
      "circular component reference",
    );
    expect(() => parseGlyphFile(glyph("{ref=loop;angle=45;}"), master, directory)).toThrow(
      "unsupported component angle",
    );
    expect(() => parseGlyphFile(glyph("{ref=loop;scale=(0,1);}"), master, directory)).toThrow(
      "zero component scale",
    );
  }));

test("malformed and unsupported contours fail instead of silently omitting nodes", () => {
  expect(() => parseGlyphFile(glyph(contour("(0,0,l),(1,2,unsupported)")), master, "")).toThrow(
    "unsupported or malformed contour node",
  );
  expect(() => parseGlyphFile(glyph(contour("(0,0,o),(1,2,o)")), master, "")).toThrow("explicit on-curve");
  expect(() => parseGlyphFile(glyph(contour("(0,0,l),(1,2,o),(3,4,l)")), master, "")).toThrow(
    "single quadratic control point",
  );
  expect(() => parseGlyphFile(glyph("{closed=0;nodes=((0,0,l),(1,1,l));}"), master, "")).toThrow(
    "unsupported open contour",
  );
});

test("source plist parsing handles quoted punctuation and rejects ambiguous duplicate fields", () => {
  expect(parseSourcePlist('{name="a (b) {c};";tuple=(1,-2.5,word);/* note */}')).toEqual({
    name: "a (b) {c};",
    tuple: [1, -2.5, "word"],
  });
  expect(() => parseSourcePlist("{x=1;x=2;}")).toThrow("Duplicate key");
  expect(() => parseSourcePlist('{x="unterminated;}')).toThrow("Unterminated quoted string");
});

const instanceMasters = [
  { layerId: "LOW", factor: 0.25 },
  { layerId: "HIGH", factor: 0.75 },
];
const variableGlyph = (low: string, high: string, extra = "") =>
  `{glyphname=fixture;unicode=44032;layers=({layerId=LOW;width=100;shapes=(${low});},{layerId=HIGH;width=200;shapes=(${high});}${extra});}`;

test("named instances interpolate source nodes, advance and control-point bounds", () => {
  const result = parseInterpolatedGlyphFile(
    variableGlyph(
      contour("(0,0,l),(10,0,o),(10,20,q),(0,20,l)"),
      contour("(20,10,ls),(50,10,o),(50,50,qs),(20,50,l)"),
    ),
    instanceMasters,
    "",
  );
  expect(result.unicode).toBe(44032);
  expect(result.width).toBe(175);
  expect(result.shapes).toEqual([
    {
      pathData: "M15 -7.5Q40 -7.5 40 -42.5L15 -42.5Z",
      minX: 15,
      maxX: 40,
      minY: 7.5,
      maxY: 42.5,
      cx: 27.5,
      cy: 25,
      w: 25,
      h: 35,
    },
  ]);
});

test("component scales and positions interpolate before recursively expanding geometry", () =>
  temporary((directory) => {
    writeFileSync(
      join(directory, "part.glyph"),
      variableGlyph(contour("(0,0,l),(10,20,l)"), contour("(0,0,l),(20,40,l)")),
    );
    const result = parseInterpolatedGlyphFile(
      variableGlyph("{ref=part;pos=(10,0);scale=(1,1);}", "{ref=part;pos=(20,10);scale=(2,3);}"),
      instanceMasters,
      directory,
    );
    // Interpolating already transformed paths would incorrectly produce x=35 here.
    expect(result.shapes[0]?.pathData).toBe("M17.5 -7.5L48.125 -95Z");
    expect(result.shapes[0]?.w).toBe(30.625);
    expect(result.shapes[0]?.h).toBe(87.5);
  }));

test("interpolation refuses incompatible topology and active intermediate layers", () => {
  const line = contour("(0,0,l),(10,10,l)");
  expect(() =>
    parseInterpolatedGlyphFile(variableGlyph(line, `${line},${line}`), instanceMasters, ""),
  ).toThrow("contour counts");
  expect(() =>
    parseInterpolatedGlyphFile(
      variableGlyph(line, contour("(0,0,l),(10,10,l),(20,20,l)")),
      instanceMasters,
      "",
    ),
  ).toThrow("node counts");
  expect(() =>
    parseInterpolatedGlyphFile(variableGlyph(line, contour("(0,0,l),(10,10,o)")), instanceMasters, ""),
  ).toThrow("node types");
  expect(() =>
    parseInterpolatedGlyphFile(variableGlyph("{ref=one;}", "{ref=two;}"), instanceMasters, ""),
  ).toThrow("component references");
  expect(() =>
    parseInterpolatedGlyphFile(
      variableGlyph(line, line, ',{layerId=EXTRA;name="{350}";shapes=();}'),
      instanceMasters,
      "",
    ),
  ).toThrow("intermediate or alternate");
  expect(() =>
    parseInterpolatedGlyphFile(
      variableGlyph(line, line, ",{layerId=EXTRA;attributes={coordinates=(350);};shapes=();}"),
      instanceMasters,
      "",
    ),
  ).toThrow("intermediate or alternate");
  expect(
    parseInterpolatedGlyphFile(
      variableGlyph(line, line, ',{layerId=BACKUP;name="Mar 6, 22 1:29";shapes=();}'),
      instanceMasters,
      "",
    ).shapes,
  ).toHaveLength(1);
  expect(() =>
    parseInterpolatedGlyphFile(variableGlyph("{ref=one;}", "{ref=one;angle=10;}"), instanceMasters, ""),
  ).toThrow("unsupported component angle");
});

test("interpolation rejects invalid coefficient models rather than extrapolating", () => {
  const source = variableGlyph(contour("(0,0,l),(1,1,l)"), contour("(0,0,l),(2,2,l)"));
  for (const masters of [
    [],
    [{ layerId: "LOW", factor: 1 }],
    [
      { layerId: "LOW", factor: 0.5 },
      { layerId: "LOW", factor: 0.5 },
    ],
    [
      { layerId: "LOW", factor: -0.5 },
      { layerId: "HIGH", factor: 1.5 },
    ],
    [
      { layerId: "LOW", factor: 0.2 },
      { layerId: "HIGH", factor: 0.2 },
    ],
    [
      { layerId: "LOW", factor: Number.NaN },
      { layerId: "HIGH", factor: 1 },
    ],
  ])
    expect(() => parseInterpolatedGlyphFile(source, masters, "")).toThrow("positive finite factors");
});
