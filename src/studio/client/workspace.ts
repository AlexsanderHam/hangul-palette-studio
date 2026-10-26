/** Durable palette commands, browser recovery, and the single-tab editing lease. */
import type {
  LeaseInfo,
  ProjectResponse,
  SessionResponse,
  StudioCommand,
  StudioErrorResponse,
  StudioSnapshot,
} from "../protocol.ts";
import { announce, el, node, readSessionValue, removeSessionValue, writeSessionValue } from "./browser.ts";

export type SaveState =
  | "loading"
  | "saved"
  | "saving"
  | "failed"
  | "conflict"
  | "offline"
  | "read-only"
  | "unconfirmed";
export type WorkspaceAction =
  | { type: "palette"; colors: string[] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "restore"; backupId: string };
export interface PendingChange {
  command: StudioCommand;
  needsRebase: boolean;
}
interface DraftState {
  dirty: boolean;
  invalid: boolean;
}
interface WorkspaceOptions {
  draftState(): DraftState;
  onSnapshot(next: StudioSnapshot, previous: StudioSnapshot | null): void;
  onDiscard(): void;
  onSettled(): void;
  onConnected(): void;
  onChange(): void;
}
export interface WorkspaceController {
  readonly snapshot: StudioSnapshot | null;
  readonly token: string;
  readonly online: boolean;
  readonly sending: boolean;
  readonly pending: PendingChange | null;
  readonly status: SaveState;
  ownsLease(): boolean;
  canEdit(): boolean;
  canExport(): boolean;
  request<T>(path: string, options?: RequestInit, authenticated?: boolean): Promise<T>;
  applySnapshot(next: StudioSnapshot): void;
  dispatch(action: WorkspaceAction): Promise<void>;
  render(): void;
  start(): Promise<void>;
}
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public response: StudioErrorResponse,
  ) {
    super(response.error.message);
  }
}
const SAVE_LABELS: Record<SaveState, string> = {
  loading: "연결 중",
  saved: "저장됨",
  saving: "저장 중…",
  failed: "저장 실패 · 변경 보류",
  conflict: "변경 충돌 · 확인 필요",
  offline: "오프라인 · 편집 중지",
  "read-only": "읽기 전용",
  unconfirmed: "저장 확인 필요",
};
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
]);

