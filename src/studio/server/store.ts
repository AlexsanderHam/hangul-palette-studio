import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultFontPalette, normalizeFontPalette } from "../../font/palette.ts";
import { decodeGlyphSource } from "../../font/source/document.ts";
import type { GlyphAssignments, GlyphGeometry } from "../../font/source/types.ts";
import { validateGlyphAssignment } from "../../font/source/validation.ts";
import { atomicWrite } from "../../shared/atomic-file.ts";
import type { LeaseInfo, StudioCommand, StudioSnapshot } from "../protocol.ts";

const HISTORY_LIMIT = 100;
const COMMAND_LIMIT = 256;
const BACKUP_LIMIT = 20;
const LEASE_MS = 45_000;
interface HistoryItem {
  label: string;
  palette: { before: string[]; after: string[] };
}

export interface ProjectFile {
  version: 1;
  projectId: string;
  rawDigest: string;
  baselineDigest: string;
  revision: number;
  fontPalette: string[];
  history: HistoryItem[];
  cursor: number;
  recentCommands: { id: string; digest: string }[];
  savedAt: string;
}

/** Immutable font source; palette revisions never change these compiler inputs. */
export interface FontSourceSnapshot {
  sourceId: string;
  raw: GlyphGeometry;
  classifications: GlyphAssignments;
}

export type PaletteSnapshot = Pick<StudioSnapshot, "projectId" | "revision" | "fontPalette" | "source">;

export interface StudioStoreOptions {
  dataPath: string;
  workspacePath: string;
  readOnly?: boolean;
  recover?: string;
  /** Allows deterministic fault injection without a second storage code path. */
  write?: typeof atomicWrite;
}

export class StudioError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "StudioError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function palettesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((color, index) => color === right[index]);
}

export class StudioStore {
  readonly raw: GlyphGeometry;
  readonly dataPath: string;
  readonly workspacePath: string;
  readonly readOnly: boolean;
  private state: ProjectFile;
  private readonly baseline: GlyphAssignments;
  private readonly glyphCount: number;
  private readonly statePath: string;
  private readonly writer: typeof atomicWrite;
  private readonly sourceFileDigest: string;
  private diskDigest: string;
  private processLock: Database | null = null;
  private uncertainWrite = false;
  private lease: LeaseInfo = { ownerId: null, expiresAt: null };
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private backupCache: StudioSnapshot["backups"] = [];

  private constructor(
    options: StudioStoreOptions,
    sourceText: string,
    raw: GlyphGeometry,
    baseline: GlyphAssignments,
    state: ProjectFile,
    glyphCount: number,
  ) {
    this.raw = raw;
    this.dataPath = resolve(options.dataPath);
    this.workspacePath = resolve(options.workspacePath);
    this.readOnly = options.readOnly ?? false;
    this.baseline = baseline;
    this.state = state;
    this.glyphCount = glyphCount;
    this.statePath = join(this.workspacePath, "project.json");
    this.writer = options.write ?? atomicWrite;
    this.sourceFileDigest = digest(sourceText);
    this.diskDigest = digest(JSON.stringify(state));
  }

