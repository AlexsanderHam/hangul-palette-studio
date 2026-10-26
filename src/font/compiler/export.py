#!/usr/bin/env python3
"""Compile and independently decode a complete Studio color-font snapshot.

The command reads only its input snapshot and production contract/license files.
It never opens an experiment, a prebuilt font, or the mutable Studio workspace.
"""

from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from multiprocessing import active_children
from functools import lru_cache
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import signal
import sys
import zipfile

import brotli
import pathops
import fontTools
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.pointInsidePen import PointInsidePen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path

from official import (COLOR_FONT_FORMAT, OfficialFontError, build_official_font, decode_official_fonts,
                      font_version as official_font_version, validate_official_font)
from regions import ASSIGNMENT_FORMAT, FEATURES as REGION_FEATURES, resolve_glyph_regions
from weights import PROFILES, source_profile

HERE = Path(__file__).resolve().parent
FAMILY = "Hangul Palette"
EXPECTED = set(map(chr, range(0xAC00, 0xD7A4))) | set(map(chr, range(0x3131, 0x3164)))
SOURCE_METRICS = {"unitsPerEm": 2896, "viewportAscender": 2259, "defaultAdvanceWidth": 2504}
METRICS = {"unitsPerEm": 2048, "ascender": 1950, "descender": -494, "hangulAdvanceWidth": 1770}
FEATURES = {value: set(features) for value, features in REGION_FEATURES.items()}


class ExportError(Exception):
    def __init__(self, code, message, diagnostics=None):
        super().__init__(message)
        self.code, self.diagnostics = code, diagnostics or []


def font_version(contract):
    try:
        return official_font_version(contract)
    except OfficialFontError as error:
        raise ExportError(error.code, "폰트 버전은 major.minor.patch 형식이어야 합니다. minor는 0–9, patch는 0–99 범위입니다.") from error


def configure_stdio():
    """The TypeScript process always sends and decodes UTF-8, on every host."""
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def emit(stage, weight=None):
    print(json.dumps({"stage": stage, **({"weight": weight} if weight else {})}), flush=True)


def toolchain():
    return {"python": platform.python_version(), "fontTools": fontTools.__version__, "brotli": brotli.__version__, "pathops": pathops.__version__}


def check_runtime():
    if sys.version_info < (3, 11):
        raise ExportError("incompatible_runtime", "Python 3.11 이상이 필요합니다.")
    if fontTools.__version__ != "4.67.0" or brotli.__version__ != "1.2.1" or pathops.__version__ != "0.9.2":
        raise ExportError("incompatible_runtime", "고정된 폰트 도구 버전이 필요합니다. bun run setup:font를 실행하세요.")


def effective_slots(payload, contract):
    """Keep region identities fixed while capturing this export's opaque colors."""
    if "palette" not in payload:
        return [dict(slot) for slot in contract["slots"]]
    palette = payload["palette"]
    if not isinstance(palette, list) or len(palette) != 20:
        raise ExportError("invalid_palette", "색상은 영역 20개에 각각 지정해야 합니다.")
    if any(not isinstance(color, str) or re.fullmatch(r"#[0-9a-fA-F]{6}", color) is None for color in palette):
        raise ExportError("invalid_palette", "색상은 #rrggbb 형식의 불투명 색상이어야 합니다.")
    return [{**slot, "color": color.lower()} for slot, color in zip(contract["slots"], palette, strict=True)]


