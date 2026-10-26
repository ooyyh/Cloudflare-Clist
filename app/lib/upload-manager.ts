/**
 * 上传任务管理器（模块级单例，独立于 React 生命周期）
 *
 * - 多文件并发上传：全局并发池（同时 3 个文件任务），每个分片任务内部再并发分片
 * - 断点续传：分片任务的 uploadId + 已完成分片持久化到 localStorage，
 *   沿用后端 multipart-init / multipart-urls / multipart-upload / multipart-complete / multipart-abort
 * - 网络自愈：分片级自动重试（指数退避）+ 停滞检测（长时间无进度自动断开重传），
 *   网络卡死恢复后任务自动继续，不影响其他在跑任务
 * - 刷新恢复：拖拽上传的文件通过 getAsFileSystemHandle 保留句柄（存 IndexedDB），
 *   刷新后一键授权续传；input/粘贴的文件刷新后按 名字+大小 重新匹配续传
 * - 跨标签页：heartbeat + storage 事件，只读展示其他标签页正在跑的任务
 */
import { apiFileUrl } from "~/lib/api-path";

export type UploadTaskStatus =
  | "queued"       // 排队等待并发槽位
  | "uploading"    // 上传中
  | "paused"       // 用户暂停（分片进度已保存）
  | "error"        // 失败（可重试）
  | "done"         // 完成
  | "interrupted"  // 刷新/断开导致中断，已存文件句柄，可一键恢复
  | "waiting-file" // 刷新/断开导致中断，需要重新选择文件
  | "checking"     // 启动时检测中（判断是否其他标签页在跑）
  | "remote";      // 其他标签页正在上传（只读展示）

export interface UploadTaskPart {
  partNumber: number;
  etag: string;
}

export interface UploadTask {
  id: string;
  name: string;
  size: number;
  storageId: number;
  dirPath: string;    // 目标目录
  uploadPath: string; // dirPath + 文件名
  contentType: string;
  chunkSize: number;
  mode: "single" | "multipart";
  status: UploadTaskStatus;
  progress: number;   // 0-100
  loaded: number;     // 已上传字节
  speed: number;      // bytes/s（滑动窗口）
  currentPart: number;
  totalParts: number;
  error?: string;
  addedAt: number;
  finishedAt?: number;
  hasHandle: boolean; // 是否保留了文件句柄（可自动恢复）
}

export interface EnqueueEntry {
  file: File;
  handle?: FileSystemFileHandle;
}

export interface EnqueueOptions {
  storageId: number;
  path: string;
  chunkSize: number;
  multipartSupported: boolean;
}

export type ResumeResult = "started" | "need-file" | "denied" | "mismatch" | "missing";

interface InternalTask {
  meta: UploadTask;
  file: File | null;
  handle: FileSystemFileHandle | null;
  xhrs: Set<XMLHttpRequest>;
  partProgress: Record<number, number>; // 分片号 -> 已传字节（在途）
  samples: Array<{ t: number; loaded: number }>;
  ctrl: { paused: boolean; canceled: boolean };
  cleanupTimer?: ReturnType<typeof setTimeout>;
  // 分片上传状态（不进 UI 快照）
  uploadId?: string;
  completedParts?: UploadTaskPart[];
  useDirectUpload?: boolean;
}

interface PersistedTask {
  id: string;
  name: string;
  size: number;
  storageId: number;
  dirPath: string;
  uploadPath: string;
  contentType: string;
  chunkSize: number;
  mode: "single" | "multipart";
  status: string;
  uploadId?: string;
  completedParts?: UploadTaskPart[];
  useDirectUpload?: boolean;
  hasHandle: boolean;
  addedAt: number;
  finishedAt?: number;
  error?: string;
}

interface PersistedStore {
  version: 1;
  heartbeat: number;
  /** 页面卸载时写入。若仍存在且 heartbeat <= unloadedAt，说明此后没有其他标签页写过心跳，
   *  即可断定上次是"刷新/关闭"而非"另一个标签页仍在传"，从而立即判定为可恢复（无需等待检测）。 */
  unloadedAt?: number;
  tasks: PersistedTask[];
}

