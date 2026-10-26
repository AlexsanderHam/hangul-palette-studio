# Development

Follow the [README](../README.md#run) to install dependencies and start Studio.

## Code structure

| Path | Responsibility |
| --- | --- |
| [`src/font/source/`](../src/font/source/) | Source documents, extraction, semantic regions and validation |
| [`src/font/compiler/`](../src/font/compiler/) | Python compiler, TypeScript process bridge, shared contract and original-font pins |
| [`src/font/`](../src/font/) | Verified inputs, font builds and palette packages |
| [`src/studio/client/`](../src/studio/client/) | Browser interface and controllers |
| [`src/studio/server/`](../src/studio/server/) | Local HTTP service, palette persistence and font preparation/download jobs |
| [`src/studio/protocol.ts`](../src/studio/protocol.ts) | Shared client/server API types |
| [`src/release.ts`](../src/release.ts) | Result repository layout and generated-file publication |
| [`bin/`](../bin/) | Command entry points |
| [`test/`](../test/) | Font, Studio and release regression checks |

## Font generation

The production path is **source → validated font build → palette package**. Both Studio and the release command use [`buildFont()` and `packageFont()`](../src/font/build.ts).

Each weight starts from its corresponding official static OTF, verified against [the pinned original-font hashes](../src/font/compiler/official-sources.json). The compiler retains the original glyphs, character mapping and placement metrics. Semantic masks come from the production Regular geometry and separately extracted geometry for the other weights. They are scaled into the official font's coordinates, clipped to its filled outlines and appended as CFF color layers, with CPAL v0 palettes.

Each WOFF2 stores its flat colors as COLR v0 layer records inside a version 1 table. The required `BaseGlyphList` is present with zero entries, so viewers use the v0 records through the [standard lookup fallback](https://learn.microsoft.com/en-us/typography/opentype/spec/colr#mixing-version-0-and-version-1-formats). This avoids the rectangular layers observed with v1 paints on iOS 27 and selects Chromium's Fontations backend on Windows, avoiding the [DirectWrite palette crash](https://github.com/brave/brave-browser/issues/59300). Validation requires complete v0 layers, an empty v1 glyph list and absent v1 paint, clipping and variation data. Keep the CSS source as `format("woff2")` without `tech(color-COLRv1)`, which would exclude Safari despite its v0 layer support.

A build ID covers geometry, ordered region assignments, compiler inputs and toolchain. Validated builds live in `.cache/font-builds/`; reuse verifies the identity, archive hashes, source pins and recorded font validation. A missing, damaged or incompatible cache requires a new build.

Palette packages capture a confirmed saved revision and reuse those font bytes. Workspace identity, revision and selected colors belong to the package, independently of the build ID.

The [shared contract](../src/font/compiler/contract.json) defines the semantic slots and font version. Constituents describe visual composition: for example, `괘` has `ㅗ + ㅏ + ㅣ`. Applications map their input methods to these slots through CSS.

Within each source layer, short branches paint underneath their continuous supporting strokes. Masks overlap slightly before clipping to the original silhouette; palettes use opaque `#RRGGBB` colors. Weight-specific contour correspondence and mask corrections are implemented in [`weights.py`](../src/font/compiler/weights.py) and [`regions.py`](../src/font/compiler/regions.py), with regressions in the [weight-profile](../test/font/weight-profiles.test.ts) and [junction](../test/font/junctions.test.ts) tests.

## Source data

[`data/glyphs.json`](../data/glyphs.json) uses `hangul-palette-source` version 1. It keeps the contours and region assignments together for 11,172 modern syllables and 51 compatibility jamo.

| Field | Meaning |
| --- | --- |
| `metrics.unitsPerEm` | Coordinate scale of the semantic source geometry |
| `metrics.viewportAscender` | Ascender used to place source paths in the viewport |
| `metrics.defaultAdvanceWidth` | Shared source advance width; currently 2504 |
| `glyphs[char].advanceWidth` | Optional override for a glyph with a different width |
| `glyphs[char].contours` | Ordered contours; earlier entries paint underneath later ones, subject to junction constraints |
| `contours[].id` | Original contour index; stays fixed when the array is reordered |
| `contours[].region` | Semantic slot ID, such as `medial.part1.vertical`; `unassigned` blocks font generation |
| `contours[].path` and `bounds` | Source path and control-point bounds |

The source uses 2896 units per em; exported fonts retain the official OTF's 2048 units per em and Hangul advance width of 1770. Source geometry defines color ownership; the official font supplies the output outlines and metrics.

Only regions required by the character's Unicode composition are valid. Keep hole contours with their enclosing bodies. A region may appear in separate paint runs, so equal region IDs do not permit merging or reordering those runs.

## Maintain source data

1. Edit the affected character's regions or contour order in the production document, preserving contour IDs, paths and bounds.
2. Inspect the diff and run the [checks below](#validation).
3. Open the changed source with a new palette workspace and inspect the affected characters in every weight with contrasting colors.

```sh
bun run start --workspace scratch/updated-source
```

Record the reason for the change and the characters inspected alongside the source diff.

### Re-extract geometry

The checked-in source is ready to use. To recreate it for maintenance or a reproducibility check:

```sh
bun run extract --output .cache/glyphs-recreated.json
```

Extraction verifies the pinned Pretendard checkout. For a new output it uses the production document as its assignment reference; for an existing output it uses that file and requires `--force`. Regions and paint order are preserved only when metrics, coverage, widths, paths and bounds match exactly. Without a reference, contours start `unassigned`.

Re-extracted documents include provenance metadata, which can change source fingerprints even when the shapes match. Review the whole diff before replacing the production document. To inspect another document, pair `--data` with a separate workspace:

```sh
bun run start --data .cache/glyphs-recreated.json --workspace scratch/recreated-source
```

Additional weight geometry is extracted automatically into internal caches during a build. See `bun run extract --help` for extraction options.

## Local state

| Path | Contents |
| --- | --- |
| `data/glyphs.json` | Tracked production source |
| `data/Pretendard-Regular.otf` | Tracked, unmodified upstream font |
| `data/.studio/` | Ignored palette workspace and automatic backups |
| `.cache/` | Ignored Python environment, verified upstream inputs, extracted geometry and font builds |

Palette projects use version 1 and store colors, history and source fingerprints. A workspace must match its source document; unsupported formats are rejected. Keep the entire workspace when backing up saved work. Cache files can be regenerated. Read-only mode leaves the palette workspace unchanged while allowing font caches and temporary files to be written.

`setup:font` installs the pinned Python dependencies from [`requirements.txt`](../src/font/compiler/requirements.txt) and prepares the official OTF inputs. If Python is outside the usual paths, set `STUDIO_PYTHON` to its absolute executable path when running setup.

## Validation

For ordinary development:

```sh
bun run check
```

This runs TypeScript checks, lint and ordinary tests. Use `bun run format` to format TypeScript and browser styles.

After changing font data or the compiler, enable the complete font checks:

```sh
STUDIO_FONT_INTEGRATION=1 bun test
```

The suite prepares all weights and checks original-font preservation, region coverage, holes, paint order, filled junction overlap and decoded outlines. It also verifies deterministic packages, CSS-only palette changes, cache reuse and saved-palette isolation. Runtime-dependent tests need the setup environment and verified source cache; CI prepares these and runs the full suite.

Structural validation cannot establish every region's visual ownership or identical browser rasterization. Inspect changed glyphs in the actual font preview, including the sizes and backgrounds used by the consuming application.

## Release metadata

The [release command](../README.md#release) writes fonts to `fonts/`, CSS to `css/`, and the manifest and validation report to `metadata/` in the distribution repository. The downloadable Studio ZIP keeps those assets together at its root, with a preview page and license notices. See the [Hangul Palette website](https://alexsanderham.github.io/hangul-palette/#usage) for font usage examples.

The font version comes from `fontVersion` in the shared contract; Studio's version comes from [`package.json`](../package.json). Release metadata records the builder and production-source fingerprints as well as output hashes.
