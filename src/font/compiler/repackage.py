#!/usr/bin/env python3
"""Repackage a verified color-font ZIP without compiling or rewriting its fonts."""

import argparse
import io
import json
from pathlib import Path
import sys
import zipfile

from fontTools.ttLib import TTFont

from official import COLOR_FONT_FORMAT, color_layer_audit, color_layer_sequences
from export import (EXPECTED, FAMILY, HERE, METRICS, PROFILES, ExportError, check_runtime, configure_stdio,
                    effective_slots, emit, encoded, font_version, make_package, require_assignment_format, sha, toolchain)
from regions import ASSIGNMENT_FORMAT

ORIGINAL_PRESERVATION_FIELDS = {
    "order", "charstrings", "globalSubrs", "localSubrsFD0", "privateFD0Bytes", "privateFD0Values",
    "fdSelectOriginal", "hmtxOriginalRecords", "vmtxOriginalRecords", "cmapBytes", "unitsPerEm",
    "hheaMetrics", "vheaMetrics", "os2Metrics", "headFontBBox", "CFFFontBBox", "FD0FontMatrix", "glyphIdOrder",
}
FONT_COVERAGE = {"mappedCharacters": 14336, "coloredCharacters": 11223,
                 "coloredMappedCharacters": 11274, "originalGlyphs": 14716, "monochromeMappedCharacters": 3062}


def require(condition, message, code="invalid_package"):
    if not condition:
        raise ExportError(code, message)


