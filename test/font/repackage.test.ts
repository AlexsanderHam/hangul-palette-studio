import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ColorFontRuntimeStatus, colorFontFingerprint } from "../../src/font/compiler/bridge.ts";

const root = resolve(import.meta.dir, "../..");
const python = resolve(
  root,
  ".cache/font-export-venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);

test.skipIf(!existsSync(python) || !existsSync(join(root, ".cache/pretendard-src")))(
  "repackaging verifies every ZIP member and nine fonts while regenerating only package metadata and CSS",
  () => {
    const script = `
import io,json,sys,zipfile
sys.path.insert(0,"src/font/compiler")
import export as compiler
import official
from fontTools.colorLib.builder import buildCOLR,buildCPAL
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.DefaultTable import DefaultTable
from fontTools.ttLib.tables.otTables import PaintFormat

compiler.check_runtime()
contract=json.loads((compiler.HERE/"contract.json").read_text())
pins=json.loads((compiler.HERE/"official-sources.json").read_text())
payload={"classificationFormat":"semantic-regions-v1","raw":{"version":1,"upm":2896,"asc":2259,"sets":[]},"classifications":{},
         "project":{"projectId":"test-project","revision":0,"rawDigest":"a"*64,"baselineDigest":"b"*64}}
compiled=[]
for profile in compiler.PROFILES.values():
    # Use real pinned fonts so fixture coverage, original glyph counts and
    # preservation checks describe the actual bytes. Each colored glyph paints
    # its own unchanged outline in one black layer; semantic splitting belongs
    # to the separate compiler integration test.
    official_bytes=(compiler.HERE.parents[2]/".cache/pretendard-src"/pins["files"][profile.id]["path"]).read_bytes()
    official.verify_official_source(official_bytes,profile)
    with TTFont(io.BytesIO(official_bytes),recalcBBoxes=False,recalcTimestamp=False) as opened:
        before=official.original_snapshot(opened)
        cmap=opened.getBestCmap()
        top=opened["CFF "].cff.topDictIndex[0]
        size,offset=top.FDArray[0].rawDict["Private"]
        private=top.FDArray[0].Private
        private.original_bytes=opened.reader["CFF "][offset:offset+size]
        private.compilerClass=official.OriginalPrivateCompiler
        raw=DefaultTable("cmap");raw.data=opened.reader["cmap"];opened["cmap"]=raw
        official._rename(opened,contract,profile)
        opened["COLR"]=official.build_color_layers({cmap[ord(char)]:[(cmap[ord(char)],0)] for char in compiler.EXPECTED},opened.getReverseGlyphMap())
        opened["CPAL"]=buildCPAL([[(0,0,0,1)]*20])
        opened.flavor="woff2"
        output=io.BytesIO();opened.save(output);font=output.getvalue()
    with TTFont(io.BytesIO(font),recalcBBoxes=False,recalcTimestamp=False) as opened:
        after=official.original_snapshot(opened,before["order"])
        preservation={key:before[key]==after[key] for key in before}
        preservation["glyphIdOrder"]=opened.getGlyphOrder()[:len(before["order"])]==before["order"]
        assert all(preservation.values())
        glyphset=opened.getGlyphSet()
        for name in opened.getGlyphOrder():
            pen=BoundsPen(glyphset);glyphset[name].draw(pen)
        colored=official.color_layer_sequences(opened)
        decoded_checks={"decodedOriginalGlyphs":len(before["order"]),
                        "decodedOfficialFilledOutlines":len(colored),
                        "sourcePaintOrders":len(colored),
                        "decodedRegionOutlines":sum(len(layers) for layers in colored.values())}
        coverage={"mappedCharacters":len(opened.getBestCmap()),"coloredCharacters":len(colored),
                  "originalGlyphs":len(before["order"]),
                  "coloredMappedCharacters":sum(name in colored for name in opened.getBestCmap().values())}
        coverage["monochromeMappedCharacters"]=coverage["mappedCharacters"]-coverage["coloredMappedCharacters"]
        report={"schemaVersion":1,"passed":True,"fontSha256":compiler.sha(font),"characters":len(compiler.EXPECTED),
                "weight":profile.weight,"weightName":profile.label,"officialSha256":compiler.sha(official_bytes),
                "originalPreservation":preservation,"checks":decoded_checks,"originalGlyphs":len(before["order"]),
                "originalCmapCharacters":len(opened.getBestCmap()),"fontGlyphs":opened["maxp"].numGlyphs,
                "encodedCOLRLayers":int.from_bytes(opened.reader["COLR"][12:14],"big"),
                "colorLayers":official.color_layer_audit(opened),
                "partitionReference":"official-static-otf-outline",
                "allRegionAndFallbackOutlinesDecoded":True,"compoundHolesPreserved":preservation["charstrings"],
                "defaultPaletteBlack":True,"sourceLayerOrderPreserved":True}
    inputs={"classificationFormat":"semantic-regions-v1","rawCanonicalSha256":compiler.sha(compiler.encoded(payload["raw"])),
            "classificationsSha256":compiler.sha(compiler.encoded(payload["classifications"])),"selection":"studio-working-snapshot"}
    source={key:pins[key] for key in ("repository","ref","revision")};source.update(pins["files"][profile.id])
    record={"id":profile.id,"label":profile.label,"weight":profile.weight,"fontFile":profile.font_file,
            "sourceProfile":{"geometrySha256":profile.geometry_sha256},"inputs":inputs,"corrections":[],
            "officialSource":source,"fontCoverage":coverage,
            "counts":{"characters":11223,"modernSyllables":11172,"compatibilityJamo":51,"slots":20,"regions":11223,"sourceContours":11223}}
    compiled.append({"font":font,"record":record,"validation":report})
license_bytes=(compiler.HERE.parents[2]/"LICENSE-OFL").read_bytes()
package,manifest=compiler.make_package(payload,contract,compiled,license_bytes,compiler.effective_slots(payload,contract))
def forbidden(*args,**kwargs): raise AssertionError("repackaging called the compiler")
for module,names in ((compiler,("resolve_snapshot_regions","compile_weight","compile_weights","build_official_font")),
                     (official,("build_official_font",))):
    for name in names:
        assert callable(getattr(module,name,None)), "Compiler guard targets a missing function: "+name
        setattr(module,name,forbidden)
# Import after installing guards so direct compiler imports are guarded too.
from repackage import repackage
changed={**payload,"project":{**payload["project"],"revision":2},"palette":["#abcdef"]*20}
recolored,updated,retained=repackage(package,changed,contract)
assert updated["project"]["revision"]==2
assert updated["inputs"]["paletteSha256"]==compiler.sha(compiler.encoded(changed["palette"]))
assert updated["slots"]==compiler.effective_slots(changed,contract)
assert updated["weights"]==manifest["weights"]
with zipfile.ZipFile(io.BytesIO(package)) as before,zipfile.ZipFile(io.BytesIO(recolored)) as after:
    assert before.read("validation.json")==after.read("validation.json")
    assert b"#abcdef" in after.read("hangul-palette.css")
    assert before.read("hangul-palette.css")!=after.read("hangul-palette.css")
    for profile in compiler.PROFILES.values(): assert before.read(profile.font_file)==after.read(profile.font_file)
    for name,record in updated["files"].items():
        data=after.read(name);assert record=={"bytes":len(data),"sha256":compiler.sha(data)}
    files={name:before.read(name) for name in before.namelist()}
def repack(files):
    target=io.BytesIO()
    with zipfile.ZipFile(target,"w") as archive:
        for name,data in files.items(): archive.writestr(name,data)
    return target.getvalue()
def update_manifest(files):
    value=json.loads(files["manifest.json"])
    for name,data in files.items():
        if name!="manifest.json":value["files"][name]={"bytes":len(data),"sha256":compiler.sha(data)}
    files["manifest.json"]=compiler.encoded(value)
def refuses(data=package,value=changed,rules=contract,code="invalid_package"):
    try: repackage(data,value,rules)
    except compiler.ExportError as error: assert error.code==code,(error.code,code,str(error))
    else: raise AssertionError("invalid package was accepted")
refuses(value={key:value for key,value in changed.items() if key!="classificationFormat"},code="unsupported_classification_format")
refuses(value={**changed,"classificationFormat":"coarse-roles-v1"},code="unsupported_classification_format")
# Workspace identity is package provenance. Exact source hashes above bind the
# fonts, so another workspace can use the same verified build without compiling.
other={**changed,"project":{"projectId":"another-workspace","revision":99,
                             "rawDigest":"different","baselineDigest":"different"}}
_,other_manifest,other_fonts=repackage(package,other,contract)
assert other_manifest["project"]==other["project"]
assert all(before["font"]==after["font"] for before,after in zip(compiled,other_fonts,strict=True))
refuses(value={**changed,"classifications":{"가":[]}},code="reuse_mismatch")
refuses(value={**changed,"raw":{**changed["raw"],"asc":1}},code="reuse_mismatch")
refuses(rules={**contract,"version":contract["version"]+"-changed"},code="reuse_mismatch")
for name in ("validation.json","hangul-palette-thin.woff2","hangul-palette-black.woff2","NOTICE.txt"):
    modified=dict(files);modified[name]+=b"tampered";refuses(repack(modified))
modified=dict(files);del modified["hangul-palette-light.woff2"];refuses(repack(modified))
modified=dict(files);report=json.loads(modified["validation.json"]);report["weights"]["regular"]["passed"]=False
modified["validation.json"]=compiler.encoded(report);update_manifest(modified);refuses(repack(modified))
modified=dict(files);value=json.loads(modified["manifest.json"]);value["toolchain"]["fontTools"]="old"
modified["manifest.json"]=compiler.encoded(value);refuses(repack(modified),code="reuse_mismatch")
modified=dict(files);modified["hangul-palette-bold.woff2"]=b"wOF2invalid"
report=json.loads(modified["validation.json"]);report["weights"]["bold"]["fontSha256"]=compiler.sha(modified["hangul-palette-bold.woff2"])
modified["validation.json"]=compiler.encoded(report);update_manifest(modified);refuses(repack(modified))
modified=dict(files)
with TTFont(io.BytesIO(modified["hangul-palette-regular.woff2"])) as opened:
    opened["CPAL"].palettes[0][0]=opened["CPAL"].palettes[0][0]._replace(red=255)
    target=io.BytesIO();opened.save(target);modified["hangul-palette-regular.woff2"]=target.getvalue()
report=json.loads(modified["validation.json"]);report["weights"]["regular"]["fontSha256"]=compiler.sha(modified["hangul-palette-regular.woff2"])
modified["validation.json"]=compiler.encoded(report);update_manifest(modified);refuses(repack(modified))
# Old reconstructed packages cannot opt into this path by carrying old-style
# success flags. Official provenance and preservation records are mandatory.
for field,value in (("officialSource",None),("fontCoverage",{"mappedCharacters":11224})):
    modified=dict(files);manifest=json.loads(modified["manifest.json"])
    manifest["weights"][3][field]=value
    modified["manifest.json"]=compiler.encoded(manifest);refuses(repack(modified))
modified=dict(files);manifest=json.loads(modified["manifest.json"])
manifest["weights"][3]["officialSource"]["sha256"]="0"*64
modified["manifest.json"]=compiler.encoded(manifest);refuses(repack(modified))
for field,value in (("schemaVersion",99),("originalPreservation",{}),("checks",{}),("officialSha256","0"*64),("colorLayers",{})):
    modified=dict(files);report=json.loads(modified["validation.json"])
    report["weights"]["regular"][field]=value
    modified["validation.json"]=compiler.encoded(report);update_manifest(modified);refuses(repack(modified))
modified=dict(files);report=json.loads(modified["validation.json"])
report["weights"]["regular"]["originalPreservation"]["charstrings"]=False
modified["validation.json"]=compiler.encoded(report);update_manifest(modified);refuses(repack(modified))
# Rehash readable fonts and package metadata after removing the v1 container or
# adding real modern paints. Neither may pass on claimed success flags alone.
for mutation in ("legacy-only", "true-modern-paints"):
    modified=dict(files)
    with TTFont(io.BytesIO(modified["hangul-palette-regular.woff2"])) as opened:
        if mutation=="legacy-only":
            opened["COLR"]=buildCOLR(official.color_layer_sequences(opened),version=0,glyphMap=opened.getReverseGlyphMap())
        else:
            colors=official.color_layer_sequences(opened)
            base=next(iter(colors))
            name,index=colors[base][0]
            paint={"Format":PaintFormat.PaintGlyph,"Glyph":name,
                   "Paint":{"Format":PaintFormat.PaintSolid,"PaletteIndex":index,"Alpha":1.0}}
            modern=buildCOLR({base:paint},version=1,glyphMap=opened.getReverseGlyphMap()).table
            table=opened["COLR"].table
            table.BaseGlyphList=modern.BaseGlyphList
            table.LayerList=modern.LayerList
        target=io.BytesIO();opened.save(target);modified["hangul-palette-regular.woff2"]=target.getvalue()
    report=json.loads(modified["validation.json"])
    report["weights"]["regular"]["fontSha256"]=compiler.sha(modified["hangul-palette-regular.woff2"])
    modified["validation.json"]=compiler.encoded(report);update_manifest(modified);refuses(repack(modified))
# Retain claimed provenance and update all hashes, but actually drop Latin A.
# The independent container check still has to reject the altered coverage.
modified=dict(files)
with TTFont(io.BytesIO(modified["hangul-palette-regular.woff2"])) as opened:
    for table in opened["cmap"].tables:
        if table.isUnicode():table.cmap.pop(ord("A"),None)
    target=io.BytesIO();opened.save(target);modified["hangul-palette-regular.woff2"]=target.getvalue()
report=json.loads(modified["validation.json"]);report["weights"]["regular"]["fontSha256"]=compiler.sha(modified["hangul-palette-regular.woff2"])
modified["validation.json"]=compiler.encoded(report);update_manifest(modified);refuses(repack(modified))
print(json.dumps({"weights":len(retained),"fontsByteExact":True,"rejected":26}))
`;
    const result = Bun.spawnSync([python, "-c", script], { cwd: root, timeout: 150_000 });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ weights: 9, fontsByteExact: true, rejected: 26 });
  },
  180_000,
);

