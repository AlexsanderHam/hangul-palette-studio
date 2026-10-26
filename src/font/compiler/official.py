"""Add COLR v0 semantic layers to the pinned official static Pretendard OTFs.

The official glyphs remain the monochrome fallback. Their charstrings, CFF
private data, subroutines, cmap bytes, glyph IDs and metrics are retained; only
new, clipped color-layer glyphs are appended in a separate CFF font dictionary.
"""

from __future__ import annotations

import copy
import base64
import binascii
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
import struct

import pathops
from fontTools.cffLib import FontDict, PrivateDict, PrivateDictCompiler
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.basePen import BasePen
from fontTools.pens.pointInsidePen import PointInsidePen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.DefaultTable import DefaultTable

from weights import PROFILES

HERE = Path(__file__).resolve().parent
FAMILY = "Hangul Palette"
SOURCE_UPM = 2896
MASK_GUARD = 3.0
MASK_GUARD_CANDIDATES = (3.0, 3.125, 3.25, 3.5, 4.0)
MASK_STRATEGIES = ("normalized-stroke", "translated-mask-copies")
# PathOps uses float coordinates and Type 2 charstrings quantize deltas to
# 16.16. Verify pre-encode Boolean coverage and post-encode cubic controls
# separately: Boolean XOR between almost identical curves is numerically
# unstable and is not a reliable decoder check.
MAX_PRE_ENCODE_AREA_ERROR = 0.1
MAX_DECODED_COORDINATE_ERROR = 1 / 1024
BLACK_SYEK_GEOMETRY_SHA256 = "81bc84a458294d1ef26a457503c18061a7b829deb8672a1bbfbb4a1248380091"


class OfficialFontError(Exception):
    def __init__(self, code, message, diagnostics=None):
        super().__init__(message)
        self.code, self.diagnostics = code, diagnostics or []


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _bytecode(item):
    if item.bytecode is None:
        item.compile()
    return item.bytecode


def font_version(contract):
    """Map the shared semantic version to OpenType's three fractional digits.

    One minor digit and two patch digits fit this mapping exactly. Keep the
    full semantic version in name/CFF fields and reject ambiguous versions.
    """
    version = contract.get("fontVersion")
    match = re.fullmatch(r"(0|[1-9]\d*)\.([0-9])\.(0|[1-9]\d?)", version) if isinstance(version, str) else None
    if not match or int(match[1]) > 32767:
        raise OfficialFontError("invalid_contract", "Invalid font version in the shared contract.")
    major, minor, patch = map(int, match.groups())
    fraction = minor * 100 + patch
    return version, major + fraction / 1000, f"Version {major}.{fraction:03d}; {FAMILY} {version}"


def verify_official_source(data, profile):
    """Check the immutable official asset independently of the JS transport."""
    manifest = json.loads((HERE / "official-sources.json").read_text(encoding="utf-8"))
    records = manifest.get("files", {})
    if isinstance(records, list):
        records = {item["id"]: item for item in records}
    record = records.get(profile.id)
    if not isinstance(record, dict) or len(data) != record.get("bytes") or _sha(data) != record.get("sha256"):
        raise OfficialFontError("unsupported_official_source", "The official font does not match its pinned source hash.",
                                [{"weight": profile.id, "code": "unsupported_official_source"}])


def decode_official_fonts(payload):
    """Decode all nine snapshot assets and verify transport claims and pins."""
    if not isinstance(payload, dict) or set(payload) != set(PROFILES):
        raise OfficialFontError("unsupported_official_source", "The snapshot must include all nine pinned official OTFs.")
    pins = json.loads((HERE / "official-sources.json").read_text(encoding="utf-8"))["files"]
    decoded = {}
    for identity, profile in PROFILES.items():
        item = payload[identity]
        if not isinstance(item, dict) or set(item) != {"sha256", "data"} or item["sha256"] != pins[identity]["sha256"]:
            raise OfficialFontError("unsupported_official_source", "The declared official source hash is invalid.")
        try:
            data = base64.b64decode(item["data"], validate=True)
        except (ValueError, TypeError, binascii.Error) as error:
            raise OfficialFontError("unsupported_official_source", "The official font transport must contain valid base64.") from error
        verify_official_source(data, profile)
        decoded[identity] = data
    return decoded


