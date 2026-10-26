import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultFontPalette, FONT_COLOR_SLOTS } from "../../../src/font/palette.ts";
import { FONT_WEIGHTS } from "../../../src/font/weights.ts";
import { createFonts, type FontsController } from "../../../src/studio/client/fonts.ts";
import type { PaletteController } from "../../../src/studio/client/palette.ts";
import { createFontPreview } from "../../../src/studio/client/preview.ts";
import { ApiError, type WorkspaceController } from "../../../src/studio/client/workspace.ts";
import type {
  ColorFontPackageJob,
  ColorFontStatusResponse,
  FontPreparation,
  StudioSnapshot,
} from "../../../src/studio/protocol.ts";

const html = readFileSync(new URL("../../../src/studio/client/index.html", import.meta.url), "utf8");
const now = "2026-10-25T00:00:00.000Z";
function readyBuild(id = "session-job", buildId = "source-compiler-build"): FontPreparation {
  return {
    id,
    buildId,
    sourceId: "source",
    status: "ready",
    startedAt: now,
    finishedAt: now,
    error: null,
    fonts: FONT_WEIGHTS.map(({ id, value, label }) => ({
      id,
      label,
      weight: value,
      fontUrl: `/fonts/${buildId}/${id}.woff2`,
      bytes: 1,
      sha256: `${buildId}-${id}`,
    })),
  };
}

async function withBrowser(run: (fixture: ReturnType<typeof mount>) => Promise<void>) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  function install(name: string, value: unknown) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    await run(mount(install));
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

