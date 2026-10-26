/**
 * 上传任务面板（右下角浮动）
 * - 显示所有上传任务（进行中 / 排队 / 暂停 / 失败 / 完成 / 待恢复）
 * - 支持暂停、继续、取消、重试、恢复（含刷新后重新选择文件续传）
 */
import { useRef, useState, useSyncExternalStore } from "react";
import { uploadManager, type UploadTask } from "~/lib/upload-manager";
import { Upload, X, Play, Pause, RefreshCw, Check, AlertCircle, ChevronRight } from "~/components/icons";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatSpeed(bytesPerSecond: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return "";
  return formatBytes(bytesPerSecond) + "/s";
}

const STATUS_META: Record<UploadTask["status"], { label: string; bar: string; text: string }> = {
  uploading:    { label: "上传中",   bar: "bg-blue-500",     text: "text-blue-500" },
  queued:       { label: "排队中",   bar: "bg-zinc-400",     text: "text-zinc-400" },
  paused:       { label: "已暂停",   bar: "bg-amber-500",    text: "text-amber-500" },
  error:        { label: "失败",     bar: "bg-red-500",      text: "text-red-500" },
  done:         { label: "完成",     bar: "bg-emerald-500",  text: "text-emerald-500" },
  interrupted:  { label: "已中断",   bar: "bg-amber-500",    text: "text-amber-500" },
  "waiting-file": { label: "待选文件", bar: "bg-amber-500",  text: "text-amber-500" },
  checking:     { label: "检测中",   bar: "bg-zinc-400",     text: "text-zinc-400" },
  remote:       { label: "其他标签页", bar: "bg-indigo-500", text: "text-indigo-400" },
};

const EMPTY_TASKS: UploadTask[] = [];

export function UploadTaskPanel() {
  const tasks = useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot, () => EMPTY_TASKS);
  const [collapsed, setCollapsed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState("");

  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort((a, b) => a.addedAt - b.addedAt);
  const activeCount = sorted.filter((t) => t.status === "uploading" || t.status === "queued").length;
  const interruptibleCount = sorted.filter((t) => t.status === "interrupted" || t.status === "waiting-file").length;
  const totalSpeed = sorted.reduce((sum, t) => sum + (t.status === "uploading" ? t.speed : 0), 0);
  const hasFinished = sorted.some((t) => t.status === "done");

  const openFilePicker = () => fileInputRef.current?.click();

  const handleResume = async (id: string) => {
    const result = await uploadManager.resume(id);
    if (result === "need-file") openFilePicker();
    else if (result === "denied") setHint("文件访问被拒绝，请点击\"选文件恢复\"重新选择");
    else if (result === "mismatch") setHint("本地文件与任务不一致（名字/大小不匹配）");
  };

  const handleRetry = async (id: string) => {
    const result = await uploadManager.retry(id);
    if (result === "need-file") openFilePicker();
  };

  const handleFilesPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    const attached = uploadManager.attachFiles(files);
    setHint(attached > 0 ? `已恢复 ${attached} 个任务` : "所选文件与待恢复任务不匹配（需名字和大小一致）");
    setTimeout(() => setHint(""), 4000);
  };

  // 折叠态：小徽标
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg px-3.5 py-2 text-sm hover:shadow-xl transition"
      >
        <span className="relative flex h-2 w-2">
          {activeCount > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-60" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${activeCount > 0 ? "bg-blue-500" : interruptibleCount > 0 ? "bg-amber-500" : "bg-emerald-500"}`} />
        </span>
        <span className="font-medium text-zinc-700 dark:text-zinc-200">
          上传 {activeCount > 0 ? `${activeCount} 个进行中` : interruptibleCount > 0 ? `${interruptibleCount} 个待恢复` : "任务"}
        </span>
        {totalSpeed > 0 && <span className="text-xs text-blue-500 tabular-nums">{formatSpeed(totalSpeed)}</span>}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden">
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFilesPicked} />

      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60">
        <Upload className="h-4 w-4 text-blue-500 shrink-0" />
        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200 truncate flex-1">
          上传任务
          {activeCount > 0 && <span className="text-zinc-400 font-normal"> · {activeCount} 个进行中</span>}
        </span>
        {totalSpeed > 0 && (
          <span className="text-xs text-blue-500 tabular-nums shrink-0">{formatSpeed(totalSpeed)}</span>
        )}
        {hasFinished && (
          <button
            onClick={() => uploadManager.clearFinished()}
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 shrink-0"
          >
            清除完成
          </button>
        )}
        <button
          onClick={() => setCollapsed(true)}
          className="icon-btn h-6 w-6 shrink-0"
          aria-label="折叠"
          title="折叠"
        >
          <ChevronRight className="h-4 w-4 rotate-90" />
        </button>
      </div>

      {hint && (
        <div className="px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border-b border-amber-100 dark:border-amber-500/20">
          {hint}
        </div>
      )}

      {/* 任务列表 */}
      <div className="max-h-72 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800">
        {sorted.map((task) => (
          <UploadTaskRow
            key={task.id}
            task={task}
            onResume={handleResume}
            onRetry={handleRetry}
            onPickFile={openFilePicker}
          />
        ))}
      </div>
    </div>
  );
}

