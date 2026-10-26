import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { buildFont, createFontEngine, packageFont } from "../../src/font/build.ts";
import {
  type ColorFontExportOptions,
  type ColorFontExportResult,
  exportColorFont,
  getColorFontStatus,
} from "../../src/font/compiler/bridge.ts";
import officialPins from "../../src/font/compiler/official-sources.json";
import { prepareFontWeightSources, prepareOfficialFontSources } from "../../src/font/inputs.ts";
import { decodeGlyphSource } from "../../src/font/source/document.ts";
import { FONT_VERSION } from "../../src/font/weights.ts";
import { studioFixture } from "../helpers/studio.ts";

const root = resolve(import.meta.dir, "../..");
const weights = [
  { id: "thin", weight: 100, label: "Thin", fontFile: "hangul-palette-thin.woff2" },
  { id: "extra-light", weight: 200, label: "ExtraLight", fontFile: "hangul-palette-extra-light.woff2" },
  { id: "light", weight: 300, label: "Light", fontFile: "hangul-palette-light.woff2" },
  { id: "regular", weight: 400, label: "Regular", fontFile: "hangul-palette-regular.woff2" },
  { id: "medium", weight: 500, label: "Medium", fontFile: "hangul-palette-medium.woff2" },
  { id: "semi-bold", weight: 600, label: "SemiBold", fontFile: "hangul-palette-semi-bold.woff2" },
  { id: "bold", weight: 700, label: "Bold", fontFile: "hangul-palette-bold.woff2" },
  { id: "extra-bold", weight: 800, label: "ExtraBold", fontFile: "hangul-palette-extra-bold.woff2" },
  { id: "black", weight: 900, label: "Black", fontFile: "hangul-palette-black.woff2" },
] as const;
function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function sameBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(
    Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(record[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

/** Inspect the delivered archive bytes, rather than the compiler's manifest alone. */
function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.from(bytes),
    files = new Map<string, Buffer>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6),
      method = buffer.readUInt16LE(offset + 8);
    expect(flags & 8).toBe(0); // The seekable ZIP writer records lengths in each local header.
    const size = buffer.readUInt32LE(offset + 18),
      decodedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26),
      extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    expect(files.has(name)).toBe(false);
    const start = offset + 30 + nameLength + extraLength;
    const packed = buffer.subarray(start, start + size);
    expect([0, 8]).toContain(method);
    const contents = method === 0 ? Buffer.from(packed) : inflateRawSync(packed);
    expect(contents.length).toBe(decodedSize);
    files.set(name, contents);
    offset = start + size;
  }
  expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
  return files;
}

