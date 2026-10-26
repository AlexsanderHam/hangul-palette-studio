/** Compose the local palette workspace, font preview, and export controls. */
import { el } from "./browser.ts";
import { createFonts, type FontsController } from "./fonts.ts";
import { createPalette, type PaletteController } from "./palette.ts";
import { createFontPreview, type FontPreviewController } from "./preview.ts";
import { createWorkspace } from "./workspace.ts";

let palette: PaletteController;
let preview: FontPreviewController;
let fonts: FontsController;

function render(): void {
  workspace.render();
  palette.render();
  fonts.render();
  preview.render();
}
const workspace = createWorkspace({
  draftState: () => ({ dirty: palette.isDirty(), invalid: palette.invalid }),
  onSnapshot: (next, previous) => palette.applySnapshot(next, previous),
  onDiscard: () => palette.reset(),
  onSettled: () => palette.scheduleSave(),
  onConnected: () => void fonts.connect(),
  onChange: render,
});
palette = createPalette(workspace, render);
preview = createFontPreview({
  workspace,
  palette,
  buildState: () => ({ build: fonts.build, sourceId: fonts.sourceId, preparing: fonts.preparing }),
  onChange: render,
});
fonts = createFonts({ workspace, palette, preview, onChange: render });

el("help-btn").addEventListener("click", () => {
  el<HTMLDialogElement>("workspace-info-dialog").close();
  el<HTMLDialogElement>("help-dialog").showModal();
});
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]")) {
  button.addEventListener("click", () => button.closest("dialog")?.close());
}
void workspace.start();