/** Event/DOM seams only: both the font workflow and FontFace preview controller are real. */
function mount(install: (name: string, value: unknown) => void) {
  const elements = new Map<string, Control>();
  const controls: Control[] = [];
  const downloads: string[] = [];
  const fetches: string[] = [];
  const timers = new Map<number, { run: () => void; delay: number }>();
  let timerId = 0;
  class Control extends EventTarget {
    children: Control[] = [];
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    attributes = new Map<string, string>();
    value = "가 값 휺 ABC";
    textContent = "";
    hidden = false;
    disabled = false;
    download = "";
    constructor() {
      super();
      controls.push(this);
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
      if (name === "id") elements.set(value, this);
      if (name === "value") this.value = value;
      if (name.startsWith("data-")) {
        const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
        this.dataset[key] = value;
      }
    }
    append(...nodes: unknown[]) {
      this.children.push(...nodes.filter((node): node is Control => node instanceof Control));
    }
    matches(selector: string): boolean {
      const attribute = /^\[data-([\w-]+)\]$/.exec(selector);
      if (!attribute) throw new Error(`Unsupported preview selector ${selector}`);
      const key = attribute[1]!.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      return this.dataset[key] !== undefined;
    }
    querySelectorAll(selector: string): Control[] {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    fire(type: string) {
      this.dispatchEvent(new Event(type, { cancelable: true }));
    }
    click() {
      if (this.download) downloads.push(this.download);
      this.fire("click");
    }
    remove() {}
  }
  for (const [, attributes] of html.matchAll(/<[a-z][\w-]*\b([^>]*)>/gi)) {
    if (!/\bid="|\bdata-font-theme=/.test(attributes!)) continue;
    const control = new Control();
    for (const [, name, value] of attributes!.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
      control.setAttribute(name!, value ?? "");
  }
  install("document", {
    getElementById: (id: string) => elements.get(id),
    createElement: () => new Control(),
    querySelectorAll: (selector: string) => controls.filter((control) => control.matches(selector)),
    head: new Control(),
    body: new Control(),
    fonts: new Set(),
  });
  install("window", {
    setTimeout(run: () => void, delay: number) {
      const id = ++timerId;
      timers.set(id, { run, delay });
      return id;
    },
  });
  const clearNativeTimeout = globalThis.clearTimeout;
  install("clearTimeout", (id: Parameters<typeof clearTimeout>[0]) => {
    if (typeof id === "number" && timers.delete(id)) return;
    clearNativeTimeout(id);
  });
  install("CSS", { supports: () => true });
  install(
    "FontFace",
    class {
      async load() {
        return this;
      }
    },
  );
  let afterArtifact: (() => void) | null = null;
  let beforeFont: (() => Promise<void>) | null = null;
  install("fetch", async (url: string) => {
    fetches.push(url);
    if (url.endsWith(".woff2")) await beforeFont?.();
    if (url.endsWith("/download")) afterArtifact?.();
    return new Response(new Uint8Array([1]));
  });
  const snapshot: StudioSnapshot = {
    projectId: "palette-workspace",
    revision: 41,
    readOnly: false,
    saveConfirmed: true,
    fontPalette: defaultFontPalette(),
    glyphCount: 11223,
    source: { rawDigest: "raw", baselineDigest: "baseline" },
    history: { canUndo: true, canRedo: false, undoLabel: "palette", redoLabel: null },
    lease: { ownerId: null, expiresAt: null },
    backups: [],
    savedAt: now,
  };
  const state = {
    canExport: true,
    statusBuild: null as FontPreparation | null,
    prepared: readyBuild(),
    packageStatus: "ready" as ColorFontPackageJob["status"],
    failPrepare: false,
    failStatus: false,
    packageFailure: "",
  };
  const requests: { path: string; body: unknown }[] = [];
  let latestPackage: ColorFontPackageJob | null = null;
  let beforePackage: (() => Promise<void>) | null = null;
  const workspace = {
    snapshot,
    token: "token",
    online: true,
    canExport: () => state.canExport,
    applySnapshot(next: StudioSnapshot) {
      Object.assign(snapshot, next);
    },
    async request(path: string, options?: RequestInit) {
      const body = options?.body ? JSON.parse(String(options.body)) : null;
      requests.push({ path, body });
      if (path === "/api/color-font/status" && state.failStatus) throw new Error("new connection failed");
      if (path === "/api/color-font/status")
        return {
          sourceId: "source",
          runtime: { ready: true },
          build: state.statusBuild,
          coverage: { glyphCount: 11223, expectedGlyphs: 11223 },
          slots: [...FONT_COLOR_SLOTS],
        } as ColorFontStatusResponse;
      if (path === "/api/color-font/prepare") {
        if (state.failPrepare) throw new Error("prepare failed");
        state.statusBuild = state.prepared;
        return { build: state.prepared };
      }
      if (path.startsWith("/api/color-font/builds/")) return { build: state.prepared };
      if (path === "/api/color-font/packages") {
        const gate = beforePackage;
        beforePackage = null;
        await gate?.();
        if (state.packageFailure) throw new Error(state.packageFailure);
        latestPackage = {
          id: "package",
          buildId: body.buildId,
          sourceId: "source",
          projectId: body.projectId,
          revision: body.expectedRevision,
          palette: [...palette.colors!],
          status: state.packageStatus,
          startedAt: now,
          finishedAt: now,
          error: null,
          artifact: {
            filename: "hangul-palette.zip",
            bytes: 1,
            sha256: "zip",
            downloadUrl: "/package/download",
          },
        };
        return { job: latestPackage };
      }
      if (path.startsWith("/api/color-font/packages/"))
        return { job: { ...latestPackage, status: state.packageStatus } };
      throw new Error(`Unexpected request ${path}`);
    },
  } as unknown as WorkspaceController;
  let slots = [...FONT_COLOR_SLOTS];
  const palette = {
    colors: [...snapshot.fontPalette],
    get slots() {
      return slots;
    },
    invalid: false,
    isDirty: () => !state.canExport,
    setSlots(next: typeof FONT_COLOR_SLOTS) {
      slots = [...next];
    },
  } as unknown as PaletteController;
  let fonts: FontsController;
  const preview = createFontPreview({
    workspace,
    palette,
    buildState: () => ({ build: fonts.build, sourceId: fonts.sourceId, preparing: fonts.preparing }),
    onChange() {
      fonts.render();
      preview.render();
    },
  });
  fonts = createFonts({
    workspace,
    palette,
    preview,
    onChange() {
      fonts.render();
      preview.render();
    },
  });
  async function settle() {
    for (let index = 0; index < 30; index++) await Promise.resolve();
  }
  return {
    state,
    snapshot,
    workspace,
    palette,
    requests,
    fetches,
    downloads,
    fonts,
    preview,
    elements,
    async click(id: string) {
      elements.get(id)!.click();
      await settle();
    },
    async poll() {
      const entry = [...timers].find(([, timer]) => timer.delay === 1200);
      expect(entry).toBeDefined();
      timers.delete(entry![0]);
      entry![1].run();
      await settle();
    },
    afterArtifact(callback: () => void) {
      afterArtifact = callback;
    },
    beforeFont(callback: () => Promise<void>) {
      beforeFont = callback;
    },
    beforePackage(callback: () => Promise<void>) {
      beforePackage = callback;
    },
    settle,
    theme: (name: string) => controls.find((control) => control.dataset.fontTheme === name)!,
  };
}

test("opening Studio prepares all faces even with an unsaved read-only palette, without packaging or downloading", async () => {
  await withBrowser(async (browser) => {
    browser.snapshot.readOnly = true;
    browser.state.canExport = false;
    const saved = JSON.stringify(browser.snapshot);
    await browser.fonts.connect();
    expect(browser.requests.map(({ path }) => path)).toEqual([
      "/api/color-font/status",
      "/api/color-font/prepare",
    ]);
    expect(browser.requests[1]!.body).toEqual({});
    expect(browser.fetches).toHaveLength(9);
    expect(browser.preview.isCurrent()).toBe(true);
    expect(browser.downloads).toEqual([]);
    expect(JSON.stringify(browser.snapshot)).toBe(saved);
    expect(browser.elements.get("font-download-btn")!.disabled).toBe(true);
  });
});

test("a cached build after reconnect reuses loaded faces independently of workspace and palette revision", async () => {
  await withBrowser(async (browser) => {
    browser.state.statusBuild = readyBuild("before-restart");
    await browser.fonts.connect();
    browser.snapshot.projectId = "another-palette-workspace";
    browser.snapshot.revision++;
    browser.state.statusBuild = readyBuild("after-restart");
    await browser.fonts.connect();
    expect(browser.requests.every(({ path }) => path === "/api/color-font/status")).toBe(true);
    expect(browser.fetches).toHaveLength(9);
    expect(browser.preview.build?.id).toBe("after-restart");
    expect(browser.preview.isCurrent()).toBe(true);
    expect(browser.downloads).toEqual([]);
  });
});

test("the initial preparation polls its shared job until all preview fonts are ready", async () => {
  await withBrowser(async (browser) => {
    browser.state.prepared = { ...readyBuild(), buildId: null, status: "building", fonts: null };
    await browser.fonts.connect();
    expect(browser.fetches).toEqual([]);
    expect(browser.fonts.preparing).toBe(true);
    browser.state.prepared = readyBuild();
    await browser.poll();
    expect(browser.requests.at(-1)?.path).toBe("/api/color-font/builds/session-job");
    expect(browser.preview.isCurrent()).toBe(true);
    expect(browser.fetches).toHaveLength(9);
    expect(browser.downloads).toEqual([]);
  });
});

test("only an explicit download packages the saved palette using the prepared immutable build", async () => {
  await withBrowser(async (browser) => {
    await browser.fonts.connect();
    await browser.click("font-download-btn");
    expect(browser.requests.at(-1)).toEqual({
      path: "/api/color-font/packages",
      body: {
        buildId: "source-compiler-build",
        projectId: "palette-workspace",
        expectedRevision: 41,
      },
    });
    expect(browser.downloads).toEqual(["hangul-palette.zip"]);
    expect(browser.fetches.filter((url) => url.endsWith(".woff2"))).toHaveLength(9);
    await browser.fonts.connect();
    expect(browser.downloads).toHaveLength(1);
  });
});

test("a changed compiler build replaces all preview faces even when the source identity is unchanged", async () => {
  await withBrowser(async (browser) => {
    browser.state.statusBuild = readyBuild();
    await browser.fonts.connect();
    browser.state.statusBuild = readyBuild("new-compiler-job", "new-compiler-build");
    await browser.fonts.connect();
    expect(browser.fetches).toHaveLength(18);
    expect(browser.preview.build?.buildId).toBe("new-compiler-build");
    expect(browser.preview.isCurrent()).toBe(true);
    expect(browser.downloads).toEqual([]);
  });
});

test("changed colors suppress a pending package download and leave an explicit retry available", async () => {
  await withBrowser(async (browser) => {
    await browser.fonts.connect();
    browser.state.packageStatus = "building";
    await browser.click("font-download-btn");
    expect(browser.downloads).toEqual([]);
    (browser.palette.colors as string[])[0] = "#123456";
    browser.state.packageStatus = "ready";
    await browser.poll();
    expect(browser.downloads).toEqual([]);
    expect(browser.elements.get("font-retry-btn")!.hidden).toBe(false);
    expect(browser.elements.get("font-download-btn")!.disabled).toBe(false);
  });
});

test("palette changes while fetching the ZIP cannot download obsolete colors", async () => {
  await withBrowser(async (browser) => {
    await browser.fonts.connect();
    browser.afterArtifact(() => {
      (browser.palette.colors as string[])[0] = "#abcdef";
    });
    await browser.click("font-download-btn");
    expect(browser.downloads).toEqual([]);
    expect(browser.elements.get("font-notice-message")!.textContent).toContain("바뀌었습니다");
  });
});

test("failed automatic preparation offers retry without looping or downloading", async () => {
  await withBrowser(async (browser) => {
    browser.state.failPrepare = true;
    await browser.fonts.connect();
    expect(browser.requests).toHaveLength(2);
    expect(browser.elements.get("font-retry-btn")!.hidden).toBe(false);
    browser.state.failPrepare = false;
    await browser.click("font-retry-btn");
    expect(browser.preview.isCurrent()).toBe(true);
    expect(browser.downloads).toEqual([]);
  });
});

test("an older poll finishing FontFace loading cannot clear a newer connection failure", async () => {
  await withBrowser(async (browser) => {
    browser.state.prepared = { ...readyBuild(), buildId: null, status: "building", fonts: null };
    await browser.fonts.connect();
    let resumeFonts!: () => void;
    const paused = new Promise<void>((resolve) => {
      resumeFonts = resolve;
    });
    browser.beforeFont(() => paused);
    browser.state.prepared = readyBuild();
    await browser.poll();
    expect(browser.preview.loading).toBe(true);
    browser.state.failStatus = true;
    await browser.fonts.connect();
    expect(browser.elements.get("font-notice-message")!.textContent).toContain("new connection failed");
    resumeFonts();
    await browser.settle();
    expect(browser.elements.get("font-notice-message")!.textContent).toContain("new connection failed");
    expect(browser.elements.get("font-retry-btn")!.hidden).toBe(false);
    expect(browser.downloads).toEqual([]);
  });
});

test("a stale package failure cannot replace the newer workspace snapshot or cancel its download", async () => {
  await withBrowser(async (browser) => {
    await browser.fonts.connect();
    let rejectOld!: () => void;
    const oldRequest = new Promise<void>((_resolve, reject) => {
      rejectOld = () =>
        reject(
          new ApiError(409, {
            error: { code: "stale-package", message: "old package failed" },
            snapshot: { ...browser.snapshot, projectId: "obsolete-workspace" },
          }),
        );
    });
    browser.beforePackage(() => oldRequest);
    await browser.click("font-download-btn");
    await browser.fonts.connect();
    browser.state.packageStatus = "building";
    await browser.click("font-download-btn");
    rejectOld();
    await browser.settle();
    expect(browser.snapshot.projectId).toBe("palette-workspace");
    expect(browser.elements.get("font-download-btn")!.disabled).toBe(true);
    expect(browser.elements.get("font-notice")!.hidden).toBe(true);
    browser.state.packageStatus = "ready";
    await browser.poll();
    expect(browser.downloads).toEqual(["hangul-palette.zip"]);
  });
});

test("retrying a failed package refreshes the source build before capturing another package", async () => {
  await withBrowser(async (browser) => {
    await browser.fonts.connect();
    browser.state.packageFailure = "producer changed";
    await browser.click("font-download-btn");
    browser.state.packageFailure = "";
    browser.state.prepared = readyBuild("new-producer-job", "new-producer-build");
    await browser.click("font-retry-btn");
    expect(browser.requests.filter(({ path }) => path === "/api/color-font/prepare")).toHaveLength(2);
    expect(browser.requests.at(-1)?.body).toEqual({
      buildId: "new-producer-build",
      projectId: "palette-workspace",
      expectedRevision: 41,
    });
    expect(browser.preview.build?.buildId).toBe("new-producer-build");
    expect(browser.downloads).toEqual(["hangul-palette.zip"]);
  });
});

test("preview text and size controls update all nine visible font rows without preparing another build", async () => {
  await withBrowser(async (browser) => {
    await browser.fonts.connect();
    const preview = browser.elements.get("font-preview-text")!;
    const sample = browser.elements.get("font-preview-input")!;
    const size = browser.elements.get("font-preview-size")!;
    const rows = preview.querySelectorAll("[data-preview-weight]");
    const lines = preview.querySelectorAll("[data-font-weight]");
    expect(rows).toHaveLength(9);
    expect(lines).toHaveLength(9);
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(preview.hidden).toBe(false);
    expect(browser.elements.get("font-preview-placeholder")!.hidden).toBe(true);
    sample.value = "가나다\nABC 123 !?";
    sample.fire("input");
    expect(lines.every((line) => line.textContent === sample.value)).toBe(true);
    size.value = "72";
    size.fire("input");
    expect(lines.every((line) => line.style.fontSize === "72px")).toBe(true);
    expect(browser.elements.get("font-preview-size-value")!.textContent).toBe("72 px");
    expect(size.attributes.get("aria-valuetext")).toBe("72 픽셀");
    expect(browser.fetches).toHaveLength(9);
    expect(browser.requests).toHaveLength(2);
    expect(browser.downloads).toEqual([]);
  });
});

test("weight selection filters actual preview rows and the single-character comparison returns to all weights", async () => {
  await withBrowser(async (browser) => {
    await browser.fonts.connect();
    const preview = browser.elements.get("font-preview-text")!;
    const weight = browser.elements.get("font-preview-weight")!;
    const rows = preview.querySelectorAll("[data-preview-weight]");
    weight.value = "bold";
    weight.fire("change");
    expect(rows.filter((row) => !row.hidden).map((row) => row.dataset.previewWeight)).toEqual(["bold"]);
    expect(preview.dataset.mode).toBe("single");
    expect(preview.attributes.get("aria-label")).toContain("Bold");
    weight.value = "all";
    weight.fire("change");
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(preview.dataset.mode).toBe("all");
    weight.value = "light";
    weight.fire("change");
    const search = browser.elements.get("font-glyph-search-input")!;
    search.value = "가";
    browser.elements.get("font-glyph-search-form")!.fire("submit");
    expect(browser.elements.get("font-preview-input")!.value).toBe("가");
    expect(preview.querySelectorAll("[data-font-weight]").every((line) => line.textContent === "가")).toBe(
      true,
    );
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(weight.value).toBe("all");
    expect(search.attributes.get("aria-invalid")).toBe("false");
    search.value = "가나";
    browser.elements.get("font-glyph-search-form")!.fire("submit");
    expect(search.attributes.get("aria-invalid")).toBe("true");
    expect(browser.elements.get("font-preview-input")!.value).toBe("가");
  });
});

test("preview theme buttons change the canvas and accessible pressed state without changing the fonts", async () => {
  await withBrowser(async (browser) => {
    await browser.fonts.connect();
    const canvas = browser.elements.get("font-preview-canvas")!;
    const dark = browser.theme("dark");
    const light = browser.theme("light");
    expect(canvas.dataset.theme).toBe("dark");
    expect(dark.attributes.get("aria-pressed")).toBe("true");
    light.click();
    expect(canvas.dataset.theme).toBe("light");
    expect(light.attributes.get("aria-pressed")).toBe("true");
    expect(dark.attributes.get("aria-pressed")).toBe("false");
    dark.click();
    expect(canvas.dataset.theme).toBe("dark");
    expect(dark.attributes.get("aria-pressed")).toBe("true");
    expect(light.attributes.get("aria-pressed")).toBe("false");
    expect(browser.fetches).toHaveLength(9);
    expect(browser.requests).toHaveLength(2);
  });
});
