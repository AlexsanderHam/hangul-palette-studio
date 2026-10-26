# Hangul Palette Studio

A local tool for building [Hangul Palette](https://alexsanderham.github.io/hangul-palette/) color webfonts from [Pretendard v1.3.9](https://github.com/orioncactus/pretendard/tree/v1.3.9). Choose colors for 20 Hangul regions and preview nine weights, from Thin to Black.

## Run

Requires **Bun 1.4.4 or newer**, Git and **Python 3.11 or newer** with virtual-environment support.

```sh
bun install --frozen-lockfile
bun run setup:font
bun run start
```

Open [localhost:4000](http://localhost:4000). Fonts prepare automatically; the first build takes longer, and later sessions reuse a verified cache. Initial setup needs network access.

## Use

1. Choose colors with the palette controls or presets.
2. Enter sample text, compare a character with **한 글자 비교**, and select a weight or compare them all.
3. Choose **폰트 다운로드** for a ZIP containing the fonts, selected CSS, preview, metadata and license notices. **CSS만 다운로드** exports just the stylesheet; keep it beside the WOFF2 files it references.

The fonts have black defaults. Selected colors apply through CSS, so changing the palette reuses the same font files shown in the preview. Latin letters, digits and punctuation follow ordinary CSS `color`.

Color layers cover modern Hangul syllables and compatibility jamo. See the [website usage guide](https://alexsanderham.github.io/hangul-palette/#usage) for applying the fonts, or explore all 11,223 colored characters in the [glyph browser](https://alexsanderham.github.io/hangul-palette/glyphs).

## Saved palettes

Colors, undo/redo history and automatic backups are stored in `data/.studio/`. Let palette saving finish before closing the server. The connection banner provides retry and discard controls for pending changes; **변경 버리기** in the palette panel clears an unsent local draft.

Use the palette's undo/redo buttons or `Ctrl/⌘ Z` and `Ctrl/⌘ Shift Z`. Text fields keep their normal text undo. Restore a saved backup through **작업 정보 → 백업 복원**.

To use a separate palette workspace or inspect saved work without editing:

```sh
bun run start --workspace scratch/my-palette
bun run start --read-only
```

If the saved project cannot be opened, stop Studio and recover a backup:

```sh
bun run start --recover latest
```

Recovery preserves the damaged file. Use `--recover <backup-id>` for a specific backup, or `bun run start --help` for all options.

## Release

With an existing [hangul-palette distribution repository](https://github.com/AlexsanderHam/hangul-palette) beside Studio, run:

```sh
bun run release --output ../hangul-palette
```

This generates the fonts, default CSS palette, metadata and license notices from the checked-in source, independently of saved Studio palettes. It preserves the distribution repository's website pages, assets, README and Git metadata. Commit and publish from that repository.

## Development

See [Development](docs/development.md) for code structure, font generation, source-data maintenance and validation commands.

## License

Studio code uses the [MIT License](LICENSE). The bundled font, derived glyph data and generated fonts use the [SIL Open Font License 1.1](LICENSE-OFL). See [NOTICE](NOTICE) for source attribution.
