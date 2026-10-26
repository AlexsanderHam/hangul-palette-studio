import contract from "./compiler/contract.json";

/** Stable semantic region and its default CSS palette color. */
export interface PaletteSlot {
  id: string;
  index: number;
  label: string;
  role: string;
  part: number;
  feature: string;
  color: string;
}

if (
  contract.slots.length !== 20 ||
  contract.slots.some((slot, index) => slot.index !== index || !/^#[0-9a-f]{6}$/.test(slot.color))
)
  throw new Error("Invalid color font palette contract.");

export const FONT_COLOR_SLOTS: readonly Readonly<PaletteSlot>[] = Object.freeze(
  contract.slots.map((slot) => Object.freeze(slot)),
);

export function defaultFontPalette(): string[] {
  return FONT_COLOR_SLOTS.map((slot) => slot.color);
}

/** Only opaque sRGB colors are supported by the font's junction policy. */
export function normalizeFontPalette(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length !== FONT_COLOR_SLOTS.length ||
    Array.from(value).some((color) => typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))
  )
    throw new Error("20개 색상을 각각 #RRGGBB 형식으로 지정하세요.");
  return value.map((color: string) => color.toLowerCase());
}
