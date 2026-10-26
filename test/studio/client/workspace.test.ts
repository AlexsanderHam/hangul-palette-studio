import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultFontPalette, FONT_COLOR_SLOTS } from "../../../src/font/palette.ts";
import { createPalette } from "../../../src/studio/client/palette.ts";
import { createWorkspace, type PendingChange } from "../../../src/studio/client/workspace.ts";
import type { StudioCommand, StudioSnapshot } from "../../../src/studio/protocol.ts";

const html = readFileSync(new URL("../../../src/studio/client/index.html", import.meta.url), "utf8");
const storageKey = (key: string) => `hangul-palette-studio:v1:${key}`;
type Mode = "editable" | "read-only" | "other-tab";
interface BrowserOptions {
  mode?: Mode;
  draft?: boolean;
  pending?: PendingChange;
  saveConfirmed?: boolean;
  holdInitialSession?: boolean;
}

/** Only the DOM methods used by the real palette and workspace controllers, without layout. */
async function browserFixture(
  run: (fixture: Awaited<ReturnType<typeof mountBrowser>>) => Promise<void>,
  options: BrowserOptions = {},
) {
  const original = new Map<string, PropertyDescriptor | undefined>();
  function install(name: string, value: unknown): void {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    await run(await mountBrowser(options, install));
  } finally {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

async function mountBrowser(options: BrowserOptions, install: (name: string, value: unknown) => void) {
  const mode = options.mode ?? "editable";
  const elements = new Map<string, Control>();
  const all: Control[] = [];
  class Control extends EventTarget {
    readonly tagName: string;
    readonly attributes = new Map<string, string>();
    readonly dataset: Record<string, string> = {};
    children: Control[] = [];
    parentElement: Control | null = null;
    hidden = false;
    disabled = false;
    checked = false;
    value = "";
    type = "text";
    textContent = "";
    constructor(tag: string) {
      super();
      this.tagName = tag.toUpperCase();
      all.push(this);
    }
    set id(value: string) {
      elements.set(value, this);
    }
    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
      if (name === "id") this.id = value;
      if (name === "type") this.type = value;
      if (name === "hidden") this.hidden = true;
      if (name === "disabled") this.disabled = true;
      if (name === "data-font-preset") this.dataset.fontPreset = value;
    }
    get isContentEditable(): boolean {
      const owner = this.closest("[contenteditable]");
      return Boolean(owner && owner.attributes.get("contenteditable") !== "false");
    }
    matches(selector: string): boolean {
      return selector.split(",").some((part) => {
        const name = part.trim();
        if (/^\[[\w-]+\]$/.test(name)) return this.attributes.has(name.slice(1, -1));
        return this.tagName.toLowerCase() === name;
      });
    }
    closest(selector: string): Control | null {
      return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
    }
    append(...nodes: Control[]): void {
      for (const node of nodes) node.parentElement = this;
      this.children.push(...nodes);
    }
    replaceChildren(...nodes: Control[]): void {
      this.children = [];
      this.append(...nodes);
    }
    querySelectorAll(selector: string): Control[] {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    fire(type: string): void {
      this.dispatchEvent(new Event(type));
    }
  }
  for (const [, tag, attributes] of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (!/\bid="|\bdata-font-preset=/.test(attributes!)) continue;
    const control = new Control(tag!);
    for (const [, name, value] of attributes!.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
      control.setAttribute(name!, value ?? "");
    if (control.dataset.fontPreset) elements.get("font-palette-presets")!.append(control);
  }
  const element = (id: string): Control => {
    const control = elements.get(id);
    if (!control) throw new Error(`Missing actual HTML control #${id}`);
    return control;
  };
  const doc = Object.assign(new EventTarget(), {
    activeElement: null as Control | null,
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => new Control(tag),
    querySelectorAll: (selector: string) => all.filter((control) => control.matches(selector)),
    querySelector: (_selector: string) => null,
  });
  const win = new EventTarget();
  const memory = new Map([[storageKey("client"), "browser-client"]]);
  if (options.draft)
    memory.set(
      storageKey("palette-draft"),
      JSON.stringify({ projectId: "project", colors: Array(20).fill("#123456") }),
    );
  if (options.pending) memory.set(storageKey("pending"), JSON.stringify(options.pending));
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const intervals: { callback: () => void; delay: number }[] = [];
  let timerId = 0;
  const setTimer = (callback: () => void, delay: number) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  };
  const saved: StudioSnapshot = {
    projectId: "project",
    revision: 41,
    fontPalette: defaultFontPalette(),
    readOnly: mode === "read-only",
    saveConfirmed: options.saveConfirmed ?? true,
    glyphCount: 11223,
    source: { rawDigest: "raw", baselineDigest: "baseline" },
    history: { canUndo: true, canRedo: true, undoLabel: "previous", redoLabel: "next" },
    lease: {
      ownerId: mode === "other-tab" ? "other-client" : "browser-client",
      expiresAt: Date.now() + 45000,
    },
    backups: [],
    savedAt: "2026-10-24T00:00:00.000Z",
  };
  const commands: StudioCommand[] = [];
  const requests = { sessions: 0, leases: 0, projects: 0 };
  let connected = 0;
  function responseGate() {
    let release!: () => void, fail!: (error: Error) => void;
    const wait = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    return { wait, release, fail };
  }
  let nextSession: ReturnType<typeof responseGate> | null = null;
  let nextLease: ReturnType<typeof responseGate> | null = null;
  const initialSession = options.holdInitialSession ? responseGate() : null;
  if (initialSession) nextSession = initialSession;
  install("Element", Control);
  install("document", doc);
  install("window", Object.assign(win, { setTimeout: setTimer }));
  install("sessionStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  });
  install("setInterval", (callback: () => void, delay: number) => {
    intervals.push({ callback, delay });
    return 0;
  });
  install("setTimeout", setTimer);
  install("clearTimeout", (id: number) => timers.delete(id));
  install("fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/lease") {
      requests.leases++;
      const response =
        mode === "other-tab"
          ? Response.json(
              { error: { code: "lease_conflict", message: "Other tab" }, snapshot: saved },
              { status: 409 },
            )
          : Response.json({ lease: saved.lease });
      const held = nextLease;
      nextLease = null;
      await held?.wait;
      return response;
    }
    if (path === "/api/command") {
      const command = JSON.parse(String(init?.body)) as StudioCommand;
      commands.push(command);
      if (command.type === "palette") saved.fontPalette = [...command.colors];
      saved.revision++;
      return Response.json({ snapshot: saved });
    }
    if (path === "/api/session") {
      requests.sessions++;
      const response = Response.json({ token: "session-token", snapshot: saved });
      const held = nextSession;
      nextSession = null;
      await held?.wait;
      return response;
    }
    if (path.startsWith("/api/project?")) {
      requests.projects++;
      const query = new URL(path, "http://localhost").searchParams;
      return Response.json({
        snapshot: Number(query.get("revision")) === saved.revision ? null : saved,
        revision: saved.revision,
        saveConfirmed: saved.saveConfirmed,
        lease: saved.lease,
      });
    }
    throw new Error(`Unexpected browser request ${path}`);
  });
  const render = () => {
    workspace.render();
    palette.render();
  };
  const workspace = createWorkspace({
    draftState: () => ({ dirty: palette.isDirty(), invalid: palette.invalid }),
    onSnapshot: (next, previous) => palette.applySnapshot(next, previous),
    onDiscard: () => palette.reset(),
    onSettled: () => palette.scheduleSave(),
    onConnected() {
      connected++;
    },
    onChange: render,
  });
  const palette = createPalette(workspace, render);
  palette.setSlots([...FONT_COLOR_SLOTS]);
  const started = workspace.start();
  if (!initialSession) await started;
  return {
    workspace,
    palette,
    saved,
    commands,
    memory,
    element,
    doc,
    requests,
    started,
    initialSession,
    connected: () => connected,
    holdSession() {
      nextSession = responseGate();
      return nextSession;
    },
    holdLease() {
      nextLease = responseGate();
      return nextLease;
    },
    async pollInterval() {
      const interval = intervals.find(({ delay }) => delay === 3000);
      if (!interval) throw new Error("Missing actual workspace poll interval");
      interval.callback();
      await Bun.sleep(0);
    },
    async online() {
      win.dispatchEvent(new Event("online"));
      await Bun.sleep(0);
    },
    async settle() {
      await Bun.sleep(0);
    },
    control: (tag: string) => new Control(tag),
    pendingDebounces: () => [...timers.values()].filter(({ delay }) => delay === 400).length,
    offline() {
      win.dispatchEvent(new Event("offline"));
    },
    async runDebounce() {
      for (const [id, timer] of timers)
        if (timer.delay === 400) {
          timers.delete(id);
          timer.callback();
        }
      await Bun.sleep(0);
    },
    async shortcut(target: Control, options: Record<string, unknown> = {}) {
      const event = new Event("keydown", { cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      Object.assign(event, { ctrlKey: true, metaKey: false, code: "KeyZ", shiftKey: false, ...options });
      doc.dispatchEvent(event);
      await Bun.sleep(0);
      return event;
    },
  };
}

test.each<Mode>([
  "read-only",
  "other-tab",
])("a restored local draft can be discarded in %s mode without changing saved work", async (mode) => {
  await browserFixture(
    async ({ element, palette, workspace, memory, saved, commands }) => {
      const before = JSON.stringify(saved);
      expect(palette.isDirty()).toBe(true);
      expect(workspace.canExport()).toBe(false);
      expect(element("font-palette-save-btn").disabled).toBe(true);
      expect(element("font-palette-save-row").hidden).toBe(false);
      const discard = element("font-palette-discard-btn");
      expect(discard.hidden).toBe(false);
      expect(discard.disabled).toBe(false);
      discard.fire("click");
      expect(palette.isDirty()).toBe(false);
      expect(palette.colors).toEqual(saved.fontPalette);
      expect(memory.has(storageKey("palette-draft"))).toBe(false);
      expect(workspace.canExport()).toBe(true);
      expect(discard.hidden).toBe(true);
      expect(commands).toEqual([]);
      expect(JSON.stringify(saved)).toBe(before);
    },
    { mode, draft: true },
  );
});

test("discard cancels an offline draft's queued automatic save", async () => {
  await browserFixture(
    async ({ element, palette, offline, runDebounce, pendingDebounces, commands, saved, workspace }) => {
      const before = JSON.stringify(saved);
      const hex = element("font-hex-0");
      hex.value = "#abcdef";
      hex.fire("input");
      expect(palette.isDirty()).toBe(true);
      expect(pendingDebounces()).toBe(1);
      offline();
      expect(workspace.online).toBe(false);
      expect(element("font-palette-discard-btn").disabled).toBe(false);
      element("font-palette-discard-btn").fire("click");
      expect(pendingDebounces()).toBe(0);
      await runDebounce();
      expect(palette.isDirty()).toBe(false);
      expect(palette.colors).toEqual(saved.fontPalette);
      expect(commands).toEqual([]);
      expect(JSON.stringify(saved)).toBe(before);
    },
  );
});

test("discard clears an invalid focused HEX field even when the palette itself is unchanged", async () => {
  await browserFixture(async ({ element, palette, doc, workspace, shortcut, commands, saved }) => {
    const before = JSON.stringify(saved);
    const hex = element("font-hex-0");
    doc.activeElement = hex;
    hex.value = "#invalid";
    hex.fire("input");
    expect(palette.isDirty()).toBe(false);
    expect(palette.invalid).toBe(true);
    expect(element("sync-label").textContent).toBe("색상 확인 필요");
    expect(element("sync-status").dataset.state).toBe("invalid");
    expect(workspace.canExport()).toBe(false);
    await shortcut(element("undo-btn"));
    expect(commands).toEqual([]);
    expect(element("font-palette-discard-btn").hidden).toBe(false);
    expect(element("font-palette-save-row").hidden).toBe(false);
    element("font-palette-discard-btn").fire("click");
    expect(hex.value).toBe(saved.fontPalette[0]!);
    expect(hex.attributes.get("aria-invalid")).toBe("false");
    expect(palette.invalid).toBe(false);
    expect(element("sync-label").textContent).toBe("저장됨");
    expect(workspace.canExport()).toBe(true);
    expect(commands).toEqual([]);
    expect(JSON.stringify(saved)).toBe(before);
  });
});

test("the header reflects a restored unsaved draft without changing transport state or saved work", async () => {
  await browserFixture(
    async ({ element, workspace, commands, saved }) => {
      const before = JSON.stringify(saved);
      expect(workspace.status).toBe("saved");
      expect(element("sync-label").textContent).toBe("미저장 변경");
      expect(element("sync-status").dataset.state).toBe("draft");
      expect(workspace.canExport()).toBe(false);
      element("font-palette-discard-btn").fire("click");
      expect(element("sync-label").textContent).toBe("저장됨");
      expect(element("sync-status").dataset.state).toBe("saved");
      expect(workspace.canExport()).toBe(true);
      expect(commands).toEqual([]);
      expect(JSON.stringify(saved)).toBe(before);
    },
    { draft: true },
  );
});

test("local edit status returns to saved only after the automatic save is acknowledged", async () => {
  await browserFixture(async ({ element, runDebounce, commands, workspace }) => {
    const hex = element("font-hex-0");
    hex.value = "#abcdef";
    hex.fire("input");
    expect(element("sync-label").textContent).toBe("미저장 변경");
    expect(commands).toEqual([]);
    expect(workspace.canExport()).toBe(false);
    await runDebounce();
    expect(commands).toHaveLength(1);
    expect(element("sync-label").textContent).toBe("저장됨");
    expect(element("sync-status").dataset.state).toBe("saved");
    expect(workspace.canExport()).toBe(true);
  });
});

test.each<Mode>([
  "read-only",
  "other-tab",
])("a local draft cannot hide the %s header status", async (mode) => {
  await browserFixture(
    async ({ element, offline }) => {
      expect(element("sync-label").textContent).toBe("읽기 전용");
      expect(element("sync-status").dataset.state).toBe("read-only");
      offline();
      expect(element("sync-status").dataset.state).toBe("offline");
    },
    { mode, draft: true },
  );
});

test("unconfirmed saves and pending conflicts take precedence over local draft status", async () => {
  await browserFixture(
    async ({ element }) => {
      expect(element("sync-label").textContent).toBe("저장 확인 필요");
      expect(element("sync-status").dataset.state).toBe("unconfirmed");
    },
    { draft: true, saveConfirmed: false },
  );
  await browserFixture(
    async ({ element }) => {
      expect(element("sync-label").textContent).toBe("변경 충돌 · 확인 필요");
      expect(element("sync-status").dataset.state).toBe("conflict");
    },
    {
      draft: true,
      pending: {
        command: {
          type: "palette",
          colors: Array(20).fill("#123456"),
          projectId: "project",
          clientId: "browser-client",
          commandId: "pending",
          expectedRevision: 40,
        },
        needsRebase: true,
      },
    },
  );
});

test("the local discard action cannot erase a pending durable command or its draft", async () => {
  const pending: PendingChange = {
    command: {
      type: "palette",
      colors: Array(20).fill("#123456"),
      projectId: "project",
      clientId: "browser-client",
      commandId: "pending",
      expectedRevision: 41,
    },
    needsRebase: true,
  };
  await browserFixture(
    async ({ element, palette, workspace, memory, commands }) => {
      const draft = [...palette.colors!];
      const storedPending = memory.get(storageKey("pending"));
      const localDiscard = element("font-palette-discard-btn");
      expect(localDiscard.hidden).toBe(true);
      expect(localDiscard.disabled).toBe(true);
      expect(element("discard-btn").hidden).toBe(false);
      localDiscard.fire("click");
      expect(workspace.pending).toEqual(pending);
      expect(palette.colors).toEqual(draft);
      expect(memory.get(storageKey("pending"))).toBe(storedPending);
      expect(commands).toEqual([]);
    },
    { draft: true, pending },
  );
});

test("Ctrl/Cmd+Z and Shift+Z work while a button or its child holds focus", async () => {
  await browserFixture(async ({ element, shortcut, control, commands }) => {
    expect((await shortcut(element("undo-btn"))).defaultPrevented).toBe(true);
    const icon = control("span");
    element("redo-btn").append(icon);
    expect((await shortcut(icon, { ctrlKey: false, metaKey: true, shiftKey: true })).defaultPrevented).toBe(
      true,
    );
    expect(commands.map(({ type }) => type)).toEqual(["undo", "redo"]);
  });
});

test("text fields and inherited editable content keep native undo and redo", async () => {
  await browserFixture(async ({ element, control, shortcut, commands }) => {
    const text = control("input");
    text.type = "text";
    const editor = control("div");
    editor.setAttribute("contenteditable", "plaintext-only");
    const child = control("span");
    editor.append(child);
    for (const target of [text, element("font-glyph-search-input"), element("font-preview-input"), child]) {
      expect((await shortcut(target)).defaultPrevented).toBe(false);
      expect((await shortcut(target, { shiftKey: true })).defaultPrevented).toBe(false);
    }
    expect(commands).toEqual([]);
  });
});

test.each<Mode>([
  "read-only",
  "other-tab",
])("button shortcuts cannot bypass %s editing guards", async (mode) => {
  await browserFixture(
    async ({ element, shortcut, commands }) => {
      await shortcut(element("undo-btn"));
      await shortcut(element("redo-btn"), { shiftKey: true });
      expect(commands).toEqual([]);
    },
    { mode },
  );
});

test("button shortcuts cannot bypass a local draft or pending command", async () => {
  await browserFixture(
    async ({ element, shortcut, commands }) => {
      await shortcut(element("undo-btn"));
      expect(commands).toEqual([]);
    },
    { draft: true },
  );
  await browserFixture(
    async ({ element, shortcut, workspace, commands }) => {
      await shortcut(element("redo-btn"), { shiftKey: true });
      expect(commands).toEqual([]);
      expect(workspace.pending?.command.commandId).toBe("pending");
    },
    {
      pending: {
        command: {
          type: "undo",
          projectId: "project",
          clientId: "browser-client",
          commandId: "pending",
          expectedRevision: 41,
        },
        needsRebase: true,
      },
    },
  );
});

test("initial connection, poll and online events use one session request", async () => {
  await browserFixture(
    async (browser) => {
      await browser.settle();
      await browser.pollInterval();
      await browser.online();
      const requestsWhileHeld = { ...browser.requests };
      browser.initialSession!.release();
      await browser.started;
      await browser.settle();
      expect(requestsWhileHeld.sessions).toBe(1);
      expect(browser.requests.sessions).toBe(1);
      expect(browser.requests.leases).toBe(1);
      expect(browser.connected()).toBe(1);
      expect(browser.workspace.canEdit()).toBe(true);
    },
    { holdInitialSession: true },
  );
});

test("overlapping retry and polling cannot roll back an acknowledged palette revision", async () => {
  await browserFixture(async (browser) => {
    const { element, workspace, saved, palette, memory } = browser;
    browser.offline();
    const held = browser.holdSession();
    expect(element("retry-btn").hidden).toBe(false);
    element("retry-btn").fire("click");
    await browser.settle();
    expect(element("retry-btn").hidden).toBe(true);
    await browser.pollInterval();
    await browser.online();
    const sessionsWhileHeld = browser.requests.sessions;
    async function saveColor() {
      element("font-hex-0").value = "#abcdef";
      element("font-hex-0").fire("input");
      await browser.runDebounce();
    }
    // The unfixed controller enables editing through a second handshake before
    // the old session response returns. Exercise the resulting stale snapshot.
    const savedBeforeRelease = workspace.canEdit();
    if (savedBeforeRelease) await saveColor();
    held.release();
    await browser.settle();
    if (!savedBeforeRelease) await saveColor();
    expect(saved.revision).toBe(42);
    expect(saved.fontPalette[0]).toBe("#abcdef");
    expect(workspace.snapshot?.revision).toBe(42);
    expect(workspace.snapshot?.fontPalette[0]).toBe("#abcdef");
    expect(palette.colors?.[0]).toBe("#abcdef");
    expect(element("font-hex-0").value).toBe("#abcdef");
    expect(element("revision-label").textContent).toBe("REV 0042");
    expect(element("sync-label").textContent).toBe("저장됨");
    expect(memory.has(storageKey("palette-draft"))).toBe(false);
    expect(sessionsWhileHeld).toBe(2); // Initial session plus one reconnect.
    expect(browser.connected()).toBe(2);
  });
});

test("the connection remains exclusive while its lease response is pending", async () => {
  await browserFixture(async (browser) => {
    browser.offline();
    const held = browser.holdLease();
    expect(browser.element("retry-btn").hidden).toBe(false);
    browser.element("retry-btn").fire("click");
    await browser.settle();
    expect(browser.requests.sessions).toBe(2);
    expect(browser.connected()).toBe(1);
    await browser.pollInterval();
    await browser.online();
    const projectsWhileHeld = browser.requests.projects;
    const connectionsWhileHeld = browser.connected();
    held.release();
    await browser.settle();
    expect(projectsWhileHeld).toBe(0);
    expect(connectionsWhileHeld).toBe(1);
    expect(browser.requests.sessions).toBe(2);
    expect(browser.requests.leases).toBe(2);
    expect(browser.connected()).toBe(2);
    expect(browser.workspace.canEdit()).toBe(true);
  });
});

test("a failed shared connection is released so the next visible retry can succeed", async () => {
  await browserFixture(async (browser) => {
    browser.offline();
    const held = browser.holdSession();
    expect(browser.element("retry-btn").hidden).toBe(false);
    browser.element("retry-btn").fire("click");
    await browser.settle();
    await browser.pollInterval();
    await browser.online();
    held.fail(new Error("session temporarily unavailable"));
    await browser.settle();
    expect(browser.workspace.online).toBe(false);
    expect(browser.element("retry-btn").hidden).toBe(false);
    browser.element("retry-btn").fire("click");
    await browser.settle();
    expect(browser.workspace.canEdit()).toBe(true);
    expect(browser.requests.sessions).toBe(3); // Initial session, failure, retry.
    expect(browser.connected()).toBe(2);
    expect(browser.element("sync-label").textContent).toBe("저장됨");
  });
});