def resolve_snapshot_regions(payload, contract, profile=None, reference_raw=None):
    require_assignment_format(payload)
    raw, assignments = payload["raw"], payload["classifications"]
    if profile is None:
        try:
            profile = source_profile(raw, payload.get("weight", "regular"))
        except (ValueError, TypeError, KeyError) as error:
            raise ExportError("unsupported_source", str(error)) from error
    glyphs = {}
    for _, _, items in raw["sets"]:
        for char, advance, paths in items:
            if char in glyphs:
                raise ExportError("invalid_source", "원본에 중복 글자가 있습니다: " + char)
            glyphs[char] = (advance, paths)
    if set(glyphs) != EXPECTED or set(assignments) != EXPECTED:
        raise ExportError("incomplete_coverage", "현대 한글 11,172자와 호환 자모 51자의 완전한 분류가 필요합니다.")
    reference = None
    if profile.id != "regular":
        if reference_raw is None:
            raise ExportError("unsupported_source", "다른 굵기를 분류하려면 검증된 Regular 기준 윤곽이 필요합니다.")
        try:
            source_profile(reference_raw, "regular")
        except (ValueError, KeyError, TypeError) as error:
            raise ExportError("unsupported_source", str(error)) from error
        reference = {char: paths for _, _, items in reference_raw["sets"] for char, _, paths in items}
    resolved, diagnostics = [], []
    for char in sorted(glyphs, key=ord):
        advance, paths = glyphs[char]
        try:
            if advance != SOURCE_METRICS["defaultAdvanceWidth"]:
                raise ValueError("The source advance width must be 2504 units.")
            entry = assignments[char]
            if not isinstance(entry, list) or any(not isinstance(pair, list) or len(pair) != 2 for pair in entry):
                raise ValueError("Invalid contour assignment pairs.")
            if any(not isinstance(ref, int) or isinstance(ref, bool) or not isinstance(slot_id, str) for ref, slot_id in entry):
                raise ValueError("Direct assignments require integer contour references and stable string region IDs.")
            if Counter(ref for ref, _ in entry) != Counter(range(len(paths))):
                raise ValueError("Every source contour must be assigned exactly once.")
            resolved.append(resolve_glyph_regions(char, advance, paths, entry, contract["slots"], profile.id,
                                           reference[char] if reference is not None else None))
        except (ValueError, KeyError, IndexError, AssertionError) as error:
            diagnostics.append({"char": char, "weight": profile.id, "code": "semantic_classification", "message": str(error) or "Cannot partition the assigned source contours."})
    if diagnostics:
        raise ExportError("semantic_classification", "세부 영역을 만들 수 없는 글자 분류가 있습니다. 표시된 글자를 확인하세요.", diagnostics)
    return resolved


def require_assignment_format(payload):
    if payload.get("classificationFormat") != ASSIGNMENT_FORMAT:
        raise ExportError("unsupported_classification_format", "semantic-regions-v1 형식의 직접 세부 영역 분류가 필요합니다.")


def normalized(records, tolerance=0):
    output, start = [], None
    for operation, args in records:
        if operation == "moveTo":
            start = args[0]
        if (operation == "closePath" and output and output[-1][0] == "lineTo" and
            all(abs(a - b) <= tolerance for a, b in zip(output[-1][1][0], start, strict=True))):
            output.pop()
        output.append((operation, args))
    return tuple(output)


@lru_cache(maxsize=None)
def path_records(path, reflected=False):
    pen = RecordingPen()
    parse_path(path, TransformPen(pen, (1, 0, 0, -1, 0, 0)) if reflected else pen)
    return normalized(pen.value)


@lru_cache(maxsize=None)
def contour_properties(path):
    area, box = AreaPen(), BoundsPen(None)
    parse_path(path, area)
    parse_path(path, box)
    records = path_records(path)
    if sum(operation == "moveTo" for operation, _ in records) != 1 or records[-1][0] != "closePath" or area.value == 0:
        raise ValueError("A source contour is open, degenerate, or contains multiple contours.")
    return area.value, box.bounds, records[0][1][0]


@lru_cache(maxsize=None)
def contains(outer, inner):
    _, outside, _ = contour_properties(outer)
    _, inside, point = contour_properties(inner)
    if not (outside[0] <= inside[0] and outside[1] <= inside[1] and outside[2] >= inside[2] and outside[3] >= inside[3]):
        return False
    pen = PointInsidePen(None, point)
    parse_path(outer, pen)
    return pen.getResult()