// ----- 常量 -----
const STORE_KEY = "clist-uploads-v1";
const LEGACY_KEY_PREFIX = "multipart_";
const MAX_ACTIVE_FILES = 3;          // 同时上传的文件数
const DIRECT_PART_CONCURRENCY = 5;   // 直传 S3 时单文件并发分片数
const PROXY_PART_CONCURRENCY = 3;    // 走 Worker 代理时单文件并发分片数
const PART_RETRIES = 12;             // 分片失败重试次数（指数退避，断网窗口约 4 分钟）
const SINGLE_RETRIES = 6;            // 小文件整体重试次数
const STALL_TIMEOUT_MS = 30_000;     // 分片无进度判定卡死
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 8_000;    // 活跃页每 5s 心跳，超过 8s 无心跳 → 认为上传页面已死
// 必须大于 HEARTBEAT_STALE_MS：保证单页刷新场景复查时心跳必然已过期（判为可恢复），
// 而真有另一标签页在跑时对方心跳 ≤5s（判为 remote 只读展示）
const REMOTE_CHECK_DELAY_MS = 10_000;
const REMOTE_STUCK_MS = 20_000;      // remote/checking 任务兜底：心跳超过此时长无更新 → 转为可恢复
const DONE_AUTO_CLEAR_MS = 60_000;

