import type { Route } from "./+types/share";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return { token: null };
  }

  return { token };
}

import { useState, useEffect } from "react";
import { FilePreview } from "~/components/FilePreview";
import { Folder, Download, Link as LinkIcon, Clock, AlertCircle, ChevronRight, Play, Lock, fileTypeIcon } from "~/components/icons";
import { getFileType } from "~/lib/file-utils";
import { apiFileUrl } from "~/lib/api-path";

interface S3Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

interface Share {
  id: string;
  storageId: number;
  filePath: string;
  isDirectory: boolean;
  shareToken: string;
  expiresAt: string | null;
  createdAt: string;
  hasPassword: boolean;
}

interface StorageInfo {
  id: number;
  name: string;
}

function SoftLoadingState({ label }: { label: string }) {
  return (
    <div className="w-full max-w-xl px-3">
      <div className="soft-loading-shell">
        <div className="soft-loading-header">
          <span className="soft-loading-dot" aria-hidden />
          <span>{label}</span>
        </div>
        <div className="mt-4 space-y-2.5">
          <div className="soft-skeleton h-2.5 w-full" />
          <div className="soft-skeleton h-2.5 w-4/5" />
          <div className="soft-skeleton h-2.5 w-3/5" />
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "-";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleString("zh-CN");
}

function getFileIcon(name: string) {
  const Icon = fileTypeIcon(getFileType(name));
  return <Icon className="h-4 w-4 shrink-0" />;
}

export default function Share({ loaderData }: Route.ComponentProps) {
  const { token } = loaderData as { token: string | null };
  const [share, setShare] = useState<Share | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [path, setPath] = useState("");
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [previewFile, setPreviewFile] = useState<S3Object | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [accessPassword, setAccessPassword] = useState("");
  const [passwordVerified, setPasswordVerified] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("分享令牌缺失");
      setLoading(false);
      return;
    }

    const fetchShareInfo = async () => {
      try {
        const res = await fetch(`/api/shares?token=${token}`);
        if (res.ok) {
          const data = (await res.json()) as { share: Share; storage: StorageInfo };
          setShare(data.share);
          setStorage(data.storage);
        } else {
          const data = (await res.json()) as { error?: string };
          setError(data.error || "分享链接不存在或已过期");
        }
      } catch {
        setError("网络错误");
      } finally {
        setLoading(false);
      }
    };

    fetchShareInfo();
  }, [token]);

  useEffect(() => {
    if (share && storage && (!share.hasPassword || passwordVerified)) {
      loadFiles();
    }
  }, [share, storage, path, passwordVerified]);

  const loadFiles = async () => {
    if (!share || !storage || !token) return;

    setLoading(true);

    try {
      // If sharing a single file and at root level, show the file itself
      if (!share.isDirectory && !path) {
        // Create a single object representing the shared file
        const fileName = share.filePath.split("/").pop() || share.filePath;
        const fileObj: S3Object = {
          key: share.filePath,
          name: fileName,
          size: 0, // We don't have size info, will show as "-"
          lastModified: share.createdAt,
          isDirectory: false,
        };
        setObjects([fileObj]);
        setLoading(false);
        return;
      }

      const basePath = share.filePath;
      const fullPath = path ? `${basePath}/${path}` : basePath;

      const res = await fetch(
        `${apiFileUrl(storage.id, fullPath)}?action=list&token=${token}${accessPassword ? `&password=${encodeURIComponent(accessPassword)}` : ""}`
      );

      if (res.ok) {
        const data = (await res.json()) as { objects?: S3Object[] };
        setObjects(data.objects || []);
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error || "加载失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  const navigateTo = (newPath: string) => {
    // If sharing a single file, don't allow navigation
    if (!share?.isDirectory) return;
    setPath(newPath.replace(/^\//, "").replace(/\/$/, ""));
  };

  const downloadFile = (key: string) => {
    window.open(
      `${apiFileUrl(storage!.id, key)}?action=download&token=${token}${accessPassword ? `&password=${encodeURIComponent(accessPassword)}` : ""}`,
      "_blank"
    );
  };

  const verifyPassword = async () => {
    setPasswordError("");
    setVerifying(true);
    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", token, password: accessPassword }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (res.ok && data.success) {
        setPasswordVerified(true);
      } else {
        setPasswordError(data.error || "密码错误，请重试");
      }
    } catch {
      setPasswordError("网络错误");
    } finally {
      setVerifying(false);
    }
  };

  const canPreviewImage = (obj: S3Object) => !obj.isDirectory && getFileType(obj.name) === "image";

  if (error && !share) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-100 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-3 text-center p-8 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
          <AlertCircle className="h-8 w-8 text-red-500 dark:text-red-400" />
          <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>
        </div>
      </div>
    );
  }

  if (!share || !storage) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-100 dark:bg-zinc-950">
        <SoftLoadingState label="正在准备分享内容…" />
      </div>
    );
  }

  // 密码保护：未验证前显示密码门
  if (share.hasPassword && !passwordVerified) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-100 dark:bg-zinc-950 p-4">
        <div className="w-full max-w-sm rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl p-6">
          <div className="flex flex-col items-center text-center gap-2 mb-5">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-600/20">
              <Lock className="h-5 w-5" />
            </span>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">需要访问密码</h2>
            <p className="text-xs text-zinc-500">该分享受密码保护，请输入密码继续访问</p>
          </div>
          <input
            type="password"
            value={accessPassword}
            onChange={(e) => setAccessPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !verifying) verifyPassword(); }}
            placeholder="输入访问密码"
            className="field"
            autoFocus
          />
          {passwordError && <div className="mt-2 text-xs text-red-500">{passwordError}</div>}
          <button onClick={verifyPassword} disabled={verifying || !accessPassword} className="btn btn-primary w-full py-2 mt-3">
            {verifying ? "验证中…" : "验证"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col bg-zinc-100 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/20">
            <LinkIcon className="h-[18px] w-[18px]" />
          </span>
          <div>
            <div className="text-lg font-bold tracking-tight">分享内容</div>
            <div className="text-xs text-zinc-500 mt-0.5">
              存储: <span className="text-zinc-700 dark:text-zinc-300">{storage.name}</span> · 项目: <span className="text-zinc-700 dark:text-zinc-300">{share.filePath}</span>
            </div>
            {share.expiresAt && (
              <div className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 mt-1">
                <Clock className="h-3.5 w-3.5" />
                过期时间: {formatDate(share.expiresAt)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/40 shrink-0 flex items-center gap-0.5 text-sm overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          onClick={() => setPath("")}
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 font-medium text-zinc-600 hover:text-blue-600 dark:text-zinc-300 dark:hover:text-blue-400 shrink-0"
        >
          <Folder className="h-4 w-4 text-blue-500" />
          根目录
        </button>
        {path
          .split("/")
          .filter(Boolean)
          .map((part, index, arr) => {
            const fullPath = arr.slice(0, index + 1).join("/");
            return (
              <div key={fullPath} className="flex items-center shrink-0">
                <ChevronRight className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />
                <button
                  onClick={() => navigateTo(fullPath)}
                  className="rounded px-1.5 py-1 text-zinc-500 hover:text-blue-600 dark:text-zinc-400 dark:hover:text-blue-400"
                >
                  {part}
                </button>
              </div>
            );
          })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="py-5">
            <SoftLoadingState label="正在加载文件列表…" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center gap-2 h-32 text-red-500 dark:text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : objects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-zinc-400 dark:text-zinc-600">
            <Folder className="h-8 w-8" />
            <span className="text-sm">空目录</span>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 bg-zinc-50/95 dark:bg-zinc-900/95 backdrop-blur">
              <tr>
                <th className="text-left py-2.5 px-6 font-medium uppercase tracking-wider">名称</th>
                <th className="text-right py-2.5 px-6 font-medium uppercase tracking-wider w-28">大小</th>
                <th className="text-right py-2.5 px-6 font-medium uppercase tracking-wider w-44">修改时间</th>
                <th className="text-right py-2.5 px-6 font-medium uppercase tracking-wider w-20">操作</th>
              </tr>
            </thead>
            <tbody>
              {objects.map((obj) => (
                <tr
                  key={obj.key}
                  className="border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40"
                >
                  <td className="py-2 px-6">
                    {obj.isDirectory ? (
                      <button
                        onClick={() => navigateTo(obj.key)}
                        className="flex items-center gap-2 font-medium text-zinc-700 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        <Folder className="h-4 w-4 shrink-0 text-blue-500" />
                        <span className="truncate">{obj.name}</span>
                      </button>
                    ) : (
                      <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                        <span className="text-zinc-400 dark:text-zinc-500">{getFileIcon(obj.name)}</span>
                        <span className="truncate">{obj.name}</span>
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-6 text-right text-zinc-500 tabular-nums">
                    {obj.isDirectory ? "-" : formatBytes(obj.size)}
                  </td>
                  <td className="py-2 px-6 text-right text-zinc-500 tabular-nums">
                    {formatDate(obj.lastModified)}
                  </td>
                  <td className="py-1.5 px-6 text-right">
                    {!obj.isDirectory && (
                      <div className="flex items-center justify-end gap-0.5">
                        {canPreviewImage(obj) && (
                          <button
                            onClick={() => setPreviewFile(obj)}
                            className="icon-btn h-7 w-7"
                            title="预览"
                            aria-label="预览"
                          >
                            <Play />
                          </button>
                        )}
                        <button
                          onClick={() => downloadFile(obj.key)}
                          className="icon-btn h-7 w-7"
                          title="下载"
                          aria-label="下载"
                        >
                          <Download />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0 text-xs text-zinc-500">
        <div>CList 分享内容</div>
      </div>

      {previewFile && token && (
        <FilePreview
          storageId={storage.id}
          fileKey={previewFile.key}
          fileName={previewFile.name}
          shareToken={token}
          password={accessPassword}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
