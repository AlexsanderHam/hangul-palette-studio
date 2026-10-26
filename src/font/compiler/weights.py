"""Pinned, calibrated Pretendard geometry profiles for the nine web weights.

Source provenance records how a profile was extracted. A separate geometry
fingerprint binds every character/advance/path, including legacy Regular data
that predates extraction provenance. No profile accepts arbitrary source paths.
"""

from dataclasses import dataclass
import hashlib
import json
import math


@dataclass(frozen=True)
class WeightProfile:
    id: str
    label: str
    weight: int
    geometry_sha256: str
    masters: tuple[tuple[str, int, float], ...]
    font_file: str


THIN = "B1F27B51-9973-4381-9301-4FE46FE1CA59"
REGULAR = "CD0E3B44-F66A-4791-B84C-A1128DC61275"
BLACK = "5C20EF92-B63D-42A8-8878-93C2863E0093"
GEOMETRY = {
    "thin": "814689e684723b2311655422de0523a806c829aacbdd4458bdf5f7fbba874dfc",
    "extra-light": "1e42d1340188b76b775397b42d20b4e62412581f92328097241da84bf5956442",
    "light": "02e26023616a345926c82d0bd52f494265b6011f8ec44e4edbf0fb6c3ebeb623",
    "regular": "2cb9f9caa28fe804b0ddb72f9bade8781865a5c2135ca0025ed2691b0184f263",
    "medium": "164a4e0296e4d8f753f0436ba4c4a0e41d160f58cdd1dc733df5dd48479c1f2f",
    "semi-bold": "d0db9fe2d7bd7269175e0a173e1b9b6fe2d0021cb17ad44842a86fd7af4d07c0",
    "bold": "08cb32dc290ec4228c6268fc595bccbd05ea4c3b9cf1f46c47c3a869d03db509",
    "extra-bold": "f1df2c3955455f8491e65ea5a8547f312c48ea5a185aee66d1e697dd66a7a149",
    "black": "ac00b8b4a8be2b104b14629637b450f9a628b73011ebacabec5e039519eedd73",
}


def interpolation_masters(weight):
    if weight == 400:
        return ((REGULAR, 400, 1.0),)
    lower, upper = ((THIN, 45), (REGULAR, 400)) if weight < 400 else ((REGULAR, 400), (BLACK, 930))
    factor = (weight - lower[1]) / (upper[1] - lower[1])
    return ((lower[0], lower[1], 1 - factor), (upper[0], upper[1], factor))


PROFILES = {
    key: WeightProfile(key, label, weight, GEOMETRY[key], interpolation_masters(weight),
                       "hangul-palette-" + key + ".woff2")
    for key, label, weight in (
        ("thin", "Thin", 100),
        ("extra-light", "ExtraLight", 200),
        ("light", "Light", 300),
        ("regular", "Regular", 400),
        ("medium", "Medium", 500),
        ("semi-bold", "SemiBold", 600),
        ("bold", "Bold", 700),
        ("extra-bold", "ExtraBold", 800),
        ("black", "Black", 900),
    )
}



def geometry_digest(raw):
    geometry = sorted(((char, advance, [path[0] for path in paths])
                       for _, _, items in raw["sets"] for char, advance, paths in items), key=lambda item: ord(item[0]))
    data = (json.dumps(geometry, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    return hashlib.sha256(data).hexdigest()


def source_profile(raw, weight="regular"):
    if weight not in PROFILES:
        raise ValueError("Unsupported color-font weight profile: " + str(weight))
    profile = PROFILES[weight]
    if not isinstance(raw, dict) or raw.get("upm") != 2896 or raw.get("asc") != 2259:
        raise ValueError(f"{profile.label} requires the recorded 2896 UPM / 2259 viewport geometry.")
    provenance = raw.get("provenance")
    if provenance is None:
        if weight != "regular":
            raise ValueError(f"{profile.label} requires verified extraction instance provenance.")
    else:
        if (not isinstance(provenance, dict) or
            provenance.get("repository") != "https://github.com/orioncactus/pretendard" or
            provenance.get("ref") != "v1.3.9" or
            provenance.get("revision") != "5c41199ea0024a9e0b2cb31735265056e5472d76"):
            raise ValueError("The source revision differs from the calibrated Pretendard v1.3.9 profiles.")
        master = provenance.get("master", {})
        if not isinstance(master, dict) or master.get("id") != REGULAR or master.get("weight") != 400:
            raise ValueError("The source profile must retain the recorded Normal 400 anchor master.")
        instance = provenance.get("instance")
        if instance is None:
            if weight != "regular":
                raise ValueError(f"{profile.label} requires its interpolated instance provenance.")
        else:
            if (not isinstance(instance, dict) or instance.get("name") != profile.label or
                instance.get("weight") != profile.weight):
                raise ValueError(f"The source instance does not match {profile.label} {profile.weight}.")
            masters = instance.get("masters")
            if not isinstance(masters, list) or len(masters) != len(profile.masters):
                raise ValueError("The source interpolation masters do not match the calibrated profile.")
            for actual, (master_id, coordinate, factor) in zip(masters, profile.masters, strict=True):
                if not isinstance(actual, dict):
                    raise ValueError("An interpolation master must be a dictionary.")
                value = actual.get("factor")
                if (actual.get("id") != master_id or actual.get("weight") != coordinate or
                    not isinstance(value, (int, float)) or isinstance(value, bool) or
                    not math.isfinite(value) or not math.isclose(value, factor, rel_tol=0, abs_tol=1e-14)):
                    raise ValueError("The source interpolation coefficients do not match the calibrated profile.")
    if geometry_digest(raw) != profile.geometry_sha256:
        raise ValueError(f"The full source geometry differs from the calibrated {profile.label} {profile.weight} profile.")
    return profile