def verified_package(data, payload, contract):
    """Accept only exact binaries covered by a successful nine-weight report."""
    require_assignment_format(payload)
    expected = {profile.font_file for profile in PROFILES.values()} | {
        "manifest.json", "validation.json", "hangul-palette.css", "LICENSE-OFL", "NOTICE.txt", "preview.html"}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            require(len(infos) == len(expected) and {item.filename for item in infos} == expected,
                    "기존 ZIP의 파일 구성이 올바르지 않습니다.")
            require(sum(item.file_size for item in infos) <= 128 * 1024 * 1024 and
                    all(item.file_size <= 32 * 1024 * 1024 and not item.flag_bits & 1 for item in infos),
                    "기존 ZIP의 파일 크기나 암호화 설정이 올바르지 않습니다.")
            files = {item.filename: archive.read(item) for item in infos}
        manifest = json.loads(files["manifest.json"])
        validation = json.loads(files["validation.json"])
        require(manifest.get("schemaVersion") == 1 and manifest.get("format") == "hangul-palette-color-font-v1" and
                manifest.get("classificationFormat") == ASSIGNMENT_FORMAT and
                manifest.get("family") == FAMILY and manifest.get("complete") is True,
                "검증을 마친 Hangul Palette ZIP이 필요합니다.")
        require(manifest.get("fontFormat") == COLOR_FONT_FORMAT and
                manifest.get("colorPolicy") == {"fontDefault": "#000000", "selectedPalette": "css-only"} and
                manifest.get("verification") == {"structural": True, "decodedOutlines": True},
                "기존 폰트의 기본색과 윤곽 검증 기록을 확인할 수 없습니다.")
        require(manifest.get("counts") == {"characters": 11223, "modernSyllables": 11172,
                                         "compatibilityJamo": 51, "slots": 20, "weights": 9},
                "9개 굵기와 전체 한글을 포함한 ZIP이 필요합니다.")
        require(manifest.get("contract") == {"version": contract["version"], "sha256": sha(encoded(contract))} and
                manifest.get("fontVersion") == font_version(contract)[0] and
                manifest.get("toolchain") == toolchain() and manifest.get("metrics") == METRICS,
                "제작 계약이나 폰트 도구가 달라졌습니다. 폰트를 다시 생성하세요.", "reuse_mismatch")
        recorded = manifest.get("files", {})
        require(set(recorded) == expected - {"manifest.json"}, "기존 ZIP의 파일 해시 목록이 올바르지 않습니다.")
        for name, record in recorded.items():
            require(record == {"bytes": len(files[name]), "sha256": sha(files[name])},
                    "기존 ZIP의 파일 검증에 실패했습니다: " + name)
        require(validation.get("schemaVersion") == 1 and validation.get("passed") is True and
                set(validation.get("weights", {})) == set(PROFILES), "9개 굵기의 검증 기록이 필요합니다.")
        raw_digest, assignments_digest = sha(encoded(payload["raw"])), sha(encoded(payload["classifications"]))
        require(manifest.get("inputs", {}).get("rawCanonicalSha256") == raw_digest and
                manifest.get("inputs", {}).get("classificationFormat") == ASSIGNMENT_FORMAT and
                manifest.get("inputs", {}).get("classificationsSha256") == assignments_digest,
                "분류나 원본이 달라졌습니다. 폰트를 다시 생성하세요.", "reuse_mismatch")
        old_slots = manifest.get("slots", [])
        require(old_slots == effective_slots({"palette": [slot["color"] for slot in old_slots]}, contract) and
                manifest["inputs"].get("paletteSha256") == sha(encoded([slot["color"] for slot in old_slots])),
                "기존 ZIP의 팔레트 계약이 올바르지 않습니다.")
        license_bytes = (HERE.parents[2] / "LICENSE-OFL").read_bytes()
        require(files["LICENSE-OFL"] == license_bytes and
                manifest.get("license") == {"spdx": "OFL-1.1", "file": "LICENSE-OFL", "sha256": sha(license_bytes)},
                "폰트 라이선스가 달라졌습니다. 폰트를 다시 생성하세요.", "reuse_mismatch")
        records = manifest.get("weights", [])
        require(len(records) == 9 and [record["id"] for record in records] == list(PROFILES),
                "기존 ZIP의 굵기 목록이 올바르지 않습니다.")
        compiled = []
        pins = json.loads((HERE / "official-sources.json").read_text(encoding="utf-8"))
        for record in records:
            profile = PROFILES[record["id"]]
            official_source = {key: pins[key] for key in ("repository", "ref", "revision")}
            official_source.update(pins["files"][profile.id])
            require(record["weight"] == profile.weight and record["label"] == profile.label and
                    record["fontFile"] == profile.font_file and
                    record.get("sourceProfile", {}).get("geometrySha256") == profile.geometry_sha256 and
                    record.get("officialSource") == official_source and record.get("fontCoverage") == FONT_COVERAGE and
                    record.get("inputs", {}).get("classificationsSha256") == assignments_digest,
                    "기존 ZIP의 굵기 원본 계약이 올바르지 않습니다: " + profile.id)
            require(record.get("inputs", {}).get("classificationFormat") == ASSIGNMENT_FORMAT,
                    "직접 세부 영역 분류 형식의 폰트만 재사용할 수 있습니다.", "reuse_mismatch")
            font = files[profile.font_file]
            report = validation["weights"][profile.id]
            preservation = report.get("originalPreservation", {})
            decoded_checks = report.get("checks", {})
            require(report.get("schemaVersion") == 1 and report.get("passed") is True and
                    report.get("fontSha256") == sha(font) and report.get("characters") == 11223 and
                    report.get("officialSha256") == official_source["sha256"] and
                    report.get("originalGlyphs") == FONT_COVERAGE["originalGlyphs"] and
                    report.get("originalCmapCharacters") == FONT_COVERAGE["mappedCharacters"] and
                    report.get("partitionReference") == "official-static-otf-outline" and
                    set(preservation) == ORIGINAL_PRESERVATION_FIELDS and all(value is True for value in preservation.values()) and
                    decoded_checks.get("decodedOriginalGlyphs") == FONT_COVERAGE["originalGlyphs"] and
                    decoded_checks.get("decodedOfficialFilledOutlines") == FONT_COVERAGE["coloredCharacters"] and
                    decoded_checks.get("sourcePaintOrders") == FONT_COVERAGE["coloredCharacters"] and
                    report.get("weight") == profile.weight and report.get("weightName") == profile.label and
                    all(report.get(key) is True for key in ("allRegionAndFallbackOutlinesDecoded", "compoundHolesPreserved",
                                                           "defaultPaletteBlack", "sourceLayerOrderPreserved")),
                    "기존 폰트와 검증 기록이 일치하지 않습니다: " + profile.id)
            # Hashes bind the expensive decoded-outline report to these exact
            # bytes. Recheck container/coverage/palette metadata without
            # resolving semantic regions or compiling a single charstring.
            with TTFont(io.BytesIO(font), lazy=True) as opened:
                cmap = opened.getBestCmap()
                colored = {cmap.get(ord(char)) for char in EXPECTED}
                layers = color_layer_sequences(opened)
                color_audit = color_layer_audit(opened)
                require(opened.flavor == "woff2" and "CFF " in opened and "COLR" in opened and "CPAL" in opened and
                        opened["COLR"].version == 1 and opened["CPAL"].version == 0 and
                        opened["OS/2"].usWeightClass == profile.weight and
                        opened["head"].unitsPerEm == METRICS["unitsPerEm"] and
                        opened["hhea"].ascent == METRICS["ascender"] and opened["hhea"].descent == METRICS["descender"] and
                        len(cmap) == FONT_COVERAGE["mappedCharacters"] and None not in colored and
                        set(layers) == colored and
                        sum(name in colored for name in cmap.values()) == FONT_COVERAGE["coloredMappedCharacters"] and
                        len(opened.getGlyphOrder()) >= FONT_COVERAGE["originalGlyphs"] and
                        report.get("fontGlyphs") == opened["maxp"].numGlyphs and
                        report.get("encodedCOLRLayers") == int.from_bytes(opened.reader["COLR"][12:14], "big") and
                        report.get("colorLayers") == color_audit and
                        decoded_checks.get("decodedRegionOutlines") == sum(map(len, layers.values())) and
                        all(opened["hmtx"][name][0] == METRICS["hangulAdvanceWidth"] for name in colored),
                        "기존 WOFF2의 문자 범위나 굵기가 올바르지 않습니다: " + profile.id)
                palette = opened["CPAL"]
                require(palette.numPaletteEntries == 20 and len(palette.palettes) == 1 and
                        all((color.red, color.green, color.blue, color.alpha) == (0, 0, 0, 255)
                            for color in palette.palettes[0]), "기존 WOFF2의 기본 팔레트가 올바르지 않습니다.")
            compiled.append({"font": font, "validation": report, "record": record})
        return compiled, license_bytes
    except ExportError:
        raise
    except Exception as error:
        raise ExportError("invalid_package", "기존 ZIP의 검증에 실패했습니다.") from error