def validate_semantics(glyphs, profile):
    """Check Unicode constituents and paint ownership independently of clipping.

    The source's 2896-unit paths locate semantic regions. They are not the
    delivered fallback outlines, which are retained from each official OTF.
    """
    checks, diagnostics = Counter(), []
    for glyph in glyphs:
        try:
            regions = glyph["regions"]
            contours = {c["index"]: c["d"] for c in glyph["contours"]}
            layer_order = [r["sourceLayerIndex"] for r in regions]
            if layer_order != sorted(layer_order):
                raise ValueError("Source layer blocks were reordered.")
            for region in regions:
                original_refs = glyph["originalLayers"][region["sourceLayerIndex"]]["contourRefs"]
                positions = [original_refs.index(ref) for ref in region["contourRefs"]]
                if positions != sorted(positions):
                    raise ValueError("Internal compound contour order changed.")
                feature = region["slotId"].split(".")[2]
                if feature != "body":
                    x0, y0, x1, y1 = region["partitionBounds"]
                    if (y1 - y0 > x1 - x0) != (feature in {"vertical", "left-vertical", "right-vertical"}):
                        raise ValueError("A semantic feature has the wrong geometric orientation.")
                    checks["independentFeatureOrientations"] += 1
            for index, layer in enumerate(glyph["originalLayers"]):
                leaves = [region for region in regions if region["sourceLayerIndex"] == index]
                refs = [ref for leaf in leaves for ref in leaf["contourRefs"]]
                if Counter(refs) != Counter(layer["contourRefs"]):
                    raise ValueError("Source contour occurrences were lost or duplicated.")
                for hole_ref in layer["contourRefs"]:
                    if contour_properties(contours[hole_ref])[0] < 0:
                        continue
                    containers = [outer for outer in layer["contourRefs"]
                                  if contour_properties(contours[outer])[0] < 0 and contains(contours[outer], contours[hole_ref])]
                    leaf = next(leaf for leaf in leaves if hole_ref in leaf["contourRefs"])
                    if not set(containers).intersection(leaf["contourRefs"]):
                        raise ValueError("A counter was separated from its enclosing outline.")
                    checks["compoundHoleOccurrences"] += 1
            positions = {region["id"]: i for i, region in enumerate(regions)}
            expected_constraints = set()
            for branch in regions:
                role, part, feature = branch["slotId"].split(".")
                ordinal = int(part.removeprefix("part"))
                if role == "medial":
                    component = glyph["semanticParts"][role]["components"][ordinal - 1]["value"]
                    support = "horizontal" if component in "ㅗㅛㅜㅠ" else "vertical"
                    if feature == support:
                        continue
                elif feature == "added-bar":
                    support = "body"
                else:
                    continue
                targets = {f"{role}.{part}.{support}"}
                if role == "medial" and feature.startswith("right-"):
                    targets.add(f"medial.part{ordinal + 1}.vertical")
                for main in regions:
                    if main["sourceLayerIndex"] == branch["sourceLayerIndex"] and main["slotId"] in targets:
                        expected_constraints.add((branch["id"], main["id"]))
                        if positions[branch["id"]] >= positions[main["id"]]:
                            raise ValueError("A branch paints over its continuous supporting stroke.")
            if expected_constraints != {(c["under"], c["over"]) for c in glyph["paintConstraints"]}:
                raise ValueError("Recorded junction constraints differ from semantic features.")
            checks["junctionConstraints"] += len(expected_constraints)
            for role, part in glyph["semanticParts"].items():
                for component in part["components"]:
                    expected = FEATURES[component["value"]] if role == "medial" else {"body", "added-bar"} if component["value"] == "ㅋ" else {"body"}
                    prefix = f"{role}.part{component['index']}."
                    actual = {r["slotId"].removeprefix(prefix) for r in regions if r["slotId"].startswith(prefix)}
                    if actual != expected:
                        raise ValueError("Semantic features do not match the Unicode constituent.")
                if role != "medial" and len(part["components"]) == 2:
                    centers = []
                    for ordinal in (1, 2):
                        selected = [ref for region in regions if region["slotId"].startswith(f"{role}.part{ordinal}.") for ref in region["contourRefs"]]
                        centers.append([(contour_properties(contours[ref])[1][0] + contour_properties(contours[ref])[1][2]) / 2 for ref in selected])
                    if not centers[0] or not centers[1] or max(centers[0]) >= min(centers[1]):
                        raise ValueError("Compound consonants are not arranged from left to right.")
                    checks["independentConsonantConstituents"] += 1
            checks["semanticGlyphs"] += 1
        except (ValueError, KeyError, IndexError, StopIteration) as error:
            diagnostics.append({"char": glyph["char"], "weight": profile.id,
                                "code": "semantic_validation", "message": str(error)})
    if diagnostics:
        raise ExportError("semantic_validation", "세부 영역 분류와 칠 순서를 검증하지 못했습니다.", diagnostics)
    return dict(checks)