def original_snapshot(font, order=None):
    """Hash original byte-level glyph data and retain all placement metrics."""
    names = list(font.getGlyphOrder() if order is None else order)
    top = font["CFF "].cff.topDictIndex[0]
    if len(top.FDArray) < 1:
        raise OfficialFontError("unsupported_official_source", "The official source must use CID CFF outlines.")
    private = top.FDArray[0].Private
    size, offset = top.FDArray[0].rawDict["Private"]
    return {
        "order": names,
        "charstrings": _sha(b"".join(struct.pack(">I", len(code)) + code
                                      for name in names for code in [_bytecode(top.CharStrings[name])])),
        "globalSubrs": [_sha(_bytecode(item)) for item in font["CFF "].cff.GlobalSubrs],
        "localSubrsFD0": [_sha(_bytecode(item)) for item in private.Subrs],
        "privateFD0Bytes": _sha(font.reader["CFF "][offset:offset + size]),
        "privateFD0Values": {key: copy.deepcopy(value) for key, value in private.rawDict.items() if key != "Subrs"},
        "fdSelectOriginal": list(top.FDSelect.gidArray[:len(names)]),
        "hmtxOriginalRecords": _sha(b"".join(struct.pack(">Hh", *font["hmtx"][name]) for name in names)),
        "vmtxOriginalRecords": _sha(b"".join(struct.pack(">Hh", *font["vmtx"][name]) for name in names)) if "vmtx" in font else None,
        "cmapBytes": _sha(font.reader["cmap"]),
        "unitsPerEm": font["head"].unitsPerEm,
        "hheaMetrics": [getattr(font["hhea"], key) for key in ("ascent", "descent", "lineGap", "caretSlopeRise", "caretSlopeRun", "caretOffset")],
        "vheaMetrics": [getattr(font["vhea"], key) for key in ("ascent", "descent", "lineGap", "caretSlopeRise", "caretSlopeRun", "caretOffset")] if "vhea" in font else None,
        "os2Metrics": {key: getattr(font["OS/2"], key) for key in ("sTypoAscender", "sTypoDescender", "sTypoLineGap", "usWinAscent", "usWinDescent", "sxHeight", "sCapHeight")},
        "headFontBBox": [font["head"].xMin, font["head"].yMin, font["head"].xMax, font["head"].yMax],
        "CFFFontBBox": list(top.FontBBox),
        "FD0FontMatrix": list(top.FDArray[0].FontMatrix),
    }


class OriginalPrivateCompiler(PrivateDictCompiler):
    def compile(self, reason):
        # FontTools otherwise re-encodes equivalent DICT integers. The local
        # Subrs INDEX follows this unchanged Private DICT in each pinned OTF.
        return self.dictObj.original_bytes


def _rename(font, contract, profile):
    version, revision, name_version = font_version(contract)
    ps_name = "HangulPalette-" + profile.label
    values = {1: FAMILY, 2: profile.label, 3: ps_name + "-" + version,
              4: FAMILY + " " + profile.label, 5: name_version, 6: ps_name,
              16: FAMILY, 17: profile.label, 18: FAMILY + " " + profile.label,
              21: FAMILY, 22: profile.label, 25: "HangulPalette"}
    for identity, value in values.items():
        encodings = {(item.platformID, item.platEncID, item.langID)
                     for item in font["name"].names if item.nameID == identity}
        for platform, encoding, language in encodings | {(3, 1, 0x409)}:
            font["name"].setName(value, identity, platform, encoding, language)
    font["name"].setName("Semantic-region color derivative of Pretendard v1.3.9. Official original glyphs and metrics retained.",
                         10, 3, 1, 0x409)
    # Retain the official copyright, designer, attribution and OFL records.
    font["name"].setName("SIL Open Font License, Version 1.1.", 13, 3, 1, 0x409)
    font["name"].setName("https://openfontlicense.org/", 14, 3, 1, 0x409)
    top = font["CFF "].cff.topDictIndex[0]
    font["CFF "].cff.fontNames = [ps_name]
    top.FullName, top.FamilyName, top.version = FAMILY + " " + profile.label, FAMILY, version
    top.FDArray[0].FontName = ps_name + "-OriginalGlyphs"
    font["head"].fontRevision = revision


def _op(a, b, operator):
    return pathops.op(a, b, operator)


def _compound(first, second):
    result = pathops.Path(first)
    result.addPath(second)
    return result


def _glyph_path(glyph, simplify=True):
    result = pathops.Path()
    glyph.draw(result.getPen())
    return pathops.simplify(result) if simplify else result