export function createWorkspace(options: WorkspaceOptions): WorkspaceController {
  let snapshot: StudioSnapshot | null = null;
  let token = "";
  let status: SaveState = "loading";
  let statusMessage = "";
  let online = false;
  let sending = false;
  let polling = false;
  let leasing = false;
  let reconnecting: Promise<void> | null = null;
  let pending: PendingChange | null = null;
  function applySnapshot(next: StudioSnapshot): void {
    const previous = snapshot;
    snapshot = next;
    options.onSnapshot(next, previous);
    options.onChange();
  }

  function makeClientId(): string {
    const previous = readSessionValue("client");
    if (previous) return previous;
    const id = crypto.randomUUID();
    writeSessionValue("client", id);
    return id;
  }

  function ownsLease(): boolean {
    const lease = snapshot?.lease;
    return Boolean(lease?.ownerId === clientId && (lease.expiresAt ?? 0) > Date.now());
  }

  function canEdit(): boolean {
    return Boolean(snapshot && !snapshot.readOnly && online && ownsLease() && !pending && !sending);
  }

  function canExport(): boolean {
    return Boolean(
      snapshot &&
        snapshot.saveConfirmed !== false &&
        online &&
        !sending &&
        !pending &&
        !options.draftState().dirty &&
        !options.draftState().invalid,
    );
  }

  function applyLease(lease: LeaseInfo): void {
    if (snapshot) snapshot.lease = lease;
    options.onChange();
  }

  function setState(next: SaveState, message = ""): void {
    status = next;
    statusMessage = message;
    options.onChange();
  }

  function settleState(): void {
    if (!online) {
      setState("offline", statusMessage || "서버와 연결되지 않았습니다.");
      return;
    }
    if (pending) {
      if (pending.command.projectId !== snapshot?.projectId) {
        setState("conflict", "보류 변경은 다른 작업본에 속합니다. 내용을 확인한 뒤 버려 주세요.");
        return;
      }
      setState(pending.needsRebase ? "conflict" : "failed", statusMessage);
      return;
    }
    if (snapshot?.saveConfirmed === false) {
      setState("unconfirmed");
      return;
    }
    setState(ownsLease() && !snapshot?.readOnly ? "saved" : "read-only");
  }

  function pendingSummary(): string {
    if (!pending) return "";
    const command = pending.command;
    if (command.type === "palette") return "폰트 색상 변경";
    return { undo: "실행 취소", redo: "다시 실행", restore: "백업 복원" }[command.type];
  }

  function renderConnection(): void {
    const draft = options.draftState();
    const localState = status === "saved" ? (draft.invalid ? "invalid" : draft.dirty ? "draft" : null) : null;
    el("sync-status").dataset.state = localState ?? status;
    el("sync-label").textContent =
      localState === "invalid"
        ? "색상 확인 필요"
        : localState === "draft"
          ? "미저장 변경"
          : SAVE_LABELS[status];
    el("revision-label").textContent = snapshot
      ? `REV ${String(snapshot.revision).padStart(4, "0")}`
      : "REV —";
    const exceptional = !["saved", "loading", "saving"].includes(status);
    let title = "";
    let detail = statusMessage;
    if (status === "read-only") {
      title = snapshot?.readOnly ? "읽기 전용으로 실행 중입니다" : "다른 탭에서 편집 중입니다";
      detail = snapshot?.readOnly
        ? "미리보기와 다운로드는 가능합니다. 편집하려면 읽기 전용 옵션 없이 서버를 실행하세요."
        : "미리보기와 다운로드는 가능합니다. 편집하려면 이 탭으로 권한을 가져오세요.";
    } else if (status === "offline") {
      title = "서버에 연결할 수 없습니다";
      detail = pending
        ? `${pendingSummary()}이 보류되어 있습니다. 서버를 다시 실행한 뒤 재시도하세요.`
        : "미리보기를 살펴볼 수 있습니다. 연결을 복구하면 다시 편집할 수 있습니다.";
    } else if (status === "conflict") {
      title = "작업본이 변경되었습니다";
      detail ||= pending
        ? `${pendingSummary()}이 보류되어 있습니다. 최신 작업본과 비교한 뒤 다시 적용하거나 버리세요.`
        : "최신 작업본을 불러왔습니다.";
      if (pending?.needsRebase && pending.command.type !== "palette") {
        detail = `${pendingSummary()}의 대상이 달라졌습니다. 보류 변경을 버린 뒤 최신 화면에서 다시 실행하세요.`;
      }
    } else if (status === "unconfirmed") {
      title = "저장 완료를 확인하지 못했습니다";
      detail = "현재 작업본을 표시하고 있습니다. 다음 변경을 저장할 때 이전 저장 상태도 함께 확인합니다.";
    } else if (status === "failed") {
      title = pending ? `${pendingSummary()} 저장 실패` : "작업을 완료하지 못했습니다";
      detail ||= "변경은 보류되어 있습니다. 원인을 해결한 뒤 다시 시도하세요.";
    }
    el("connection-banner").hidden = !exceptional;
    el("connection-title").textContent = title;
    el("connection-detail").textContent = detail;
    const retry = el<HTMLButtonElement>("retry-btn");
    retry.hidden =
      !["offline", "failed", "conflict"].includes(status) ||
      Boolean(pending?.needsRebase && pending.command.type !== "palette" && online);
    retry.disabled =
      sending ||
      Boolean(pending && online && !ownsLease()) ||
      Boolean(pending && snapshot && pending.command.projectId !== snapshot.projectId);
    retry.textContent = pending?.needsRebase ? "변경 다시 적용" : "다시 시도";
    el("discard-btn").hidden = !pending;
    el<HTMLButtonElement>("discard-btn").disabled = sending;
    el("takeover-btn").hidden = !online || ownsLease() || !snapshot || snapshot.readOnly;
    el<HTMLButtonElement>("takeover-btn").disabled = sending || leasing;
  }

  function renderHistory(): void {
    const draft = options.draftState();
    el<HTMLButtonElement>("undo-btn").disabled =
      !canEdit() || draft.dirty || draft.invalid || !snapshot?.history.canUndo;
    el<HTMLButtonElement>("redo-btn").disabled =
      !canEdit() || draft.dirty || draft.invalid || !snapshot?.history.canRedo;
    el("undo-btn").title =
      `실행 취소 · Ctrl/⌘ Z${snapshot?.history.undoLabel ? ` · ${snapshot.history.undoLabel}` : ""}`;
    el("redo-btn").title =
      `다시 실행 · Ctrl/⌘ Shift Z${snapshot?.history.redoLabel ? ` · ${snapshot.history.redoLabel}` : ""}`;
    el<HTMLButtonElement>("backup-btn").disabled = !snapshot?.backups.length;
    el<HTMLButtonElement>("restore-btn").disabled =
      !canEdit() ||
      draft.dirty ||
      draft.invalid ||
      !el<HTMLInputElement>("backup-confirm").checked ||
      !el<HTMLSelectElement>("backup-select").value;
    el("backup-message").textContent = draft.invalid
      ? "잘못된 HEX 색상을 수정한 뒤 복원하세요."
      : draft.dirty
        ? "색상 변경을 저장한 뒤 복원하세요."
        : !canEdit()
          ? "복원하려면 서버 연결과 이 탭의 편집 권한이 필요합니다."
          : "";
  }

  async function request<T>(path: string, options: RequestInit = {}, authenticated = true): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = new Headers(options.headers);
      if (authenticated) headers.set("X-Studio-Token", token);
      if (options.body) headers.set("Content-Type", "application/json");
      const response = await fetch(path, {
        ...options,
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        let error: StudioErrorResponse;
        try {
          error = (await response.json()) as StudioErrorResponse;
        } catch {
          error = { error: { code: "http-error", message: `서버 응답 오류 (${response.status})` } };
        }
        throw new ApiError(response.status, error);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  function savePending(): void {
    if (pending) {
      if (!writeSessionValue("pending", JSON.stringify(pending)))
        announce("브라우저 저장소를 사용할 수 없습니다. 보류 변경이 있다면 이 탭을 닫지 마세요.");
    } else removeSessionValue("pending");
  }

  function loadPending(): void {
    const value = readSessionValue("pending");
    if (!value) return;
    try {
      const parsed = JSON.parse(value) as PendingChange;
      if (
        !parsed.command ||
        typeof parsed.command.commandId !== "string" ||
        typeof parsed.command.projectId !== "string" ||
        !["palette", "undo", "redo", "restore"].includes(parsed.command.type)
      )
        throw new Error("Invalid pending command");
      pending = parsed;
    } catch {
      removeSessionValue("pending");
      announce("읽을 수 없는 보류 변경 정보가 있습니다. 서버의 저장된 작업본을 표시합니다.");
    }
  }

  async function dispatch(action: WorkspaceAction): Promise<void> {
    if (!canEdit() || !snapshot) return;
    if (action.type !== "palette" && (options.draftState().dirty || options.draftState().invalid)) return;
    pending = {
      command: {
        ...action,
        clientId,
        expectedRevision: snapshot.revision,
        projectId: snapshot.projectId,
        commandId: crypto.randomUUID(),
      },
      needsRebase: false,
    };
    savePending();
    await sendPending();
  }

  async function sendPending(): Promise<void> {
    if (!pending || sending || !snapshot || pending.command.projectId !== snapshot.projectId) return;
    if (!ownsLease()) return settleState();
    sending = true;
    setState("saving");
    const active = pending;
    try {
      const result = await request<{ snapshot: StudioSnapshot }>("/api/command", {
        method: "POST",
        body: JSON.stringify(active.command),
      });
      pending = null;
      savePending();
      online = true;
      applySnapshot(result.snapshot);
      if (active.command.type === "restore")
        announce("백업을 새 작업본으로 복원했습니다. 실행 취소할 수 있습니다.");
    } catch (error) {
      if (error instanceof ApiError) {
        online = true;
        if (error.response.snapshot) applySnapshot(error.response.snapshot);
        if (error.statusCode === 409 || error.statusCode === 412) {
          active.needsRebase = true;
          savePending();
          setState("conflict", error.message);
        } else if (error.statusCode === 401 || error.statusCode === 403) {
          online = false;
          setState("offline", "서버 연결 정보가 만료되었습니다. 다시 시도하면 연결을 갱신합니다.");
        } else {
          setState("failed", error.message);
        }
      } else {
        online = false;
        setState("offline");
      }
    } finally {
      sending = false;
      if (!pending) settleState();
      options.onChange();
      options.onSettled();
    }
  }

  async function acquireLease(takeover = false): Promise<void> {
    if (leasing || !snapshot || snapshot.readOnly || !online) return;
    leasing = true;
    renderConnection();
    try {
      const result = await request<{ lease: LeaseInfo }>("/api/lease", {
        method: "POST",
        body: JSON.stringify({ clientId, takeover }),
      });
      applyLease(result.lease);
      if (!sending) settleState();
      options.onSettled();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.response.snapshot) applySnapshot(error.response.snapshot);
        setState(error.statusCode === 409 ? "read-only" : "failed", error.message);
      } else {
        online = false;
        setState("offline");
      }
    } finally {
      leasing = false;
      options.onChange();
    }
  }

  function reconnect(): Promise<void> {
    if (reconnecting) return reconnecting;
    // Register the shared work before callbacks run, through lease acquisition.
    const work = Promise.resolve()
      .then(async () => {
        setState("loading");
        try {
          const result = await request<SessionResponse>("/api/session", {}, false);
          token = result.token;
          online = true;
          applySnapshot(result.snapshot);
          await acquireLease();
          settleState();
          options.onConnected();
        } catch (error) {
          online = false;
          setState("offline", error instanceof Error ? error.message : "연결할 수 없습니다.");
        }
      })
      .finally(() => {
        if (reconnecting === work) reconnecting = null;
      });
    reconnecting = work;
    return work;
  }

  async function retry(): Promise<void> {
    if (sending) return;
    if (reconnecting || !online) await reconnect();
    if (!online || !pending || !snapshot) return settleState();
    if (pending.command.projectId !== snapshot.projectId || !ownsLease()) return settleState();
    if (pending.needsRebase) {
      // History targets and whole-project restoration must be chosen again from fresh UI.
      if (pending.command.type !== "palette") {
        settleState();
        return;
      }
      pending.command = {
        ...pending.command,
        commandId: crypto.randomUUID(),
        expectedRevision: snapshot.revision,
        clientId,
      };
      pending.needsRebase = false;
      savePending();
    }
    await sendPending();
  }

  async function poll(): Promise<void> {
    if (polling || sending || reconnecting) return;
    polling = true;
    const observedProject = snapshot?.projectId;
    const observedRevision = snapshot?.revision;
    const superseded = () =>
      sending || snapshot?.projectId !== observedProject || snapshot?.revision !== observedRevision;
    try {
      if (!online) {
        await reconnect();
        return;
      }
      const response = await request<ProjectResponse>(
        `/api/project?revision=${snapshot?.revision ?? -1}&projectId=${encodeURIComponent(snapshot?.projectId ?? "")}`,
      );
      if (superseded()) return;
      online = true;
      if (response.snapshot) {
        applySnapshot(response.snapshot);
      }
      if (snapshot) snapshot.saveConfirmed = response.saveConfirmed;
      applyLease(response.lease);
      if (!pending) settleState();
    } catch (error) {
      if (superseded()) return;
      if (error instanceof ApiError && [401, 403].includes(error.statusCode)) {
        online = false;
        await reconnect();
      } else {
        online = false;
        setState("offline");
      }
    } finally {
      polling = false;
    }
  }

  function openBackups(): void {
    if (!snapshot) return;
    el<HTMLDialogElement>("workspace-info-dialog").close();
    const select = el<HTMLSelectElement>("backup-select");
    select.replaceChildren();
    for (const backup of snapshot.backups) {
      const option = node(
        "option",
        "",
        `REV ${backup.revision} · ${new Date(backup.savedAt).toLocaleString("ko-KR")}`,
      );
      option.value = backup.id;
      select.append(option);
    }
    el<HTMLInputElement>("backup-confirm").checked = false;
    renderBackupPreview();
    el<HTMLDialogElement>("backup-dialog").showModal();
  }

  function renderBackupPreview(): void {
    const id = el<HTMLSelectElement>("backup-select").value;
    const backup = snapshot?.backups.find((candidate) => candidate.id === id);
    el("backup-preview").textContent = backup
      ? `백업 ID  ${backup.id}\n작업본 버전  REV ${backup.revision}\n저장 시각  ${new Date(backup.savedAt).toLocaleString("ko-KR")}\n현재 버전  REV ${snapshot?.revision}`
      : "복원할 수 있는 백업이 없습니다.";
    renderHistory();
  }

  async function initialize(): Promise<void> {
    loadPending();
    await reconnect();
    if (pending) announce("이전 세션의 보류 변경을 찾았습니다. 내용을 확인하고 다시 시도하거나 버려 주세요.");
  }

  function retryConnection(): void {
    void retry();
  }

  function discardPending(): void {
    if (sending) return;
    pending = null;
    savePending();
    options.onDiscard();
    settleState();
    announce("보류 변경을 버렸습니다. 서버에 저장된 작업본을 유지합니다.");
  }

  const clientId = makeClientId();

  el("undo-btn").addEventListener("click", () => void dispatch({ type: "undo" }));
  el("redo-btn").addEventListener("click", () => void dispatch({ type: "redo" }));
  el("retry-btn").addEventListener("click", retryConnection);
  el("discard-btn").addEventListener("click", discardPending);
  el("takeover-btn").addEventListener("click", () => void acquireLease(true));
  el("backup-btn").addEventListener("click", openBackups);
  el("workspace-info-btn").addEventListener("click", () =>
    el<HTMLDialogElement>("workspace-info-dialog").showModal(),
  );
  el("backup-select").addEventListener("change", renderBackupPreview);
  el("backup-confirm").addEventListener("change", options.onChange);
  el("restore-btn").addEventListener("click", () => {
    const backupId = el<HTMLSelectElement>("backup-select").value;
    if (
      !canEdit() ||
      options.draftState().dirty ||
      options.draftState().invalid ||
      !backupId ||
      !el<HTMLInputElement>("backup-confirm").checked
    )
      return;
    el<HTMLDialogElement>("backup-dialog").close();
    void dispatch({ type: "restore", backupId });
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.isComposing ||
      event.repeat ||
      !snapshot ||
      event.altKey ||
      document.querySelector("dialog[open]")
    )
      return;
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest<HTMLElement>("[contenteditable]")?.isContentEditable) return;
      const field = target.closest<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
      if (field && (field.tagName === "TEXTAREA" || !NON_TEXT_INPUT_TYPES.has(field.type))) return;
    }
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
      event.preventDefault();
      if (event.shiftKey ? snapshot.history.canRedo : snapshot.history.canUndo)
        void dispatch({ type: event.shiftKey ? "redo" : "undo" });
    }
  });

  window.addEventListener("online", () => void poll());
  window.addEventListener("offline", () => {
    online = false;
    setState("offline");
  });
  window.addEventListener("beforeunload", (event) => {
    const draft = options.draftState();
    if (!pending && !draft.dirty && !draft.invalid) return;
    event.preventDefault();
    event.returnValue = "";
  });

  return {
    get snapshot() {
      return snapshot;
    },
    get token() {
      return token;
    },
    get online() {
      return online;
    },
    get sending() {
      return sending;
    },
    get pending() {
      return pending;
    },
    get status() {
      return status;
    },
    ownsLease,
    canEdit,
    canExport,
    request,
    applySnapshot,
    dispatch,
    render() {
      renderConnection();
      renderHistory();
    },
    async start() {
      setInterval(() => void poll(), 3000);
      setInterval(() => {
        if (online && ownsLease() && !sending) void acquireLease();
      }, 10000);
      await initialize();
    },
  };
}
