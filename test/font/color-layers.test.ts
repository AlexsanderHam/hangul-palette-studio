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
  "color font validation requires an empty v1 container and complete valid v0 layers",
  () => {
    const script = `
import copy, io, json, struct, sys
sys.path.insert(0, "src/font/compiler")
from official import OfficialFontError, build_color_layers, color_layer_audit, color_layer_sequences
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.otTables import PaintFormat

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

def roundtrip(candidate):
    output = io.BytesIO(); candidate.save(output)
    return TTFont(io.BytesIO(output.getvalue()))

font = roundtrip(builder.font)
assert color_layer_sequences(font) == expected
assert color_layer_audit(font) == {"colrVersion": 1, "v0Glyphs": 2, "v0LayerRecords": 4,
                                  "v1Glyphs": 0, "v1LayerRecords": 0, "v1LayerReferences": 0}
# Inspect the actual encoded offset, not only FontTools' decoded object. The
# required modern list is present and empty; all drawing stays in v0 records.
data = font.reader["COLR"]
base_list_offset, *optional_offsets = struct.unpack_from(">IIIII", data, 14)
assert base_list_offset > 0 and struct.unpack_from(">I", data, base_list_offset)[0] == 0
assert optional_offsets == [0, 0, 0, 0]
before = font["COLR"].compile(font)
assert color_layer_sequences(font) == expected and font["COLR"].compile(font) == before

single = copy.deepcopy(font)
single["COLR"] = build_color_layers({"base-a": [("left", 0)]}, glyph_map)
single = roundtrip(single)
assert color_layer_sequences(single) == {"base-a": [("left", 0)]}
assert color_layer_audit(single) == {"colrVersion": 1, "v0Glyphs": 1, "v0LayerRecords": 1,
                                    "v1Glyphs": 0, "v1LayerRecords": 0, "v1LayerReferences": 0}

# V0 order and indices are authoritative. A valid change must survive a real
# binary round trip and be returned exactly, without sorting or reclassification.
edited = copy.deepcopy(font)
edited_table = edited["COLR"].table
edited_table.LayerRecordArray.LayerRecord[:2] = list(reversed(edited_table.LayerRecordArray.LayerRecord[:2]))
edited_table.LayerRecordArray.LayerRecord[0].PaletteIndex = 9
edited_table.LayerRecordArray.LayerRecord[0].LayerGlyph = "left"
assert color_layer_sequences(roundtrip(edited)) == {
    "base-a": [("left", 9), ("left", 0)], "base-b": expected["base-b"]}

def table(candidate):
    return candidate["COLR"].table
def first_base(candidate):
    return table(candidate).BaseGlyphRecordArray.BaseGlyphRecord[0]
def first_layer(candidate):
    return table(candidate).LayerRecordArray.LayerRecord[0]
def modern_paints(candidate):
    # Reintroducing real paints is a rendering regression on iOS, even when
    # their ordered glyphs and palette entries exactly match the v0 sequence.
    paints = {base: {"Format": PaintFormat.PaintColrLayers,
                     "Layers": [{"Format": PaintFormat.PaintGlyph, "Glyph": name,
                                 "Paint": {"Format": PaintFormat.PaintSolid, "PaletteIndex": index, "Alpha": 1.0}}
                                for name, index in layers]} for base, layers in expected.items()}
    modern = buildCOLR(paints, version=1, glyphMap=glyph_map).table
    table(candidate).BaseGlyphList = modern.BaseGlyphList
    table(candidate).LayerList = modern.LayerList
def missing_table(candidate):
    del candidate["COLR"]
def missing_palette(candidate):
    del candidate["CPAL"]
def missing_bases(candidate):
    table(candidate).BaseGlyphRecordArray = None
    table(candidate).BaseGlyphRecordCount = 0
def missing_layers(candidate):
    table(candidate).LayerRecordArray = None
    table(candidate).LayerRecordCount = 0
def forged_empty_modern(candidate):
    modern_paints(candidate)
    table(candidate).BaseGlyphList.BaseGlyphCount = 0
def reversed_bases(candidate):
    table(candidate).BaseGlyphRecordArray.BaseGlyphRecord.reverse()

cases = {
    "true v1 paint graph": modern_paints,
    "missing required modern list": lambda f: setattr(table(f), "BaseGlyphList", None),
    "missing modern list attribute": lambda f: delattr(table(f), "BaseGlyphList"),
    "forged empty modern list": forged_empty_modern,
    "nonzero modern count": lambda f: setattr(table(f).BaseGlyphList, "BaseGlyphCount", 1),
    "boolean modern count": lambda f: setattr(table(f).BaseGlyphList, "BaseGlyphCount", False),
    "missing modern record list": lambda f: delattr(table(f).BaseGlyphList, "BaseGlyphPaintRecord"),
    "unexpected modern layer list": lambda f: setattr(table(f), "LayerList", object()),
    "unexpected clip list": lambda f: setattr(table(f), "ClipList", object()),
    "unexpected variation index map": lambda f: setattr(table(f), "VarIndexMap", object()),
    "unexpected variation store": lambda f: setattr(table(f), "VarStore", object()),
    "legacy-only format": lambda f: f.__setitem__("COLR", buildCOLR(expected, version=0, glyphMap=glyph_map)),
    "inconsistent COLR header version": lambda f: setattr(table(f), "Version", 0),
    "unsupported palette version": lambda f: setattr(f["CPAL"], "version", 1),
    "COLR table missing": missing_table,
    "CPAL table missing": missing_palette,
    "base records missing": missing_bases,
    "layer records missing": missing_layers,
    "base count mismatch": lambda f: setattr(table(f), "BaseGlyphRecordCount", 1),
    "layer count mismatch": lambda f: setattr(table(f), "LayerRecordCount", 3),
    "base glyph absent": lambda f: setattr(first_base(f), "BaseGlyph", "absent"),
    "base glyph duplicated": lambda f: setattr(table(f).BaseGlyphRecordArray.BaseGlyphRecord[1], "BaseGlyph", "base-a"),
    "base glyph order reversed": reversed_bases,
    "layer glyph absent": lambda f: setattr(first_layer(f), "LayerGlyph", "absent"),
    "layer palette out of range": lambda f: setattr(first_layer(f), "PaletteIndex", 20),
    "layer palette negative": lambda f: setattr(first_layer(f), "PaletteIndex", -1),
    "layer palette boolean": lambda f: setattr(first_layer(f), "PaletteIndex", True),
    "layer slice negative": lambda f: setattr(first_base(f), "FirstLayerIndex", -1),
    "layer slice truncated": lambda f: setattr(first_base(f), "FirstLayerIndex", 3),
    "layer slice empty": lambda f: setattr(first_base(f), "NumLayers", 0),
    "layer count boolean": lambda f: setattr(first_base(f), "NumLayers", True),
}
rejected = []
for label, mutate in cases.items():
    broken = copy.deepcopy(font)
    mutate(broken)
    try:
        color_layer_sequences(broken)
    except OfficialFontError as error:
        assert error.code == "font_validation", (label, error.code)
        rejected.append(label)
    else:
        raise AssertionError("Invalid color layers were accepted: " + label)
assert color_layer_sequences(font) == expected and font["COLR"].compile(font) == before
print(json.dumps({"rejected": len(rejected), "singleLayerSupported": True,
                  "v0EditsPreserved": True, "originalUnchanged": True}))
`;
    const result = Bun.spawnSync([python, "-c", script], { cwd: root, timeout: 30_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      rejected: 31,
      singleLayerSupported: true,
      v0EditsPreserved: true,
      originalUnchanged: true,
    });
  },
  35_000,
);