  static async open(options: StudioStoreOptions): Promise<StudioStore> {
    const sourceText = await readFile(options.dataPath, "utf8");
    let decoded: ReturnType<typeof decodeGlyphSource>;
    try {
      decoded = decodeGlyphSource(JSON.parse(sourceText));
    } catch (error) {
      throw new StudioError("invalid_data", `글리프 데이터 형식을 확인하세요: ${(error as Error).message}`);
    }
    const { raw, classifications: baseline, rawText, baselineText } = decoded;
    const glyphs = new Map(raw.sets.flatMap((set) => set[2].map((glyph) => [glyph[0], glyph] as const)));
    const now = new Date().toISOString();
    const initial: ProjectFile = {
      version: 1,
      projectId: randomUUID(),
      rawDigest: digest(rawText),
      baselineDigest: digest(baselineText),
      revision: 0,
      fontPalette: defaultFontPalette(),
      history: [],
      cursor: 0,
      recentCommands: [],
      savedAt: now,
    };
    for (const [char, glyph] of glyphs) {
      const issues = validateGlyphAssignment(char, baseline[char], glyph[2].length);
      if (issues.length) throw new StudioError("invalid_data", `${char}: ${issues.join(", ")}`);
    }
    const store = new StudioStore(options, sourceText, raw, baseline, initial, glyphs.size);
    if (!store.readOnly) await store.acquireProcessLock();
    try {
      if (options.recover) {
        if (store.readOnly)
          throw new StudioError("read_only", "읽기 전용 모드에서는 복구할 수 없습니다.", 403);
        await store.recoverFile(options.recover);
      } else {
        try {
          const savedText = await readFile(store.statePath, "utf8");
          const saved: unknown = JSON.parse(savedText);
          store.state = store.validateProject(saved);
          store.diskDigest = digest(savedText);
          if (!store.readOnly) await store.writer(store.statePath, savedText);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new StudioError(
              "project_load_failed",
              `작업본을 열지 못했습니다: ${(error as Error).message}\n복구: bun run start -- --recover latest`,
            );
          }
          if (!store.readOnly) await store.writer(store.statePath, JSON.stringify(initial));
        }
      }
      await store.refreshBackups();
      return store;
    } catch (error) {
      await store.releaseProcessLock();
      throw error;
    }
  }

  /** Validate a current-format project without changing the open workspace. */
  validateProject(value: unknown): ProjectFile {
    if (record(value) && value.version !== 1) {
      throw new StudioError(
        "project_version",
        "현재 작업본은 version 1 형식만 지원합니다. 기존 파일은 변경하지 않았습니다. 별도 --workspace 경로를 지정해 새 작업본을 사용하세요.",
      );
    }
    if (
      !record(value) ||
      value.version !== 1 ||
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "projectId",
            "rawDigest",
            "baselineDigest",
            "revision",
            "fontPalette",
            "history",
            "cursor",
            "recentCommands",
            "savedAt",
          ].includes(key),
      ) ||
      !identifier(value.projectId) ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 ||
      !Array.isArray(value.history) ||
      value.history.length > HISTORY_LIMIT ||
      !Number.isInteger(value.cursor) ||
      (value.cursor as number) < 0 ||
      (value.cursor as number) > value.history.length ||
      !Array.isArray(value.recentCommands) ||
      value.recentCommands.length > COMMAND_LIMIT ||
      typeof value.savedAt !== "string" ||
      !Number.isFinite(Date.parse(value.savedAt))
    ) {
      throw new StudioError("invalid_project", "작업본 형식이 올바르지 않습니다.");
    }
    if (value.rawDigest !== this.state.rawDigest || value.baselineDigest !== this.state.baselineDigest) {
      throw new StudioError(
        "source_mismatch",
        "작업본의 원본 글리프 데이터가 달라졌습니다. 원본을 되돌리거나 다른 --workspace로 새 작업을 시작하세요.",
        409,
      );
    }
    let fontPalette: string[];
    try {
      fontPalette = normalizeFontPalette(value.fontPalette);
    } catch {
      throw new StudioError("invalid_project", "작업본의 폰트 색상이 올바르지 않습니다.");
    }
    let expectedPalette: string[] | undefined;
    let previousPalette: string[] | undefined;
    for (const [index, item] of value.history.entries()) {
      try {
        if (
          !record(item) ||
          Object.keys(item).some((key) => !["label", "palette"].includes(key)) ||
          typeof item.label !== "string" ||
          !record(item.palette) ||
          Object.keys(item.palette).some((key) => !["before", "after"].includes(key))
        )
          throw new Error("Invalid palette history");
        const before = normalizeFontPalette(item.palette.before);
        const after = normalizeFontPalette(item.palette.after);
        if (previousPalette && !palettesEqual(previousPalette, before))
          throw new Error("Disconnected palette history");
        if (index === 0 && value.cursor === 0) expectedPalette = before;
        if (index + 1 === value.cursor) expectedPalette = after;
        previousPalette = after;
      } catch {
        throw new StudioError("invalid_project", "변경 기록의 폰트 색상이 올바르지 않습니다.");
      }
    }
    if (expectedPalette && !palettesEqual(expectedPalette, fontPalette))
      throw new StudioError("invalid_project", "변경 기록과 현재 폰트 색상이 일치하지 않습니다.");
    const commandIds = new Set<string>();
    for (const command of value.recentCommands) {
      if (
        !record(command) ||
        !identifier(command.id) ||
        commandIds.has(command.id) ||
        typeof command.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(command.digest)
      ) {
        throw new StudioError("invalid_project", "저장 확인 기록이 올바르지 않습니다.");
      }
      commandIds.add(command.id);
    }
    return { ...value, fontPalette } as unknown as ProjectFile;
  }

  private async acquireProcessLock(): Promise<void> {
    await mkdir(this.workspacePath, { recursive: true });
    const lock = new Database(join(this.workspacePath, ".write-lock.sqlite"), { create: true });
    try {
      // SQLite owns the OS file lock. A crashed process cannot leave a stale
      // PID lock; no unsafe rename/delete based lock reclamation is needed.
      lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
      this.processLock = lock;
    } catch (error) {
      lock.close();
      if ((error as { code?: string }).code === "SQLITE_BUSY") {
        throw new StudioError(
          "workspace_locked",
          "이미 실행 중인 Studio가 작업본을 사용 중입니다. 해당 서버를 이용하거나 별도 --workspace를 지정하세요.",
          409,
        );
      }
      throw error;
    }
  }

  private async releaseProcessLock(): Promise<void> {
    this.processLock?.close();
    this.processLock = null;
  }

  leaseInfo(): LeaseInfo {
    if (this.lease.expiresAt !== null && this.lease.expiresAt <= Date.now())
      this.lease = { ownerId: null, expiresAt: null };
    return { ...this.lease };
  }

  claimLease(clientId: unknown, takeover = false): LeaseInfo {
    if (this.closed) throw new StudioError("closed", "Studio가 종료 중입니다.", 503);
    if (this.readOnly) throw new StudioError("read_only", "읽기 전용 Studio입니다.", 403);
    if (!identifier(clientId)) throw new StudioError("invalid_client", "잘못된 편집 세션입니다.");
    const lease = this.leaseInfo();
    if (lease.ownerId !== null && lease.ownerId !== clientId && !takeover) {
      throw new StudioError(
        "lease_conflict",
        "다른 탭에서 편집 중입니다. 편집 권한 가져오기를 사용하세요.",
        409,
      );
    }
    this.lease = { ownerId: clientId, expiresAt: Date.now() + LEASE_MS };
    return this.leaseInfo();
  }

  snapshot(): StudioSnapshot {
    return clone({
      projectId: this.state.projectId,
      readOnly: this.readOnly,
      saveConfirmed: !this.uncertainWrite,
      revision: this.state.revision,
      fontPalette: this.state.fontPalette,
      glyphCount: this.glyphCount,
      source: {
        rawDigest: this.state.rawDigest,
        baselineDigest: this.state.baselineDigest,
      },
      history: {
        canUndo: this.state.cursor > 0,
        canRedo: this.state.cursor < this.state.history.length,
        undoLabel: this.state.history[this.state.cursor - 1]?.label ?? null,
        redoLabel: this.state.history[this.state.cursor]?.label ?? null,
      },
      lease: this.leaseInfo(),
      backups: this.backupCache,
      savedAt: this.state.savedAt,
    });
  }

  get revision(): number {
    return this.state.revision;
  }
  get projectId(): string {
    return this.state.projectId;
  }
  get saveConfirmed(): boolean {
    return !this.uncertainWrite;
  }

  fontSourceSnapshot(): FontSourceSnapshot {
    return {
      sourceId: digest(JSON.stringify({ raw: this.state.rawDigest, assignments: this.state.baselineDigest })),
      raw: clone(this.raw),
      classifications: clone(this.baseline),
    };
  }

  async assertFontSourceUnchanged(): Promise<void> {
    if (this.closed) throw new StudioError("closed", "Studio가 종료되었습니다.", 503);
    await this.ensureSourceUnchanged();
  }

  /** Capture a confirmed saved palette for a package, independently of font preparation. */
  capturePalette(projectId: unknown, expectedRevision: unknown): Promise<PaletteSnapshot> {
    const action = this.queue.then(async () => {
      if (this.closed) throw new StudioError("closed", "Studio가 종료되었습니다.", 503);
      if (
        typeof projectId !== "string" ||
        typeof expectedRevision !== "number" ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      )
        throw new StudioError("invalid_export", "내보낼 작업본과 저장 버전을 확인하세요.");
      if (this.readOnly) await this.refreshReadOnly();
      if (projectId !== this.projectId)
        throw new StudioError(
          "project_conflict",
          "다른 작업본입니다. 최신 상태로 연결한 뒤 내보내세요.",
          409,
        );
      if (expectedRevision !== this.revision)
        throw new StudioError("revision_conflict", "작업본이 변경되었습니다. 최신 버전에서 내보내세요.", 409);
      if (!this.saveConfirmed)
        throw new StudioError("storage_error", "저장 완료를 확인한 뒤 내보내세요.", 503);
      if (this.readOnly) {
        await this.ensureSourceUnchanged();
      } else {
        await this.ensureUnchanged();
      }
      return clone({
        projectId: this.state.projectId,
        revision: this.state.revision,
        fontPalette: this.state.fontPalette,
        source: { rawDigest: this.state.rawDigest, baselineDigest: this.state.baselineDigest },
      });
    });
    this.queue = action.then(
      () => {},
      () => {},
    );
    return action;
  }

  execute(command: StudioCommand): Promise<StudioSnapshot> {
    const action = this.queue.then(() => this.apply(command));
    this.queue = action.then(
      () => {},
      () => {},
    );
    return action;
  }

  private async apply(command: StudioCommand): Promise<StudioSnapshot> {
    if (this.closed) throw new StudioError("closed", "Studio가 종료 중입니다.", 503);
    if (this.readOnly) throw new StudioError("read_only", "읽기 전용 Studio입니다.", 403);
    if (
      !record(command) ||
      !["palette", "undo", "redo", "restore"].includes(command.type) ||
      !identifier(command.commandId) ||
      !identifier(command.clientId) ||
      !Number.isSafeInteger(command.expectedRevision)
    )
      throw new StudioError("invalid_command", "잘못된 변경 요청입니다.");
    if (command.projectId !== this.state.projectId)
      throw new StudioError(
        "project_conflict",
        "다른 작업본의 변경 요청입니다. 작업 내용을 확인하고 다시 시도하세요.",
        409,
      );
    const commandDigest = digest(JSON.stringify(command));
    const previous = this.state.recentCommands.find((item) => item.id === command.commandId);
    if (previous) {
      if (previous.digest !== commandDigest)
        throw new StudioError("command_conflict", "같은 변경 ID를 다른 내용으로 사용할 수 없습니다.", 409);
      if (this.uncertainWrite) {
        try {
          await this.ensureUnchanged();
          await this.writer(this.statePath, JSON.stringify(this.state));
          this.uncertainWrite = false;
          await this.refreshBackups();
        } catch (error) {
          if (error instanceof StudioError) throw error;
          throw new StudioError(
            "storage_error",
            `저장 완료를 확인하지 못했습니다. 같은 변경으로 다시 시도하세요: ${(error as Error).message}`,
            503,
          );
        }
      }
      return this.snapshot();
    }
    if (this.leaseInfo().ownerId !== command.clientId)
      throw new StudioError("lease_conflict", "편집 권한이 없습니다. 다른 탭의 변경을 먼저 확인하세요.", 409);
    if (command.expectedRevision !== this.state.revision)
      throw new StudioError(
        "revision_conflict",
        "작업본이 변경되었습니다. 최신 상태를 확인한 뒤 다시 적용하세요.",
        409,
      );
    if (this.uncertainWrite) {
      await this.ensureUnchanged();
      try {
        await this.writer(this.statePath, JSON.stringify(this.state));
      } catch (error) {
        throw new StudioError(
          "storage_error",
          `이전 저장 완료를 확인하지 못했습니다: ${(error as Error).message}`,
          503,
        );
      }
      this.uncertainWrite = false;
    }
    const next = clone(this.state);
    let history: HistoryItem | null = null;
    if (command.type === "palette") {
      let colors: string[];
      try {
        colors = normalizeFontPalette(command.colors);
      } catch (error) {
        throw new StudioError("invalid_palette", (error as Error).message);
      }
      if (palettesEqual(colors, next.fontPalette)) return this.snapshot();
      history = {
        label: "폰트 색상 수정",
        palette: { before: clone(next.fontPalette), after: colors },
      };
      next.fontPalette = colors;
    } else if (command.type === "undo" || command.type === "redo") {
      const index = command.type === "undo" ? next.cursor - 1 : next.cursor;
      const item = next.history[index];
      if (!item) throw new StudioError("history_empty", "되돌릴 변경이 없습니다.");
      next.fontPalette = normalizeFontPalette(
        command.type === "undo" ? item.palette.before : item.palette.after,
      );
      next.cursor += command.type === "undo" ? -1 : 1;
    } else if (command.type === "restore") {
      const restored = await this.readBackup(command.backupId);
      if (palettesEqual(restored.fontPalette, next.fontPalette)) return this.snapshot();
      history = {
        label: "백업 색상 복원",
        palette: { before: clone(next.fontPalette), after: clone(restored.fontPalette) },
      };
      next.fontPalette = clone(restored.fontPalette);
    } else throw new StudioError("invalid_command", "지원하지 않는 변경 요청입니다.");
    if (history) {
      next.history = next.history.slice(0, next.cursor);
      next.history.push(history);
      if (next.history.length > HISTORY_LIMIT) next.history.shift();
      next.cursor = next.history.length;
    }
    next.revision++;
    next.savedAt = new Date().toISOString();
    next.recentCommands = [...next.recentCommands, { id: command.commandId, digest: commandDigest }].slice(
      -COMMAND_LIMIT,
    );
    await this.commit(next);
    this.lease.expiresAt = Date.now() + LEASE_MS;
    return this.snapshot();
  }

  private async ensureSourceUnchanged(): Promise<void> {
    if (digest(await readFile(this.dataPath, "utf8")) !== this.sourceFileDigest) {
      throw new StudioError(
        "source_mismatch",
        "원본 글리프 데이터가 실행 중 변경되었습니다. 서버를 다시 실행해 확인하세요.",
        409,
      );
    }
  }

  private async ensureUnchanged(): Promise<string> {
    await this.ensureSourceUnchanged();
    const currentBytes = await readFile(this.statePath, "utf8");
    if (digest(currentBytes) !== this.diskDigest) {
      throw new StudioError(
        "external_change",
        "작업본 파일이 Studio 밖에서 변경되었습니다. 서버를 다시 실행해 확인하세요.",
        409,
      );
    }
    return currentBytes;
  }

  private async commit(next: ProjectFile): Promise<void> {
    try {
      const currentBytes = await this.ensureUnchanged();
      const backupId = `r${this.state.revision}-${this.diskDigest.slice(0, 24)}`;
      await this.writer(join(this.workspacePath, "backups", `${backupId}.json`), currentBytes);
      const nextBytes = JSON.stringify(next);
      await this.writer(this.statePath, nextBytes);
      this.backupCache = [
        { id: backupId, revision: this.state.revision, savedAt: this.state.savedAt },
        ...this.backupCache.filter((backup) => backup.id !== backupId),
      ];
      this.state = next;
      this.diskDigest = digest(nextBytes);
      this.uncertainWrite = false;
      const stale = this.backupCache.slice(BACKUP_LIMIT);
      for (const item of stale)
        await unlink(join(this.workspacePath, "backups", `${item.id}.json`)).catch(() => {});
      this.backupCache = this.backupCache.slice(0, BACKUP_LIMIT);
    } catch (error) {
      if (error instanceof StudioError) throw error;
      // A filesystem may report failure after rename. Reconcile a committed
      // state before responding; retrying the same command remains idempotent.
      try {
        const saved = this.validateProject(JSON.parse(await readFile(this.statePath, "utf8")));
        if (saved.revision === next.revision && JSON.stringify(saved) === JSON.stringify(next)) {
          this.state = saved;
          this.diskDigest = digest(JSON.stringify(saved));
          this.uncertainWrite = true;
        }
      } catch {
        /* Preserve the last known-good in-memory state. */
      }
      throw new StudioError(
        "storage_error",
        `저장에 실패했습니다. 같은 변경을 다시 시도할 수 있습니다: ${(error as Error).message}`,
        503,
      );
    }
  }

  private async refreshBackups(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(join(this.workspacePath, "backups"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.backupCache = [];
        return;
      }
      throw error;
    }
    const found: StudioSnapshot["backups"] = [];
    for (const file of files) {
      if (!/^r\d+-[a-f0-9-]+\.json$/.test(file)) continue;
      try {
        const info = this.validateProject(
          JSON.parse(await readFile(join(this.workspacePath, "backups", file), "utf8")),
        );
        found.push({ id: file.slice(0, -5), revision: info.revision, savedAt: info.savedAt });
      } catch {
        /* Corrupt or unrelated backups are never offered for restore. */
      }
    }
    this.backupCache = found.sort((a, b) => b.revision - a.revision || b.savedAt.localeCompare(a.savedAt));
  }

  private async readBackup(id: unknown): Promise<ProjectFile> {
    if (typeof id !== "string" || !/^r\d+-[a-f0-9-]+$/.test(id))
      throw new StudioError("invalid_backup", "잘못된 백업입니다.");
    try {
      return this.validateProject(
        JSON.parse(await readFile(join(this.workspacePath, "backups", `${id}.json`), "utf8")),
      );
    } catch (error) {
      throw new StudioError("invalid_backup", `백업을 읽지 못했습니다: ${(error as Error).message}`);
    }
  }

  private async recoverFile(id: string): Promise<void> {
    await this.refreshBackups();
    const selected = id === "latest" ? this.backupCache[0]?.id : id;
    if (!selected) throw new StudioError("backup_missing", "복구 가능한 백업이 없습니다.");
    const restored = clone(await this.readBackup(selected));
    try {
      const damaged = await readFile(this.statePath, "utf8");
      await atomicWrite(join(this.workspacePath, `damaged-${Date.now()}-${randomUUID()}.json`), damaged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // New identity prevents an old tab's unacknowledged command from replaying.
    restored.projectId = randomUUID();
    restored.revision++;
    restored.recentCommands = [];
    restored.savedAt = new Date().toISOString();
    await this.writer(this.statePath, JSON.stringify(restored));
    this.state = restored;
    this.diskDigest = digest(JSON.stringify(restored));
  }

  /** A read-only second server may observe the writable server's atomic saves. */
  async refreshReadOnly(): Promise<void> {
    if (!this.readOnly) return;
    try {
      const bytes = await readFile(this.statePath, "utf8");
      if (digest(bytes) !== this.diskDigest) {
        this.state = this.validateProject(JSON.parse(bytes));
        this.diskDigest = digest(bytes);
        await this.refreshBackups();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.releaseProcessLock();
  }
}