function UploadTaskRow({
  task,
  onResume,
  onRetry,
  onPickFile,
}: {
  task: UploadTask;
  onResume: (id: string) => void;
  onRetry: (id: string) => void;
  onPickFile: () => void;
}) {
  const meta = STATUS_META[task.status];
  const isActive = task.status === "uploading" || task.status === "queued";

  return (
    <div className="px-3 py-2">
      {/* 第一行：文件名 + 状态 + 操作 */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200 truncate flex-1" title={task.uploadPath}>
          {task.name}
        </span>
        {task.status === "done" ? (
          <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
        ) : task.status === "error" ? (
          <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
        ) : null}
        <span className={`text-[11px] shrink-0 ${meta.text}`}>{meta.label}</span>

        {/* 操作按钮 */}
        <div className="flex items-center gap-0.5 shrink-0">
          {isActive && (
            <>
              <button onClick={() => uploadManager.pause(task.id)} className="icon-btn h-6 w-6" title="暂停" aria-label="暂停">
                <Pause className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => uploadManager.cancel(task.id)} className="icon-btn h-6 w-6" title="取消" aria-label="取消">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {task.status === "paused" && (
            <>
              <button onClick={() => onResume(task.id)} className="icon-btn h-6 w-6" title="继续" aria-label="继续">
                <Play className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => uploadManager.cancel(task.id)} className="icon-btn h-6 w-6" title="取消" aria-label="取消">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {task.status === "error" && (
            <>
              <button onClick={() => onRetry(task.id)} className="icon-btn h-6 w-6" title="重试" aria-label="重试">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => uploadManager.dismiss(task.id)} className="icon-btn h-6 w-6" title="移除" aria-label="移除">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {task.status === "interrupted" && (
            <>
              <button
                onClick={() => onResume(task.id)}
                className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition"
              >
                恢复
              </button>
              <button onClick={() => uploadManager.cancel(task.id)} className="icon-btn h-6 w-6" title="取消" aria-label="取消">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {task.status === "waiting-file" && (
            <>
              <button
                onClick={onPickFile}
                className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition"
              >
                选文件恢复
              </button>
              <button onClick={() => uploadManager.cancel(task.id)} className="icon-btn h-6 w-6" title="取消" aria-label="取消">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {task.status === "done" && (
            <button onClick={() => uploadManager.dismiss(task.id)} className="icon-btn h-6 w-6" title="清除" aria-label="清除">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 第二行：进度条 */}
      <div className="mt-1.5 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-200 ${meta.bar} ${task.status === "uploading" ? "" : "opacity-80"}`}
          style={{ width: `${task.status === "done" ? 100 : task.progress}%` }}
        />
      </div>

      {/* 第三行：明细 */}
      <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 tabular-nums">
        <span>{task.progress}%</span>
        <span>·</span>
        <span className="truncate">
          {formatBytes(task.status === "done" ? task.size : task.loaded)} / {formatBytes(task.size)}
        </span>
        {task.mode === "multipart" && task.status === "uploading" && (
          <>
            <span>·</span>
            <span className="truncate">{task.currentPart}/{task.totalParts} 片</span>
          </>
        )}
        {task.status === "uploading" && task.speed > 0 && (
          <span className="ml-auto text-blue-500 shrink-0">{formatSpeed(task.speed)}</span>
        )}
        {task.error && (
          <span className="ml-auto truncate text-red-400" title={task.error}>{task.error}</span>
        )}
      </div>
    </div>
  );
}