// ----- 带停滞检测的 XHR 上传 -----
function uploadXhr(
  url: string,
  body: Blob,
  xhrs: Set<XMLHttpRequest>,
  onProgress: (loaded: number) => void,
): Promise<{ etag: string; responseText: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrs.add(xhr);
    const detach = () => xhrs.delete(xhr);
    let stalled = false;
    let stallTimer = setTimeout(() => { stalled = true; try { xhr.abort(); } catch { /* ignore */ } }, STALL_TIMEOUT_MS);
    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; try { xhr.abort(); } catch { /* ignore */ } }, STALL_TIMEOUT_MS);
    };

    xhr.upload.onprogress = (event) => {
      resetStall();
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      clearTimeout(stallTimer);
      detach();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ etag: xhr.getResponseHeader("ETag")?.replace(/"/g, "") || "", responseText: xhr.responseText });
      } else {
        reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText.slice(0, 200)}`));
      }
    };
    xhr.onerror = () => { clearTimeout(stallTimer); detach(); reject(new Error(stalled ? "连接停滞，已断开待重试" : "网络错误")); };
    xhr.onabort = () => { clearTimeout(stallTimer); detach(); reject(new Error("已中断")); };

    xhr.open("PUT", url);
    xhr.send(body);
  });
}

// ----- IndexedDB 文件句柄存储 -----
let idbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("clist-uploads", 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("handles"); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}
async function idbRun<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await idb();
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction("handles", mode);
      const req = fn(tx.objectStore("handles"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch { return undefined; }
}
const idbPutHandle = (id: string, handle: FileSystemFileHandle) => idbRun("readwrite", (s) => s.put(handle, id));
const idbGetHandle = (id: string) => idbRun("readonly", (s) => s.get(id) as IDBRequest<FileSystemFileHandle | undefined>);
const idbDeleteHandle = (id: string) => idbRun("readwrite", (s) => s.delete(id));

interface PermissionCapableHandle {
  queryPermission?: (desc?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (desc?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
}

// ----- 上传管理器 -----
class UploadManager {
  private tasks = new Map<string, InternalTask>();
  private listeners = new Set<() => void>();
  private finishCbs = new Set<(task: UploadTask) => void>();
  private snapshot: UploadTask[] = [];
  private activeCount = 0;
  private idCounter = 0;
  private initialized = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private unloading = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  // ===== React 外部存储接口 =====
  subscribe = (fn: () => void): (() => void) => {
    this.ensureInit();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): UploadTask[] => {
    this.ensureInit();
    return this.snapshot;
  };

  onFinish = (cb: (task: UploadTask) => void): (() => void) => {
    this.finishCbs.add(cb);
    return () => this.finishCbs.delete(cb);
  };

  private notify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.snapshot = Array.from(this.tasks.values()).map((t) => t.meta);
      for (const fn of this.listeners) fn();
      // 存在待判定/远端任务时启动看门狗，防止误判后死锁在只读状态
      for (const t of this.tasks.values()) {
        if (t.meta.status === "checking" || t.meta.status === "remote") { this.startWatchdog(); break; }
      }
    }, 60);
  }

  /** 兜底看门狗：remote/checking 任务的心跳长期不更新（上传页被杀/误判）→ 转为可恢复 */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      let hasPending = false;
      for (const t of this.tasks.values()) {
        if (t.meta.status === "remote" || t.meta.status === "checking") { hasPending = true; break; }
      }
      if (!hasPending) {
        if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
        return;
      }
      const data = this.readStore();
      if (data && Date.now() - data.heartbeat <= REMOTE_STUCK_MS) return; // 上传页还活着
      let changed = false;
      for (const t of this.tasks.values()) {
        if (t.meta.status === "remote" || t.meta.status === "checking") {
          this.markInterrupted(t);
          changed = true;
        }
      }
      if (changed) this.notify();
    }, 5_000);
  }

  // ===== 初始化：恢复持久化任务 + 跨标签页监听 =====
  private ensureInit(): void {
    if (this.initialized || typeof window === "undefined") return;
    this.initialized = true;

    const data = this.readStore();
    const now = Date.now();
    // 上次是干净卸载（刷新/关闭）且之后没有其他标签页写过心跳 → 立即判定为可恢复，无需等检测
    const cleanUnload = !!data?.unloadedAt && now - data.unloadedAt < 60_000 && data.heartbeat <= data.unloadedAt;
    const heartbeatFresh = !!data && !cleanUnload && now - data.heartbeat < HEARTBEAT_STALE_MS;

    for (const pt of data?.tasks ?? []) {
      const internal = this.reviveTask(pt);
      if (!internal) continue;

      if (pt.status === "uploading" || pt.status === "queued") {
        if (cleanUnload) {
          this.markInterrupted(internal);
        } else if (heartbeatFresh) {
          // 可能是另一个标签页在跑：延迟复查心跳，期间显示"检测中"
          internal.meta.status = "checking";
          const id = internal.meta.id;
          setTimeout(() => this.recheckRemote(id), REMOTE_CHECK_DELAY_MS);
        } else {
          this.markInterrupted(internal);
        }
      } else if (pt.status === "paused" || pt.status === "error") {
        // 刷新后 File 引用丢失，需要重新选择文件（保留错误信息）
        internal.meta.status = "waiting-file";
      } else if (pt.status === "done") {
        this.scheduleDoneCleanup(internal);
      }
      this.tasks.set(pt.id, internal);
    }

    window.addEventListener("storage", (e) => { if (e.key === STORE_KEY) this.onStorageEvent(); });
    // 刷新/关闭页面前落盘：避免卸载时在途请求被中断而把任务误写成 error
    const onLeave = () => this.onPageHide();
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("pagehide", onLeave);
    this.snapshot = Array.from(this.tasks.values()).map((t) => t.meta);
  }

  /** 页面卸载：把进行中的任务定格为"上传中"，并写入卸载标记，下次加载可立即恢复 */
  private onPageHide(): void {
    this.unloading = true;
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.meta.status === "uploading" || t.meta.status === "queued") {
        t.meta.status = "uploading";
        t.meta.error = undefined;
        changed = true;
      }
    }
    if (!changed) return;
    const now = Date.now();
    const tasks = Array.from(this.tasks.values()).map((t) => this.serialize(t));
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, heartbeat: now, unloadedAt: now, tasks } satisfies PersistedStore));
    } catch { /* 配额满：忽略 */ }
  }

  private reviveTask(pt: PersistedTask): InternalTask | null {
    if (!pt.id || !pt.uploadPath || !pt.size || !pt.chunkSize) return null;
    const totalParts = pt.mode === "multipart" ? Math.ceil(pt.size / pt.chunkSize) : 1;
    const loaded = this.completedBytes(pt);
    return {
      meta: {
        id: pt.id,
        name: pt.name,
        size: pt.size,
        storageId: pt.storageId,
        dirPath: pt.dirPath,
        uploadPath: pt.uploadPath,
        contentType: pt.contentType,
        chunkSize: pt.chunkSize,
        mode: pt.mode,
        status: pt.status as UploadTaskStatus,
        progress: pt.status === "done" ? 100 : Math.min(99, Math.round((loaded / pt.size) * 100)),
        loaded,
        speed: 0,
        currentPart: pt.completedParts?.length ?? 0,
        totalParts,
        error: pt.error,
        addedAt: pt.addedAt,
        finishedAt: pt.finishedAt,
        hasHandle: pt.hasHandle,
      },
      file: null,
      handle: null,
      xhrs: new Set(),
      partProgress: {},
      samples: [],
      ctrl: { paused: false, canceled: false },
      uploadId: pt.uploadId,
      completedParts: pt.completedParts,
      useDirectUpload: pt.useDirectUpload ?? true,
    };
  }

  private markInterrupted(internal: InternalTask): void {
    if (internal.meta.hasHandle) internal.meta.status = "interrupted";
    else internal.meta.status = "waiting-file";
  }

  /** checking → 复查：心跳仍在跳 = 其他标签页在跑（remote 只读展示）；停了/已完成 = 定格 */
  private recheckRemote(id: string): void {
    const t = this.tasks.get(id);
    if (!t || t.meta.status !== "checking") return;
    const data = this.readStore();
    const pt = data?.tasks.find((p) => p.id === id);
    if (pt?.status === "done") {
      t.meta.status = "done";
      t.meta.progress = 100;
      t.meta.finishedAt = pt.finishedAt ?? Date.now();
      this.scheduleDoneCleanup(t);
    } else if (data && Date.now() - data.heartbeat < HEARTBEAT_STALE_MS) {
      t.meta.status = "remote";
    } else {
      this.markInterrupted(t);
    }
    this.notify();
  }

  /** 其他标签页写入 store：同步 remote/checking 任务的进度，清理已消失的任务 */
  private onStorageEvent(): void {
    let hasRemote = false;
    for (const t of this.tasks.values()) {
      if (t.meta.status === "remote" || t.meta.status === "checking") { hasRemote = true; break; }
    }
    if (!hasRemote) return;

    const data = this.readStore();
    if (!data) return;
    for (const t of Array.from(this.tasks.values())) {
      if (t.meta.status !== "remote" && t.meta.status !== "checking") continue;
      const pt = data.tasks.find((p) => p.id === t.meta.id);
      if (!pt) { this.tasks.delete(t.meta.id); continue; }
      if (pt.status === "uploading" || pt.status === "queued") {
        t.meta.loaded = this.completedBytes(pt);
        t.meta.currentPart = pt.completedParts?.length ?? 0;
        t.meta.progress = Math.min(99, Math.round((t.meta.loaded / t.meta.size) * 100));
      } else if (pt.status === "done") {
        t.meta.status = "done";
        t.meta.progress = 100;
        t.meta.finishedAt = pt.finishedAt ?? Date.now();
        this.scheduleDoneCleanup(t);
      }
    }
    // 上传页被强杀（心跳长期不跳）→ 转为可恢复
    if (Date.now() - data.heartbeat > REMOTE_STUCK_MS) {
      for (const t of this.tasks.values()) {
        if (t.meta.status === "remote" || t.meta.status === "checking") this.markInterrupted(t);
      }
    }
    this.notify();
  }

  // ===== 心跳 & 持久化 =====
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.hasRunningTasks()) this.writeStore();
      else if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private hasRunningTasks(): boolean {
    for (const t of this.tasks.values()) {
      if (t.meta.status === "uploading" || t.meta.status === "queued") return true;
    }
    return false;
  }

  private readStore(): PersistedStore | null {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw) as PersistedStore;
      if (!Array.isArray(data.tasks)) return null;
      return data;
    } catch { return null; }
  }

  private serialize(t: InternalTask): PersistedTask {
    const m = t.meta;
    return {
      id: m.id,
      name: m.name,
      size: m.size,
      storageId: m.storageId,
      dirPath: m.dirPath,
      uploadPath: m.uploadPath,
      contentType: m.contentType,
      chunkSize: m.chunkSize,
      mode: m.mode,
      status: m.status === "remote" || m.status === "checking" ? "uploading" : m.status,
      uploadId: t.uploadId,
      completedParts: t.completedParts,
      useDirectUpload: t.useDirectUpload,
      hasHandle: m.hasHandle,
      addedAt: m.addedAt,
      finishedAt: m.finishedAt,
      error: m.error,
    };
  }

  private writeStore(): void {
    if (typeof window === "undefined") return;
    const tasks = Array.from(this.tasks.values()).map((t) => this.serialize(t));
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, heartbeat: Date.now(), tasks } satisfies PersistedStore));
    } catch { /* 配额满：跳过本次写入 */ }
  }

  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeStore();
    }, 600);
  }

  private persistNow(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    this.writeStore();
  }

  private completedBytes(pt: Pick<PersistedTask, "completedParts" | "chunkSize" | "size">): number {
    if (!pt.completedParts?.length) return 0;
    let sum = 0;
    for (const p of pt.completedParts) {
      sum += Math.min(p.partNumber * pt.chunkSize, pt.size) - (p.partNumber - 1) * pt.chunkSize;
    }
    return sum;
  }

  // ===== 对外操作 =====
  enqueue(entries: EnqueueEntry[], opts: EnqueueOptions): number {
    this.ensureInit();
    let added = 0;
    for (const entry of entries) {
      if (!entry.file) continue;
      const file = entry.file;
      const uploadPath = opts.path ? `${opts.path}/${file.name}` : file.name;

      // 同一目标已有未完成任务 → 跳过（避免重复排队同一文件）
      let dup = false;
      for (const t of this.tasks.values()) {
        if (t.meta.uploadPath === uploadPath && t.meta.size === file.size &&
          !["done", "error", "canceled", "waiting-file"].includes(t.meta.status)) { dup = true; break; }
      }
      if (dup) continue;

      const mode: "single" | "multipart" = opts.multipartSupported && file.size >= opts.chunkSize ? "multipart" : "single";
      const totalParts = mode === "multipart" ? Math.ceil(file.size / opts.chunkSize) : 1;
      const id = `u${Date.now().toString(36)}${(this.idCounter++).toString(36)}`;

      this.tasks.set(id, {
        meta: {
          id, name: file.name, size: file.size, storageId: opts.storageId,
          dirPath: opts.path, uploadPath,
          contentType: file.type || "application/octet-stream",
          chunkSize: opts.chunkSize, mode, status: "queued",
          progress: 0, loaded: 0, speed: 0, currentPart: 0, totalParts,
          addedAt: Date.now(), hasHandle: !!entry.handle,
        },
        file, handle: entry.handle ?? null,
        xhrs: new Set(), partProgress: {}, samples: [], ctrl: { paused: false, canceled: false },
        useDirectUpload: true,
      });
      if (entry.handle) void idbPutHandle(id, entry.handle);
      added++;
    }
    if (added > 0) { this.persistNow(); this.pump(); this.notify(); }
    return added;
  }

  pause(id: string): void {
    const t = this.tasks.get(id);
    if (!t || (t.meta.status !== "uploading" && t.meta.status !== "queued")) return;
    t.ctrl.paused = true;
    this.abortAll(t);
    t.meta.status = "paused";
    t.partProgress = {};
    t.samples = [];
    t.meta.speed = 0;
    this.persistNow(); this.notify();
  }

  async resume(id: string): Promise<ResumeResult> {
    const t = this.tasks.get(id);
    if (!t) return "missing";
    if (t.meta.status === "uploading" || t.meta.status === "queued") return "started";

    if (!t.file) {
      // 刷新后需要重新拿文件：优先用保存的句柄（resume 由用户点击触发，可请求授权）
      const handle = t.handle ?? (await idbGetHandle(id)) ?? null;
      if (handle) {
        const perm = await this.acquireReadPermission(handle);
        if (perm !== "granted") return "denied";
        try { t.file = await handle.getFile(); } catch { return "denied"; }
        if (t.file.name !== t.meta.name || t.file.size !== t.meta.size) return "mismatch";
        t.handle = handle;
      } else {
        return "need-file";
      }
    }

    t.ctrl.paused = false;
    t.meta.status = "queued";
    t.meta.error = undefined;
    t.partProgress = {};
    t.samples = [];
    this.persistNow(); this.pump(); this.notify();
    return "started";
  }

  private async acquireReadPermission(handle: FileSystemFileHandle): Promise<"granted" | "denied"> {
    const cap = handle as FileSystemFileHandle & PermissionCapableHandle;
    try {
      if (typeof cap.queryPermission === "function") {
        let state = await cap.queryPermission({ mode: "read" });
        if (state !== "granted" && typeof cap.requestPermission === "function") {
          state = await cap.requestPermission({ mode: "read" });
        }
        return state === "granted" ? "granted" : "denied";
      }
    } catch { return "denied"; }
    return "granted"; // 不支持 Permission API 的实现默认放行
  }

  /** 为 waiting-file 任务重新绑定文件（按 名字+大小 校验），绑定后自动开始/续传 */
  attachFile(id: string, file: File): boolean {
    const t = this.tasks.get(id);
    if (!t || t.file || file.name !== t.meta.name || file.size !== t.meta.size) return false;
    t.file = file;
    t.ctrl.paused = false;
    t.meta.status = "queued";
    t.meta.error = undefined;
    this.persistNow(); this.pump(); this.notify();
    return true;
  }

  /** 用户重新选择的一批文件：批量匹配所有等文件的任务（含句柄授权被拒降级的），返回匹配数量 */
  attachFiles(files: File[]): number {
    let attached = 0;
    for (const t of Array.from(this.tasks.values())) {
      if (t.file || (t.meta.status !== "waiting-file" && t.meta.status !== "interrupted")) continue;
      const match = files.find((f) => f.name === t.meta.name && f.size === t.meta.size);
      if (match && this.attachFile(t.meta.id, match)) attached++;
    }
    return attached;
  }

  cancel(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.ctrl.canceled = true;
    this.abortAll(t);
    this.tasks.delete(id);
    if (t.cleanupTimer) clearTimeout(t.cleanupTimer);
    if (t.meta.mode === "multipart" && t.uploadId) {
      void fetch(`${apiFileUrl(t.meta.storageId, t.meta.uploadPath)}?action=multipart-abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: t.uploadId }),
      }).catch(() => {});
    }
    void idbDeleteHandle(id);
    this.persistNow(); this.notify();
  }

  /** 失败重试：uploadId 已失效（NoSuchUpload/InvalidPart）时自动从头开始 */
  async retry(id: string): Promise<ResumeResult> {
    const t = this.tasks.get(id);
    if (!t) return "missing";
    if (t.meta.error && /NoSuchUpload|InvalidPart|no such upload|invalid part/i.test(t.meta.error)) {
      t.uploadId = undefined;
      t.completedParts = [];
      t.useDirectUpload = true;
      t.meta.currentPart = 0;
      t.meta.loaded = 0;
      t.meta.progress = 0;
    }
    return this.resume(id);
  }

  dismiss(id: string): void {
    const t = this.tasks.get(id);
    if (!t || !["done", "error"].includes(t.meta.status)) return;
    if (t.cleanupTimer) clearTimeout(t.cleanupTimer);
    this.tasks.delete(id);
    void idbDeleteHandle(id);
    this.persistNow(); this.notify();
  }

  clearFinished(): void {
    for (const t of Array.from(this.tasks.values())) {
      if (t.meta.status === "done") this.dismiss(t.meta.id);
    }
  }

  /** 导入一条旧版 multipart_* 记录为可恢复任务（本页立即显示） */
  importLegacy(pt: PersistedTask): boolean {
    this.ensureInit();
    for (const t of this.tasks.values()) {
      if (t.uploadId && t.uploadId === pt.uploadId) return false;
    }
    const internal = this.reviveTask(pt);
    if (!internal) return false;
    internal.meta.status = "waiting-file";
    this.tasks.set(pt.id, internal);
    this.persistNow(); this.notify();
    return true;
  }

  // ===== 调度 =====
  private pump(): void {
    while (!this.unloading && this.activeCount < MAX_ACTIVE_FILES) {
      let next: InternalTask | null = null;
      for (const t of this.tasks.values()) {
        if (t.meta.status === "queued" && t.file) { next = t; break; }
      }
      if (!next) break;
      next.meta.status = "uploading";
      this.activeCount++;
      this.runTask(next)
        .catch(() => {})
        .finally(() => { this.activeCount--; this.pump(); });
    }
    this.startHeartbeat();
    this.notify();
  }

  private abortAll(t: InternalTask): void {
    for (const xhr of t.xhrs) { try { xhr.abort(); } catch { /* ignore */ } }
    t.xhrs.clear();
  }

  /** 完成的任务 1 分钟后自动从面板移除（用户也可手动清除） */
  private scheduleDoneCleanup(t: InternalTask): void {
    if (t.cleanupTimer) clearTimeout(t.cleanupTimer);
    t.cleanupTimer = setTimeout(() => {
      if (this.tasks.get(t.meta.id)?.meta.status === "done") this.dismiss(t.meta.id);
    }, DONE_AUTO_CLEAR_MS);
  }

  private async runTask(t: InternalTask): Promise<void> {
    const m = t.meta;
    try {
      if (m.mode === "multipart") await this.runMultipart(t);
      else await this.runSingle(t);
      m.status = "done";
      m.progress = 100;
      m.loaded = m.size;
      m.finishedAt = Date.now();
      m.error = undefined;
      this.persistNow(); this.notify();
      for (const cb of this.finishCbs) { try { cb(m); } catch { /* ignore */ } }
      this.scheduleDoneCleanup(t);
    } catch (err) {
      if (this.unloading) return;   // 页面卸载导致的中断：保留"上传中"状态供下次加载恢复
      if (t.ctrl.canceled) return; // 已从 map 移除
      if (t.ctrl.paused) { m.status = "paused"; this.persistNow(); this.notify(); return; }
      m.status = "error";
      m.error = err instanceof Error ? err.message : String(err);
      m.speed = 0;
      this.persistNow(); this.notify();
    }
  }

  private ensureActive(t: InternalTask): void {
    if (this.unloading) throw new Error("__unloading__");
    if (t.ctrl.canceled) throw new Error("__canceled__");
    if (t.ctrl.paused) throw new Error("__paused__");
  }

  /** 可中断睡眠：暂停/取消时立即退出 */
  private async interruptibleSleep(t: InternalTask, ms: number): Promise<void> {
    const step = 400;
    let waited = 0;
    while (waited < ms) {
      this.ensureActive(t);
      await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
      waited += step;
    }
    this.ensureActive(t);
  }

  private pushSample(t: InternalTask, loaded: number): void {
    const now = Date.now();
    t.samples.push({ t: now, loaded });
    while (t.samples.length > 2 && (now - t.samples[0].t > 6000 || t.samples.length > 48)) t.samples.shift();
    const first = t.samples[0];
    const dt = (now - first.t) / 1000;
    if (t.samples.length > 1 && dt >= 0.5) t.meta.speed = Math.max(0, (loaded - first.loaded) / dt);
  }

  private updateMultipartProgress(t: InternalTask): void {
    const m = t.meta;
    m.loaded = this.completedBytes({ completedParts: t.completedParts, chunkSize: m.chunkSize, size: m.size })
      + Object.values(t.partProgress).reduce((a, b) => a + b, 0);
    m.currentPart = t.completedParts?.length ?? 0;
    m.progress = m.size > 0 ? Math.min(99, Math.round((m.loaded / m.size) * 100)) : 100;
    this.pushSample(t, m.loaded);
    this.notify();
  }

  // ===== 小文件单请求上传 =====
  private async runSingle(t: InternalTask): Promise<void> {
    const m = t.meta;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= SINGLE_RETRIES; attempt++) {
      this.ensureActive(t);
      try {
        await uploadXhr(apiFileUrl(m.storageId, m.uploadPath), t.file!, t.xhrs, (loaded) => {
          m.loaded = loaded;
          m.progress = m.size > 0 ? Math.min(99, Math.round((loaded / m.size) * 100)) : 100;
          this.pushSample(t, loaded);
          this.notify();
        });
        m.error = undefined;
        return;
      } catch (err) {
        if (this.unloading || t.ctrl.canceled || t.ctrl.paused) throw err;
        lastErr = err;
        if (attempt < SINGLE_RETRIES) {
          m.error = `连接不稳定，第 ${attempt + 1}/${SINGLE_RETRIES} 次重试中…`;
          this.notify();
          await this.interruptibleSleep(t, Math.min(1000 * 2 ** attempt, 15_000));
        }
      }
    }
    throw lastErr;
  }

  // ===== 分片上传 =====
  private async runMultipart(t: InternalTask): Promise<void> {
    const m = t.meta;

    if (!t.uploadId) {
      const initRes = await fetch(`${apiFileUrl(m.storageId, m.uploadPath)}?action=multipart-init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: m.contentType, size: m.size, chunkSize: m.chunkSize }),
      });
      if (!initRes.ok) {
        const data = await initRes.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "初始化分片上传失败");
      }
      t.uploadId = ((await initRes.json()) as { uploadId: string }).uploadId;
      t.completedParts = [];
      t.useDirectUpload = true;
      this.persistNow();
    }
    t.completedParts ??= [];
    t.useDirectUpload ??= true;

    const done = new Set(t.completedParts.map((p) => p.partNumber));
    const remaining = Array.from({ length: m.totalParts }, (_, i) => i + 1).filter((n) => !done.has(n));

    // 直传签名 URL（获取失败则整体走代理）
    let signedUrls: Record<number, string> = {};
    if (t.useDirectUpload && remaining.length) {
      try {
        const urlsRes = await fetch(`${apiFileUrl(m.storageId, m.uploadPath)}?action=multipart-urls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId: t.uploadId, partNumbers: remaining }),
        });
        if (urlsRes.ok) signedUrls = ((await urlsRes.json()) as { urls?: Record<number, string> }).urls ?? {};
      } catch { /* 代理兜底 */ }
    }

    this.updateMultipartProgress(t);

    let queueIndex = 0;
    const queue = remaining.map((partNumber) => ({
      partNumber,
      start: (partNumber - 1) * m.chunkSize,
      end: Math.min(partNumber * m.chunkSize, m.size),
    }));

    const uploadPartWithRetry = async (item: { partNumber: number; start: number; end: number }): Promise<UploadTaskPart> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= PART_RETRIES; attempt++) {
        this.ensureActive(t);
        try {
          const chunk = t.file!.slice(item.start, item.end);
          // 先尝试直传 S3；失败（CORS/网络）则本任务永久切换到代理
          if (t.useDirectUpload && signedUrls[item.partNumber]) {
            try {
              const res = await uploadXhr(signedUrls[item.partNumber], chunk, t.xhrs, (loaded) => {
                t.partProgress[item.partNumber] = loaded;
                this.updateMultipartProgress(t);
              });
              if (res.etag) return { partNumber: item.partNumber, etag: res.etag };
              throw new Error(`分片 ${item.partNumber} 直传未返回 ETag`);
            } catch {
              t.useDirectUpload = false;
              this.persist();
            }
          }
          const url = `${apiFileUrl(m.storageId, m.uploadPath)}?action=multipart-upload&uploadId=${encodeURIComponent(t.uploadId!)}&partNumber=${item.partNumber}`;
          const res = await uploadXhr(url, chunk, t.xhrs, (loaded) => {
            t.partProgress[item.partNumber] = loaded;
            this.updateMultipartProgress(t);
          });
          let etag = res.etag;
          if (!etag) { try { etag = (JSON.parse(res.responseText) as { etag?: string }).etag ?? ""; } catch { /* ignore */ } }
          if (!etag) throw new Error(`分片 ${item.partNumber} 未返回 ETag`);
          return { partNumber: item.partNumber, etag };
        } catch (err) {
          if (this.unloading || t.ctrl.canceled || t.ctrl.paused) throw err;
          lastErr = err;
          if (attempt < PART_RETRIES) {
            t.meta.error = `连接不稳定，第 ${attempt + 1}/${PART_RETRIES} 次重试中…`;
            this.notify();
            await this.interruptibleSleep(t, Math.min(1000 * 2 ** attempt, 30_000));
          }
        }
      }
      throw lastErr;
    };

    const worker = async (): Promise<void> => {
      while (queueIndex < queue.length) {
        this.ensureActive(t);
        const item = queue[queueIndex++];
        const part = await uploadPartWithRetry(item);
        delete t.partProgress[item.partNumber];
        t.completedParts!.push(part);
        if (t.meta.error?.includes("重试")) { t.meta.error = undefined; }
        this.persist();
        this.updateMultipartProgress(t);
      }
    };

    const concurrency = Math.min(t.useDirectUpload ? DIRECT_PART_CONCURRENCY : PROXY_PART_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    // 合并（按分片号排序）
    const completeRes = await fetch(`${apiFileUrl(m.storageId, m.uploadPath)}?action=multipart-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId: t.uploadId, parts: [...t.completedParts!].sort((a, b) => a.partNumber - b.partNumber) }),
    });
    if (!completeRes.ok) {
      const data = await completeRes.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || "完成分片上传失败");
    }

    void idbDeleteHandle(m.id); // 成功后清句柄，done 状态由 runTask 写入
  }
}

export const uploadManager = new UploadManager();

/**
 * 从 DataTransfer 提取文件（拖拽时尽力保留 FileSystemFileHandle，刷新后可一键恢复）。
 * 注意：DataTransferItem 在事件处理后即失效，同步 API 必须先于任何 await 调用。
 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<EnqueueEntry[]> {
  const items = Array.from(dt.items ?? []);
  if (!items.length) return Array.from(dt.files).map((file) => ({ file }));

  const grabbed = items
    .filter((it) => it.kind === "file")
    .map((it) => {
      const getHandle = (it as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
      return {
        file: it.getAsFile(),
        handlePromise: typeof getHandle === "function" ? getHandle.call(it) : null,
      };
    });

  const entries = await Promise.all(grabbed.map(async (g) => {
    if (g.handlePromise) {
      try {
        const handle = await g.handlePromise;
        if (handle && handle.kind === "file") {
          const fh = handle as FileSystemFileHandle;
          return { file: g.file ?? (await fh.getFile()), handle: fh };
        }
      } catch { /* 回落到纯文件 */ }
    }
    return g.file ? { file: g.file } : null;
  }));

  return entries.filter((e): e is EnqueueEntry => !!e?.file);
}

/** 迁移旧版 multipart_* localStorage 键为可恢复任务（返回迁移数量） */
export function migrateLegacyUploads(chunkSizeMB: number): number {
  if (typeof window === "undefined") return 0;
  const chunkSize = chunkSizeMB * 1024 * 1024;
  let migrated = 0;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(LEGACY_KEY_PREFIX)) keys.push(key);
  }
  for (const key of keys) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "{}") as {
        uploadId?: string; fileName?: string; parts?: UploadTaskPart[]; useDirectUpload?: boolean;
      };
      const match = key.match(/^multipart_(\d+)_(.+)_(\d+)$/);
      if (!parsed.uploadId || !match || !parsed.parts) { localStorage.removeItem(key); continue; }
      const storageId = parseInt(match[1], 10);
      const uploadPath = match[2];
      const size = parseInt(match[3], 10);
      const dirPath = uploadPath.includes("/") ? uploadPath.slice(0, uploadPath.lastIndexOf("/")) : "";

      const ok = uploadManager.importLegacy({
        id: `legacy_${key}`,
        name: parsed.fileName || uploadPath.split("/").pop() || "未命名",
        size, storageId, dirPath, uploadPath,
        contentType: "application/octet-stream",
        chunkSize, mode: "multipart",
        status: "waiting-file",
        uploadId: parsed.uploadId,
        completedParts: parsed.parts,
        useDirectUpload: parsed.useDirectUpload ?? true,
        hasHandle: false,
        addedAt: Date.now(),
      });
      if (ok) migrated++;
      localStorage.removeItem(key);
    } catch { /* ignore */ }
  }
  return migrated;
}