def css_text(slots):
    def palette(name, colors):
        return f'@font-palette-values {name} {{font-family:"{FAMILY}";base-palette:0;override-colors:' + ", ".join(f"{index} {color}" for index, color in enumerate(colors)) + ";}\n"
    css = "".join(f'@font-face {{font-family:"{FAMILY}";src:url("./{profile.font_file}") format("woff2");font-weight:{profile.weight};font-style:normal;font-display:swap;}}\n' for profile in PROFILES.values())
    css += palette("--hangul-palette", [slot["color"] for slot in slots])
    css += palette("--hangul-palette-gray", ["#64748b"] * len(slots))
    css += palette("--hangul-palette-roles", [{"initial": "#ee7a8a", "medial": "#e8b476", "final": "#87cbb5"}[slot["role"]] for slot in slots])
    for slot in slots:
        css += f"/* {slot['index']}: {slot['id']} — {slot['label']} */\n"
    css += '.hangul-palette {font-family:"Hangul Palette",sans-serif;font-synthesis:none;font-palette:--hangul-palette;}\n'
    return css


def weight_record(payload, raw, glyphs, profile):
    return {"id": profile.id, "label": profile.label, "weight": profile.weight, "fontFile": profile.font_file,
            "sourceProfile": {"upstream": "Pretendard " + profile.label + " v1.3.9", "weight": profile.weight,
                              "geometrySha256": profile.geometry_sha256,
                              "scope": "Verified semantic masks for this pinned official static font; masks do not replace original fallback outlines.",
                              "sourceViewportAscender": raw.get("asc")},
            "inputs": {"rawCanonicalSha256": sha(encoded(raw)),
                       "classificationFormat": ASSIGNMENT_FORMAT,
                       "classificationsSha256": sha(encoded(payload["classifications"])),
                       "sourceProvenance": raw.get("provenance"),
                       "digestEncoding": "SHA-256 of UTF-8 JSON with sorted object keys, compact separators, unescaped Unicode and one trailing LF.",
                       "selection": "studio-working-snapshot"},
            "counts": {"characters": len(glyphs), "modernSyllables": 11172, "compatibilityJamo": 51,
                       "slots": 20, "regions": sum(len(g["regions"]) for g in glyphs),
                       "sourceContours": sum(len(g["contours"]) for g in glyphs)},
            "corrections": [{"char": glyph["char"], "semantic": glyph["semanticOverrides"], "geometry": glyph["geometryOverrides"]}
                            for glyph in glyphs if glyph["semanticOverrides"] or glyph["geometryOverrides"]]}


