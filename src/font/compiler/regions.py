#!/usr/bin/env python3
"""Resolve explicit, stable semantic-region assignments without inferring labels."""

from collections import Counter
from functools import lru_cache
import json
from pathlib import Path
import re

from fontTools.pens.boundsPen import BoundsPen
from fontTools.svgLib.path import parse_path

ASSIGNMENT_FORMAT = "semantic-regions-v1"
UNASSIGNED = "unassigned"
INITIALS = list("ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ")
VOWELS = list("ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ")
FINALS = [""] + list("ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ")
COMPONENTS = {'ㄲ': 'ㄱㄱ',
 'ㄸ': 'ㄷㄷ',
 'ㅃ': 'ㅂㅂ',
 'ㅆ': 'ㅅㅅ',
 'ㅉ': 'ㅈㅈ',
 'ㄳ': 'ㄱㅅ',
 'ㄵ': 'ㄴㅈ',
 'ㄶ': 'ㄴㅎ',
 'ㄺ': 'ㄹㄱ',
 'ㄻ': 'ㄹㅁ',
 'ㄼ': 'ㄹㅂ',
 'ㄽ': 'ㄹㅅ',
 'ㄾ': 'ㄹㅌ',
 'ㄿ': 'ㄹㅍ',
 'ㅀ': 'ㄹㅎ',
 'ㅄ': 'ㅂㅅ',
 'ㅐ': 'ㅏㅣ',
 'ㅒ': 'ㅑㅣ',
 'ㅔ': 'ㅓㅣ',
 'ㅖ': 'ㅕㅣ',
 'ㅘ': 'ㅗㅏ',
 'ㅙ': 'ㅗㅏㅣ',
 'ㅚ': 'ㅗㅣ',
 'ㅝ': 'ㅜㅓ',
 'ㅞ': 'ㅜㅓㅣ',
 'ㅟ': 'ㅜㅣ',
 'ㅢ': 'ㅡㅣ'}
COMPOUND_FINALS = set("ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄ")
FEATURES = {'ㅏ': ['vertical', 'right-bar'],
 'ㅑ': ['vertical', 'right-upper-bar', 'right-lower-bar'],
 'ㅓ': ['vertical', 'left-bar'],
 'ㅕ': ['vertical', 'left-upper-bar', 'left-lower-bar'],
 'ㅗ': ['vertical', 'horizontal'],
 'ㅜ': ['vertical', 'horizontal'],
 'ㅛ': ['horizontal', 'left-vertical', 'right-vertical'],
 'ㅠ': ['horizontal', 'left-vertical', 'right-vertical'],
 'ㅡ': ['horizontal'],
 'ㅣ': ['vertical']}

