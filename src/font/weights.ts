import contract from "./compiler/contract.json";

export const FONT_VERSION = contract.fontVersion;

export const FONT_WEIGHTS = [
  { id: "thin", label: "Thin", value: 100, file: "hangul-palette-thin.woff2" },
  { id: "extra-light", label: "ExtraLight", value: 200, file: "hangul-palette-extra-light.woff2" },
  { id: "light", label: "Light", value: 300, file: "hangul-palette-light.woff2" },
  { id: "regular", label: "Regular", value: 400, file: "hangul-palette-regular.woff2" },
  { id: "medium", label: "Medium", value: 500, file: "hangul-palette-medium.woff2" },
  { id: "semi-bold", label: "SemiBold", value: 600, file: "hangul-palette-semi-bold.woff2" },
  { id: "bold", label: "Bold", value: 700, file: "hangul-palette-bold.woff2" },
  { id: "extra-bold", label: "ExtraBold", value: 800, file: "hangul-palette-extra-bold.woff2" },
  { id: "black", label: "Black", value: 900, file: "hangul-palette-black.woff2" },
] as const;

export type FontWeightId = (typeof FONT_WEIGHTS)[number]["id"];
export type FontWeightSources<T> = Record<Exclude<FontWeightId, "regular">, T>;
export type FontWeightFiles = Record<FontWeightId, Uint8Array>;
export interface OfficialFontSource {
  sha256: string;
  data: string;
}
export type OfficialFontSources = Record<FontWeightId, OfficialFontSource>;
