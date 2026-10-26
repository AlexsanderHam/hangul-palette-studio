// ── Font metrics ──

/** Units per em (Pretendard source uses 2896) */
export const UPM = 2896;
/** Vertical origin used by source-mask previews, independent of official font metrics. */
export const ASC = Math.round(UPM * 0.78);
/** Default glyph advance width when not specified in .glyph file */
export const DEFAULT_GLYPH_WIDTH = 2504;

// ── Hangul syllable decomposition ──
//
// Unicode Hangul syllable block (가-힣) encodes each syllable as:
//   codepoint = HANGUL_BASE + (initialIdx * MEDIAL_COUNT * FINAL_COUNT)
//                            + (medialIdx * FINAL_COUNT)
//                            + finalIdx

export const HANGUL_BASE = 0xac00;
export const MEDIAL_COUNT = 21;
export const FINAL_COUNT = 28;
/** Initial consonant count. Not exported because only HANGUL_END uses it. */
const INITIAL_COUNT = 19;
export const HANGUL_END = HANGUL_BASE + INITIAL_COUNT * MEDIAL_COUNT * FINAL_COUNT - 1; // U+D7A3 (힣)

// ── Compatibility jamo Unicode block ──

/** First codepoint in compatibility jamo block (ㄱ). */
export const JAMO_START = 0x3131;
/** Last codepoint in compatibility jamo block (ㅣ). */
export const JAMO_END = 0x3163;
/** First vowel codepoint (ㅏ). Codepoints below this in the block are consonants. */
export const JAMO_VOWEL_START = 0x314f;

// ── Jamo character tables ──

export const INITIALS = [
  "ㄱ",
  "ㄲ",
  "ㄴ",
  "ㄷ",
  "ㄸ",
  "ㄹ",
  "ㅁ",
  "ㅂ",
  "ㅃ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅉ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
] as const;

export const MEDIALS = [
  "ㅏ",
  "ㅐ",
  "ㅑ",
  "ㅒ",
  "ㅓ",
  "ㅔ",
  "ㅕ",
  "ㅖ",
  "ㅗ",
  "ㅘ",
  "ㅙ",
  "ㅚ",
  "ㅛ",
  "ㅜ",
  "ㅝ",
  "ㅞ",
  "ㅟ",
  "ㅠ",
  "ㅡ",
  "ㅢ",
  "ㅣ",
] as const;

/** All 28 final consonants. Index 0 = no final consonant. */
export const FINALS = [
  "",
  "ㄱ",
  "ㄲ",
  "ㄳ",
  "ㄴ",
  "ㄵ",
  "ㄶ",
  "ㄷ",
  "ㄹ",
  "ㄺ",
  "ㄻ",
  "ㄼ",
  "ㄽ",
  "ㄾ",
  "ㄿ",
  "ㅀ",
  "ㅁ",
  "ㅂ",
  "ㅄ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
] as const;