# Exact source coordinates for the retained, calibrated vowel junction masks.
VOWEL_JUNCTIONS = {'thin': ['M1593.4647887323943 -901.0985915492957L1593.4647887323943 -597.9999999999999L1683.6338028169014 '
          '-597.9999999999999L1683.6338028169014 -901.0985915492957Z',
          'M125.6619718309859 -919.2957746478872L125.6619718309859 -837.4929577464789L2363.5774647887324 '
          '-837.4929577464789L2363.5774647887324 -919.2957746478872Z',
          None],
 'extra-light': ['M1574.3098591549297 -866.7323943661972L1574.3098591549297 -558L1708.4225352112676 '
                 '-558L1708.4225352112676 -866.7323943661972Z',
                 'M117.77464788732395 -936.1971830985915L117.77464788732395 '
                 '-825.661971830986L2373.718309859155 -825.661971830986L2373.718309859155 '
                 '-936.1971830985915Z',
                 None],
 'light': ['M1555.1549295774648 -832.3661971830986L1555.1549295774648 -518L1733.2112676056338 '
           '-518L1733.2112676056338 -832.3661971830986Z',
           'M109.88732394366197 -953.0985915492957L109.88732394366197 -813.830985915493L2383.8591549295775 '
           '-813.830985915493L2383.8591549295775 -953.0985915492957Z',
           None],
 'regular': ['M1536 -798L1536 -478L1758 -478L1758 -798Z',
             'M102 -970L102 -802L2394 -802L2394 -970Z',
             'M1536 -928L1536 -478L1758 -478L1758 -928Z'],
 'medium': ['M1515.2452830188681 -762.5283018867925L1515.2452830188681 -435.7358490566038L1784.0377358490568 '
            '-435.7358490566038L1784.0377358490568 -762.5283018867925Z',
            'M93.69811320754717 -988.4905660377358L93.69811320754717 -790.3018867924528L2404.1886792452833 '
            '-790.3018867924528L2404.1886792452833 -988.4905660377358Z',
            None],
 'semi-bold': ['M1494.4905660377358 -727.0566037735848L1494.4905660377358 '
               '-393.47169811320754L1810.0754716981132 -393.47169811320754L1810.0754716981132 '
               '-727.0566037735848Z',
               'M85.39622641509433 -1006.9811320754717L85.39622641509433 '
               '-778.6037735849056L2414.377358490566 -778.6037735849056L2414.377358490566 '
               '-1006.9811320754717Z',
               None],
 'bold': ['M1473.7358490566037 -691.5849056603773L1473.7358490566037 -351.20754716981133L1836.1132075471698 '
          '-351.20754716981133L1836.1132075471698 -691.5849056603773Z',
          'M77.09433962264151 -1025.4716981132076L77.09433962264151 -766.9056603773586L2424.566037735849 '
          '-766.9056603773586L2424.566037735849 -1025.4716981132076Z',
          None],
 'extra-bold': ['M1452.9811320754716 -656.1132075471698L1452.9811320754716 '
                '-308.9433962264151L1862.1509433962265 -308.9433962264151L1862.1509433962265 '
                '-656.1132075471698Z',
                'M68.79245283018868 -1043.9622641509434L68.79245283018868 '
                '-755.2075471698113L2434.754716981132 -755.2075471698113L2434.754716981132 '
                '-1043.9622641509434Z',
                None],
 'black': ['M1432.2264150943397 -620.6415094339623L1432.2264150943397 -266.6792452830189L1888.188679245283 '
           '-266.6792452830189L1888.188679245283 -620.6415094339623Z',
           'M60.49056603773585 -1062.4528301886792L60.49056603773585 -743.5094339622642L2444.943396226415 '
           '-743.5094339622642L2444.943396226415 -1062.4528301886792Z',
           None]}

JUNCTION_GAP_FIXES = {'thin': {'몋': [{'contourRef': 0,
                 'beforeD': 'M1295.6901408450703 -1906.394366197183L1295.6901408450703 '
                            '-1817.9718309859154L2035.1830985915492 -1817.9718309859154L2035.1830985915492 '
                            '-1906.394366197183Z',
                 'afterD': 'M1295.6901408450703 -1906.394366197183L1295.6901408450703 '
                           '-1817.9718309859154L2080.7605633802816 -1817.9718309859154L2080.7605633802816 '
                           '-1906.394366197183Z',
                 'slotId': 'medial.part1.left-upper-bar',
                 'supportRef': 8,
                 'supportD': 'M2036.676056338028 -2256.957746478873L2036.676056338028 '
                             '-928.0281690140845L2124.845070422535 -928.0281690140845L2124.845070422535 '
                             '-2256.957746478873Z',
                 'supportSlotId': 'medial.part1.vertical'},
                {'contourRef': 1,
                 'beforeD': 'M1295.6901408450703 -1486.3661971830986L1295.6901408450703 '
                            '-1397.6338028169014L2035.1830985915492 -1397.6338028169014L2035.1830985915492 '
                            '-1486.3661971830986Z',
                 'afterD': 'M1295.6901408450703 -1486.3661971830986L1295.6901408450703 '
                           '-1397.6338028169014L2080.7605633802816 -1397.6338028169014L2080.7605633802816 '
                           '-1486.3661971830986Z',
                 'slotId': 'medial.part1.left-lower-bar',
                 'supportRef': 8,
                 'supportD': 'M2036.676056338028 -2256.957746478873L2036.676056338028 '
                             '-928.0281690140845L2124.845070422535 -928.0281690140845L2124.845070422535 '
                             '-2256.957746478873Z',
                 'supportSlotId': 'medial.part1.vertical'}]}}

