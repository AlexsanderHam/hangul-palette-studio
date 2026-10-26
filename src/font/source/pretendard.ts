import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import officialSources from "../compiler/official-sources.json";

/** The extraction format is deliberately limited to Glyphs 3's text plist syntax. */
export type PlistValue = string | number | PlistValue[] | { [key: string]: PlistValue };
export type PlistObject = { [key: string]: PlistValue };

export function parseSourcePlist(text: string): PlistObject {
  let cursor = 0;
  function skip(): void {
    while (cursor < text.length) {
      if (/\s/.test(text[cursor]!)) cursor++;
      else if (text.startsWith("//", cursor)) {
        const end = text.indexOf("\n", cursor);
        cursor = end < 0 ? text.length : end + 1;
      } else if (text.startsWith("/*", cursor)) {
        const end = text.indexOf("*/", cursor + 2);
        if (end < 0) throw new Error("Unterminated source comment");
        cursor = end + 2;
      } else break;
    }
  }
  function fail(message: string): never {
    throw new Error(`${message} near source offset ${cursor}`);
  }
  function token(): string {
    skip();
    if (text[cursor] === '"') {
      cursor++;
      let result = "";
      while (cursor < text.length) {
        const char = text[cursor++]!;
        if (char === '"') return result;
        if (char === "\\") {
          if (cursor >= text.length) fail("Unterminated quoted string");
          const next = text[cursor++]!;
          result += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
        } else result += char;
      }
      return fail("Unterminated quoted string");
    }
    const start = cursor;
    while (cursor < text.length && !/[\s{}()=;,]/.test(text[cursor]!)) cursor++;
    if (cursor === start) fail("Expected source token");
    return text.slice(start, cursor);
  }
  function value(): PlistValue {
    skip();
    if (text[cursor] === "{") {
      cursor++;
      const object: PlistObject = Object.create(null);
      skip();
      while (text[cursor] !== "}") {
        const key = token();
        skip();
        if (text[cursor++] !== "=") fail("Expected '='");
        if (Object.hasOwn(object, key)) fail(`Duplicate key '${key}'`);
        object[key] = value();
        skip();
        if (text[cursor++] !== ";") fail("Expected ';'");
        skip();
      }
      cursor++;
      return object;
    }
    if (text[cursor] === "(") {
      cursor++;
      const list: PlistValue[] = [];
      skip();
      while (text[cursor] !== ")") {
        list.push(value());
        skip();
        if (text[cursor] === ",") cursor++;
        skip();
      }
      cursor++;
      return list;
    }
    const quoted = text[cursor] === '"';
    const raw = token();
    return !quoted && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) ? Number(raw) : raw;
  }
  const result = value();
  skip();
  if (cursor !== text.length) fail("Unexpected trailing source content");
  if (typeof result !== "object" || Array.isArray(result)) fail("Expected a source dictionary");
  return result as PlistObject;
}

export function sourceObject(value: PlistValue | undefined, context: string): PlistObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${context}: expected dictionary`);
  return value;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export const PRETENDARD_SOURCE = {
  repository: "https://github.com/orioncactus/pretendard",
  ref: "v1.3.9",
  revision: "5c41199ea0024a9e0b2cb31735265056e5472d76",
} as const;

function git(source: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", source, ...args]);
  if (result.exitCode !== 0)
    throw new Error(`Source verification failed: git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

/** An existing cache must match the pinned source; a directory is not proof of provenance. */
export function verifySourceRepository(source: string): void {
  const head = git(source, ["rev-parse", "HEAD"]);
  if (head !== PRETENDARD_SOURCE.revision)
    throw new Error(
      `Source revision ${head} does not match pinned ${PRETENDARD_SOURCE.ref} (${PRETENDARD_SOURCE.revision}). Use a separate checkout; the Studio never resets your source.`,
    );
  const status = git(source, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "src/Pretendard.glyphspackage",
    ...Object.values(officialSources.files).map((font) => font.path),
    "LICENSE",
  ]);
  if (status)
    throw new Error(
      `Source has modified or untracked font inputs. Restore them or use a clean checkout:\n${status}`,
    );
}

const pendingRepositories = new Map<string, Promise<void>>();

/** Download into a temporary checkout, then publish only a verified pinned revision. */
export async function ensureSourceRepository(source: string): Promise<void> {
  const directory = resolve(source);
  if (existsSync(directory)) return verifySourceRepository(directory);
  const pending = pendingRepositories.get(directory);
  if (pending) return pending;
  const work = (async () => {
    await mkdir(dirname(directory), { recursive: true });
    const staging = await mkdtemp(join(dirname(directory), ".pretendard-src-"));
    try {
      const child = Bun.spawn(
        [
          "git",
          "clone",
          "--depth",
          "1",
          "--branch",
          PRETENDARD_SOURCE.ref,
          PRETENDARD_SOURCE.repository,
          staging,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 180_000, killSignal: "SIGKILL" },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0)
        throw new Error(`Could not download the pinned Pretendard source: ${stderr.trim() || stdout.trim()}`);
      verifySourceRepository(staging);
      if (!existsSync(directory)) await rename(staging, directory);
      verifySourceRepository(directory);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  })();
  pendingRepositories.set(directory, work);
  try {
    await work;
  } finally {
    if (pendingRepositories.get(directory) === work) pendingRepositories.delete(directory);
  }
}

/** The same path/content sequence yields the same fingerprint on every platform. */
export function fingerprintSource(source: string, relativePaths: string[]): string {
  const hash = createHash("sha256");
  for (const path of [...relativePaths].sort()) {
    const content = readFileSync(join(source, path));
    hash.update(path).update("\0").update(String(content.byteLength)).update("\0").update(content);
  }
  return hash.digest("hex");
}
