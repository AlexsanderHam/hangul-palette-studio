import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FONT_COLOR_SLOTS } from "../../font/palette.ts";
import type { StudioCommand } from "../protocol.ts";
import { type FontEngine, StudioFonts } from "./fonts.ts";
import { StudioError, StudioStore, type StudioStoreOptions } from "./store.ts";

export interface StudioServerOptions extends StudioStoreOptions {
  port?: number;
  root?: string;
  fontEngine?: FontEngine;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const bytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new StudioError("invalid_json", "올바른 JSON 요청이 필요합니다.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StudioError("invalid_json", "JSON 객체가 필요합니다.");
  return value as Record<string, unknown>;
}

export async function startStudioServer(options: StudioServerOptions) {
  const root = resolve(options.root ?? join(import.meta.dir, "../../.."));
  const store = await StudioStore.open(options);
  const token = randomBytes(32).toString("hex");
  const fontPath = [
    join(root, "data/Pretendard-Regular.otf"),
    join(root, ".cache/pretendard-src/packages/pretendard/dist/public/static/Pretendard-Regular.otf"),
  ].find(existsSync);
  let closing: Promise<void> | null = null;
  const fonts = new StudioFonts(root, store.fontSourceSnapshot(), options.fontEngine);

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port ?? 4000,
      maxRequestBodySize: 256 * 1024,
      async fetch(request) {
        const url = new URL(request.url);
        if (!LOCAL_HOSTS.has(url.hostname))
          return json({ error: { code: "invalid_host", message: "로컬 주소로 접속하세요." } }, 403);
        const origin = request.headers.get("origin");
        if (origin) {
          let allowed = false;
          try {
            const parsed = new URL(origin);
            allowed =
              parsed.protocol === "http:" &&
              LOCAL_HOSTS.has(parsed.hostname) &&
              (parsed.port || "80") === String(server.port);
          } catch {
            /* Invalid and opaque origins are rejected. */
          }
          if (!allowed)
            return json(
              {
                error: { code: "invalid_origin", message: "다른 사이트에서 보낸 요청은 허용되지 않습니다." },
              },
              403,
            );
        }
        if (
          request.headers.get("sec-fetch-site") === "cross-site" &&
          (url.pathname.startsWith("/api/") || request.method !== "GET")
        )
          return json(
            { error: { code: "invalid_origin", message: "로컬 Studio 화면에서 요청하세요." } },
            403,
          );
        try {
          if (url.pathname === "/api/session" && request.method === "GET") {
            await store.refreshReadOnly();
            return json({ token, snapshot: store.snapshot() });
          }
          if (url.pathname.startsWith("/api/")) {
            if (!tokenMatches(request.headers.get("x-studio-token"), token))
              throw new StudioError("invalid_session", "연결이 갱신되었습니다. 다시 연결하세요.", 401);
            if (url.pathname === "/api/project" && request.method === "GET") {
              await store.refreshReadOnly();
              const revision = Number(url.searchParams.get("revision"));
              const projectMatches = url.searchParams.get("projectId") === store.projectId;
              return json({
                snapshot:
                  url.searchParams.has("revision") && revision === store.revision && projectMatches
                    ? null
                    : store.snapshot(),
                revision: store.revision,
                saveConfirmed: store.saveConfirmed,
                lease: store.leaseInfo(),
              });
            }
            if (url.pathname === "/api/lease" && request.method === "POST") {
              const value = await readJsonBody(request);
              if (value.takeover !== undefined && typeof value.takeover !== "boolean")
                throw new StudioError("invalid_lease", "잘못된 편집 권한 요청입니다.");
              return json({ lease: store.claimLease(value.clientId, value.takeover === true) });
            }
            if (url.pathname === "/api/command" && request.method === "POST") {
              return json({
                snapshot: await store.execute((await readJsonBody(request)) as unknown as StudioCommand),
              });
            }
            if (url.pathname === "/api/color-font/status" && request.method === "GET") {
              await store.assertFontSourceUnchanged();
              return json({
                ...(await fonts.status()),
                coverage: { glyphCount: store.snapshot().glyphCount, expectedGlyphs: 11223 },
                slots: FONT_COLOR_SLOTS,
              });
            }
            if (url.pathname === "/api/color-font/prepare" && request.method === "POST") {
              await readJsonBody(request);
              await store.assertFontSourceUnchanged();
              return json({ build: await fonts.prepare() }, 202);
            }
            if (url.pathname === "/api/color-font/packages" && request.method === "POST") {
              const value = await readJsonBody(request);
              const captured = await store.capturePalette(value.projectId, value.expectedRevision);
              const job = fonts.startPackage(value.buildId, captured);
              return json({ job }, 202);
            }
            const buildRoute =
              /^\/api\/color-font\/builds\/([a-zA-Z0-9_-]+)(?:\/fonts\/([a-zA-Z0-9_-]+)\.woff2)?$/.exec(
                url.pathname,
              );
            if (buildRoute && request.method === "GET") {
              const id = buildRoute[1]!;
              const requestedWeight = buildRoute[2];
              if (requestedWeight) {
                const font = fonts.getFont(id, requestedWeight);
                return new Response(font, {
                  headers: {
                    ...HEADERS,
                    "Content-Type": "font/woff2",
                    "Content-Length": String(font.byteLength),
                  },
                });
              }
              return json({ build: fonts.getBuild(id) });
            }
            const packageRoute = /^\/api\/color-font\/packages\/([a-zA-Z0-9_-]+)(\/download)?$/.exec(
              url.pathname,
            );
            if (packageRoute && request.method === "GET") {
              const id = packageRoute[1]!;
              if (!packageRoute[2]) return json({ job: fonts.getPackage(id) });
              const download = fonts.getDownload(id);
              return new Response(download.bytes, {
                headers: {
                  ...HEADERS,
                  "Content-Type": "application/zip",
                  "Content-Length": String(download.bytes.byteLength),
                  "Content-Disposition": `attachment; filename="${download.filename}"`,
                },
              });
            }
            return json({ error: { code: "not_found", message: "존재하지 않는 API입니다." } }, 404);
          }
          if (request.method !== "GET")
            return new Response("Method Not Allowed", { status: 405, headers: { ...HEADERS, Allow: "GET" } });
          if (url.pathname === "/studio.js") {
            const build = await Bun.build({
              entrypoints: [join(root, "src/studio/client/main.ts")],
              target: "browser",
              format: "esm",
              sourcemap: "inline",
            });
            if (!build.success) {
              console.error(build.logs);
              return new Response("Studio client build failed. Check the server log.", {
                status: 500,
                headers: HEADERS,
              });
            }
            return new Response(await build.outputs[0]!.text(), {
              headers: { ...HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
            });
          }
          if (url.pathname === "/font.otf") {
            if (!fontPath)
              return new Response("Font unavailable. System font fallback is active.", {
                status: 404,
                headers: HEADERS,
              });
            return new Response(Bun.file(fontPath), {
              headers: { ...HEADERS, "Content-Type": "font/otf", "Cache-Control": "private, max-age=86400" },
            });
          }
          const file = {
            "/": "src/studio/client/index.html",
            "/studio.css": "src/studio/client/studio.css",
            "/LICENSE-OFL": "LICENSE-OFL",
          }[url.pathname];
          if (file)
            return new Response(await readFile(join(root, file)), {
              headers: {
                ...HEADERS,
                "Content-Type": file.endsWith(".html")
                  ? "text/html; charset=utf-8"
                  : file.endsWith(".css")
                    ? "text/css; charset=utf-8"
                    : "text/plain; charset=utf-8",
              },
            });
          return new Response("Not Found", { status: 404, headers: HEADERS });
        } catch (error) {
          if (error instanceof StudioError)
            return json(
              {
                error: { code: error.code, message: error.message },
                ...(error.status === 409 || error.status === 503 ? { snapshot: store.snapshot() } : {}),
              },
              error.status,
            );
          console.error(error);
          return json(
            {
              error: {
                code: "internal_error",
                message: "요청을 처리하지 못했습니다. 서버 로그를 확인하세요.",
              },
            },
            500,
          );
        }
      },
    });
  } catch (error) {
    await store.close();
    throw error;
  }

  async function stop(): Promise<void> {
    if (!closing) {
      const jobsDone = fonts.close();
      closing = (async () => {
        await server.stop(false);
        await jobsDone;
        await store.close();
      })();
    }
    return closing;
  }
  return { server, store, stop };
}