def components(value):
    return list(COMPONENTS.get(value, value))


def semantics(char):
    if 0xAC00 <= ord(char) <= 0xD7A3:
        number = ord(char) - 0xAC00
        values = {"initial": INITIALS[number // 588], "medial": VOWELS[number // 28 % 21],
                  "final": FINALS[number % 28]}
    elif char in VOWELS:
        values = {"medial": char}
    elif char in COMPOUND_FINALS:
        values = {"final": char}
    else:
        values = {"initial": char}
    return {role: {"value": value, "components": [{"index": i + 1, "value": c}
             for i, c in enumerate(components(value))]} for role, value in values.items() if value}


@lru_cache(maxsize=None)
def bounds(d):
    pen = BoundsPen(None)
    parse_path(d, pen)
    return list(pen.bounds)


def junction_constraints(regions, semantic):
    constraints = []
    for region in regions:
        role, part, feature = region["slotId"].split(".")
        if role == "medial":
            component = semantic[role]["components"][int(part[-1]) - 1]["value"]
            support = "horizontal" if component in "ㅗㅛㅜㅠ" else "vertical"
            is_branch = feature != support
        else:
            support, is_branch = "body", feature == "added-bar"
        if is_branch:
            for other in regions:
                if (other["sourceLayerIndex"] == region["sourceLayerIndex"] and
                    (other["slotId"] == f"{role}.{part}.{support}" or
                     (role == "medial" and feature.startswith("right-") and
                      other["slotId"] == f"medial.part{int(part[-1]) + 1}.vertical"))):
                    constraints.append({"under": region["id"], "over": other["id"],
                                        "reason": "Keep the continuous supporting stroke unbroken at the junction."})
    return constraints


def paint_order(regions, constraints):
    """Stable topological order, confined to the original layer blocks."""
    remaining = [region["id"] for region in regions]
    done, output = set(), []
    predecessors = {region_id: {c["under"] for c in constraints if c["over"] == region_id}
                    for region_id in remaining}
    while remaining:
        ready = next((region_id for region_id in remaining if predecessors[region_id] <= done), None)
        if ready is None:
            raise ValueError("Cyclic junction policy")
        remaining.remove(ready)
        done.add(ready)
        output.append(ready)
    return output


@lru_cache(maxsize=1)
def _contract_slots():
    return json.loads((Path(__file__).resolve().parent / "contract.json").read_text(encoding="utf-8"))["slots"]


def expected_regions(char, slots=None):
    """List exactly the Unicode constituent features, in shared contract order."""
    slots = _contract_slots() if slots is None else slots
    required = set()
    for role, part in semantics(char).items():
        for component in part["components"]:
            features = FEATURES[component["value"]] if role == "medial" else ["body", "added-bar"] if component["value"] == "ㅋ" else ["body"]
            required.update(f"{role}.part{component['index']}.{feature}" for feature in features)
    order = {slot["id"]: slot["index"] for slot in slots}
    if not required <= order.keys():
        raise ValueError("The shared contract has no slot for a Unicode constituent.")
    return sorted(required, key=order.__getitem__)


def resolve_glyph_regions(char, advance, paths, assignment, slots, weight="regular", reference_paths=None):
    """Keep explicit slot identities and contiguous paint runs as authored.

    Only the calibrated cross-master contour correspondence and geometric
    junction masks are applied. No geometry heuristic assigns or changes a
    semantic label. Disjoint occurrences of a slot are never merged globally.
    """
    if weight not in VOWEL_JUNCTIONS:
        raise ValueError("Unsupported calibrated weight: " + str(weight))
    if not isinstance(assignment, list) or any(not isinstance(pair, (list, tuple)) or len(pair) != 2 for pair in assignment):
        raise ValueError("Invalid direct semantic-region assignment pairs.")
    if any(not isinstance(ref, int) or isinstance(ref, bool) for ref, _ in assignment):
        raise ValueError("Contour references must be integers.")
    if Counter(ref for ref, _ in assignment) != Counter(range(len(paths))):
        raise ValueError("Every source contour must be assigned exactly once.")
    slot_ids = {slot["id"]: slot for slot in slots}
    if any(slot_id == UNASSIGNED for _, slot_id in assignment):
        raise ValueError("Every contour needs a semantic region before font export.")
    if any(not isinstance(slot_id, str) or slot_id not in slot_ids for _, slot_id in assignment):
        raise ValueError("Unknown semantic-region identifier.")
    if {slot_id for _, slot_id in assignment} != set(expected_regions(char, slots)):
        raise ValueError("Assignments must contain exactly the Unicode character's required semantic regions.")
    contours = {index: {"index": index, "d": path[0], "bounds": bounds(path[0])}
                for index, path in enumerate(paths)}
    reference = contours
    if reference_paths is not None:
        if len(reference_paths) != len(paths) or any(
            re.findall(r"[MLCZ]", path[0]) != re.findall(r"[MLCZ]", source[0])
            for path, source in zip(paths, reference_paths, strict=True)):
            raise ValueError("The weight geometry no longer has the calibrated Regular contour topology.")
        reference = {index: {"index": index, "d": path[0], "bounds": bounds(path[0])}
                     for index, path in enumerate(reference_paths)}
    # Regular contour IDs 1 and 12 exchange physical attachments in this
    # heavy master. Transport their stored identities, never infer new labels.
    remap = {1: 12, 12: 1} if char == "휺" and weight in {
        "medium", "semi-bold", "bold", "extra-bold", "black"
    } else {}
    if remap and reference_paths is None:
        raise ValueError("The heavy 휺 semantic correspondence requires its calibrated Regular reference.")
    if remap:
        reference = {ref: {**reference[remap.get(ref, ref)], "index": ref} for ref in reference}
    semantic = semantics(char)
    layers, regions, overrides = [], [], []
    original_slots = dict(assignment)
    for source_ref, slot_id in assignment:
        ref = remap.get(source_ref, source_ref)
        role = slot_id.split(".")[0]
        if not layers or layers[-1]["role"] != role:
            layers.append({"role": role, "contourRefs": []})
        layer_index = len(layers) - 1
        layers[-1]["contourRefs"].append(ref)
        if not regions or regions[-1]["slotId"] != slot_id or regions[-1]["sourceLayerIndex"] != layer_index:
            regions.append({"id": f"{ord(char):04x}-r{len(regions):02d}", "slotId": slot_id,
                            "slot": slot_ids[slot_id]["index"], "contourRefs": [], "sourceLayerIndex": layer_index})
        regions[-1]["contourRefs"].append(ref)
        if source_ref in remap:
            overrides.append({"sourceContourRef": source_ref, "contourRef": ref,
                              "originalSlotId": original_slots[ref], "slotId": slot_id,
                              "reason": "The heavy master exchanges the vowel branch and final ㅎ stem; retain the stored Regular semantic identity on its corresponding physical contour."})
    for layer in layers:
        layer["d"] = " ".join(contours[ref]["d"] for ref in layer["contourRefs"])
    for region in regions:
        region["partitionBounds"] = bounds(" ".join(reference[ref]["d"] for ref in region["contourRefs"]))
    constraints = junction_constraints(regions, semantic)
    ordered = []
    by_id = {region["id"]: region for region in regions}
    for index in range(len(layers)):
        current = [region for region in regions if region["sourceLayerIndex"] == index]
        ids = {region["id"] for region in current}
        ordered.extend(by_id[identity] for identity in paint_order(current, [item for item in constraints if item["under"] in ids]))
    for index, layer in enumerate(layers):
        refs = [ref for region in ordered if region["sourceLayerIndex"] == index for ref in region["contourRefs"]]
        if Counter(refs) != Counter(layer["contourRefs"]):
            raise ValueError("Semantic paint planning changed source contour occurrences.")
    geometry = []
    if char == "휺":
        branch_ref = remap.get(1, 1)
        before, support, after = VOWEL_JUNCTIONS[weight]
        # This exact source guard names physical refs 1 and 6; ref 1 becomes
        # the final stem in heavy masters, whose actual vowel branch is 12.
        if contours[1]["d"] != before or contours[6]["d"] != support:
            raise ValueError("The recorded ㅠ junction geometry no longer matches the source.")
        branch = next(region for region in ordered if branch_ref in region["contourRefs"])
        main = next(region for region in ordered if 6 in region["contourRefs"])
        if branch["slotId"] not in {"medial.part1.left-vertical", "medial.part1.right-vertical"} or main["slotId"] != "medial.part1.horizontal":
            raise ValueError("The calibrated ㅠ junction must retain a medial branch and its horizontal support.")
        if ordered.index(branch) >= ordered.index(main):
            raise ValueError("The calibrated ㅠ branch must remain below its continuous support.")
        if after is not None:
            if bounds(before)[1] <= bounds(support)[3] or bounds(after)[1] >= bounds(support)[3]:
                raise ValueError("The recorded branch extension must close an actual gap beneath its support.")
            geometry.append({"contourRef": branch_ref, "beforeD": before, "afterD": after,
                             "reason": "The recorded branch extension closes the inherited source gap beneath its continuous support.",
                             "supportRef": 6, "supportD": support})
        elif contours[branch_ref]["bounds"][1] > bounds(support)[3]:
            raise ValueError("The recorded unmodified branch no longer meets its continuous support.")
    for fix in JUNCTION_GAP_FIXES.get(weight, {}).get(char, []):
        ref, support_ref = fix["contourRef"], fix["supportRef"]
        if contours[ref]["d"] != fix["beforeD"] or contours[support_ref]["d"] != fix["supportD"]:
            raise ValueError("The recorded thin-vowel junction correction no longer matches the source.")
        branch = next(region for region in ordered if ref in region["contourRefs"])
        main = next(region for region in ordered if support_ref in region["contourRefs"])
        if (branch["slotId"] not in {"medial.part1.left-upper-bar", "medial.part1.left-lower-bar"} or
            main["slotId"] != fix["supportSlotId"] or
            not any(item["under"] == branch["id"] and item["over"] == main["id"] for item in constraints) or
            ordered.index(branch) >= ordered.index(main)):
            raise ValueError("The calibrated Thin vowel bar must remain beneath its continuous medial stem.")
        before, support, after = bounds(fix["beforeD"]), bounds(fix["supportD"]), bounds(fix["afterD"])
        if (before[2] >= support[0] or not support[0] < after[2] < support[2] or before[:2] != after[:2] or
            before[3] != after[3] or max(before[1], support[1]) >= min(before[3], support[3])):
            raise ValueError("The recorded thin-vowel correction must only bridge the horizontal source gap.")
        geometry.append({key: fix[key] for key in ("contourRef", "beforeD", "afterD", "supportRef", "supportD")})
        geometry[-1]["reason"] = "The recorded Thin branch extension closes the inherited gap beneath its continuous medial stem."
    replacements = {fix["contourRef"]: fix["afterD"] for fix in geometry}
    for region in ordered:
        region["d"] = " ".join(replacements.get(ref, contours[ref]["d"]) for ref in region["contourRefs"])
    return {"char": char, "advanceWidth": advance, "semanticParts": semantic,
            "contours": list(contours.values()), "originalLayers": layers,
            "regions": ordered, "paintConstraints": constraints,
            "semanticOverrides": overrides, "geometryOverrides": geometry}