test("font reuse fingerprint follows compiler, contract, source extraction and runtime changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hangul-font-fingerprint-"));
  const runtime = {
    ready: true,
    code: "ready",
    message: "ready",
    setupCommand: "bun run setup:font",
    toolchain: { python: "3.14.5", fontTools: "4.67.0", brotli: "1.2.1" },
  } as ColorFontRuntimeStatus;
  try {
    await mkdir(join(directory, "bin"));
    await cp(join(root, "src/font/compiler"), join(directory, "src/font/compiler"), { recursive: true });
    await cp(join(root, "src"), join(directory, "src"), { recursive: true });
    await cp(join(root, "bin/extract.ts"), join(directory, "bin/extract.ts"));
    await cp(join(root, "LICENSE-OFL"), join(directory, "LICENSE-OFL"));
    let previous = await colorFontFingerprint(directory, runtime);
    expect(await colorFontFingerprint(directory, runtime)).toBe(previous);
    for (const file of [
      "src/font/compiler/regions.py",
      "src/font/palette.ts",
      "src/font/source/regions.ts",
      "src/font/compiler/contract.json",
      "src/font/compiler/official.py",
      "src/font/compiler/official-sources.json",
      "src/font/source/extraction.ts",
    ]) {
      await writeFile(join(directory, file), "changed input");
      const next = await colorFontFingerprint(directory, runtime);
      expect(next).not.toBe(previous);
      previous = next;
    }
    expect(
      await colorFontFingerprint(directory, {
        ...runtime,
        toolchain: { ...runtime.toolchain!, python: "3.15.0" },
      }),
    ).not.toBe(previous);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