def make_package(payload, contract, compiled, license_bytes, slots):
    require_assignment_format(payload)
    version, _, _ = font_version(contract)
    css = css_text(slots).encode()
    notice = ("Hangul Palette is an independent derivative of Pretendard v1.3.9.\n\n"
              "Original font copyright (c) 2021, Kil Hyung-jin.\n"
              "The fonts are distributed under the SIL Open Font License 1.1. See LICENSE-OFL.\n\n"
              "Pretendard is a Reserved Font Name and is used here for attribution only.\n").encode()
    rows = "".join(f'<h2>{profile.label} {profile.weight}</h2><p class="hangul-palette" style="font-weight:{profile.weight}" contenteditable="true" spellcheck="false">가 과 값 밖 껴 쎤 쬸 휺 ㅐ ㅙ ㅋ ㅂ</p>' for profile in PROFILES.values())
    preview = ('''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hangul Palette</title><link rel="stylesheet" href="./hangul-palette.css"><style>body{max-width:960px;margin:48px auto;padding:0 24px;font-family:system-ui;background:#10151c;color:#e4e9f0}p.hangul-palette{font-size:clamp(32px,7vw,72px);line-height:1.5;overflow-wrap:anywhere}code{color:#99d6ff}</style><h1>Hangul Palette</h1><p>Thin 100부터 Black 900까지 9개 굵기 · 각 굵기 현대 한글 11,172자 · 호환 자모 51자 · 색상 슬롯 20개</p>''' + rows + '''<p>폰트의 기본색은 검정이며, 선택한 색상은 CSS로만 적용됩니다. CSS <code>font-weight</code>에 100부터 900까지 100 단위 값을 지정해 굵기를 선택하세요. 문장을 편집하거나 <code>hangul-palette.css</code>의 <code>override-colors</code>에서 색상을 바꿀 수 있습니다. 슬롯 목록과 파일 해시는 <code>manifest.json</code>에 있습니다.</p><p>공식 원본의 영문·숫자·문장 부호도 포함하며 일반 CSS color로 색을 지정할 수 있습니다. 한글의 세부 영역은 CSS 팔레트로 색칠합니다. 색상은 COLR/CPAL 및 CSS font-palette를 지원하는 브라우저에서 표시됩니다.</p><p>접합부는 불투명 색상을 기준으로 정리되어 있습니다. 생성된 각 굵기의 구조와 윤곽을 자동으로 검사합니다.</p></html>''').encode()
    validation = {"schemaVersion": 1, "passed": True,
                  "weights": {item["record"]["id"]: item["validation"] for item in compiled}}
    files = {item["record"]["fontFile"]: item["font"] for item in compiled}
    files.update({"hangul-palette.css": css, "validation.json": encoded(validation),
                  "LICENSE-OFL": license_bytes, "NOTICE.txt": notice, "preview.html": preview})
    regular = next(item["record"] for item in compiled if item["record"]["id"] == "regular")
    manifest = {"schemaVersion": 1, "format": "hangul-palette-color-font-v1", "family": FAMILY,
                "classificationFormat": ASSIGNMENT_FORMAT,
                "fontVersion": version,
                "fontFormat": COLOR_FONT_FORMAT, "complete": True,
                "project": payload["project"], "metrics": METRICS, "semanticSourceMetrics": SOURCE_METRICS,
                "outlinePolicy": "official-static-font-with-clipped-semantic-layers",
                "inputs": {**regular["inputs"], "paletteSha256": sha(encoded([slot["color"] for slot in slots]))},
                "weights": [item["record"] for item in compiled],
                "contract": {"version": contract["version"], "sha256": sha(encoded(contract))},
                "slots": slots, "paintPolicy": contract["paintPolicy"],
                "colorPolicy": {"fontDefault": "#000000", "selectedPalette": "css-only"},
                "counts": {"characters": 11223, "modernSyllables": 11172, "compatibilityJamo": 51,
                           "slots": 20, "weights": len(compiled)},
                "license": {"spdx": "OFL-1.1", "file": "LICENSE-OFL", "sha256": sha(license_bytes)},
                "files": {name: {"bytes": len(data), "sha256": sha(data)} for name, data in files.items()},
                "toolchain": toolchain(), "verification": {"structural": True, "decodedOutlines": True},
                "limits": ["Semantic colors cover modern Hangul syllables and compatibility jamo; 51 original halfwidth Hangul aliases share the colored jamo glyphs. Latin, digits and punctuation retain ordinary foreground color. Supported static weights: 100 through 900 in steps of 100.",
                           "Original glyph data and placement metrics are preserved; color rasterization is not guaranteed pixel-identical to monochrome rendering.",
                           "Opaque colors are assumed for continuous-stroke junction ownership."]}
    files["manifest.json"] = encoded(manifest)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_STORED if name.endswith(".woff2") else zipfile.ZIP_DEFLATED
            archive.writestr(info, files[name], compresslevel=9)
    return output.getvalue(), manifest


def clear_geometry_caches():
    # Retain at most one complete weight's decoded geometry in the worker.
    from regions import bounds
    for function in (bounds, path_records, contour_properties, contains):
        function.cache_clear()


