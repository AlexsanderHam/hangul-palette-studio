import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareFontWeightSources } from "../../src/font/inputs.ts";
import { decodeGlyphSource } from "../../src/font/source/document.ts";

const root = resolve(import.meta.dir, "../..");
const python = join(
  root,
  ".cache/font-export-venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const runWholeFont = process.env.STUDIO_FONT_INTEGRATION === "1";

test.skipIf(!runWholeFont)(
  "weight calibration refuses mislabeled geometry and preserves explicit regions and calibrated junction masks",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "studio-weight-profiles-"));
    try {
      const sources = await prepareFontWeightSources(root);
      const { raw, classifications } = decodeGlyphSource(
        JSON.parse(await readFile(join(root, "data/glyphs.json"), "utf8")),
      );
      const input = join(directory, "profiles.json");
      await writeFile(
        input,
        JSON.stringify({
          ...sources,
          regular: raw,
          classifications,
        }),
      );
      const script = `
import copy, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "src/font/compiler"))
from regions import bounds, resolve_glyph_regions
from weights import PROFILES, source_profile
value = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
slots = json.loads((Path(sys.argv[1]) / "src/font/compiler/contract.json").read_text(encoding="utf-8"))["slots"]
glyphs = {weight: {char: (advance, paths) for _, _, items in value[weight]["sets"] for char, advance, paths in items} for weight in PROFILES}
for weight in PROFILES:
    assert source_profile(value[weight], weight) == PROFILES[weight]

def refuses(raw, weight, message):
    try:
        source_profile(raw, weight)
    except ValueError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("Mislabeled or modified source was accepted")

refuses(value["light"], "bold", "instance does not match")
refuses(value["regular"], "light", "requires verified extraction")
# Metadata alone cannot turn Light geometry into Bold.
original = value["light"]["provenance"]["instance"]
value["light"]["provenance"]["instance"] = value["bold"]["provenance"]["instance"]
refuses(value["light"], "bold", "full source geometry differs")
value["light"]["provenance"]["instance"] = original
path = value["light"]["sets"][0][2][0][2][0]
original = path[0]
path[0] += " "
refuses(value["light"], "light", "full source geometry differs")
path[0] = original

refuses({**value["bold"], "provenance": {**value["bold"]["provenance"], "instance": []}}, "bold", "instance does not match")

def resolve_regions(weight, char, paths=None):
    advance, source = glyphs[weight][char]
    return resolve_glyph_regions(char, advance, source if paths is None else paths,
                          value["classifications"][char], slots, weight,
                          glyphs["regular"][char][1] if weight != "regular" else None)

checks = 0
for weight in PROFILES:
    for char in "가과값밖껴쬸휺꿏꿼럶렮쮲텲퇆몋":
        glyph = resolve_regions(weight, char)
        assert sorted(ref for region in glyph["regions"] for ref in region["contourRefs"]) == list(range(len(glyph["contours"])))
        positions = {region["id"]: index for index, region in enumerate(glyph["regions"])}
        assert all(positions[item["under"]] < positions[item["over"]] for item in glyph["paintConstraints"])
        remap = {1: 12, 12: 1} if char == "휺" and PROFILES[weight].weight >= 500 else {}
        expected = {remap.get(ref, ref): slot_id for ref, slot_id in value["classifications"][char]}
        assert {ref: region["slotId"] for region in glyph["regions"] for ref in region["contourRefs"]} == expected
        checks += 1
    # These corrections now belong to the saved explicit baseline, not a
    # geometry heuristic which could override explicit region assignments.
    assert resolve_regions(weight, "껴")["semanticOverrides"] == []
    assert resolve_regions(weight, "쬸")["semanticOverrides"] == []

# A source index alone is not a semantic identity across masters: the heavy
# vowel branch and ㅎ stem exchange indices. Verify the actual source contour
# in each semantic region, without a compensating geometry extension.
for weight, profile in PROFILES.items():
    glyph = resolve_regions(weight, "휺")
    heavy = profile.weight >= 500
    by_slot = {region["slotId"]: region for region in glyph["regions"]}
    assert by_slot["medial.part1.right-vertical"]["contourRefs"] == [12 if heavy else 1]
    assert set(by_slot["final.part2.body"]["contourRefs"]) == {9, 10, 11, 1 if heavy else 12}
    assert len(glyph["semanticOverrides"]) == (2 if heavy else 0)
    if weight != "regular":
        assert glyph["geometryOverrides"] == []
    if heavy:
        assert all(region["d"] == " ".join(glyphs[weight]["휺"][1][ref][0]
                   for ref in region["contourRefs"]) for region in glyph["regions"])
        try:
            advance, paths = glyphs[weight]["휺"]
            resolve_glyph_regions("휺", advance, paths, value["classifications"]["휺"], slots, weight)
        except ValueError as error:
            assert "requires its calibrated Regular reference" in str(error), str(error)
        else:
            raise AssertionError("Heavy master semantics accepted without its reference correspondence")
# Regular alone retains the genuine source gap beneath its vowel support.
glyph = resolve_regions("regular", "휺")
fix, = glyph["geometryOverrides"]
assert bounds(fix["beforeD"])[1] > bounds(fix["supportD"])[3]
assert bounds(fix["afterD"])[1] < bounds(fix["supportD"])[3]
branch = next(region for region in glyph["regions"] if fix["contourRef"] in region["contourRefs"])
support = next(region for region in glyph["regions"] if fix["supportRef"] in region["contourRefs"])
assert glyph["regions"].index(branch) < glyph["regions"].index(support)
# Only Thin 몋 contains the two calibrated horizontal source gaps.
thin = resolve_regions("thin", "몋")
assert [fix["contourRef"] for fix in thin["geometryOverrides"]] == [0, 1]
for fix in thin["geometryOverrides"]:
    before, support, after = map(bounds, (fix["beforeD"], fix["supportD"], fix["afterD"]))
    assert before[2] < support[0] < after[2] < support[2]
for weight in PROFILES:
    if weight != "thin":
        assert resolve_regions(weight, "몋")["geometryOverrides"] == []
changed = copy.deepcopy(glyphs["thin"]["몋"][1])
changed[0][0] += " "
try:
    resolve_regions("thin", "몋", changed)
except ValueError as error:
    assert "correction no longer matches" in str(error), str(error)
else:
    raise AssertionError("A changed Thin junction contour bypassed its source guard")
# Check the calibrated source masks directly with the geometry engine used by
# the compiler. Decoded output preservation is tested in official-output/export.
import pathops
from fontTools.pens.recordingPen import RecordingPen
from fontTools.svgLib.path import parse_path

def source_path(d):
    path = pathops.Path()
    parse_path(d, path.getPen())
    return path

def filled_overlap(first, second):
    return abs(pathops.op(first, second, pathops.PathOp.INTERSECTION).area) > 0

square = source_path("M0 0L10 0L10 10L0 10Z")
assert not filled_overlap(square, source_path("M20 0L30 0L30 10L20 10Z"))
assert not filled_overlap(square, source_path("M10 0L20 0L20 10L10 10Z"))
assert filled_overlap(square, source_path("M5 5L15 5L15 15L5 15Z"))
# Bounding boxes overlap, but the actual triangular fills do not.
first = source_path("M0 0L10 0L0 10Z")
second = source_path("M8 8L18 8L8 18Z")
assert not filled_overlap(first, second)
for fix in thin["geometryOverrides"]:
    support = source_path(fix["supportD"])
    assert not filled_overlap(source_path(fix["beforeD"]), support)
    assert filled_overlap(source_path(fix["afterD"]), support)
# Thin 롸 has a shallow genuine intersection; retain that junction regression
# without keeping the obsolete sampling algorithm in production.
shallow = resolve_regions("thin", "롸")
branch = next(region for region in shallow["regions"] if region["slotId"] == "medial.part1.vertical")
support = next(region for region in shallow["regions"] if region["slotId"] == "medial.part1.horizontal")
assert filled_overlap(source_path(branch["d"]), source_path(support["d"]))
# Bold has valid vertical vowel branches wider than their remaining height.
# Stored constituent identity survives even when the final ratio changes.
short = resolve_regions("bold", "꿏")
verticals = [region for region in short["regions"] if region["slotId"] == "medial.part1.vertical"]
assert verticals
assert any((lambda box: box[2]-box[0] > box[3]-box[1])(bounds(region["d"])) for region in verticals)
# Audit the original failure mechanism throughout all 1,197 final ㄶ/ㅀ/ㅎ
# syllables in every weight. A ㅎ consists of two curved ring contours and
# two rectangles (stem and crossbar). Their actual filled rectangles must
# share positive area; preserving assignment IDs alone is insufficient.
def rectangle(d):
    pen = RecordingPen()
    parse_path(d, pen)
    records = pen.value
    if (not records or records[0][0] != "moveTo" or records[-1][0] != "closePath"
            or any(record[0] != "lineTo" for record in records[1:-1])):
        return None
    points = [record[1][0] for record in records[:-1]]
    if len(points) > 1 and points[-1] == points[0]:
        points.pop()
    if len(points) != 4 or len(set(points)) != 4:
        return None
    if len({p[0] for p in points}) != 2 or len({p[1] for p in points}) != 2:
        return None
    if any(a[0] != b[0] and a[1] != b[1] for a, b in zip(points, points[1:] + points[:1])):
        return None
    return bounds(d)

hieuh_checks = 0
for weight in PROFILES:
    selected = 0
    for char in glyphs[weight]:
        code = ord(char) - 0xAC00
        if not 0 <= code < 11172 or code % 28 not in (6, 15, 27):
            continue
        glyph = resolve_regions(weight, char)
        slot_id = "final.part1.body" if code % 28 == 27 else "final.part2.body"
        region, = [r for r in glyph["regions"] if r["slotId"] == slot_id]
        assert len(region["contourRefs"]) == 4, (weight, char, region)
        rectangles = [box for ref in region["contourRefs"]
                      if (box := rectangle(glyph["contours"][ref]["d"])) is not None]
        assert len(rectangles) == 2, (weight, char, rectangles)
        a, b = rectangles
        assert max(a[0], b[0]) < min(a[2], b[2]) and max(a[1], b[1]) < min(a[3], b[3]), (
            weight, char, "final Hieuh stem is detached from its own crossbar", region["contourRefs"], rectangles)
        selected += 1
    assert selected == 1197, (weight, selected)
    hieuh_checks += selected
    bounds.cache_clear()
print(json.dumps({"profiles": len(PROFILES), "sampleChecks": checks, "exactCorrections": True,
                  "thickBranches": True, "hieuhAttachments": hieuh_checks}))
`;
      const child = Bun.spawn([python, "-c", script, root, input], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        profiles: 9,
        sampleChecks: 135,
        exactCorrections: true,
        thickBranches: true,
        hieuhAttachments: 10773,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