function inspectPackage(result: ColorFontExportResult, input: ColorFontExportOptions): Map<string, Buffer> {
  const files = unzip(result.zip);
  expect([...files.keys()].sort()).toEqual(
    [
      "LICENSE-OFL",
      "NOTICE.txt",
      ...weights.map(({ fontFile }) => fontFile),
      "manifest.json",
      "hangul-palette.css",
      "preview.html",
      "validation.json",
    ].sort(),
  );
  const manifest = JSON.parse(files.get("manifest.json")!.toString());
  expect(manifest).toEqual(result.manifest);
  expect(manifest).toMatchObject({
    complete: true,
    schemaVersion: 1,
    format: "hangul-palette-color-font-v1",
    fontFormat: "WOFF2 / CFF / COLR v1 container with v0 layers / CPAL v0",
    family: "Hangul Palette",
    fontVersion: FONT_VERSION,
    colorPolicy: { fontDefault: "#000000", selectedPalette: "css-only" },
    outlinePolicy: "official-static-font-with-clipped-semantic-layers",
    metrics: { unitsPerEm: 2048, ascender: 1950, descender: -494, hangulAdvanceWidth: 1770 },
    project: input.project,
    counts: {
      characters: 11223,
      modernSyllables: 11172,
      compatibilityJamo: 51,
      slots: 20,
      weights: 9,
    },
    inputs: {
      classificationFormat: "semantic-regions-v1",
      selection: "studio-working-snapshot",
      classificationsSha256: sha(canonical(input.classifications) + "\n"),
    },
    verification: { structural: true, decodedOutlines: true },
  });
  expect(result.glyphCount).toBe(11223);
  expect(result.slotCount).toBe(20);
  expect(Object.keys(result.fonts).sort()).toEqual(weights.map(({ id }) => id).sort());
  expect(
    manifest.weights.map(({ id, weight, label, fontFile }: (typeof weights)[number]) => ({
      id,
      weight,
      label,
      fontFile,
    })),
  ).toEqual(weights);
  const palette = manifest.slots.map((slot: { color: string }) => slot.color);
  expect(manifest.inputs.paletteSha256).toBe(sha(canonical(palette) + "\n"));
  if (input.palette) expect(palette).toEqual(input.palette.map((color) => color.toLowerCase()));
  expect(manifest.slots.map((slot: { index: number }) => slot.index)).toEqual(
    Array.from({ length: 20 }, (_, index) => index),
  );
  for (const [name, data] of files) {
    if (name === "manifest.json") continue;
    expect(manifest.files[name]).toEqual({ bytes: data.length, sha256: sha(data) });
  }
  expect(files.get("hangul-palette-regular.woff2")!.subarray(0, 4).toString()).toBe("wOF2");
  const css = files.get("hangul-palette.css")!.toString();
  expect(css.match(/@font-face/g)).toHaveLength(9);
  expect(css).toContain('@font-palette-values --hangul-palette {font-family:"Hangul Palette";');
  expect(css).toContain('.hangul-palette {font-family:"Hangul Palette",sans-serif;');
  expect(css).not.toContain("hangul-regions");
  expect(files.get("preview.html")!.toString()).toContain("<title>Hangul Palette</title>");
  for (const slot of manifest.slots) {
    expect(css).toContain(`${slot.index} ${slot.color}`);
    expect(css).toContain(slot.id);
  }
  const validation = JSON.parse(files.get("validation.json")!.toString());
  expect(validation.passed).toBe(true);
  expect(Object.keys(validation.weights).sort()).toEqual(weights.map(({ id }) => id).sort());
  for (const profile of weights) {
    const bytes = files.get(profile.fontFile)!;
    const manifestWeight = manifest.weights.find((item: { id: string }) => item.id === profile.id);
    expect(sameBytes(result.fonts[profile.id], bytes)).toBe(true);
    expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
    expect(css).toContain(`url("./${profile.fontFile}")`);
    expect(css).toContain(`font-weight:${profile.weight}`);
    const regionRuns = Object.values(input.classifications).reduce(
      (total, entry) =>
        total + entry.filter(([, region], index) => index === 0 || entry[index - 1]![1] !== region).length,
      0,
    );
    expect(manifestWeight.counts).toMatchObject({
      characters: 11223,
      modernSyllables: 11172,
      compatibilityJamo: 51,
      slots: 20,
      regions: regionRuns,
      sourceContours: 104276,
    });
    expect(manifestWeight.sourceProfile).toMatchObject({ weight: profile.weight });
    expect(manifestWeight.sourceProfile.upstream).toBe(`Pretendard ${profile.label} v1.3.9`);
    expect(manifestWeight.sourceProfile.geometrySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifestWeight.inputs.rawCanonicalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifestWeight.inputs.classificationsSha256).toBe(sha(canonical(input.classifications) + "\n"));
    if (profile.id !== "regular") {
      expect(manifestWeight.inputs.sourceProvenance).toMatchObject({
        repository: "https://github.com/orioncactus/pretendard",
        ref: "v1.3.9",
        revision: "5c41199ea0024a9e0b2cb31735265056e5472d76",
        instance: { name: profile.label, weight: profile.weight },
      });
    }
    const officialSource = {
      repository: officialPins.repository,
      ref: officialPins.ref,
      revision: officialPins.revision,
      ...officialPins.files[profile.id],
    };
    expect(manifestWeight.officialSource).toEqual(officialSource);
    expect(manifestWeight.fontCoverage).toEqual({
      mappedCharacters: 14336,
      coloredCharacters: 11223,
      coloredMappedCharacters: 11274,
      originalGlyphs: 14716,
      monochromeMappedCharacters: 3062,
    });
    expect(validation.weights[profile.id]).toMatchObject({
      schemaVersion: 1,
      passed: true,
      originalGlyphs: 14716,
      originalCmapCharacters: 14336,
      officialSha256: officialSource.sha256,
      partitionReference: "official-static-otf-outline",
      characters: 11223,
      fontSha256: sha(bytes),
      sourceLayerOrderPreserved: true,
      compoundHolesPreserved: true,
      allRegionAndFallbackOutlinesDecoded: true,
      defaultPaletteBlack: true,
    });
    const report = validation.weights[profile.id];
    expect(report.checks).toMatchObject({
      decodedOriginalGlyphs: 14716,
      decodedOfficialFilledOutlines: 11223,
    });
    expect(Object.keys(report.originalPreservation).sort()).toEqual(
      [
        "order",
        "charstrings",
        "globalSubrs",
        "localSubrsFD0",
        "privateFD0Bytes",
        "privateFD0Values",
        "fdSelectOriginal",
        "hmtxOriginalRecords",
        "vmtxOriginalRecords",
        "cmapBytes",
        "unitsPerEm",
        "hheaMetrics",
        "vheaMetrics",
        "os2Metrics",
        "headFontBBox",
        "CFFFontBBox",
        "FD0FontMatrix",
        "glyphIdOrder",
      ].sort(),
    );
    expect(Object.values(report.originalPreservation).every((passed) => passed === true)).toBe(true);
    expect(report.encodedCOLRLayers).toBeGreaterThan(0);
    expect(report.encodedCOLRLayers).toBeLessThanOrEqual(65535);
    expect(report.colorLayers).toEqual({
      colrVersion: 1,
      v0Glyphs: 11223,
      v0LayerRecords: report.encodedCOLRLayers,
      v1Glyphs: 0,
      v1LayerRecords: 0,
      v1LayerReferences: 0,
    });
    expect(report.fontGlyphs).toBeLessThanOrEqual(65535);
    expect(report.maximumDecodedCoordinateError).toBeLessThanOrEqual(report.decodedCoordinateTolerance);
    expect(report.decodedGeometryProof).toBe("matching-cubic-topology-and-bounded-control-points");
    expect(validation.weights[profile.id].checks.compoundHoleOccurrences).toBe(7131);
    const correctedCharacters = profile.id === "thin" ? ["몋"] : profile.weight < 400 ? [] : ["휺"];
    expect(manifestWeight.corrections.map((item: { char: string }) => item.char).sort()).toEqual(
      correctedCharacters.sort(),
    );
  }
  expect(new Set(weights.map(({ fontFile }) => sha(files.get(fontFile)!))).size).toBe(9);
  expect(
    new Set(
      manifest.weights.map(
        (item: { sourceProfile: { geometrySha256: string } }) => item.sourceProfile.geometrySha256,
      ),
    ).size,
  ).toBe(9);
  return files;
}

