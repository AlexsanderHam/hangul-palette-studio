/** Editable palette draft, field validation, and durable automatic saving. */
import type { ColorFontStatusResponse, StudioSnapshot } from "../protocol.ts";
import { announce, el, node, readSessionValue, removeSessionValue, writeSessionValue } from "./browser.ts";
import type { WorkspaceController } from "./workspace.ts";

export function palettesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((color, index) => color.toLowerCase() === b[index]?.toLowerCase());
}
export interface PaletteController {
  readonly colors: readonly string[] | null;
  readonly slots: Readonly<ColorFontStatusResponse["slots"]>;
  readonly invalid: boolean;
  isDirty(): boolean;
  applySnapshot(next: StudioSnapshot, previous: StudioSnapshot | null): void;
  setSlots(next: ColorFontStatusResponse["slots"]): void;
  scheduleSave(): void;
  reset(): void;
  render(): void;
}
export function createPalette(workspace: WorkspaceController, onChange: () => void): PaletteController {
  let draft: string[] | null = null;
  let projectId = "";
  let saveTimer = 0;
  let restored = false;
  let slots: ColorFontStatusResponse["slots"] = [];
  const invalidFields = new Set<number>();
  const inputs = new Map<number, { color: HTMLInputElement; hex: HTMLInputElement }>();
  function isDirty(): boolean {
    return Boolean(workspace.snapshot && draft && !palettesEqual(draft, workspace.snapshot.fontPalette));
  }

  function canEdit(): boolean {
    return Boolean(
      workspace.snapshot &&
        !workspace.snapshot.readOnly &&
        workspace.online &&
        workspace.ownsLease() &&
        (!workspace.pending ||
          (workspace.pending.command.type === "palette" &&
            !workspace.pending.needsRebase &&
            workspace.status === "saving")),
    );
  }

  function normalizeColor(value: string): string | null {
    const color = value.trim().replace(/^#/, "").toLowerCase();
    if (/^[\da-f]{6}$/.test(color)) return `#${color}`;
    if (/^[\da-f]{3}$/.test(color)) return `#${[...color].map((digit) => digit + digit).join("")}`;
    return null;
  }

  function restoreDraft(next: StudioSnapshot): void {
    const stored = readSessionValue("palette-draft");
    try {
      const value = stored ? (JSON.parse(stored) as { projectId: string; colors: string[] }) : null;
      if (
        value?.projectId === next.projectId &&
        Array.isArray(value.colors) &&
        value.colors.length === next.fontPalette.length &&
        value.colors.every((color) => typeof color === "string" && /^#[\da-f]{6}$/i.test(color))
      ) {
        draft = value.colors.map((color) => color.toLowerCase());
        restored = !palettesEqual(draft, next.fontPalette);
      } else if (
        workspace.pending?.command.type === "palette" &&
        workspace.pending.command.projectId === next.projectId &&
        Array.isArray(workspace.pending.command.colors) &&
        workspace.pending.command.colors.length === next.fontPalette.length &&
        workspace.pending.command.colors.every(
          (color) => typeof color === "string" && /^#[\da-f]{6}$/i.test(color),
        )
      ) {
        draft = [...workspace.pending.command.colors];
      }
    } catch {
      removeSessionValue("palette-draft");
    }
  }

  function persistDraft(): void {
    if (!workspace.snapshot || !draft) return;
    if (isDirty()) {
      writeSessionValue(
        "palette-draft",
        JSON.stringify({ projectId: workspace.snapshot.projectId, colors: draft }),
      );
    } else {
      restored = false;
      removeSessionValue("palette-draft");
    }
  }

  function updateColor(index: number, color: string): void {
    if (!canEdit() || !draft) return;
    draft[index] = color;
    restored = false;
    persistDraft();
    scheduleSave();
    onChange();
  }

  function scheduleSave(): void {
    clearTimeout(saveTimer);
    if (isDirty() && !workspace.pending && !restored && !invalidFields.size && workspace.canEdit())
      saveTimer = window.setTimeout(() => void save(), 400);
  }

  async function save(): Promise<void> {
    clearTimeout(saveTimer);
    if (!isDirty() || !draft || invalidFields.size || !workspace.canEdit()) return;
    restored = false;
    await workspace.dispatch({ type: "palette", colors: [...draft] });
    persistDraft();
    scheduleSave();
    onChange();
  }

  function reset(): void {
    clearTimeout(saveTimer);
    draft = workspace.snapshot ? [...workspace.snapshot.fontPalette] : null;
    invalidFields.clear();
    restored = false;
    for (const [index, fields] of inputs) {
      if (draft?.[index]) fields.hex.value = draft[index];
    }
    persistDraft();
    onChange();
  }

  function discardDraft(): void {
    if (!workspace.snapshot || workspace.pending || workspace.sending) return;
    reset();
    announce("이 탭의 색상 변경을 버리고 저장된 팔레트로 돌아갔습니다.");
  }

  function applyPreset(name: string): void {
    if (!canEdit() || !slots.length) return;
    draft = slots.map((slot) => {
      if (name === "mono") return "#8997ac";
      if (name === "jamo") {
        if (slot.role === "initial") return "#fa7384";
        if (slot.role === "medial") return slot.part === 1 ? "#efaa6a" : "#f1d978";
        return slot.part === 1 ? "#70cdb3" : "#a99aff";
      }
      return slot.color;
    });
    invalidFields.clear();
    restored = false;
    persistDraft();
    onChange();
    void save();
  }

  function installControls(): void {
    if (!slots.length || inputs.size) return;
    const container = el("font-palette-slots");
    container.replaceChildren();
    for (const [role, title] of [
      ["initial", "초성"],
      ["medial", "중성"],
      ["final", "종성"],
    ]) {
      const group = node("fieldset", "font-palette-group");
      const groupSlots = slots.filter((slot) => slot.role === role);
      group.append(node("legend", "", `${title} · ${groupSlots.length}개 영역`));
      for (const slot of groupSlots) {
        const row = node("div", "font-palette-row");
        const color = node("input", "font-color-input");
        color.type = "color";
        color.id = `font-color-${slot.index}`;
        color.setAttribute("aria-label", `${slot.label} 색상 선택`);
        color.value = draft?.[slot.index] ?? slot.color;
        const label = node(
          "label",
          "font-color-label",
          slot.label.replace(`${title} `, "").replace("구성 자모", "자모"),
        );
        label.htmlFor = `font-hex-${slot.index}`;
        const hex = node("input", "font-hex-input");
        hex.type = "text";
        hex.id = `font-hex-${slot.index}`;
        hex.value = color.value;
        hex.maxLength = 7;
        hex.spellcheck = false;
        hex.autocomplete = "off";
        hex.setAttribute("aria-label", `${slot.label} HEX 색상`);
        hex.setAttribute("aria-describedby", "font-palette-save-state");
        color.addEventListener("input", () => {
          if (!canEdit()) return;
          invalidFields.delete(slot.index);
          hex.value = color.value;
          updateColor(slot.index, color.value);
        });
        color.addEventListener("change", () => void save());
        hex.addEventListener("input", () => {
          if (!canEdit()) return;
          const value = normalizeColor(hex.value);
          if (value) {
            invalidFields.delete(slot.index);
            color.value = value;
            updateColor(slot.index, value);
          } else {
            clearTimeout(saveTimer);
            invalidFields.add(slot.index);
            onChange();
          }
        });
        hex.addEventListener("change", () => {
          const value = normalizeColor(hex.value);
          if (!value || !canEdit()) return;
          hex.value = value;
          void save();
        });
        row.append(color, label, hex);
        group.append(row);
        inputs.set(slot.index, { color, hex });
      }
      container.append(group);
    }
  }

  function render(): void {
    installControls();
    const editable = canEdit();
    for (const [index, fields] of inputs) {
      const color = draft?.[index];
      if (color) {
        fields.color.value = color;
        if (document.activeElement !== fields.hex && !invalidFields.has(index)) fields.hex.value = color;
      }
      fields.hex.setAttribute("aria-invalid", String(invalidFields.has(index)));
      fields.color.disabled = !editable;
      fields.hex.disabled = !editable;
    }
    for (const button of el("font-palette-presets").querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = !editable || !slots.length;
    }
    const dirty = isDirty();
    let message = "색상 저장됨 · 변경하면 자동 저장";
    if (!workspace.snapshot || !slots.length) message = "팔레트를 불러오는 중…";
    else if (invalidFields.size) message = "HEX 색상을 #RRGGBB 형식으로 입력해 주세요.";
    else if (workspace.pending?.command.type === "palette") {
      message = workspace.sending
        ? "색상 저장 중…"
        : "색상 저장이 보류되었습니다. 연결 상태를 확인해 주세요.";
    } else if (dirty) {
      message = restored
        ? editable
          ? "저장하지 못한 색상을 복구했습니다. 저장하거나 변경을 버릴 수 있습니다."
          : "저장하지 못한 색상을 복구했습니다. 변경을 버리면 저장된 팔레트로 돌아갑니다."
        : !editable
          ? "저장되지 않은 색상이 있습니다. 편집 권한과 연결을 확인하거나 변경을 버려 주세요."
          : "색상 저장 대기 중…";
    } else if (workspace.sending) message = "작업 저장 중…";
    else if (!editable) message = "읽기 전용 · 저장된 팔레트";
    el("font-palette-save-state").textContent = message;
    el("font-palette-save-state").dataset.state =
      invalidFields.size || (workspace.pending && !workspace.sending)
        ? "error"
        : dirty || workspace.sending
          ? "saving"
          : "saved";
    const saveButton = el<HTMLButtonElement>("font-palette-save-btn");
    saveButton.hidden = !dirty || Boolean(workspace.pending);
    saveButton.disabled = !workspace.canEdit() || Boolean(invalidFields.size);
    const discardButton = el<HTMLButtonElement>("font-palette-discard-btn");
    discardButton.hidden = !(dirty || invalidFields.size) || Boolean(workspace.pending);
    discardButton.disabled = !workspace.snapshot || Boolean(workspace.pending) || workspace.sending;
    el("font-palette-save-row").hidden = Boolean(
      workspace.snapshot &&
        slots.length &&
        !dirty &&
        !invalidFields.size &&
        !workspace.pending &&
        !workspace.sending,
    );
  }

  el("font-palette-save-btn").addEventListener("click", () => void save());
  el("font-palette-discard-btn").addEventListener("click", discardDraft);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-font-preset]")) {
    button.addEventListener("click", () => applyPreset(button.dataset.fontPreset ?? "default"));
  }
  return {
    get colors() {
      return draft;
    },
    get slots() {
      return slots;
    },
    get invalid() {
      return Boolean(invalidFields.size);
    },
    isDirty,
    scheduleSave,
    reset,
    render,
    setSlots(next) {
      slots = next;
    },
    applySnapshot(next, previous) {
      if (projectId !== next.projectId) {
        projectId = next.projectId;
        draft = [...next.fontPalette];
        invalidFields.clear();
        clearTimeout(saveTimer);
        restoreDraft(next);
      } else if (!draft || (previous && palettesEqual(draft, previous.fontPalette) && !invalidFields.size)) {
        draft = [...next.fontPalette];
      }
      persistDraft();
    },
  };
}
