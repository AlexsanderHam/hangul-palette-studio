import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareFontWeightSources, prepareOfficialFontSources } from "../../src/font/inputs.ts";
import { decodeGlyphSource } from "../../src/font/source/document.ts";

const root = resolve(import.meta.dir, "../..");
const python = join(
  root,
  ".cache/font-export-venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const runIntegration = process.env.STUDIO_FONT_INTEGRATION === "1";

test.skipIf(!runIntegration)(
  "official v1 container preserves originals and v0 layers deterministically with changed paint order",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "studio-official-color-font-"));
    try {
      const { raw, classifications } = decodeGlyphSource(
        JSON.parse(await readFile(join(root, "data/glyphs.json"), "utf8")),
      );
      const [sources, official] = await Promise.all([
        prepareFontWeightSources(root),
        prepareOfficialFontSources(root),
      ]);
      const samples = new Set("가값과밖휺쌀썰쐆괬딨폈클콥닄셱휅뭫붷쉏웧줳퀗풯엥ㅋ");
      const select = (value: typeof raw) =>
        Object.fromEntries(
          value.sets
            .flatMap(([, , glyphs]) => glyphs)
            .filter(([char]) => samples.has(char))
            .map(([char, advance, paths]) => [char, [advance, paths]]),
        );
      const input = join(directory, "samples.json");
      await writeFile(
        input,
        JSON.stringify({
          regular: select(raw),
          black: select(sources.black),
          bold: select(sources.bold),
          "extra-light": select(sources["extra-light"]),
          classifications: Object.fromEntries([...samples].map((char) => [char, classifications[char]])),
          official: {
            regular: official.regular,
            black: official.black,
            bold: official.bold,
            "extra-light": official["extra-light"],
          },
        }),
      );
      const script = `
import base64, copy, io, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "src/font/compiler"))
from regions import resolve_glyph_regions
from official import OfficialFontError, build_official_font, validate_official_font, color_layer_sequences, _partition, _glyph_path, _check_filled_points, _coordinate_error, _inside
from export import validate_semantics
from weights import PROFILES
from fontTools.ttLib import TTFont
import pathops
value = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
contract = json.loads((Path(sys.argv[1]) / "src/font/compiler/contract.json").read_text(encoding="utf-8"))
checks = 0
for identity in ["regular", "black"]:
    profile = PROFILES[identity]
    source = base64.b64decode(value["official"][identity]["data"], validate=True)
    glyphs = [resolve_glyph_regions(char, advance, paths, value["classifications"][char], contract["slots"], identity,
                           value["regular"][char][1] if identity != "regular" else None)
              for char, (advance, paths) in value[identity].items()]
    first, audit = build_official_font(glyphs, contract, profile, source)
    second, second_audit = build_official_font(glyphs, contract, profile, source)
    assert first == second and audit == second_audit
    verification = validate_official_font(first, source, glyphs, contract, profile)
    assert all(verification["originalPreservation"].values())
    assert verification["checks"]["decodedOriginalGlyphs"] == 14716
    assert verification["checks"]["independentFilledPointCharacters"] >= 14
    assert audit["totalGlyphs"] < 65535
    if identity == "black":
        allocation, = verification["officialFillAllocations"]
        assert allocation["char"] == "셱" and allocation["slotId"] == "medial.part1.left-lower-bar"
        assert allocation["sourceContourRef"] == 3
        assert verification["checks"]["independentAllocationOwnershipPoints"] == 2178
        # The calibrated official-only corner follows the user's selection on
        # physical source contour 3; it does not force the former lower-bar ID.
        swap = {"medial.part1.left-upper-bar": "medial.part1.left-lower-bar",
                "medial.part1.left-lower-bar": "medial.part1.left-upper-bar"}
        assignment = [[ref, swap.get(slot, slot)] for ref, slot in value["classifications"]["셱"]]
        advance, paths = value[identity]["셱"]
        edited_glyph = resolve_glyph_regions("셱", advance, paths, assignment, contract["slots"], identity,
                                     value["regular"]["셱"][1])
        validate_semantics([edited_glyph], profile)
        edited, edited_report = build_official_font([edited_glyph], contract, profile, source)
        edited_validation = validate_official_font(edited, source, [edited_glyph], contract, profile)
        assert all(edited_validation["originalPreservation"].values())
        assert edited_report["officialFillAllocations"][0]["slot"] == 6
        with TTFont(io.BytesIO(first)) as before, TTFont(io.BytesIO(edited)) as after:
            def corner_owners(font):
                glyphset = font.getGlyphSet()
                layers = color_layer_sequences(font)[font.getBestCmap()[ord("셱")]]
                return [slot for slot in (0, 6, 7) if any(
                    _inside(_glyph_path(glyphset[name], simplify=False), (930, 874))
                    for name, index in layers if index == slot)]
            assert corner_owners(before) == [7] and corner_owners(after) == [6]
    else:
        assert verification["officialFillAllocations"] == []
    if identity == "regular":
        # A direct same-parent feature edit must reach actual COLR ownership.
        # The compiler must not infer the former body/bar labels back again.
        assignment = [[ref, "initial.part1.body" if slot == "initial.part1.added-bar" else "initial.part1.added-bar"]
                      for ref, slot in value["classifications"]["ㅋ"]]
        advance, paths = value[identity]["ㅋ"]
        edited_glyph = resolve_glyph_regions("ㅋ", advance, paths, assignment, contract["slots"])
        assert {ref: region["slotId"] for region in edited_glyph["regions"] for ref in region["contourRefs"]} == dict(assignment)
        validate_semantics([edited_glyph], profile)
        edited, _ = build_official_font([edited_glyph], contract, profile, source)
        validate_official_font(edited, source, [edited_glyph], contract, profile)
        with TTFont(io.BytesIO(first)) as before, TTFont(io.BytesIO(edited)) as after:
            point = (1000 * 2048 / 2896, 1600 * 2048 / 2896)
            def colored_at(font, slot):
                glyphset = font.getGlyphSet()
                layers = color_layer_sequences(font)[font.getBestCmap()[ord("ㅋ")]]
                return any(_inside(_glyph_path(glyphset[name], simplify=False), point)
                           for name, index in layers if index == slot)
            assert colored_at(before, 0) and not colored_at(before, 2)
            assert colored_at(after, 2) and not colored_at(after, 0)
    changed = copy.deepcopy(glyphs)
    selected = next(glyph for glyph in changed if glyph["char"] == "가")
    selected["regions"].reverse()
    different, _ = build_official_font(changed, contract, profile, source)
    assert different != first
    validate_official_font(different, source, changed, contract, profile)
    with TTFont(io.BytesIO(first)) as a, TTFont(io.BytesIO(different)) as b:
        name = a.getBestCmap()[ord("가")]
        assert [slot for _, slot in color_layer_sequences(a)[name]] == list(reversed(
            [slot for _, slot in color_layer_sequences(b)[name]]))
    try:
        build_official_font(glyphs, contract, profile, source[:-1] + bytes([source[-1] ^ 1]))
    except OfficialFontError as error:
        assert error.code == "unsupported_official_source"
    else:
        raise AssertionError("Modified official source was accepted")
    broken = copy.deepcopy(glyphs)
    broken[0]["regions"][0]["d"] = ""
    try:
        build_official_font(broken, contract, profile, source)
    except OfficialFontError as error:
        assert error.code == "official_geometry"
        assert error.diagnostics[0]["char"] == broken[0]["char"]
    else:
        raise AssertionError("Missing semantic geometry was accepted")
    checks += 1
guard_regressions = 0
for identity, chars in [("extra-light", "휅"), ("bold", "뭫붷쉏웧줳퀗풯엥")]:
    data = base64.b64decode(value["official"][identity]["data"], validate=True)
    roundtrip_glyphs = []
    with TTFont(io.BytesIO(data)) as font:
        glyphset, cmap = font.getGlyphSet(), font.getBestCmap()
        for char in chars:
            advance, paths = value[identity][char]
            glyph = resolve_glyph_regions(char, advance, paths, value["classifications"][char], contract["slots"], identity,
                                   value["regular"][char][1])
            roundtrip_glyphs.append(glyph)
            base = glyphset[cmap[ord(char)]]
            original = _glyph_path(base)
            pieces, audit = _partition(original, glyph["regions"], font["head"].unitsPerEm / 2896, char, identity)
            assert audit["remainingArea"] <= 0.1 and audit["xorArea"] <= 0.1
            assert _check_filled_points(base, [piece for _, piece in pieces], original.bounds) == 289
            if identity == "bold":
                assert audit["maskExpansionStrategy"] == "translated-mask-copies"
            guard_regressions += 1
    compiled, _ = build_official_font(roundtrip_glyphs, contract, PROFILES[identity], data)
    validated = validate_official_font(compiled, data, roundtrip_glyphs, contract, PROFILES[identity])
    assert all(validated["originalPreservation"].values())
    assert validated["maximumDecodedCoordinateError"] <= 1 / 1024
    with TTFont(io.BytesIO(data)) as original, TTFont(io.BytesIO(compiled)) as decoded:
        source_glyphs, output_glyphs = original.getGlyphSet(), decoded.getGlyphSet()
        for char in chars:
            base = decoded.getBestCmap()[ord(char)]
            pieces = [_glyph_path(output_glyphs[name], simplify=False)
                      for name, _ in color_layer_sequences(decoded)[base]]
            assert _check_filled_points(source_glyphs[base], pieces, _glyph_path(source_glyphs[base]).bounds) == 289
# The Type 2 optimizer may merge forward collinear line runs. This preserves
# the exact polygon; a reversal or a noncollinear intermediate point does not
# receive that canonicalization.
def polygon(points):
    path = pathops.Path()
    path.moveTo(*points[0])
    for point in points[1:]:
        path.lineTo(*point)
    path.close()
    return path
reference = polygon([(0, 0), (0, 10), (10, 10)])
assert _coordinate_error(reference, polygon([(0, 0), (0, 5), (0, 10), (10, 10)])) == 0
for changed in [polygon([(0, 0), (0, 12), (0, 10), (10, 10)]),
                polygon([(0, 0), (0.0001, 5), (0, 10), (10, 10)])]:
    try:
        _coordinate_error(reference, changed)
    except ValueError:
        pass
    else:
        raise AssertionError("A non-equivalent line run was silently canonicalized")
print(json.dumps({"passed": True, "weights": checks, "guardRegressions": guard_regressions}))
`;
      const result = Bun.spawnSync([python, "-c", script, root, input], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ passed: true, weights: 2, guardRegressions: 9 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  300_000,
);