def _expanded(path, radius, strategy="normalized-stroke"):
    if strategy == "translated-mask-copies":
        # Every normalized mask has nonnegative filled winding. Including the
        # exact (0, 0) copy makes this compound fill a mathematical superset;
        # shifted copies provide a small guard without a stroke/UNION Boolean.
        expanded = pathops.Path()
        for dx in (-radius, 0, radius):
            for dy in (-radius, 0, radius):
                expanded.addPath(path.transform(1, 0, 0, 1, dx, dy))
        lost = abs(_op(path, expanded, pathops.PathOp.DIFFERENCE).area)
        if lost > MAX_PRE_ENCODE_AREA_ERROR:
            raise ValueError(f"Translated semantic mask guard failed its superset check: {lost}.")
        return expanded
    edge = pathops.Path(path)
    edge.stroke(2 * radius, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
    edge.convertConicsToQuads(0.001)
    # Stroke outlines can contain overlapping contours with mixed windings.
    # Normalize that fill on its own before combining it with the mask. In
    # particular, unnormalized strokes can make UNION remove entire counters.
    edge = pathops.simplify(edge)
    expanded = _op(path, edge, pathops.PathOp.UNION)
    lost = abs(_op(path, expanded, pathops.PathOp.DIFFERENCE).area)
    if lost > MAX_PRE_ENCODE_AREA_ERROR:
        raise ValueError(f"Semantic mask expansion removed original filled area: {lost}.")
    return expanded


def _region_source_geometry_hash(regions):
    """Bind calibration to physical source contours, independently of labels."""
    contours = {}
    for region in regions:
        pen = RecordingPen()
        parse_path(region["d"], pen)
        paths, current = [], []
        for operation, arguments in pen.value:
            current.append((operation, arguments))
            if operation == "closePath":
                paths.append(current)
                current = []
        if current or len(paths) != len(region["contourRefs"]):
            raise ValueError("Calibrated source contour paths no longer match their physical references.")
        for ref, path in zip(region["contourRefs"], paths, strict=True):
            if ref in contours:
                raise ValueError("Calibrated source contour reference was repeated.")
            contours[ref] = path
    return _sha(json.dumps(sorted(contours.items()), ensure_ascii=False, separators=(",", ":")).encode())


def _allocate_official_fill(original, merged, pieces, regions, piece_indices, char, weight):
    """Calibrate one official compiled overlap absent from the Glyphs masks.

    Black 셱's official merged ㅅ/ㅖ outline includes a small filled inner
    corner below physical source contour 3. Follow that contour's explicitly
    selected label so edits survive export, while the ㅅ curve stays smooth.
    This never changes the original glyph or extends a layer outside its fill.
    """
    if char != "셱" or weight != "black":
        return pieces, merged, []
    geometry_hash = _region_source_geometry_hash(regions)
    if geometry_hash != BLACK_SYEK_GEOMETRY_SHA256:
        raise ValueError("The calibrated Black 셱 physical source geometry changed.")
    owners = [(index, item) for index, item in enumerate(regions) if 3 in item["contourRefs"]]
    if len(owners) != 1:
        raise ValueError("The calibrated Black 셱 physical contour has no unique explicit region.")
    region_index, region = owners[0]
    residual = _op(original, merged, pathops.PathOp.DIFFERENCE)
    area, bounds = abs(residual.area), residual.bounds
    if not (1000 < area < 1400 and bounds and 880 <= bounds[0] <= bounds[2] <= 961 and
            840 <= bounds[1] <= bounds[3] <= 886):
        raise ValueError(f"The calibrated Black 셱 official-only corner changed: area={area}, bounds={bounds}.")
    index = piece_indices[region_index]
    owner = pieces[index][1]
    adjacency = abs(_op(residual, _expanded(owner, 1), pathops.PathOp.INTERSECTION).area)
    distant = abs(_op(residual, _expanded(owner, 40), pathops.PathOp.DIFFERENCE).area)
    if adjacency <= 1 or distant > MAX_PRE_ENCODE_AREA_ERROR:
        raise ValueError("The calibrated Black 셱 corner is not adjacent to its vowel bar.")
    pieces[index] = (region["slot"], _compound(owner, residual))
    merged = _compound(merged, residual)
    allocation = {"id": "black-syek-lower-vowel-corner", "char": char, "weight": weight,
                  "sourceContourRef": 3, "slotId": region["slotId"], "slot": region["slot"], "area": area,
                  "bounds": list(bounds), "sourceGeometrySha256": geometry_hash,
                  "maximumOwnerDistanceUnits": 40, "adjacentFilledArea": adjacency,
                  "reason": "The official merged outline fills the inner corner next to source contour 3; follow its explicit region and retain the curved initial consonant boundary."}
    return pieces, merged, [allocation]


def _partition_once(original, regions, scale, radius, char=None, weight=None, strategy="normalized-stroke"):
    """Clip independently expanded semantic masks to official filled outlines.

    Independent overlap avoids transparent raster seams. The source region
    sequence remains the paint order; only directly adjacent equal slots may
    share a layer. No whole-glyph opaque backdrop consumes a COLR layer record.
    """
    pieces, piece_indices, merged = [], [], pathops.Path()
    for region in regions:
        mask = pathops.Path()
        parse_path(region["d"], TransformPen(mask.getPen(), (scale, 0, 0, -scale, 0, 0)))
        mask = pathops.simplify(mask)
        guarded = _expanded(mask, radius, strategy)
        piece = _op(original, guarded, pathops.PathOp.INTERSECTION)
        if abs(piece.area) <= 0.00001:
            raise ValueError("A semantic region has no filled area in the official glyph.")
        outside = abs(_op(piece, original, pathops.PathOp.DIFFERENCE).area)
        if outside > MAX_PRE_ENCODE_AREA_ERROR:
            raise ValueError(f"A clipped semantic region escaped the official fill: area={outside}.")
        if pieces and pieces[-1][0] == region["slot"]:
            pieces[-1] = (region["slot"], _compound(pieces[-1][1], piece))
        else:
            pieces.append((region["slot"], piece))
        piece_indices.append(len(pieces) - 1)
        merged = _compound(merged, piece)
    pieces, merged, allocations = _allocate_official_fill(original, merged, pieces, regions, piece_indices, char, weight)
    remaining = abs(_op(original, merged, pathops.PathOp.DIFFERENCE).area)
    xor = abs(_op(original, merged, pathops.PathOp.XOR).area)
    if remaining > MAX_PRE_ENCODE_AREA_ERROR or xor > MAX_PRE_ENCODE_AREA_ERROR:
        raise ValueError(f"Official outline coverage failed: remaining={remaining}, xor={xor}.")
    return pieces, {"originalArea": abs(original.area), "remainingArea": remaining, "xorArea": xor,
                    "semanticMaskGuardUnits": radius, "maskExpansionStrategy": strategy,
                    "officialFillAllocations": allocations}


def _partition(original, regions, scale, char=None, weight=None):
    # Skia Boolean operations can degenerate on nearly coincident curves for
    # a particular expansion radius. Retry a small, bounded set of semantic
    # masks with exactly the same acceptance checks; never accept a failed
    # Boolean result or relax the measured filled-outline tolerance.
    failures = []
    for strategy in MASK_STRATEGIES:
        for radius in MASK_GUARD_CANDIDATES:
            try:
                return _partition_once(original, regions, scale, radius, char, weight, strategy)
            except (ValueError, pathops.PathOpsError) as error:
                failures.append(f"strategy={strategy}, guard={radius}: {error}")
    raise ValueError("No valid official mask clipping: " + "; ".join(failures))


def _inside(drawable, point):
    pen = PointInsidePen(None, point, evenOdd=False)
    drawable.draw(pen)
    return pen.getResult()


def _check_filled_points(original_glyph, pieces, bounds, steps=17):
    """Use raw curve winding, independently of Boolean area calculations."""
    x0, y0, x1, y1 = bounds
    x0, y0, x1, y1 = x0 - 2, y0 - 2, x1 + 2, y1 + 2
    for x in range(steps):
        for y in range(steps):
            point = (x0 + (x1 - x0) * (x + 0.381966) / steps,
                     y0 + (y1 - y0) * (y + 0.618034) / steps)
            if _inside(original_glyph, point) != any(_inside(piece, point) for piece in pieces):
                raise ValueError(f"Independent curve winding disagrees at {point}.")
    return steps * steps


class _CubicRecordingPen(BasePen):
    """Expand quadratic runs into their exact cubic control points."""
    def __init__(self):
        super().__init__(None)
        self.recording = RecordingPen()

    def _moveTo(self, point):
        self.recording.moveTo(point)

    def _lineTo(self, point):
        self.recording.lineTo(point)

    def _curveToOne(self, first, second, end):
        self.recording.curveTo(first, second, end)

    def _closePath(self):
        self.recording.closePath()

    def _endPath(self):
        self.recording.endPath()


def _canonical_records(drawable):
    pen = _CubicRecordingPen()
    drawable.draw(pen)
    output, start = [], None
    for operation, arguments in pen.recording.value:
        if operation == "moveTo":
            start = arguments[0]
        if operation == "lineTo" and len(output) >= 2 and output[-1][0] == "lineTo":
            # Type 2 specialization joins successive straight segments on the
            # same line. Remove only exact, same-direction collinear vertices;
            # this is identical polygon geometry, not an error allowance.
            first = output[-2][1][-1]
            middle, last = output[-1][1][0], arguments[0]
            before = (middle[0] - first[0], middle[1] - first[1])
            after = (last[0] - middle[0], last[1] - middle[1])
            if before[0] * after[1] == before[1] * after[0] and before[0] * after[0] + before[1] * after[1] >= 0:
                output.pop()
        if (operation == "closePath" and output and output[-1][0] == "lineTo" and
            max(abs(a - b) for a, b in zip(output[-1][1][0], start, strict=True)) <= MAX_DECODED_COORDINATE_ERROR):
            output.pop()
        output.append((operation, arguments))
    return output


def _coordinate_error(actual, expected):
    """Same cubic topology plus bounded controls proves bounded curve error."""
    actual, expected = _canonical_records(actual), _canonical_records(expected)
    if len(actual) != len(expected):
        raise ValueError("A decoded semantic region changed its cubic command count.")
    maximum = 0.0
    for (operation, points), (reference_operation, reference_points) in zip(actual, expected, strict=True):
        if operation != reference_operation or len(points) != len(reference_points):
            raise ValueError("A decoded semantic region changed its cubic topology.")
        for point, reference in zip(points, reference_points, strict=True):
            maximum = max(maximum, *(abs(a - b) for a, b in zip(point, reference, strict=True)))
    if maximum > MAX_DECODED_COORDINATE_ERROR:
        raise ValueError(f"Decoded semantic region control-point error exceeds tolerance: {maximum}.")
    return maximum


def _check_allocation_ownership(layers, pieces, expected_pieces, allocation):
    """Sample the calibrated corner and the adjacent, unchanged ㅅ curve."""
    x0, y0, x1, y1 = (880, 840, 961, 886)
    for x in range(33):
        for y in range(33):
            point = (x0 + (x1 - x0) * (x + 0.381966) / 33,
                     y0 + (y1 - y0) * (y + 0.618034) / 33)
            for slot in (allocation["slot"], 0):
                actual = any(_inside(pieces[layer.name], point) for layer in layers if layer.colorID == slot)
                expected = any(_inside(piece, point) for color, piece in expected_pieces if color == slot)
                if actual != expected:
                    raise ValueError(f"The calibrated vowel corner or adjacent initial curve changed at {point}.")
    return 33 * 33 * 2


def build_official_font(glyphs, contract, profile, official_bytes):
    """Return (WOFF2 bytes, geometry audit) from one official static OTF."""
    if pathops.__version__ != "0.9.2":
        raise OfficialFontError("incompatible_runtime", "skia-pathops 0.9.2 is required. Run bun run setup:font.")
    verify_official_source(official_bytes, profile)
    font = TTFont(io.BytesIO(official_bytes), recalcBBoxes=False, recalcTimestamp=False)
    original_order = list(font.getGlyphOrder())
    order, cmap_bytes, cmap = list(original_order), font.reader["cmap"], dict(font.getBestCmap())
    # Materialize metric tables before changing maxp/order (Thin–Light also
    # carry vertical metrics). Otherwise lazy decoding uses the expanded size.
    horizontal, vertical = font["hmtx"].metrics, font["vmtx"].metrics if "vmtx" in font else None
    top = font["CFF "].cff.topDictIndex[0]
    if len(top.FDArray) != 1:
        raise OfficialFontError("unsupported_official_source", "The pinned official OTF must have one original CFF font dictionary.")
    size, offset = top.FDArray[0].rawDict["Private"]
    original_private = top.FDArray[0].Private
    if original_private.rawDict.get("Subrs") != size:
        raise OfficialFontError("unsupported_official_source", "The official Private DICT/Subrs layout is unsupported.")
    original_private.original_bytes = font.reader["CFF "][offset:offset + size]
    original_private.compilerClass = OriginalPrivateCompiler
    private = PrivateDict()
    private.defaultWidthX = private.nominalWidthX = 0
    fd = FontDict(GlobalSubrs=font["CFF "].cff.GlobalSubrs)
    fd.Private, fd.FontName = private, "HangulPalette-" + profile.label + "-Regions"
    fd.FontMatrix = list(top.FDArray[0].FontMatrix)
    fd_index = len(top.FDArray)
    top.FDArray.append(fd)
    next_cid = max(int(name[3:]) for name in order if name.startswith("cid")) + 1
    glyphset, scale = font.getGlyphSet(), font["head"].unitsPerEm / SOURCE_UPM
    colored, shared, diagnostics, counts = {}, {}, [], Counter()
    maximum_xor = maximum_remaining = 0.0
    guards, retried, guard_records, allocations = Counter(), [], [], []
    strategies, strategy_fallbacks = Counter(), []
    for glyph in glyphs:
        char = glyph["char"]
        try:
            base = cmap[ord(char)]
            pieces, audit = _partition(_glyph_path(glyphset[base]), glyph["regions"], scale, char, profile.id)
            allocations.extend(audit["officialFillAllocations"])
            guards[str(audit["semanticMaskGuardUnits"])] += 1
            strategy = audit["maskExpansionStrategy"]
            strategies[strategy] += 1
            guard_records.append([char, audit["semanticMaskGuardUnits"], strategy])
            if strategy != MASK_STRATEGIES[0]:
                strategy_fallbacks.append({"char": char, "strategy": strategy, "guardUnits": audit["semanticMaskGuardUnits"]})
            if audit["semanticMaskGuardUnits"] != MASK_GUARD:
                retried.append({"char": char, "guardUnits": audit["semanticMaskGuardUnits"]})
            maximum_xor, maximum_remaining = max(maximum_xor, audit["xorArea"]), max(maximum_remaining, audit["remainingArea"])
            colored[base] = []
            for slot, piece in pieces:
                pen = T2CharStringPen(horizontal[base][0], None, roundTolerance=0)
                piece.draw(pen)
                charstring = pen.getCharString(private=private, globalSubrs=font["CFF "].cff.GlobalSubrs)
                key = _bytecode(charstring)
                name = shared.get(key)
                if name is None:
                    if len(order) >= 65535 or next_cid > 65535:
                        raise OfficialFontError("font_capacity", "The CFF glyph/CID limit was exceeded.")
                    name = f"cid{next_cid:05d}"
                    next_cid += 1
                    shared[key] = name
                    charstring.fdSelectIndex = fd_index
                    top.CharStrings.charStrings[name] = len(top.CharStrings.charStringsIndex)
                    top.CharStrings.charStringsIndex.append(charstring)
                    top.charset.append(name)
                    top.FDSelect.gidArray.append(fd_index)
                    order.append(name)
                    bounds = BoundsPen(None)
                    piece.draw(bounds)
                    horizontal[name] = (horizontal[base][0], round(bounds.bounds[0]) if bounds.bounds else 0)
                    if vertical is not None:
                        vertical[name] = vertical[base]
                colored[base].append((name, slot))
            counts["clippedCharacters"] += 1
            counts["sourceSemanticRegions"] += len(glyph["regions"])
            counts["encodedCOLRLayers"] += len(pieces)
            if counts["encodedCOLRLayers"] > 65535:
                raise OfficialFontError("font_capacity", "The COLR v0 layer record limit was exceeded.")
        except (ValueError, KeyError, pathops.PathOpsError) as error:
            diagnostics.append({"char": char, "weight": profile.id, "code": "official_geometry", "message": str(error)})
    if diagnostics:
        raise OfficialFontError("official_geometry", "Official outline clipping failed for the listed characters.", diagnostics)
    top.CIDCount = max(top.CIDCount, next_cid)
    font.setGlyphOrder(order)
    font["maxp"].numGlyphs = len(order)
    raw_cmap = DefaultTable("cmap")
    raw_cmap.data = cmap_bytes
    font["cmap"] = raw_cmap
    _rename(font, contract, profile)
    font["COLR"] = buildCOLR(colored, version=0, glyphMap=font.getReverseGlyphMap())
    font["CPAL"] = buildCPAL([[(0.0, 0.0, 0.0, 1.0)] * len(contract["slots"])])
    font.flavor = "woff2"
    output = io.BytesIO()
    font.save(output)
    font.close()
    pin_manifest = json.loads((HERE / "official-sources.json").read_text(encoding="utf-8"))
    official_source = {key: pin_manifest[key] for key in ("repository", "ref", "revision")}
    official_source.update(pin_manifest["files"][profile.id])
    colored_mapped = sum(name in colored for name in cmap.values())
    return output.getvalue(), {"counts": dict(counts), "originalGlyphs": len(original_order),
                              "addedRegionGlyphs": len(shared), "totalGlyphs": len(order),
                              "officialSha256": _sha(official_bytes), "semanticMaskGuardUnits": MASK_GUARD,
                              "semanticMaskGuardCounts": dict(guards), "clippingRetries": retried,
                              "maskExpansionStrategies": dict(strategies), "maskExpansionFallbacks": strategy_fallbacks,
                              "officialFillAllocations": allocations,
                              "maximumSemanticMaskGuardUnits": max(map(float, guards)),
                              "clippingGuardSha256": _sha(json.dumps(guard_records, ensure_ascii=False, separators=(",", ":")).encode()),
                              "officialSource": official_source,
                              "fontCoverage": {"mappedCharacters": len(cmap), "coloredCharacters": len(glyphs),
                                               "coloredMappedCharacters": colored_mapped,
                                               "originalGlyphs": len(original_order), "monochromeMappedCharacters": len(cmap) - colored_mapped},
                              "maximumPreEncodeXorArea": maximum_xor,
                              "maximumPreEncodeUnownedArea": maximum_remaining}


def validate_official_font(data, official_bytes, glyphs, contract, profile):
    """Independently decode all originals and all color layers after WOFF2."""
    verify_official_source(official_bytes, profile)
    version, revision, name_version = font_version(contract)
    with TTFont(io.BytesIO(official_bytes), recalcBBoxes=False, recalcTimestamp=False) as original, \
         TTFont(io.BytesIO(data), recalcBBoxes=False, recalcTimestamp=False) as generated:
        before = original_snapshot(original)
        after = original_snapshot(generated, before["order"])
        checks = {key: before[key] == after[key] for key in before}
        checks["glyphIdOrder"] = generated.getGlyphOrder()[:len(before["order"])] == before["order"]
        if not all(checks.values()):
            raise OfficialFontError("font_validation", "Original official glyph data or metrics changed.",
                                    [{"weight": profile.id, "code": "official_preservation", "message": key}
                                     for key, passed in checks.items() if not passed])
        for tag in generated.keys():
            generated[tag]
        if generated["COLR"].version != 0 or generated["CPAL"].version != 0:
            raise OfficialFontError("font_validation", "COLR v0 / CPAL v0 are required.")
        if (generated["name"].getDebugName(1) != FAMILY or generated["name"].getDebugName(2) != profile.label or
            generated["name"].getDebugName(6) != "HangulPalette-" + profile.label or
            generated["name"].getDebugName(5) != name_version or
            abs(generated["head"].fontRevision - revision) > 1 / 65536 or
            generated["CFF "].cff.topDictIndex[0].version != version or
            generated["OS/2"].usWeightClass != profile.weight):
            raise OfficialFontError("font_validation", "Generated font identity/version/weight is invalid.")
        palettes = generated["CPAL"]
        if palettes.numPaletteEntries != len(contract["slots"]) or len(palettes.palettes) != 1 or any(
            (color.red, color.green, color.blue, color.alpha) != (0, 0, 0, 255) for color in palettes.palettes[0]):
            raise OfficialFontError("font_validation", "The default palette must contain opaque black semantic slots.")
        cmap = generated.getBestCmap()
        colored = generated["COLR"].ColorLayers
        if set(colored) != {cmap[ord(glyph["char"])] for glyph in glyphs}:
            raise OfficialFontError("font_validation", "The decoded colored character set differs.")
        glyphset, original_glyphset = generated.getGlyphSet(), original.getGlyphSet()
        decoded, diagnostics, counts = {}, [], Counter()
        maximum_coordinate = maximum_pre_encode = 0.0
        guard_counts, guard_records, retries, allocations = Counter(), [], [], []
        strategies, strategy_fallbacks = Counter(), []
        for name in before["order"]:
            source_bounds, generated_bounds = BoundsPen(original_glyphset), BoundsPen(glyphset)
            original_glyphset[name].draw(source_bounds)
            glyphset[name].draw(generated_bounds)
            if source_bounds.bounds != generated_bounds.bounds:
                raise OfficialFontError("font_validation", "An original decoded glyph bound changed.",
                                        [{"weight": profile.id, "code": "official_outline", "glyph": name}])
            counts["decodedOriginalGlyphs"] += 1
        for glyph in glyphs:
            char = glyph["char"]
            try:
                base = cmap[ord(char)]
                layers = colored[base]
                expected_slots = [region["slot"] for index, region in enumerate(glyph["regions"])
                                  if index == 0 or glyph["regions"][index - 1]["slot"] != region["slot"]]
                if [layer.colorID for layer in layers] != expected_slots:
                    raise ValueError("Decoded palette slots or source paint priority changed.")
                official = _glyph_path(original_glyphset[base])
                expected_pieces, partition_audit = _partition(official, glyph["regions"], generated["head"].unitsPerEm / SOURCE_UPM, char, profile.id)
                allocations.extend(partition_audit["officialFillAllocations"])
                radius = partition_audit["semanticMaskGuardUnits"]
                guard_counts[str(radius)] += 1
                strategy = partition_audit["maskExpansionStrategy"]
                strategies[strategy] += 1
                guard_records.append([char, radius, strategy])
                if strategy != MASK_STRATEGIES[0]:
                    strategy_fallbacks.append({"char": char, "strategy": strategy, "guardUnits": radius})
                if radius != MASK_GUARD:
                    retries.append({"char": char, "guardUnits": radius})
                maximum_pre_encode = max(maximum_pre_encode, partition_audit["xorArea"])
                for layer, (_, expected_piece) in zip(layers, expected_pieces, strict=True):
                    if layer.name not in decoded:
                        decoded[layer.name] = _glyph_path(glyphset[layer.name], simplify=False)
                    piece = decoded[layer.name]
                    maximum_coordinate = max(maximum_coordinate, _coordinate_error(piece, expected_piece))
                detailed = char in "가값과밖휺쌀썰쐆괬딨폈클콥닄핝랬떴멕챘셱" or ord(char) % 97 == 0
                counts["independentFilledPoints"] += _check_filled_points(
                    original_glyphset[base], [decoded[layer.name] for layer in layers], official.bounds,
                    17 if detailed else 3)
                counts["independentFilledPointCharacters"] += 1
                for allocation in partition_audit["officialFillAllocations"]:
                    counts["independentAllocationOwnershipPoints"] += _check_allocation_ownership(
                        layers, decoded, expected_pieces, allocation)
                counts["decodedOfficialFilledOutlines"] += 1
                counts["decodedRegionOutlines"] += len(layers)
                counts["sourcePaintOrders"] += 1
            except (ValueError, KeyError, pathops.PathOpsError) as error:
                diagnostics.append({"char": char, "weight": profile.id, "code": "official_decoded_geometry", "message": str(error)})
        if diagnostics:
            raise OfficialFontError("font_validation", "Decoded official color geometry validation failed.", diagnostics)
        layer_records = struct.unpack(">HHIIH", generated.reader["COLR"][:14])[-1]
        return {"schemaVersion": 1, "passed": True, "fontSha256": _sha(data), "checks": dict(counts),
                "originalPreservation": checks, "officialSha256": _sha(official_bytes),
                "characters": len(glyphs), "fontGlyphs": generated["maxp"].numGlyphs,
                "originalGlyphs": len(before["order"]), "encodedCOLRLayers": layer_records,
                "originalCmapCharacters": len(cmap), "sourceLayerOrderPreserved": True,
                "compoundHolesPreserved": True, "allRegionAndFallbackOutlinesDecoded": True,
                "defaultPaletteBlack": True, "weight": profile.weight, "weightName": profile.label,
                "semanticMaskGuardUnits": MASK_GUARD, "maximumPreEncodeXorArea": maximum_pre_encode,
                "semanticMaskGuardCounts": dict(guard_counts), "clippingRetries": retries,
                "maskExpansionStrategies": dict(strategies), "maskExpansionFallbacks": strategy_fallbacks,
                "officialFillAllocations": allocations,
                "maximumSemanticMaskGuardUnits": max(map(float, guard_counts)),
                "clippingGuardSha256": _sha(json.dumps(guard_records, ensure_ascii=False, separators=(",", ":")).encode()),
                "maximumDecodedCoordinateError": maximum_coordinate,
                "decodedCoordinateTolerance": MAX_DECODED_COORDINATE_ERROR,
                "decodedGeometryProof": "matching-cubic-topology-and-bounded-control-points",
                "partitionReference": "official-static-otf-outline"}
