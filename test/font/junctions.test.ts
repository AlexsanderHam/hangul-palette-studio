import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareFontWeightSources } from "../../src/font/inputs.ts";
import { decodeGlyphSource } from "../../src/font/source/document.ts";

const root = resolve(import.meta.dir, "../..");
const runWholeFont = process.env.STUDIO_FONT_INTEGRATION === "1";
const weightIds = [
  "thin",
  "extra-light",
  "light",
  "regular",
  "medium",
  "semi-bold",
  "bold",
  "extra-bold",
  "black",
];

test.skipIf(!runWholeFont)(
  "all nine full Hangul weights retain real filled overlap at every medial junction",
  async () => {
    const weightSources = await prepareFontWeightSources(root);
    const { raw, classifications } = decodeGlyphSource(
      JSON.parse(await readFile(join(root, "data/glyphs.json"), "utf8")),
    );
    const directory = await mkdtemp(join(tmpdir(), "studio-junction-audit-"));
    try {
      const input = join(directory, "input.json");
      await writeFile(
        input,
        JSON.stringify({
          sources: { regular: raw, ...weightSources },
          classifications,
        }),
      );
      const python = join(
        root,
        ".cache/font-export-venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
      const script = `
import json, sys
from collections import Counter
from functools import lru_cache
from pathlib import Path
from fontTools.pens.pointInsidePen import PointInsidePen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.svgLib.path import parse_path
sys.path.insert(0, sys.argv[2])
from regions import resolve_glyph_regions, bounds
from weights import source_profile

@lru_cache(maxsize=None)
def recording(d):
    pen = RecordingPen()
    parse_path(d, pen)
    return pen

@lru_cache(maxsize=None)
def rectangle(d):
    records = recording(d).value
    if (not records or records[0][0] != "moveTo" or records[-1][0] != "closePath"
            or any(record[0] != "lineTo" for record in records[1:-1])):
        return None
    points = [record[1][0] for record in records[:-1]]
    if len(points) > 1 and points[-1] == points[0]:
        points.pop()
    if len(points) != 4:
        return None
    xs, ys = {point[0] for point in points}, {point[1] for point in points}
    if len(xs) != 2 or len(ys) != 2 or len(set(points)) != 4:
        return None
    if any(a[0] != b[0] and a[1] != b[1] for a, b in zip(points, points[1:] + points[:1])):
        return None
    return min(xs), min(ys), max(xs), max(ys)

def inside(d, point):
    pen = PointInsidePen(None, point, evenOdd=False)
    recording(d).replay(pen)
    return pen.getResult()

@lru_cache(maxsize=None)
def prove_overlap(first, second):
    a, b = bounds(first), bounds(second)
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x0 >= x1 or y0 >= y1:
        return "disjoint"
    # A single filled rectangle has no curves or holes, so this is exact.
    if rectangle(first) is not None and rectangle(second) is not None:
        return "rectangle"
    # For curves and multipart paths, a common nonzero-filled point proves
    # real intersection. An unsuccessful grid remains unproven and fails.
    samples = [(0.5, 0.5)] + [(x, y) for x in (0.25, 0.5, 0.75)
                             for y in (0.25, 0.5, 0.75) if (x, y) != (0.5, 0.5)]
    for xf, yf in samples:
        point = x0 + (x1 - x0) * xf, y0 + (y1 - y0) * yf
        if inside(first, point) and inside(second, point):
            return "filled-point"
    # Very thin strokes can meet a curved supporting stroke only near the
    # edge of the intersection box. A finer grid still requires an actual
    # point inside both filled outlines; boxes alone never prove a junction.
    for step in range(1, 32):
        point = x0 + (x1 - x0) * 0.5, y0 + (y1 - y0) * step / 32
        if inside(first, point) and inside(second, point):
            return "filled-point"
    for x_step in range(1, 32):
        for y_step in range(1, 32):
            point = x0 + (x1 - x0) * x_step / 32, y0 + (y1 - y0) * y_step / 32
            if inside(first, point) and inside(second, point):
                return "filled-point"
    return "unproven"

# Verify the oracle rejects separated shapes even when their boxes overlap.
assert prove_overlap("M0 0L10 0L10 10L0 10Z", "M20 0L30 0L30 10L20 10Z") == "disjoint"
assert prove_overlap("M0 0L10 0L0 10Z", "M8 8L18 8L8 18Z") == "unproven"
assert prove_overlap("M0 0L10 0L10 10L0 10Z", "M5 5L15 5L15 15L5 15Z") == "rectangle"
# The shallow filled cap is missed by all 3x3 samples but has real overlap.
strip, cap = "M0 0L1 0L1 10L0 10Z", "M0 9.9L20 0L20 10Z"
assert not any(inside(strip, (x, y * 10)) and inside(cap, (x, y * 10))
               for x in (0.25, 0.5, 0.75) for y in (0.25, 0.5, 0.75))
assert prove_overlap(strip, cap) == "filled-point"

payload = json.loads(Path(sys.argv[1]).read_text())
sources, assignments = payload["sources"], payload["classifications"]
slots = json.loads((Path(sys.argv[2]) / "contract.json").read_text())["slots"]
expected = set(map(chr, range(0xAC00, 0xD7A4))) | set(map(chr, range(0x3131, 0x3164)))
glyphs = {}
identities = ("thin", "extra-light", "light", "regular", "medium", "semi-bold", "bold", "extra-bold", "black")
for weight in identities:
    # Validate source provenance AND the entire calibrated geometry fingerprint.
    source_profile(sources[weight], weight)
    items = [glyph for _, _, group in sources[weight]["sets"] for glyph in group]
    glyphs[weight] = {glyph[0]: glyph for glyph in items}
    assert len(items) == len(expected) and set(glyphs[weight]) == expected, weight
assert set(assignments) == expected

summary = {}
for weight in identities:
    counts = Counter()
    for char, (_, advance, paths) in glyphs[weight].items():
        glyph = resolve_glyph_regions(char, advance, paths, assignments[char], slots, weight,
                               None if weight == "regular" else glyphs["regular"][char][2])
        regions = {region["id"]: region for region in glyph["regions"]}
        for constraint in glyph["paintConstraints"]:
            under, over = regions[constraint["under"]], regions[constraint["over"]]
            if not under["slotId"].startswith("medial.") or not over["slotId"].startswith("medial."):
                continue
            proof = prove_overlap(*sorted((under["d"], over["d"])))
            assert proof in ("rectangle", "filled-point"), (
                weight, char, under["slotId"], under["contourRefs"],
                over["slotId"], over["contourRefs"], proof)
            counts[proof] += 1
    summary[weight] = {"glyphs": len(glyphs[weight]), "constraints": sum(counts.values()),
                       "rectangle": counts["rectangle"], "filledPoint": counts["filled-point"],
                       "unproven": counts["unproven"] + counts["disjoint"]}
    bounds.cache_clear()
    recording.cache_clear()
    rectangle.cache_clear()
    prove_overlap.cache_clear()
print(json.dumps(summary))
`;
      const child = Bun.spawn([python, "-c", script, input, join(root, "src/font/compiler")], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 600_000,
        killSignal: "SIGKILL",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr.trim()).toBe("");
      expect(exitCode).toBe(0);
      const summary = JSON.parse(stdout) as Record<
        string,
        {
          glyphs: number;
          constraints: number;
          rectangle: number;
          filledPoint: number;
          unproven: number;
        }
      >;
      expect(Object.keys(summary).sort()).toEqual([...weightIds].sort());
      for (const weight of weightIds) {
        expect(summary[weight]).toMatchObject({ glyphs: 11223, constraints: 17056, unproven: 0 });
        expect(summary[weight]!.rectangle).toBeGreaterThan(0);
        expect(summary[weight]!.filledPoint).toBeGreaterThan(0);
        expect(summary[weight]!.rectangle + summary[weight]!.filledPoint).toBe(17056);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  900_000,
);
