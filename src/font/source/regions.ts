import contract from "../compiler/contract.json";
import { FINALS, HANGUL_BASE, HANGUL_END, INITIALS, JAMO_END, JAMO_START, MEDIALS } from "./hangul.ts";

export const UNASSIGNED_REGION = "unassigned";
export const SEMANTIC_REGIONS = Object.freeze(contract.slots.map((slot) => Object.freeze({ ...slot })));
export const REGION_IDS: readonly string[] = Object.freeze(SEMANTIC_REGIONS.map(({ id }) => id));
const KNOWN_REGIONS = new Set(REGION_IDS);

export function isRegionId(value: unknown): value is string {
  return typeof value === "string" && KNOWN_REGIONS.has(value);
}

export type SemanticRole = "initial" | "medial" | "final";
export interface GlyphComponent {
  value: string;
  components: { index: number; value: string }[];
}
export type GlyphComponents = Partial<Record<SemanticRole, GlyphComponent>>;

const COMPONENTS: Readonly<Record<string, string>> = {
  ㄲ: "ㄱㄱ",
  ㄸ: "ㄷㄷ",
  ㅃ: "ㅂㅂ",
  ㅆ: "ㅅㅅ",
  ㅉ: "ㅈㅈ",
  ㄳ: "ㄱㅅ",
  ㄵ: "ㄴㅈ",
  ㄶ: "ㄴㅎ",
  ㄺ: "ㄹㄱ",
  ㄻ: "ㄹㅁ",
  ㄼ: "ㄹㅂ",
  ㄽ: "ㄹㅅ",
  ㄾ: "ㄹㅌ",
  ㄿ: "ㄹㅍ",
  ㅀ: "ㄹㅎ",
  ㅄ: "ㅂㅅ",
  ㅐ: "ㅏㅣ",
  ㅒ: "ㅑㅣ",
  ㅔ: "ㅓㅣ",
  ㅖ: "ㅕㅣ",
  ㅘ: "ㅗㅏ",
  ㅙ: "ㅗㅏㅣ",
  ㅚ: "ㅗㅣ",
  ㅝ: "ㅜㅓ",
  ㅞ: "ㅜㅓㅣ",
  ㅟ: "ㅜㅣ",
  ㅢ: "ㅡㅣ",
};
const CLUSTERS = new Set(Array.from("ㄳㄵㄶㄺㄻㄼㄽㄾㄿㅀㅄ"));
const VOWEL_FEATURES: Readonly<Record<string, readonly string[]>> = {
  ㅏ: ["vertical", "right-bar"],
  ㅑ: ["vertical", "right-upper-bar", "right-lower-bar"],
  ㅓ: ["vertical", "left-bar"],
  ㅕ: ["vertical", "left-upper-bar", "left-lower-bar"],
  ㅗ: ["vertical", "horizontal"],
  ㅜ: ["vertical", "horizontal"],
  ㅛ: ["horizontal", "left-vertical", "right-vertical"],
  ㅠ: ["horizontal", "left-vertical", "right-vertical"],
  ㅡ: ["horizontal"],
  ㅣ: ["vertical"],
};

/** Canonical visual constituents, independent of keyboards and source contour grouping. */
export function glyphComponents(char: string): GlyphComponents {
  if (Array.from(char).length !== 1) return {};
  const code = char.codePointAt(0)!;
  let values: Partial<Record<SemanticRole, string>>;
  if (code >= HANGUL_BASE && code <= HANGUL_END) {
    const offset = code - HANGUL_BASE;
    values = {
      initial: INITIALS[Math.floor(offset / 588)]!,
      medial: MEDIALS[Math.floor(offset / 28) % 21]!,
      final: FINALS[offset % 28]!,
    };
  } else if (code >= JAMO_START && code <= JAMO_END) {
    values = code >= 0x314f ? { medial: char } : CLUSTERS.has(char) ? { final: char } : { initial: char };
  } else return {};
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value)
      .map(([role, value]) => [
        role,
        {
          value,
          components: Array.from(COMPONENTS[value] ?? value).map((value, index) => ({
            index: index + 1,
            value,
          })),
        },
      ]),
  ) as GlyphComponents;
}

/** Exact required region IDs in the shared palette contract's stable order. */
export function expectedRegions(char: string): string[] {
  const wanted = new Set<string>();
  for (const [role, component] of Object.entries(glyphComponents(char))) {
    for (const { index, value } of component.components) {
      const features =
        role === "medial" ? VOWEL_FEATURES[value] : value === "ㅋ" ? ["body", "added-bar"] : ["body"];
      for (const feature of features ?? []) wanted.add(`${role}.part${index}.${feature}`);
    }
  }
  return REGION_IDS.filter((id) => wanted.has(id));
}