def compile_weight(weight, raw, reference_raw, assignments, contract, official_bytes):
    """Compile one face in an isolated process and keep structured failures."""
    profile = PROFILES[weight]
    payload = {"raw": raw, "classifications": assignments, "classificationFormat": ASSIGNMENT_FORMAT}
    try:
        emit("preparing", weight)
        glyphs = resolve_snapshot_regions(payload, contract, profile, reference_raw)
        semantic_checks = validate_semantics(glyphs, profile)
        emit("compiling", weight)
        font, build_report = build_official_font(glyphs, contract, profile, official_bytes)
        emit("validating", weight)
        validation = validate_official_font(font, official_bytes, glyphs, contract, profile)
        validation["checks"].update(semantic_checks)
        record = weight_record(payload, raw, glyphs, profile)
        record["officialSource"] = build_report["officialSource"]
        record["fontCoverage"] = build_report["fontCoverage"]
        if build_report.get("officialFillAllocations"):
            record["officialFillAllocations"] = build_report["officialFillAllocations"]
        return {"font": font, "validation": validation, "record": record}
    except (OfficialFontError, ExportError) as error:
        return {"error": {"code": error.code, "message": str(error), "diagnostics": error.diagnostics}}
    except Exception as error:
        return {"error": {"code": "compiler_error", "message": str(error),
                          "diagnostics": [{"weight": weight, "code": "compiler_error", "message": str(error)}]}}
    finally:
        clear_geometry_caches()


def stop_build_workers():
    # This standalone compiler owns its worker children. They only read
    # snapshots and build in memory; no partial font is published by a worker.
    for worker in active_children():
        try:
            worker.kill()
        except ProcessLookupError:
            pass


def stop_compilation(signum, frame):
    stop_build_workers()
    raise SystemExit(128 + signum)


def compile_weights(jobs):
    """Surface native worker crashes immediately and stop sibling workers."""
    completed = {}
    try:
        with ProcessPoolExecutor(max_workers=min(3, os.cpu_count() or 1)) as workers:
            pending = {workers.submit(compile_weight, *job): job[0] for job in jobs}
            try:
                for task in as_completed(pending):
                    result = task.result()
                    if "error" in result:
                        error = result["error"]
                        raise ExportError(error["code"], error["message"], error["diagnostics"])
                    completed[pending[task]] = result
            except BaseException:
                stop_build_workers()
                raise
    except BrokenProcessPool as error:
        raise ExportError("compiler_worker_failed", "폰트 작업 프로세스가 비정상 종료되었습니다. 다시 시도하세요.") from error
    return completed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--font-directory", type=Path)
    args = parser.parse_args()
    check_runtime()
    if args.check:
        print(json.dumps({"ready": True, "toolchain": toolchain()}))
        return
    if not args.input or not args.output:
        parser.error("--input and --output are required")
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    require_assignment_format(payload)
    contract = json.loads((HERE / "contract.json").read_text(encoding="utf-8"))
    if [slot["index"] for slot in contract["slots"]] != list(range(20)) or len({s["id"] for s in contract["slots"]}) != 20:
        raise ExportError("invalid_contract", "컬러 슬롯 계약이 올바르지 않습니다.")
    slots = effective_slots(payload, contract)
    weight_sources = payload.get("weightSources")
    if not isinstance(weight_sources, dict) or set(weight_sources) != set(PROFILES) - {"regular"}:
        raise ExportError("unsupported_source", "9개 굵기를 만들기 위한 검증된 원본 윤곽이 모두 필요합니다.")
    sources = {weight: payload["raw"] if weight == "regular" else weight_sources[weight] for weight in PROFILES}
    try:
        profiles = {weight: source_profile(raw, weight) for weight, raw in sources.items()}
    except (ValueError, KeyError, TypeError) as error:
        raise ExportError("unsupported_source", str(error)) from error
    try:
        official_fonts = decode_official_fonts(payload.get("officialFonts"))
    except OfficialFontError as error:
        raise ExportError(error.code, str(error), error.diagnostics) from error
    # Keep at most three complete weights in memory while avoiding a serial
    # nine-face build. Workers receive immutable snapshots, never file paths.
    signal.signal(signal.SIGTERM, stop_compilation)
    signal.signal(signal.SIGINT, stop_compilation)
    jobs = [(weight, sources[weight], payload["raw"], payload["classifications"],
             contract, official_fonts[weight]) for weight in profiles]
    completed = compile_weights(jobs)
    compiled = [completed[weight] for weight in profiles]
    emit("packaging")
    package, manifest = make_package(payload, contract, compiled, (HERE.parents[2] / "LICENSE-OFL").read_bytes(), slots)
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
        print(json.dumps({"error": {"code": "compiler_error", "message": "컬러 폰트 생성 중 오류가 발생했습니다.", "detail": str(error)}}, ensure_ascii=False), file=sys.stderr, flush=True)
        sys.exit(1)