test("font compiler reports a missing local runtime without downloading or building", async () => {
  const directory = await mkdtemp(join(tmpdir(), "studio-no-font-runtime-"));
  try {
    expect(await getColorFontStatus(directory)).toMatchObject({
      ready: false,
      code: "missing_runtime",
      setupCommand: "bun run setup:font",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("font export rejects incomplete classifications before requiring the compiler runtime", async () => {
  const fixture = await studioFixture();
  try {
    const input: ColorFontExportOptions = {
      root: fixture.directory,
      raw: JSON.parse(fixture.rawText),
      classifications: JSON.parse(fixture.baselineText).classifications,
      project: {
        projectId: "test-project",
        revision: 0,
        rawDigest: sha(fixture.rawText),
        baselineDigest: sha(fixture.baselineText),
      },
    };
    await expect(exportColorFont(input)).rejects.toMatchObject({ code: "invalid_classifications" });
    expect(await readFile(fixture.dataPath, "utf8")).toBe(fixture.dataText);
  } finally {
    await fixture.cleanup();
  }
});

test("font export rejects invalid palette colors before invoking the compiler", async () => {
  const fixture = await studioFixture();
  try {
    const colors = Array.from({ length: 20 }, () => "#123456");
    for (const palette of [
      colors.slice(1),
      [...colors, "#123456"],
      ["#123", ...colors.slice(1)],
      ["#12345678", ...colors.slice(1)],
      ["red", ...colors.slice(1)],
      ["#GG1234", ...colors.slice(1)],
    ]) {
      await expect(
        exportColorFont({
          root: fixture.directory,
          raw: JSON.parse(fixture.rawText),
          classifications: JSON.parse(fixture.baselineText).classifications,
          project: {
            projectId: "palette-test",
            revision: 0,
            rawDigest: sha(fixture.rawText),
            baselineDigest: sha(fixture.baselineText),
          },
          palette,
        }),
      ).rejects.toMatchObject({ code: "invalid_palette" });
    }
  } finally {
    await fixture.cleanup();
  }
});

const runWholeFont = process.env.STUDIO_FONT_INTEGRATION === "1";
test.skipIf(!runWholeFont)(
  "official nine-weight output preserves original font data and reuses exact binaries for CSS palettes",
  async () => {
    expect((await getColorFontStatus(root)).ready).toBe(true);
    const dataPath = join(root, "data/glyphs.json");
    const dataText = await readFile(dataPath, "utf8");
    const { raw, classifications, rawText, baselineText } = decodeGlyphSource(JSON.parse(dataText));
    const weightSources = await prepareFontWeightSources(root);
    const input: ColorFontExportOptions = {
      root,
      raw,
      classifications,
      weightSources,
      onProgress: process.env.STUDIO_FONT_TEST_OUTPUT
        ? (stage, weight) => console.info(`font integration: ${stage}${weight ? ` / ${weight}` : ""}`)
        : undefined,
      project: {
        projectId: "font-export-integration",
        revision: 7,
        rawDigest: sha(rawText),
        baselineDigest: sha(baselineText),
      },
    };
    const directory = await mkdtemp(join(tmpdir(), "studio-official-font-decode-"));
    try {
      // Compile the complete package once. Repackaging exercises deterministic
      // archive output and CSS-only changes without rebuilding nine full fonts.
      const source = { root, raw, classifications, onProgress: input.onProgress };
      const build = await buildFont(source).catch((error) => {
        console.error(JSON.stringify({ code: error.code, diagnostics: error.diagnostics }, null, 2));
        throw error;
      });
      const baseline = await packageFont({ root, build, project: input.project });
      const files = inspectPackage(baseline, input);
      expect(sameBytes(files.get("LICENSE-OFL")!, await readFile(join(root, "LICENSE-OFL")))).toBe(true);
      const notice = files.get("NOTICE.txt")!.toString();
      expect(notice).toContain("independent derivative of Pretendard v1.3.9");
      expect(notice).toContain("Original font copyright (c) 2021, Kil Hyung-jin.");
      expect(notice).toContain("SIL Open Font License 1.1. See LICENSE-OFL.");
      expect(notice).toContain("Pretendard is a Reserved Font Name");
      expect(baseline.filename).toBe("hangul-palette-rev-7.zip");

      const repeat = await packageFont({ root, build, project: input.project });
      expect(sameBytes(repeat.zip, baseline.zip)).toBe(true);
      expect(repeat.manifest).toEqual(baseline.manifest);
      const paletteOnly: ColorFontExportOptions = {
        ...input,
        project: { ...input.project, revision: 8 },
        palette: Array.from(
          { length: 20 },
          (_, index) => "#" + ((index + 1) * 321987).toString(16).padStart(6, "0").toUpperCase(),
        ),
      };
      const recolored = await packageFont({
        root,
        build,
        project: paletteOnly.project,
        palette: paletteOnly.palette,
      });
      const recoloredFiles = inspectPackage(recolored, paletteOnly);
      for (const { id, fontFile } of weights) {
        expect(sameBytes(recolored.fonts[id], baseline.fonts[id])).toBe(true);
        expect(sameBytes(recoloredFiles.get(fontFile)!, files.get(fontFile)!)).toBe(true);
      }
      expect(recolored.manifest.inputs.classificationsSha256).toBe(
        baseline.manifest.inputs.classificationsSha256,
      );
      expect(recolored.manifest.inputs.paletteSha256).not.toBe(baseline.manifest.inputs.paletteSha256);
      expect(sameBytes(recoloredFiles.get("hangul-palette.css")!, files.get("hangul-palette.css")!)).toBe(
        false,
      );
      expect(sameBytes(recoloredFiles.get("validation.json")!, files.get("validation.json")!)).toBe(true);

      // A new engine has no in-memory build records: restore the verified disk
      // build and package it for a different workspace without compilation.
      const restarted = createFontEngine();
      const restored = await restarted.loadFontBuild(source);
      expect(restored?.id).toBe(build.id);
      const otherProject = { ...input.project, projectId: "another-workspace", revision: 99 };
      const resumed = await restarted.packageFont({ root, build: restored!, project: otherProject });
      expect(resumed.manifest.project).toEqual(otherProject);
      for (const { id } of weights) expect(sameBytes(resumed.fonts[id], baseline.fonts[id])).toBe(true);

      // Inspect the actual WOFF2 files against each pinned OTF directly. This
      // audit does not import the production compiler or its validator.
      const officialSources = await prepareOfficialFontSources(root);
      for (const { id, fontFile } of weights) {
        await writeFile(join(directory, fontFile), files.get(fontFile)!);
        await writeFile(join(directory, id + ".otf"), Buffer.from(officialSources[id].data, "base64"));
      }
      const python = join(
        root,
        ".cache/font-export-venv",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
      const script = `
import hashlib, json, struct, sys
from pathlib import Path
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

folder, version = Path(sys.argv[1]), sys.argv[2]
pins = json.loads(Path(sys.argv[3]).read_text())["files"]
profiles = json.loads(sys.argv[4])
expected = set(range(0xAC00, 0xD7A4)) | set(range(0x3131, 0x3164))
major, minor, patch = map(int, version.split("."))
revision = major + (minor * 100 + patch) / 1000
name_version = f"Version {major}.{minor * 100 + patch:03d}; Hangul Palette {version}"

def bytecode(item):
    # Both fonts are decoded from files, so retain their actual Type 2 bytes.
    assert item.bytecode is not None, "An original charstring was unexpectedly recompiled"
    return item.bytecode

def private_bytes(font, top):
    size, offset = top.FDArray[0].rawDict["Private"]
    return font.reader["CFF "][offset:offset + size]

def records(glyph):
    pen = RecordingPen()
    glyph.draw(pen)
    return pen.value

def decoded_color_layers(font):
    # Independent decoding from the shipped binary, without compiler helpers or
    # success flags: a v1 container must draw only its complete v0 records.
    assert font["COLR"].version == 1
    data = font.reader["COLR"]
    base_list_offset, *optional_offsets = struct.unpack_from(">IIIII", data, 14)
    assert base_list_offset > 0 and struct.unpack_from(">I", data, base_list_offset)[0] == 0
    assert optional_offsets == [0, 0, 0, 0]
    table = font["COLR"].table
    assert table.BaseGlyphList is not None
    assert table.BaseGlyphList.BaseGlyphCount == 0 and table.BaseGlyphList.BaseGlyphPaintRecord == []
    assert all(getattr(table, key, None) is None for key in ("LayerList", "ClipList", "VarIndexMap", "VarStore"))
    base_records = table.BaseGlyphRecordArray.BaseGlyphRecord
    layer_records = table.LayerRecordArray.LayerRecord
    assert table.BaseGlyphRecordCount == len(base_records) == 11223
    assert table.LayerRecordCount == len(layer_records)
    legacy = {}
    for item in base_records:
        assert item.BaseGlyph not in legacy and item.NumLayers > 0
        layers = layer_records[item.FirstLayerIndex:item.FirstLayerIndex + item.NumLayers]
        assert len(layers) == item.NumLayers
        legacy[item.BaseGlyph] = [(layer.LayerGlyph, layer.PaletteIndex) for layer in layers]
    return legacy

summary, areas = {}, []
for profile in profiles:
    identity, weight, label = profile["id"], profile["weight"], profile["label"]
    original_path, generated_path = folder / (identity + ".otf"), folder / profile["fontFile"]
    original_bytes = original_path.read_bytes()
    assert len(original_bytes) == pins[identity]["bytes"]
    assert hashlib.sha256(original_bytes).hexdigest() == pins[identity]["sha256"]
    with TTFont(original_path) as original, TTFont(generated_path) as font:
        # Materialize every table, including the Thin–Light vertical metrics.
        for candidate in (original, font):
            for tag in candidate.keys():
                candidate[tag]
        order, output_order = original.getGlyphOrder(), font.getGlyphOrder()
        output_names = set(output_order)
        assert len(order) == 14716 and output_order[:len(order)] == order, identity
        assert font["maxp"].numGlyphs == len(output_order) <= 65535
        source_top, top = original["CFF "].cff.topDictIndex[0], font["CFF "].cff.topDictIndex[0]
        assert len(source_top.FDArray) == 1 and len(top.FDArray) == 2
        assert top.FDSelect.gidArray[:len(order)] == source_top.FDSelect.gidArray
        assert all(index == 1 for index in top.FDSelect.gidArray[len(order):])
        assert top.charset[:len(order)] == source_top.charset
        assert top.CIDCount <= 65535 and max(int(name[3:]) for name in output_order if name.startswith("cid")) <= 65535
        assert list(top.FontBBox) == list(source_top.FontBBox)
        assert list(top.FDArray[0].FontMatrix) == list(source_top.FDArray[0].FontMatrix)
        assert private_bytes(font, top) == private_bytes(original, source_top)
        private, source_private = top.FDArray[0].Private, source_top.FDArray[0].Private
        assert {k: v for k, v in private.rawDict.items() if k != "Subrs"} == {
            k: v for k, v in source_private.rawDict.items() if k != "Subrs"}
        assert [bytecode(item) for item in private.Subrs] == [bytecode(item) for item in source_private.Subrs]
        assert [bytecode(item) for item in font["CFF "].cff.GlobalSubrs] == [
            bytecode(item) for item in original["CFF "].cff.GlobalSubrs]
        assert font.reader["cmap"] == original.reader["cmap"]
        cmap, source_cmap = font.getBestCmap(), original.getBestCmap()
        assert cmap == source_cmap and len(cmap) == 14336 and expected <= set(cmap)
        assert font["head"].unitsPerEm == original["head"].unitsPerEm == 2048
        assert [getattr(font["head"], field) for field in ("xMin", "yMin", "xMax", "yMax", "macStyle")] == [
            getattr(original["head"], field) for field in ("xMin", "yMin", "xMax", "yMax", "macStyle")]
        for tag in ("hhea", "vhea"):
            assert (tag in font) == (tag in original)
            if tag not in original:
                continue
            fields = ("ascent", "descent", "lineGap", "caretSlopeRise", "caretSlopeRun", "caretOffset")
            assert [getattr(font[tag], field) for field in fields] == [getattr(original[tag], field) for field in fields]
        assert (font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap) == (1950, -494, 0)
        fields = ("sTypoAscender", "sTypoDescender", "sTypoLineGap", "usWinAscent", "usWinDescent",
                  "sxHeight", "sCapHeight", "fsSelection", "fsType", "usWidthClass")
        assert [getattr(font["OS/2"], field) for field in fields] == [getattr(original["OS/2"], field) for field in fields]
        assert font["OS/2"].usWeightClass == original["OS/2"].usWeightClass == weight
        assert font["name"].getDebugName(1) == "Hangul Palette"
        assert font["name"].getDebugName(2) == label
        assert font["name"].getDebugName(6) == "HangulPalette-" + label
        assert font["name"].getDebugName(5) == name_version
        # The same font ships with LICENSE in the distribution and LICENSE-OFL
        # in Studio ZIPs, so its embedded license must not require either name.
        assert font["name"].getDebugName(13) == "SIL Open Font License, Version 1.1."
        assert font["name"].getDebugName(14) == "https://openfontlicense.org/"
        assert abs(font["head"].fontRevision - revision) <= 1 / 65536
        assert top.version == version and font["CFF "].cff.fontNames == ["HangulPalette-" + label]
        assert top.FamilyName == "Hangul Palette"
        for name in order:
            assert bytecode(top.CharStrings[name]) == bytecode(source_top.CharStrings[name]), (identity, name, "charstring")
            assert font["hmtx"][name] == original["hmtx"][name], (identity, name, "horizontal metric")
            if "vmtx" in original:
                assert font["vmtx"][name] == original["vmtx"][name], (identity, name, "vertical metric")
        assert ("vmtx" in font) == ("vmtx" in original)
        assert all(font["hmtx"][cmap[code]][0] == 1770 for code in expected)
        assert len({font["hmtx"][cmap[ord(char)]][0] for char in "iW1! "}) > 1
        assert font["COLR"].version == 1 and font["CPAL"].version == 0
        assert font["CPAL"].numPaletteEntries == 20 and len(font["CPAL"].palettes) == 1
        assert [(c.red, c.green, c.blue, c.alpha) for c in font["CPAL"].palettes[0]] == [(0, 0, 0, 255)] * 20
        colored = decoded_color_layers(font)
        assert len(colored) == 11223 and set(colored) == {cmap[code] for code in expected}
        mapped = {code for code, name in cmap.items() if name in colored}
        aliases = mapped - expected
        assert len(mapped) == 11274 and len(aliases) == 51 and all(0xFFA0 <= code <= 0xFFDC for code in aliases)
        assert all(cmap[ord(char)] not in colored for char in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!?.,()[] ")
        assert {slot for layers in colored.values() for _, slot in layers} == set(range(20))
        layer_records = struct.unpack(">HHIIH", font.reader["COLR"][:14])[-1]
        assert 0 < layer_records <= 65535
        assert all(name in output_names and 0 <= slot < 20
                   for layers in colored.values() for name, slot in layers)
        for char, branch, stem in (("ㅏ", 5, 3), ("ㅗ", 3, 4), ("ㅋ", 2, 0), ("몋", 6, 3), ("몋", 7, 3)):
            slots = [slot for _, slot in colored[cmap[ord(char)]]]
            assert slots.index(branch) < slots.index(stem), (identity, char, slots)
        assert [slot for _, slot in colored[cmap[ord("가")]]] == [5, 3, 0]
        generated_glyphs, original_glyphs = font.getGlyphSet(), original.getGlyphSet()
        for name in order:
            assert records(generated_glyphs[name]) == records(original_glyphs[name]), (identity, name, "decoded outline")
        # New layer programs must also decode independently of the build report.
        for name in output_order[len(order):]:
            assert records(generated_glyphs[name]), (identity, name, "empty color outline")
        pen = AreaPen(generated_glyphs)
        generated_glyphs[cmap[ord("가")]].draw(pen)
        areas.append(abs(pen.value))
        summary[identity] = {"originalGlyphs": len(order), "decodedOriginalGlyphs": len(order),
                             "addedRegionGlyphs": len(output_order) - len(order), "mappedCharacters": len(cmap),
                             "coloredGlyphs": len(colored), "coloredMappedCharacters": len(mapped),
                             "halfwidthAliases": len(aliases), "encodedCOLRLayers": layer_records,
                             "weight": weight, "originalDataAndMetricsPreserved": True, "blackPalette": True,
                             "emptyV1ContainerWithCompleteV0Layers": True}
assert len(areas) == 9 and all(a < b for a, b in zip(areas, areas[1:])), areas
print(json.dumps(summary))
`;
      const child = Bun.spawn(
        [
          python,
          "-c",
          script,
          directory,
          FONT_VERSION,
          join(root, "src/font/compiler/official-sources.json"),
          JSON.stringify(weights),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 300_000,
          killSignal: "SIGKILL",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr.trim()).toBe("");
      expect(exitCode).toBe(0);
      const independent = JSON.parse(stdout) as Record<
        string,
        {
          originalGlyphs: number;
          decodedOriginalGlyphs: number;
          mappedCharacters: number;
          coloredGlyphs: number;
          coloredMappedCharacters: number;
          halfwidthAliases: number;
          weight: number;
          originalDataAndMetricsPreserved: boolean;
          blackPalette: boolean;
          emptyV1ContainerWithCompleteV0Layers: boolean;
        }
      >;
      expect(Object.keys(independent).sort()).toEqual(weights.map(({ id }) => id).sort());
      for (const { id, weight } of weights) {
        expect(independent[id]).toMatchObject({
          originalGlyphs: 14716,
          decodedOriginalGlyphs: 14716,
          mappedCharacters: 14336,
          coloredGlyphs: 11223,
          coloredMappedCharacters: 11274,
          halfwidthAliases: 51,
          weight,
          originalDataAndMetricsPreserved: true,
          blackPalette: true,
          emptyV1ContainerWithCompleteV0Layers: true,
        });
      }

      // Reject a missing required region before any full-font compilation.
      const invalidStages: string[] = [];
      const invalid: ColorFontExportOptions = {
        ...input,
        classifications: structuredClone(classifications),
        onProgress: (stage) => invalidStages.push(stage),
      };
      invalid.classifications.가 = classifications.가!.map(([ref]) => [ref, "initial.part1.body"]);
      await expect(exportColorFont(invalid)).rejects.toMatchObject({ code: "invalid_classifications" });
      expect(invalidStages).not.toContain("compiling");

      // Root can retain this exact validated package for browser comparisons and
      // release packaging; ordinary tests write no artifacts outside temp space.
      if (process.env.STUDIO_FONT_TEST_OUTPUT) {
        const output = resolve(process.env.STUDIO_FONT_TEST_OUTPUT);
        await mkdir(output, { recursive: true });
        await writeFile(join(output, "font.zip"), baseline.zip);
        await writeFile(join(output, "build-id.txt"), build.id + "\n");
        for (const [name, bytes] of files) await writeFile(join(output, name), bytes);
        await writeFile(
          join(output, "independent-validation.json"),
          JSON.stringify(independent, null, 2) + "\n",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      expect(await readFile(dataPath, "utf8")).toBe(dataText);
    }
  },
  1_800_000,
);
