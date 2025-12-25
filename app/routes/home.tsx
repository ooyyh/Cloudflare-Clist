import type { Route } from "./+types/home";
import { requireAuth } from "~/lib/auth";
import { getAllStorages, getPublicStorages, initDatabase } from "~/lib/storage";
import { useState, useEffect, useRef, useCallback } from "react";
import { FilePreview } from "~/components/FilePreview";
import { getFileType, isPreviewable } from "~/lib/file-utils";

export function meta({ data }: Route.MetaArgs) {
  const title = data?.siteTitle || "CList";
  return [
    { title: `${title} - 存储聚合` },
    { name: "description", content: "S3 兼容存储聚合服务" },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  const siteTitle = context.cloudflare.env.SITE_TITLE || "CList";
  const siteAnnouncement = context.cloudflare.env.SITE_ANNOUNCEMENT || "";

  if (!db) {
    console.error("D1 Database not bound");
    return { isAdmin: false, storages: [], siteTitle, siteAnnouncement };
  }

  await initDatabase(db);

  const { isAdmin } = await requireAuth(request, db);

  const storages = isAdmin
    ? await getAllStorages(db)
    : await getPublicStorages(db);

  return {
    isAdmin,
    siteTitle,
    siteAnnouncement,
    storages: storages.map((s) => ({
      id: s.id,
      name: s.name,
      endpoint: s.endpoint,
      region: s.region,
      accessKeyId: s.accessKeyId,
      bucket: s.bucket,
      basePath: s.basePath,
      isPublic: s.isPublic,
    })),
  };
}

interface S3Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

interface StorageInfo {
  id: number;
  name: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  bucket?: string;
  basePath?: string;
  isPublic: boolean;
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

function LoginModal({ onLogin, onClose }: { onLogin: () => void; onClose: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/storages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", username, password }),
      });

      if (res.ok) {
        onLogin();
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error || "登录失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 dark:bg-black/80 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-sm rounded-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-mono text-sm">管理员登录</span>
          <button onClick={onClose} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1 font-mono">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1 font-mono">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
              required
            />
          </div>
          {error && <div className="text-red-500 dark:text-red-400 text-xs font-mono">{error}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-500 text-sm font-mono transition rounded"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-mono disabled:opacity-50 transition rounded"
            >
              {loading ? "..." : "登录"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function StorageModal({
  storage,
  onSave,
  onCancel,
}: {
  storage?: StorageInfo;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [formData, setFormData] = useState({
    name: storage?.name || "",
    endpoint: storage?.endpoint || "",
    region: storage?.region || "auto",
    accessKeyId: storage?.accessKeyId || "",
    secretAccessKey: "",
    bucket: storage?.bucket || "",
    basePath: storage?.basePath || "",
    isPublic: storage?.isPublic ?? false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const method = storage ? "PUT" : "POST";
      const body = storage ? { id: storage.id, ...formData } : formData;

      if (storage && !formData.secretAccessKey) {
        delete (body as Record<string, unknown>).secretAccessKey;
      }

      const res = await fetch("/api/storages", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        onSave();
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error || "保存失败");
      }
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 dark:bg-black/80 flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between sticky top-0 bg-white dark:bg-zinc-900 rounded-t-lg">
          <span className="text-zinc-900 dark:text-zinc-100 font-mono text-sm">{storage ? "编辑存储" : "添加存储"}</span>
          <button onClick={onCancel} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs text-zinc-500 mb-1 font-mono">名称 *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
                placeholder="My Storage"
                required
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-zinc-500 mb-1 font-mono">Endpoint *</label>
              <input
                type="url"
                value={formData.endpoint}
                onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
                placeholder="https://s3.us-east-1.amazonaws.com"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1 font-mono">Region</label>
              <input
                type="text"
                value={formData.region}
                onChange={(e) => setFormData({ ...formData, region: e.target.value })}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
                placeholder="auto"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1 font-mono">Bucket *</label>
              <input
                type="text"
                value={formData.bucket}
                onChange={(e) => setFormData({ ...formData, bucket: e.target.value })}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
                placeholder="my-bucket"
                required
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1 font-mono">Access Key *</label>
              <input
                type="text"
                value={formData.accessKeyId}
                onChange={(e) => setFormData({ ...formData, accessKeyId: e.target.value })}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
                required={!storage}
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1 font-mono">
                Secret Key {storage && "(留空保持)"}
              </label>
              <input
                type="password"
                value={formData.secretAccessKey}
                onChange={(e) => setFormData({ ...formData, secretAccessKey: e.target.value })}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
                required={!storage}
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-zinc-500 mb-1 font-mono">根路径</label>
              <input
                type="text"
                value={formData.basePath}
                onChange={(e) => setFormData({ ...formData, basePath: e.target.value })}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-sm focus:border-blue-500 focus:outline-none rounded"
                placeholder="/path/to/folder"
              />
            </div>
            <div className="col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.isPublic}
                  onChange={(e) => setFormData({ ...formData, isPublic: e.target.checked })}
                  className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                />
                <span className="text-sm text-zinc-700 dark:text-zinc-300 font-mono">公开访问</span>
                <span className="text-xs text-zinc-500">(允许游客浏览下载)</span>
              </label>
            </div>
          </div>
          {error && <div className="text-red-500 dark:text-red-400 text-xs font-mono">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-2 px-4 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-500 text-sm font-mono transition rounded"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-mono disabled:opacity-50 transition rounded"
            >
              {loading ? "保存中..." : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SettingsModal({ onClose, siteTitle }: { onClose: () => void; siteTitle: string }) {
  return (
    <div className="fixed inset-0 bg-black/60 dark:bg-black/80 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-md rounded-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-mono text-sm">关于</span>
          <button onClick={onClose} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">×</button>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-center py-4">
            <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 font-mono mb-1">{siteTitle}</div>
            <div className="text-xs text-zinc-500 font-mono">v1.0.0</div>
          </div>
          <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono space-y-2">
            <p>S3 兼容存储聚合服务</p>
            <p className="text-zinc-500">支持: AWS S3 / Cloudflare R2 / 阿里云 OSS / 腾讯云 COS / MinIO 等</p>
          </div>
          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4 text-xs text-zinc-500 font-mono">
            <p>Powered by Cloudflare Workers</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnnouncementModal({ announcement, onClose }: { announcement: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 dark:bg-black/80 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-lg rounded-lg shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-mono text-sm flex items-center gap-2">
            <span className="text-yellow-500">📢</span> 公告
          </span>
          <button onClick={onClose} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">×</button>
        </div>
        <div className="p-4">
          <p className="text-sm text-zinc-700 dark:text-zinc-300 font-mono whitespace-pre-wrap leading-relaxed">
            {announcement}
          </p>
        </div>
        <div className="px-4 pb-4">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-mono transition rounded"
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}

function FileBrowser({ storage, isAdmin, isDark }: { storage: StorageInfo; isAdmin: boolean; isDark: boolean }) {
  const [path, setPath] = useState("");
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<{ name: string; progress: number } | null>(null);
  const [previewFile, setPreviewFile] = useState<S3Object | null>(null);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [showOfflineDownload, setShowOfflineDownload] = useState(false);
  const [offlineUrl, setOfflineUrl] = useState("");
  const [offlineFilename, setOfflineFilename] = useState("");
  const [offlineDownloading, setOfflineDownloading] = useState(false);

  useEffect(() => {
    setPath("");
  }, [storage.id]);

  useEffect(() => {
    loadFiles();
  }, [storage.id, path]);

  const loadFiles = async () => {
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/files/${storage.id}/${path}?action=list`);
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
    setPath(newPath.replace(/^\//, "").replace(/\/$/, ""));
  };

  const goUp = () => {
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    setPath(parts.join("/"));
  };

  const downloadFile = (key: string) => {
    window.open(`/api/files/${storage.id}/${key}?action=download`, "_blank");
  };

  const deleteFile = async (key: string) => {
    if (!confirm(`确定删除 ${key}?`)) return;
    try {
      const res = await fetch(`/api/files/${storage.id}/${key}`, { method: "DELETE" });
      if (res.ok) {
        loadFiles();
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "删除失败");
      }
    } catch {
      alert("网络错误");
    }
  };

  const deleteFolder = async (key: string, name: string) => {
    if (!confirm(`确定删除文件夹 "${name}" 及其所有内容?`)) return;
    try {
      const res = await fetch(`/api/files/${storage.id}/${key}?action=rmdir`, { method: "DELETE" });
      if (res.ok) {
        loadFiles();
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "删除失败");
      }
    } catch {
      alert("网络错误");
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of Array.from(files)) {
      try {
        const uploadPath = path ? `${path}/${file.name}` : file.name;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const percent = Math.round((event.loaded / event.total) * 100);
              setUploadProgress({ name: file.name, progress: percent });
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              try {
                const data = JSON.parse(xhr.responseText);
                reject(new Error(data.error || "上传失败"));
              } catch {
                reject(new Error("上传失败"));
              }
            }
          };

          xhr.onerror = () => reject(new Error("网络错误"));

          xhr.open("PUT", `/api/files/${storage.id}/${uploadPath}`);
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.send(file);
        });
      } catch (err) {
        alert(`上传 ${file.name} 失败: ${err instanceof Error ? err.message : "未知错误"}`);
      }
    }
    setUploadProgress(null);
    loadFiles();
    e.target.value = "";
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    setCreatingFolder(true);
    try {
      const folderPath = path ? `${path}/${newFolderName.trim()}` : newFolderName.trim();
      const res = await fetch(`/api/files/${storage.id}/${folderPath}?action=mkdir`, {
        method: "POST",
      });

      if (res.ok) {
        setNewFolderName("");
        setShowNewFolderInput(false);
        loadFiles();
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "创建文件夹失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleOfflineDownload = async () => {
    if (!offlineUrl.trim()) return;

    setOfflineDownloading(true);
    try {
      const res = await fetch(`/api/files/${storage.id}/${path}?action=fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: offlineUrl.trim(),
          filename: offlineFilename.trim() || undefined,
        }),
      });

      const data = await res.json() as { success?: boolean; filename?: string; size?: number; error?: string };

      if (res.ok && data.success) {
        const sizeStr = data.size ? ` (${formatBytes(data.size)})` : "";
        alert(`下载成功: ${data.filename}${sizeStr}`);
        setOfflineUrl("");
        setOfflineFilename("");
        setShowOfflineDownload(false);
        loadFiles();
      } else {
        alert(data.error || "下载失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setOfflineDownloading(false);
    }
  };

  const breadcrumbs = path ? path.split("/").filter(Boolean) : [];

  // Get previewable files for navigation
  const previewableFiles = objects.filter((obj) => !obj.isDirectory && isPreviewable(obj.name));
  const currentPreviewIndex = previewFile ? previewableFiles.findIndex((f) => f.key === previewFile.key) : -1;

  const handlePreview = (obj: S3Object) => {
    if (isPreviewable(obj.name)) {
      setPreviewFile(obj);
    }
  };

  const handlePrevPreview = () => {
    if (currentPreviewIndex > 0) {
      setPreviewFile(previewableFiles[currentPreviewIndex - 1]);
    }
  };

  const handleNextPreview = () => {
    if (currentPreviewIndex < previewableFiles.length - 1) {
      setPreviewFile(previewableFiles[currentPreviewIndex + 1]);
    }
  };

  // Get file icon based on type
  const getFileIcon = (fileName: string) => {
    const type = getFileType(fileName);
    switch (type) {
      case 'video': return '🎬';
      case 'audio': return '🎵';
      case 'image': return '🖼️';
      case 'pdf': return '📕';
      case 'code': return '📝';
      case 'text': return '📄';
      default: return '📄';
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between py-2 px-4 border-b border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50">
        <div className="flex items-center gap-1 text-sm font-mono overflow-x-auto">
          <button onClick={() => setPath("")} className="text-blue-500 hover:text-blue-400 shrink-0">
            {storage.name}
          </button>
          {breadcrumbs.map((part, i) => (
            <span key={i} className="flex items-center shrink-0">
              <span className="text-zinc-400 dark:text-zinc-600 mx-1">/</span>
              <button
                onClick={() => navigateTo(breadcrumbs.slice(0, i + 1).join("/"))}
                className="text-blue-500 hover:text-blue-400"
              >
                {part}
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {path && (
            <button onClick={goUp} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono px-2 py-1">
              ← 上级
            </button>
          )}
          <button onClick={loadFiles} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono px-2 py-1">
            刷新
          </button>
          {isAdmin && (
            <>
              <button
                onClick={() => setShowNewFolderInput(true)}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono px-2 py-1"
              >
                + 文件夹
              </button>
              <button
                onClick={() => setShowOfflineDownload(true)}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono px-2 py-1"
              >
                离线下载
              </button>
              <label className={`text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 font-mono cursor-pointer rounded ${uploadProgress ? 'opacity-50 pointer-events-none' : ''}`}>
                {uploadProgress ? '上传中...' : '上传'}
                <input type="file" multiple onChange={handleUpload} className="hidden" disabled={!!uploadProgress} />
              </label>
            </>
          )}
        </div>
      </div>

      {/* New Folder Input */}
      {showNewFolderInput && (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 font-mono">新建文件夹:</span>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
                if (e.key === "Escape") {
                  setShowNewFolderInput(false);
                  setNewFolderName("");
                }
              }}
              placeholder="输入文件夹名称"
              className="flex-1 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-sm font-mono text-zinc-900 dark:text-zinc-100 rounded focus:border-blue-500 focus:outline-none"
              autoFocus
              disabled={creatingFolder}
            />
            <button
              onClick={handleCreateFolder}
              disabled={creatingFolder || !newFolderName.trim()}
              className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 font-mono rounded"
            >
              {creatingFolder ? "创建中..." : "创建"}
            </button>
            <button
              onClick={() => {
                setShowNewFolderInput(false);
                setNewFolderName("");
              }}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono px-2 py-1"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Offline Download Input */}
      {showOfflineDownload && (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 font-mono shrink-0">链接地址:</span>
              <input
                type="url"
                value={offlineUrl}
                onChange={(e) => setOfflineUrl(e.target.value)}
                placeholder="https://example.com/file.zip"
                className="flex-1 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-sm font-mono text-zinc-900 dark:text-zinc-100 rounded focus:border-blue-500 focus:outline-none"
                autoFocus
                disabled={offlineDownloading}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 font-mono shrink-0">文件名称:</span>
              <input
                type="text"
                value={offlineFilename}
                onChange={(e) => setOfflineFilename(e.target.value)}
                placeholder="可选，留空自动识别"
                className="flex-1 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-sm font-mono text-zinc-900 dark:text-zinc-100 rounded focus:border-blue-500 focus:outline-none"
                disabled={offlineDownloading}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleOfflineDownload();
                  if (e.key === "Escape") {
                    setShowOfflineDownload(false);
                    setOfflineUrl("");
                    setOfflineFilename("");
                  }
                }}
              />
              <button
                onClick={handleOfflineDownload}
                disabled={offlineDownloading || !offlineUrl.trim()}
                className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 font-mono rounded whitespace-nowrap"
              >
                {offlineDownloading ? "下载中..." : "开始下载"}
              </button>
              <button
                onClick={() => {
                  setShowOfflineDownload(false);
                  setOfflineUrl("");
                  setOfflineFilename("");
                }}
                disabled={offlineDownloading}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono px-2 py-1"
              >
                取消
              </button>
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-600 font-mono">
              提示: 文件将下载到当前目录，大文件可能需要较长时间
            </p>
          </div>
        </div>
      )}

      {/* Upload Progress */}
      {uploadProgress && (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50">
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-600 dark:text-zinc-400 font-mono truncate flex-1">
              正在上传: {uploadProgress.name}
            </span>
            <span className="text-xs text-zinc-500 font-mono w-12 text-right">
              {uploadProgress.progress}%
            </span>
          </div>
          <div className="mt-1 h-1 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-150"
              style={{ width: `${uploadProgress.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-zinc-500 font-mono text-sm">
            加载中...
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-32 text-red-500 dark:text-red-400 font-mono text-sm">
            {error}
          </div>
        ) : objects.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-zinc-400 dark:text-zinc-600 font-mono text-sm">
            空目录
          </div>
        ) : (
          <table className="w-full text-sm font-mono">
            <thead className="text-xs text-zinc-500 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 bg-zinc-50 dark:bg-zinc-900">
              <tr>
                <th className="text-left py-2 px-4 font-normal">名称</th>
                <th className="text-right py-2 px-4 font-normal w-24">大小</th>
                <th className="text-right py-2 px-4 font-normal w-44">修改时间</th>
                <th className="text-right py-2 px-4 font-normal w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {objects.map((obj) => (
                <tr key={obj.key} className="border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-100 dark:hover:bg-zinc-800/30">
                  <td className="py-2 px-4">
                    {obj.isDirectory ? (
                      <button
                        onClick={() => navigateTo(obj.key)}
                        className="flex items-center gap-2 text-blue-500 hover:text-blue-400"
                      >
                        <span className="text-yellow-500">📁</span>
                        {obj.name}
                      </button>
                    ) : isPreviewable(obj.name) ? (
                      <button
                        onClick={() => handlePreview(obj)}
                        className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 hover:text-blue-500 dark:hover:text-blue-400"
                      >
                        <span>{getFileIcon(obj.name)}</span>
                        {obj.name}
                      </button>
                    ) : (
                      <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                        <span className="text-zinc-400 dark:text-zinc-500">{getFileIcon(obj.name)}</span>
                        {obj.name}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-4 text-right text-zinc-500">
                    {obj.isDirectory ? "-" : formatBytes(obj.size)}
                  </td>
                  <td className="py-2 px-4 text-right text-zinc-500">
                    {formatDate(obj.lastModified)}
                  </td>
                  <td className="py-2 px-4 text-right">
                    {obj.isDirectory ? (
                      isAdmin && (
                        <button
                          onClick={() => deleteFolder(obj.key, obj.name)}
                          className="text-zinc-400 dark:text-zinc-500 hover:text-red-500"
                          title="删除文件夹"
                        >
                          ×
                        </button>
                      )
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        {isPreviewable(obj.name) && (
                          <button
                            onClick={() => handlePreview(obj)}
                            className="text-zinc-400 dark:text-zinc-500 hover:text-blue-500"
                            title="预览"
                          >
                            ▶
                          </button>
                        )}
                        <button
                          onClick={() => downloadFile(obj.key)}
                          className="text-zinc-400 dark:text-zinc-500 hover:text-blue-500"
                          title="下载"
                        >
                          ↓
                        </button>
                        {isAdmin && (
                          <button
                            onClick={() => deleteFile(obj.key)}
                            className="text-zinc-400 dark:text-zinc-500 hover:text-red-500"
                            title="删除"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* File Preview Modal */}
      {previewFile && (
        <FilePreview
          storageId={storage.id}
          fileKey={previewFile.key}
          fileName={previewFile.name}
          onClose={() => setPreviewFile(null)}
          onPrev={handlePrevPreview}
          onNext={handleNextPreview}
          hasPrev={currentPreviewIndex > 0}
          hasNext={currentPreviewIndex < previewableFiles.length - 1}
        />
      )}
    </div>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const [isAdmin, setIsAdmin] = useState(loaderData.isAdmin);
  const [storages, setStorages] = useState<StorageInfo[]>(loaderData.storages);
  const [selectedStorage, setSelectedStorage] = useState<StorageInfo | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [showStorageForm, setShowStorageForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAnnouncement, setShowAnnouncement] = useState(false);
  const [editingStorage, setEditingStorage] = useState<StorageInfo | null>(null);
  const [isDark, setIsDark] = useState(true);
  const themeButtonRef = useRef<HTMLButtonElement>(null);

  const siteTitle = loaderData.siteTitle || "CList";
  const siteAnnouncement = loaderData.siteAnnouncement || "";

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light") {
      setIsDark(false);
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }

    // Show announcement on first visit (per session)
    if (siteAnnouncement) {
      const announcementShown = sessionStorage.getItem("announcement_shown");
      if (!announcementShown) {
        setShowAnnouncement(true);
        sessionStorage.setItem("announcement_shown", "true");
      }
    }
  }, [siteAnnouncement]);

  const toggleTheme = useCallback((event: React.MouseEvent) => {
    const newIsDark = !isDark;

    const changeTheme = () => {
      setIsDark(newIsDark);
      if (newIsDark) {
        document.documentElement.classList.add("dark");
        localStorage.setItem("theme", "dark");
      } else {
        document.documentElement.classList.remove("dark");
        localStorage.setItem("theme", "light");
      }
    };

    if (!document.startViewTransition) {
      changeTheme();
      return;
    }

    const x = event.clientX;
    const y = event.clientY;
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    const transition = document.startViewTransition(() => {
      changeTheme();
    });

    transition.ready.then(() => {
      const clipPath = [
        `circle(0px at ${x}px ${y}px)`,
        `circle(${endRadius}px at ${x}px ${y}px)`,
      ];
      document.documentElement.animate(
        { clipPath: isDark ? clipPath : clipPath.reverse() },
        {
          duration: 400,
          easing: "ease-in-out",
          pseudoElement: isDark
            ? "::view-transition-new(root)"
            : "::view-transition-old(root)",
        }
      );
    });
  }, [isDark]);

  const refreshStorages = async () => {
    try {
      const res = await fetch("/api/storages");
      if (res.ok) {
        const data = (await res.json()) as { storages: StorageInfo[]; isAdmin: boolean };
        setStorages(data.storages);
        setIsAdmin(data.isAdmin);
      }
    } catch { /* ignore */ }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/storages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      setIsAdmin(false);
      setSelectedStorage(null);
      refreshStorages();
    } catch { /* ignore */ }
  };

  const handleDeleteStorage = async (s: StorageInfo) => {
    if (!confirm(`删除存储 "${s.name}"?`)) return;
    try {
      const res = await fetch(`/api/storages?id=${s.id}`, { method: "DELETE" });
      if (res.ok) {
        if (selectedStorage?.id === s.id) setSelectedStorage(null);
        refreshStorages();
      }
    } catch { /* ignore */ }
  };

  return (
    <div className="h-screen overflow-hidden bg-zinc-100 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        <div className="px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xl font-bold font-mono tracking-tight">CList</span>
          </div>
          <div className="flex-1 text-center min-w-0">
            <span className="text-sm font-mono text-zinc-600 dark:text-zinc-400 truncate block">{siteTitle}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              ref={themeButtonRef}
              onClick={toggleTheme}
              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono px-2 py-1 whitespace-nowrap"
            >
              {isDark ? "☀ 亮色" : "☾ 暗色"}
            </button>
            {isAdmin ? (
              <>
                <button
                  onClick={() => setShowSettings(true)}
                  className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono whitespace-nowrap"
                >
                  关于
                </button>
                <span className="text-xs text-green-600 dark:text-green-500 font-mono whitespace-nowrap">● 管理员</span>
                <button
                  onClick={handleLogout}
                  className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono whitespace-nowrap"
                >
                  登出
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowLogin(true)}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-mono whitespace-nowrap"
              >
                登录
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-zinc-200 dark:border-zinc-800 shrink-0 bg-white dark:bg-zinc-900/50 flex flex-col">
          <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between shrink-0">
            <span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">存储列表</span>
            {isAdmin && (
              <button
                onClick={() => { setEditingStorage(null); setShowStorageForm(true); }}
                className="text-xs text-blue-500 hover:text-blue-400 font-mono"
              >
                + 添加
              </button>
            )}
          </div>
          <div className="overflow-y-auto flex-1">
            {storages.length === 0 ? (
              <div className="p-4 text-center text-zinc-400 dark:text-zinc-600 text-xs font-mono">
                暂无存储
              </div>
            ) : (
              storages.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-center justify-between px-3 py-2 cursor-pointer border-l-2 transition ${
                    selectedStorage?.id === s.id
                      ? "border-blue-500 bg-blue-50 dark:bg-zinc-800/50"
                      : "border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800/30"
                  }`}
                  onClick={() => setSelectedStorage(s)}
                >
                  <div className="min-w-0">
                    <div className={`text-sm font-mono truncate ${selectedStorage?.id === s.id ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}`}>
                      {s.name}
                    </div>
                    <div className="text-xs text-zinc-400 dark:text-zinc-600 font-mono">
                      {s.isPublic ? "公开" : "私有"}
                    </div>
                  </div>
                  {isAdmin && (
                    <div className="hidden group-hover:flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => { setEditingStorage(s); setShowStorageForm(true); }}
                        className="text-zinc-400 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 text-xs px-1"
                        title="编辑"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => handleDeleteStorage(s)}
                        className="text-zinc-400 dark:text-zinc-600 hover:text-red-500 dark:hover:text-red-400 text-xs px-1"
                        title="删除"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Main */}
        <main className="flex-1 bg-zinc-50 dark:bg-zinc-900 min-w-0 overflow-hidden">
          {selectedStorage ? (
            <FileBrowser storage={selectedStorage} isAdmin={isAdmin} isDark={isDark} />
          ) : (
            <div className="flex items-center justify-center h-full text-zinc-400 dark:text-zinc-600 font-mono text-sm">
              ← 选择存储以浏览文件
            </div>
          )}
        </main>
      </div>

      {/* Modals */}
      {showLogin && (
        <LoginModal
          onLogin={() => { setShowLogin(false); refreshStorages(); setIsAdmin(true); }}
          onClose={() => setShowLogin(false)}
        />
      )}
      {showStorageForm && (
        <StorageModal
          storage={editingStorage || undefined}
          onSave={() => { setShowStorageForm(false); setEditingStorage(null); refreshStorages(); }}
          onCancel={() => { setShowStorageForm(false); setEditingStorage(null); }}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} siteTitle={siteTitle} />}
      {showAnnouncement && siteAnnouncement && (
        <AnnouncementModal
          announcement={siteAnnouncement}
          onClose={() => setShowAnnouncement(false)}
        />
      )}
    </div>
  );
}
