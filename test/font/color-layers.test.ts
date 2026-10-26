import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const python = join(
  root,
  ".cache/font-export-venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);

test.skipIf(!existsSync(python))(
  "color font validation rejects missing, inconsistent or unsupported modern and legacy paint definitions",
  () => {
    const script = `
import copy, io, json, sys
sys.path.insert(0, "src/font/compiler")
from official import OfficialFontError, build_color_layers, color_layer_audit, color_layer_sequences
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.otTables import Paint, PaintFormat

order = [".notdef", "base-a", "base-b", "left", "right"]
expected = {"base-a": [("left", 0), ("right", 5)], "base-b": [("left", 7), ("right", 19)]}
glyph_map = {name: index for index, name in enumerate(order)}
builder = FontBuilder(1000, isTTF=False)
builder.setupGlyphOrder(order)
builder.setupCharacterMap({ord("가"): "base-a", ord("나"): "base-b"})
builder.setupHorizontalMetrics({name: (600, 0) for name in order})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable({"familyName": "Color Layer Test", "styleName": "Regular", "psName": "ColorLayerTest-Regular"})
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
charstrings = {}
for name in order:
    pen = T2CharStringPen(600, None)
    pen.moveTo((0, 0)); pen.lineTo((100, 0)); pen.lineTo((0, 100)); pen.closePath()
    charstrings[name] = pen.getCharString()
builder.setupCFF("ColorLayerTest-Regular", {}, charstrings, {})
builder.font["COLR"] = build_color_layers(expected, glyph_map)
builder.font["CPAL"] = buildCPAL([[(0, 0, 0, 1)] * 20])
builder.font.flavor = "woff2"
output = io.BytesIO(); builder.font.save(output)
font = TTFont(io.BytesIO(output.getvalue()))
assert color_layer_sequences(font) == expected
audit = color_layer_audit(font)
assert audit == {"colrVersion": 1, "v0Glyphs": 2, "v0LayerRecords": 4,
                 "v1Glyphs": 2, "v1LayerRecords": 4, "v1LayerReferences": 4,
                 "v0FallbackMatchesV1": True}
before = font["COLR"].compile(font)
assert color_layer_sequences(font) == expected and font["COLR"].compile(font) == before
# FontTools optimizes one-layer paint lists into real PaintGlyph roots. Such a
# font may legitimately omit LayerList while retaining complete v1 definitions.
single = copy.deepcopy(font)
single["COLR"] = build_color_layers({"base-a": [("left", 0)]}, glyph_map)
output = io.BytesIO(); single.save(output)
single = TTFont(io.BytesIO(output.getvalue()))
assert single["COLR"].table.LayerList is None
assert color_layer_sequences(single) == {"base-a": [("left", 0)]}
assert color_layer_audit(single) == {"colrVersion": 1, "v0Glyphs": 1, "v0LayerRecords": 1,
                                    "v1Glyphs": 1, "v1LayerRecords": 0, "v1LayerReferences": 1,
                                    "v0FallbackMatchesV1": True}

def root_paint(candidate):
    return candidate["COLR"].table.BaseGlyphList.BaseGlyphPaintRecord[0].Paint
def first_paint(candidate):
    root = root_paint(candidate)
    assert root.Format == PaintFormat.PaintColrLayers and root.NumLayers == 2
    return candidate["COLR"].table.LayerList.Paint[root.FirstLayerIndex]
def legacy_order(candidate):
    table = candidate["COLR"].table
    base = table.BaseGlyphRecordArray.BaseGlyphRecord[0]
    start = base.FirstLayerIndex
    table.LayerRecordArray.LayerRecord[start:start + base.NumLayers] = list(reversed(
        table.LayerRecordArray.LayerRecord[start:start + base.NumLayers]))
def modern_order(candidate):
    root = root_paint(candidate)
    values = candidate["COLR"].table.LayerList.Paint
    start = root.FirstLayerIndex
    values[start:start + root.NumLayers] = list(reversed(values[start:start + root.NumLayers]))
def missing_modern(candidate):
    table = candidate["COLR"].table.BaseGlyphList
    table.BaseGlyphPaintRecord.pop(); table.BaseGlyphCount -= 1
def missing_legacy(candidate):
    table = candidate["COLR"].table
    table.BaseGlyphRecordArray.BaseGlyphRecord.pop(); table.BaseGlyphRecordCount -= 1
def empty_modern(candidate):
    table = candidate["COLR"].table.BaseGlyphList
    table.BaseGlyphPaintRecord = []; table.BaseGlyphCount = 0
def no_legacy(candidate):
    table = candidate["COLR"].table
    table.BaseGlyphRecordArray = None; table.BaseGlyphRecordCount = 0
    table.LayerRecordArray = None; table.LayerRecordCount = 0
def cycle(candidate):
    root = root_paint(candidate)
    candidate["COLR"].table.LayerList.Paint[root.FirstLayerIndex] = root
def missing_table(candidate):
    del candidate["COLR"]
def nested_layers(candidate, count):
    table = candidate["COLR"].table
    # Keep child paints before their parents: validating the layer list first
    # memoizes every child before a later base glyph reaches the full depth.
    for index in range(count):
        paint = Paint()
        paint.Format = PaintFormat.PaintColrLayers
        paint.FirstLayerIndex = 0 if index == 0 else len(table.LayerList.Paint) - 1
        paint.NumLayers = 2 if index == 0 else 1
        table.LayerList.Paint.append(paint)
    table.LayerList.LayerCount = len(table.LayerList.Paint)
    root = root_paint(candidate)
    root.FirstLayerIndex = len(table.LayerList.Paint) - 1
    root.NumLayers = 1
    output = io.BytesIO(); candidate.save(output)
    return TTFont(io.BytesIO(output.getvalue()))

# The drawing sequence is unchanged by nested layer lists. Shallow nesting and
# the inclusive depth-64 boundary remain valid after a real binary round trip.
for count in (3, 63):
    assert color_layer_sequences(nested_layers(copy.deepcopy(font), count)) == expected

cases = {
    "legacy layer order differs": legacy_order,
    "modern layer order differs": modern_order,
    "modern palette differs": lambda f: setattr(first_paint(f).Paint, "PaletteIndex", 1),
    "modern glyph differs": lambda f: setattr(first_paint(f), "Glyph", "right"),
    "modern alpha differs": lambda f: setattr(first_paint(f).Paint, "Alpha", 0.5),
    "modern palette out of range": lambda f: setattr(first_paint(f).Paint, "PaletteIndex", 20),
    "modern glyph is missing": lambda f: setattr(first_paint(f), "Glyph", "absent"),
    "modern layer range is truncated": lambda f: setattr(root_paint(f), "NumLayers", 200),
    "unsupported modern paint": lambda f: setattr(first_paint(f), "Format", PaintFormat.PaintTransform),
    "paint cycle": cycle,
    "memoized child-first graph exceeds depth limit": lambda f: nested_layers(f, 72),
    "modern glyph missing": missing_modern,
    "legacy glyph missing": missing_legacy,
    "empty modern list": empty_modern,
    "legacy representation missing": no_legacy,
    "COLR table missing": missing_table,
    "legacy-only format": lambda f: f.__setitem__("COLR", buildCOLR(expected, version=0, glyphMap=glyph_map)),
}
rejected = []
for label, mutate in cases.items():
    broken = copy.deepcopy(font)
    replacement = mutate(broken)
    if replacement is not None:
        broken = replacement
    try:
        color_layer_sequences(broken)
    except OfficialFontError as error:
        assert error.code == "font_validation", (label, error.code)
        rejected.append(label)
    else:
        raise AssertionError("Invalid color layers were accepted: " + label)
assert color_layer_sequences(font) == expected and font["COLR"].compile(font) == before
print(json.dumps({"rejected": len(rejected), "singleLayerPaintSupported": True,
                  "depthBoundarySupported": True, "originalUnchanged": True}))
`;
    const result = Bun.spawnSync([python, "-c", script], { cwd: root, timeout: 30_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      rejected: 17,
      singleLayerPaintSupported: true,
      depthBoundarySupported: true,
      originalUnchanged: true,
    });
  },
  35_000,
);