def repackage(data, payload, contract):
    compiled, license_bytes = verified_package(data, payload, contract)
    slots = effective_slots(payload, contract)
    return (*make_package(payload, contract, compiled, license_bytes, slots), compiled)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--reuse", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--font-directory", type=Path)
    args = parser.parse_args()
    check_runtime()
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    contract = json.loads((HERE / "contract.json").read_text(encoding="utf-8"))
    emit("packaging")
    package, manifest, compiled = repackage(args.reuse.read_bytes(), payload, contract)
    args.output.write_bytes(package)
    if args.font_directory:
        args.font_directory.mkdir(parents=True, exist_ok=True)
        for item in compiled:
            (args.font_directory / item["record"]["fontFile"]).write_bytes(item["font"])
    print(json.dumps({"complete": True, "manifest": manifest}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    configure_stdio()
    try:
        main()
    except ExportError as error:
        print(json.dumps({"error": {"code": error.code, "message": str(error), "diagnostics": error.diagnostics}}, ensure_ascii=False), file=sys.stderr, flush=True)
        sys.exit(1)
    except Exception as error:
        print(json.dumps({"error": {"code": "packaging_error", "message": "색상 CSS 패키지를 만들지 못했습니다.", "detail": str(error)}}, ensure_ascii=False), file=sys.stderr, flush=True)
        sys.exit(1)
