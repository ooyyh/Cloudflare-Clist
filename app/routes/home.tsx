import type { Route } from "./+types/home";
import { requireAuth } from "~/lib/auth";
import { getAllStorages, getPublicStorages, initDatabase } from "~/lib/storage";
import { useState, useEffect, useCallback, useRef } from "react";
import { FilePreview } from "~/components/FilePreview";
import { getFileType, isPreviewable } from "~/lib/file-utils";
import { apiFileUrl } from "~/lib/api-path";
import { uploadManager, filesFromDataTransfer, migrateLegacyUploads, type EnqueueEntry } from "~/lib/upload-manager";
import { UploadTaskPanel } from "~/components/UploadTaskPanel";
import { marked } from "marked";
import {
  X, Plus, Search, Sun, Moon, SlidersHorizontal, LogIn, LogOut, ShieldCheck, Cloud,
  ChevronRight, ArrowLeft, ArrowRightLeft, RefreshCw, PanelLeft,
  FolderPlus, Upload, Download, Copy, Share2, Pencil, Trash2, Play, BarChart3, FileText,
  Folder, AlertCircle, Github, fileTypeIcon, Globe, LayoutGrid, List, Star, Calculator,
} from "~/components/icons";

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
  const chunkSizeMB = parseInt(context.cloudflare.env.CHUNK_SIZE_MB || "50", 10);
  const webdavEnabled = (context.cloudflare.env.WEBDAV_ENABLED as string) === "true";

  if (!db) {
    console.error("D1 Database not bound");
    return { isAdmin: false, storages: [], siteTitle, siteAnnouncement, chunkSizeMB, webdavEnabled: false };
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
    chunkSizeMB,
    webdavEnabled,
    storages: storages.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      endpoint: s.endpoint,
      region: s.region,
      accessKeyId: s.accessKeyId,
      bucket: s.bucket,
      basePath: s.basePath,
      config: isAdmin ? s.config : undefined,
      isPublic: s.isPublic,
      guestList: s.guestList,
      guestDownload: s.guestDownload,
      guestUpload: s.guestUpload,
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
  type?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  bucket?: string;
  basePath?: string;
  config?: Record<string, any>;
  isPublic: boolean;
  guestList: boolean;
  guestDownload: boolean;
  guestUpload: boolean;
}

type ConfigField = {
  key: string;
  label: string;
  type: "text" | "password" | "textarea" | "select" | "boolean";
  required?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | boolean;
  show?: (values: Record<string, any>) => boolean;
  help?: string;
};

const driveConfigMap: Record<string, { name: string; supportsMultipart: boolean; fields: ConfigField[] }> = {
  onedrive: {
    name: "OneDrive",
    supportsMultipart: true,
    fields: [
      {
        key: "region",
        label: "区域",
        type: "select",
        required: true,
        options: [
          { value: "global", label: "全球版" },
          { value: "cn", label: "中国版（世纪互联）" },
          { value: "us", label: "美国政府版" },
          { value: "de", label: "德国版" },
        ],
        defaultValue: "global",
      },
      { key: "refresh_token", label: "刷新令牌", type: "textarea", required: true, placeholder: "Microsoft OAuth 刷新令牌" },
      { key: "use_online_api", label: "使用在线API", type: "boolean", defaultValue: true },
      {
        key: "api_address",
        label: "在线API地址",
        type: "text",
        defaultValue: "https://api.oplist.org/onedrive/renewapi",
        placeholder: "自建刷新接口地址",
        show: (values) => values.use_online_api === true,
      },
      {
        key: "client_id",
        label: "客户端ID",
        type: "text",
        placeholder: "本地客户端ID",
        show: (values) => values.use_online_api !== true,
      },
      {
        key: "client_secret",
        label: "客户端密钥",
        type: "password",
        placeholder: "本地客户端密钥",
        show: (values) => values.use_online_api !== true,
      },
      {
        key: "redirect_uri",
        label: "重定向URI",
        type: "text",
        placeholder: "https://api.oplist.org/onedrive/callback",
        defaultValue: "https://api.oplist.org/onedrive/callback",
        show: (values) => values.use_online_api !== true,
      },
      { key: "is_sharepoint", label: "SharePoint 模式", type: "boolean", defaultValue: false },
      {
        key: "site_id",
        label: "SharePoint 站点ID",
        type: "text",
        placeholder: "SharePoint 站点ID",
        show: (values) => values.is_sharepoint === true,
      },
      { key: "root_folder_path", label: "根文件夹路径", type: "text", defaultValue: "/" },
      { key: "chunk_size", label: "分块大小 (MB)", type: "text", defaultValue: "5" },
      { key: "custom_host", label: "自定义下载主机", type: "text", placeholder: "可选：自定义下载域名" },
    ],
  },
  gdrive: {
    name: "Google Drive",
    supportsMultipart: true,
    fields: [
      { key: "refresh_token", label: "刷新令牌", type: "textarea", required: true, placeholder: "Google OAuth 刷新令牌" },
      { key: "use_online_api", label: "使用在线API", type: "boolean", defaultValue: true },
      {
        key: "api_address",
        label: "在线API地址",
        type: "text",
        defaultValue: "https://api.oplist.org/googleui/renewapi",
        placeholder: "自建刷新接口地址",
        show: (values) => values.use_online_api === true,
      },
      {
        key: "client_id",
        label: "客户端ID",
        type: "text",
        placeholder: "本地客户端ID",
        show: (values) => values.use_online_api !== true,
      },
      {
        key: "client_secret",
        label: "客户端密钥",
        type: "password",
        placeholder: "本地客户端密钥",
        show: (values) => values.use_online_api !== true,
      },
      { key: "root_folder_id", label: "根目录ID", type: "text", defaultValue: "root", placeholder: "默认 root" },
      { key: "order_by", label: "排序字段", type: "text", defaultValue: "folder,name,modifiedTime", placeholder: "folder,name,modifiedTime" },
      {
        key: "order_direction",
        label: "排序方向",
        type: "select",
        options: [
          { value: "asc", label: "升序" },
          { value: "desc", label: "降序" },
        ],
        defaultValue: "asc",
      },
      { key: "chunk_size", label: "分块大小 (MB)", type: "text", defaultValue: "5" },
    ],
  },
  alicloud: {
    name: "阿里云盘",
    supportsMultipart: true,
    fields: [
      {
        key: "drive_type",
        label: "驱动类型",
        type: "select",
        required: true,
        options: [
          { value: "resource", label: "资源库" },
          { value: "backup", label: "备份盘" },
          { value: "default", label: "默认" },
        ],
        defaultValue: "resource",
      },
      { key: "refresh_token", label: "刷新令牌", type: "textarea", required: true },
      { key: "root_folder_id", label: "根目录ID", type: "text", defaultValue: "root" },
      {
        key: "order_by",
        label: "排序方式",
        type: "select",
        options: [
          { value: "name", label: "文件名" },
          { value: "size", label: "文件大小" },
          { value: "updated_at", label: "修改时间" },
          { value: "created_at", label: "创建时间" },
        ],
        defaultValue: "name",
      },
      {
        key: "order_direction",
        label: "排序方向",
        type: "select",
        options: [
          { value: "ASC", label: "升序" },
          { value: "DESC", label: "降序" },
        ],
        defaultValue: "ASC",
      },
      { key: "use_online_api", label: "使用在线API", type: "boolean", defaultValue: true },
      {
        key: "api_address",
        label: "在线API地址",
        type: "text",
        defaultValue: "https://api.oplist.org/alicloud/renewapi",
        placeholder: "自建刷新接口地址",
        show: (values) => values.use_online_api === true,
      },
      {
        key: "client_id",
        label: "客户端ID",
        type: "text",
        placeholder: "本地客户端ID",
        show: (values) => values.use_online_api !== true,
      },
      {
        key: "client_secret",
        label: "客户端密钥",
        type: "password",
        placeholder: "本地客户端密钥",
        show: (values) => values.use_online_api !== true,
      },
      {
        key: "remove_way",
        label: "删除方式",
        type: "select",
        options: [
          { value: "trash", label: "移到回收站" },
          { value: "delete", label: "直接删除" },
        ],
        defaultValue: "trash",
      },
      { key: "rapid_upload", label: "秒传", type: "boolean", defaultValue: false },
      { key: "internal_upload", label: "内网上传", type: "boolean", defaultValue: false },
      {
        key: "livp_download_format",
        label: "LIVP 下载格式",
        type: "select",
        options: [
          { value: "jpeg", label: "JPEG" },
          { value: "mov", label: "MOV" },
        ],
        defaultValue: "jpeg",
      },
      {
        key: "alipan_type",
        label: "云盘类型",
        type: "select",
        options: [
          { value: "default", label: "默认" },
          { value: "alipanTV", label: "阿里云盘TV" },
        ],
        defaultValue: "default",
      },
    ],
  },
  baiduyun: {
    name: "百度网盘",
    supportsMultipart: false,
    fields: [
      { key: "refresh_token", label: "刷新令牌", type: "textarea", required: true },
      { key: "root_path", label: "根目录路径", type: "text", defaultValue: "/" },
      {
        key: "order_by",
        label: "排序方式",
        type: "select",
        options: [
          { value: "name", label: "文件名" },
          { value: "time", label: "修改时间" },
          { value: "size", label: "文件大小" },
        ],
        defaultValue: "name",
      },
      {
        key: "order_direction",
        label: "排序方向",
        type: "select",
        options: [
          { value: "asc", label: "升序" },
          { value: "desc", label: "降序" },
        ],
        defaultValue: "asc",
      },
      { key: "use_online_api", label: "使用在线API", type: "boolean", defaultValue: true },
      {
        key: "api_address",
        label: "在线API地址",
        type: "text",
        defaultValue: "https://api.oplist.org/baiduyun/renewapi",
        placeholder: "自建刷新接口地址",
        show: (values) => values.use_online_api === true,
      },
      {
        key: "client_id",
        label: "客户端ID",
        type: "text",
        placeholder: "本地客户端ID",
        show: (values) => values.use_online_api !== true,
      },
      {
        key: "client_secret",
        label: "客户端密钥",
        type: "password",
        placeholder: "本地客户端密钥",
        show: (values) => values.use_online_api !== true,
      },
    ],
  },
  s3: {
    name: "S3 兼容服务",
    supportsMultipart: true,
    fields: [
      {
        key: "forcePathStyle",
        label: "强制使用 Path-Style 访问",
        type: "boolean",
        defaultValue: false,
        help: "默认(关闭)=自动识别：IP/本地/带端口端点用 Path-Style，域名端点用虚拟托管(Virtual-Hosted)。阿里云 OSS / AWS S3 / R2 保持关闭即可。仅当 MinIO 用了域名但没配泛域名解析时才需手动开启。",
      },
    ],
  },
};

function supportsMultipart(type?: string): boolean {
  if (!type) {
    return true;
  }
  if (type === "webdev") {
    return false;
  }
  if (type === "s3") {
    return true;
  }
  const config = driveConfigMap[type];
  if (config) {
    return config.supportsMultipart;
  }
  return false;
}

interface AuditLog {
  id: number;
  action: string;
  storageId: number | null;
  path: string | null;
  userType: "guest" | "admin" | "share";
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
  createdAt: string;
}


function formatBytes(bytes: number): string {
  if (bytes === 0) return "-";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond === 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleString("zh-CN");
}

function Modal({ title, onClose, children, maxWidth = "max-w-sm" }: { title: string; onClose: () => void; children: React.ReactNode; maxWidth?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`w-full ${maxWidth} rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="关闭">
            <X />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
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
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-sm rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm">管理员登录</span>
          <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="关闭"><X /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full field"
              required
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full field"
              required
            />
          </div>
          {error && <div className="text-red-500 dark:text-red-400 text-xs font-medium">{error}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-500 text-sm transition rounded"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50 transition rounded"
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
  const initConfig = (type: string, existing?: Record<string, any>) => {
    const fields = driveConfigMap[type]?.fields || [];
    const base = { ...(existing || {}) };
    if (base.api_address === undefined && base.api_url_address !== undefined) {
      base.api_address = base.api_url_address;
    }
    for (const field of fields) {
      if (base[field.key] === undefined && field.defaultValue !== undefined) {
        base[field.key] = field.defaultValue;
      }
    }
    const hasLocalClient = Boolean(String(base.client_id || "").trim() && String(base.client_secret || "").trim());
    if (fields.some((field) => field.key === "use_online_api") && !hasLocalClient) {
      base.use_online_api = true;
    }
    return base;
  };

  const [formData, setFormData] = useState({
    name: storage?.name || "",
    type: storage?.type || "s3",
    endpoint: storage?.endpoint || "",
    region: storage?.region || "auto",
    accessKeyId: storage?.accessKeyId || "",
    secretAccessKey: "",
    bucket: storage?.bucket || "",
    basePath: storage?.basePath || "",
    config: initConfig(storage?.type || "s3", storage?.config),
    isPublic: storage?.isPublic ?? false,
    guestList: storage?.guestList ?? false,
    guestDownload: storage?.guestDownload ?? false,
    guestUpload: storage?.guestUpload ?? false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const driveConfig = driveConfigMap[formData.type || ""];
  const isS3 = formData.type === "s3";
  const isWebdav = formData.type === "webdev";

  const handleTypeChange = (nextType: string) => {
    setFormData({
      ...formData,
      type: nextType,
      endpoint: nextType === "s3" || nextType === "webdev" ? formData.endpoint : "",
      region: nextType === "s3" ? formData.region : "auto",
      accessKeyId: nextType === "s3" || nextType === "webdev" ? formData.accessKeyId : "",
      secretAccessKey: "",
      bucket: nextType === "s3" ? formData.bucket : "",
      basePath: nextType === "s3" || nextType === "webdev" ? formData.basePath : "",
      config: initConfig(nextType, {}),
    });
  };

  const updateConfigValue = (key: string, value: string | number | boolean) => {
    setFormData({
      ...formData,
      config: { ...(formData.config || {}), [key]: value },
    });
  };

  const renderConfigField = (field: ConfigField) => {
    const values = formData.config || {};
    if (field.show && !field.show(values)) {
      return null;
    }

    const commonClasses = "w-full field";
    const value = values[field.key] ?? "";

    if (field.type === "boolean") {
      return (
        <label key={field.key} className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => updateConfigValue(field.key, e.target.checked)}
            className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
          />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">{field.label}</span>
          {field.help && <span className="text-xs text-zinc-500">{field.help}</span>}
        </label>
      );
    }

    if (field.type === "select") {
      return (
        <div key={field.key}>
          <label className="block text-xs text-zinc-500 mb-1.5">{field.label}{field.required ? " *" : ""}</label>
          <select
            value={String(value)}
            onChange={(e) => updateConfigValue(field.key, e.target.value)}
            className={commonClasses}
            required={field.required}
          >
            {(field.options || []).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      );
    }

    if (field.type === "textarea") {
      return (
        <div key={field.key}>
          <label className="block text-xs text-zinc-500 mb-1.5">{field.label}{field.required ? " *" : ""}</label>
          <textarea
            value={String(value)}
            onChange={(e) => updateConfigValue(field.key, e.target.value)}
            className={`${commonClasses} h-24`}
            placeholder={field.placeholder || ""}
            required={field.required}
          />
        </div>
      );
    }

    return (
      <div key={field.key}>
        <label className="block text-xs text-zinc-500 mb-1.5">{field.label}{field.required ? " *" : ""}</label>
        <input
          type={field.type}
          value={String(value)}
          onChange={(e) => updateConfigValue(field.key, e.target.value)}
          className={commonClasses}
          placeholder={field.placeholder || ""}
          required={field.required}
        />
      </div>
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const method = storage ? "PUT" : "POST";
      const configToSend = { ...(formData.config || {}) };
      if (configToSend.api_address && !configToSend.api_url_address) {
        configToSend.api_url_address = configToSend.api_address;
      }
      if (driveConfig) {
        for (const field of driveConfig.fields) {
          if (field.type === "password" && !configToSend[field.key]) {
            delete configToSend[field.key];
          }
        }
      }
      const body = storage
        ? { id: storage.id, ...formData, config: configToSend }
        : { ...formData, config: configToSend };

      if (storage && !formData.secretAccessKey && (isS3 || isWebdav)) {
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
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between sticky top-0 bg-white dark:bg-zinc-900 rounded-t-lg">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm">{storage ? "编辑存储" : "添加存储"}</span>
          <button onClick={onCancel} className="icon-btn h-7 w-7" aria-label="关闭"><X /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs text-zinc-500 mb-1.5">名称 *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full field"
                placeholder="My Storage"
                required
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-zinc-500 mb-1.5">存储类型 *</label>
              <select
                value={formData.type}
                onChange={(e) => handleTypeChange(e.target.value)}
                className="w-full field"
                required
              >
                <option value="s3">S3 兼容服务</option>
                <option value="webdev">WebDAV</option>
                <option value="onedrive">OneDrive</option>
                <option value="gdrive">Google Drive</option>
                <option value="alicloud">阿里云盘</option>
                <option value="baiduyun">百度网盘</option>
              </select>
            </div>
            {(isS3 || isWebdav) && (
              <div className="col-span-2">
                <label className="block text-xs text-zinc-500 mb-1.5">
                  {isWebdav ? "WebDAV 服务器地址" : "Endpoint"} *
                </label>
                <input
                  type="url"
                  value={formData.endpoint}
                  onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                  className="w-full field"
                  placeholder={isWebdav ? "https://example.com/webdav" : "https://s3.us-east-1.amazonaws.com"}
                  required
                />
              </div>
            )}
            {isS3 && (
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Region</label>
                <input
                  type="text"
                  value={formData.region}
                  onChange={(e) => setFormData({ ...formData, region: e.target.value })}
                  className="w-full field"
                  placeholder="auto"
                />
              </div>
            )}
            {isS3 && (
              <div>
                <label className="block text-xs text-zinc-500 mb-1.5">Bucket *</label>
                <input
                  type="text"
                  value={formData.bucket}
                  onChange={(e) => setFormData({ ...formData, bucket: e.target.value })}
                  className="w-full field"
                  placeholder="my-bucket"
                  required={isS3}
                />
              </div>
            )}
            {(isS3 || isWebdav) && (
              <>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">
                    {isWebdav ? "用户名" : "Access Key"} *
                  </label>
                  <input
                    type="text"
                    value={formData.accessKeyId}
                    onChange={(e) => setFormData({ ...formData, accessKeyId: e.target.value })}
                    className="w-full field"
                    required={!storage && (isS3 || isWebdav)}
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">
                    {isWebdav ? "密码" : "Secret Key"} {storage && "(留空保持)"}
                  </label>
                  <input
                    type="password"
                    value={formData.secretAccessKey}
                    onChange={(e) => setFormData({ ...formData, secretAccessKey: e.target.value })}
                    className="w-full field"
                    required={!storage && (isS3 || isWebdav)}
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-zinc-500 mb-1.5">根路径</label>
                  <input
                    type="text"
                    value={formData.basePath}
                    onChange={(e) => setFormData({ ...formData, basePath: e.target.value })}
                    className="w-full field"
                    placeholder="/path/to/folder"
                  />
                </div>
              </>
            )}
            {driveConfig && (
              <div className="col-span-2 border-t border-zinc-200 dark:border-zinc-700 pt-3 mt-1">
                <div className="text-xs text-zinc-500 mb-2 font-medium">驱动配置 - {driveConfig.name}</div>
                <div className="space-y-3">
                  {driveConfig.fields.map(renderConfigField)}
                </div>
              </div>
            )}
            <div className="col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.isPublic}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setFormData({
                      ...formData,
                      isPublic: checked,
                      guestList: checked,
                      guestDownload: checked,
                    });
                  }}
                  className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                />
                <span className="text-sm text-zinc-700 dark:text-zinc-300">公开访问</span>
                <span className="text-xs text-zinc-500">(快速开启浏览和下载)</span>
              </label>
            </div>
            <div className="col-span-2 border-t border-zinc-200 dark:border-zinc-700 pt-3 mt-1">
              <div className="text-xs text-zinc-500 mb-2 font-medium">游客权限设置</div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.guestList}
                    onChange={(e) => setFormData({ ...formData, guestList: e.target.checked })}
                    className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                  />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">允许浏览</span>
                  <span className="text-xs text-zinc-500">(查看文件列表)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.guestDownload}
                    onChange={(e) => setFormData({ ...formData, guestDownload: e.target.checked })}
                    className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                  />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">允许下载</span>
                  <span className="text-xs text-zinc-500">(下载和预览文件)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.guestUpload}
                    onChange={(e) => setFormData({ ...formData, guestUpload: e.target.checked })}
                    className="w-4 h-4 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded"
                  />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">允许上传</span>
                  <span className="text-xs text-zinc-500">(上传新文件)</span>
                </label>
              </div>
            </div>
          </div>
          {error && <div className="text-red-500 dark:text-red-400 text-xs font-medium">{error}</div>}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-2 px-4 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-400 dark:hover:border-zinc-500 text-sm transition rounded"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50 transition rounded"
            >
              {loading ? "保存中..." : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SettingsModal({
  onClose,
  siteTitle,
  siteAnnouncement,
  isDark,
  onToggleTheme,
  isAdmin,
  onRefreshStorages,
  webdavEnabled,
  storages,
}: {
  onClose: () => void;
  siteTitle: string;
  siteAnnouncement: string;
  isDark: boolean;
  onToggleTheme: (e: React.MouseEvent) => void;
  isAdmin: boolean;
  onRefreshStorages: () => void;
  webdavEnabled: boolean;
  storages: StorageInfo[];
}) {
  const [activeTab, setActiveTab] = useState<'general' | 'webdav' | 'backup' | 'audit' | 'about'>('general');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");

  const handleExportBackup = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/storages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export-backup" }),
      });

      if (res.ok) {
        const data = await res.json() as { backup: unknown };
        const blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `clist-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const data = await res.json() as { error?: string };
        alert(data.error || "导出失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setExporting(false);
    }
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setImportResult(null);

    try {
      const text = await file.text();
      const backup = JSON.parse(text);

      if (!backup.storages || !Array.isArray(backup.storages)) {
        setImportResult({ success: false, message: "无效的备份文件格式" });
        return;
      }

      const res = await fetch("/api/storages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import-backup", backup, mode: importMode }),
      });

      const data = await res.json() as { success?: boolean; imported?: number; skipped?: number; errors?: string[]; error?: string };

      if (res.ok && data.success) {
        let message = `成功导入 ${data.imported} 个存储`;
        if (data.skipped && data.skipped > 0) {
          message += `，跳过 ${data.skipped} 个已存在的存储`;
        }
        if (data.errors && data.errors.length > 0) {
          message += `\n\n错误:\n${data.errors.join("\n")}`;
        }
        setImportResult({ success: true, message });
        onRefreshStorages();
      } else {
        setImportResult({ success: false, message: data.error || "导入失败" });
      }
    } catch (err) {
      setImportResult({ success: false, message: err instanceof Error ? err.message : "解析备份文件失败" });
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  const fetchAuditLogs = async () => {
    setAuditLoading(true);
    setAuditError("");
    try {
      const res = await fetch("/api/audit?limit=200");
      if (res.ok) {
        const data = await res.json() as { logs?: AuditLog[] };
        setAuditLogs(data.logs || []);
      } else {
        const data = await res.json() as { error?: string };
        setAuditError(data.error || "加载审计日志失败");
      }
    } catch {
      setAuditError("网络错误");
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "audit" && isAdmin) {
      fetchAuditLogs();
    }
  }, [activeTab, isAdmin]);

  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-md rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm">设置</span>
          <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="关闭"><X /></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-200 dark:border-zinc-700">
          <button
            onClick={() => setActiveTab('general')}
            className={`flex-1 px-4 py-2 text-xs font-medium transition ${
              activeTab === 'general'
                ? 'text-blue-500 border-b-2 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            常规
          </button>
          {isAdmin && (
            <button
              onClick={() => setActiveTab('webdav')}
              className={`flex-1 px-4 py-2 text-xs font-medium transition ${
                activeTab === 'webdav'
                  ? 'text-blue-500 border-b-2 border-blue-500'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
              }`}
            >
              WebDAV
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setActiveTab('backup')}
              className={`flex-1 px-4 py-2 text-xs font-medium transition ${
                activeTab === 'backup'
                  ? 'text-blue-500 border-b-2 border-blue-500'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
              }`}
            >
              备份
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setActiveTab('audit')}
              className={activeTab === 'audit' ? 'flex-1 px-4 py-2 text-xs font-medium transition text-blue-500 border-b-2 border-blue-500' : 'flex-1 px-4 py-2 text-xs font-medium transition text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'}
            >
              审计
            </button>
          )}
          <button
            onClick={() => setActiveTab('about')}
            className={`flex-1 px-4 py-2 text-xs font-medium transition ${
              activeTab === 'about'
                ? 'text-blue-500 border-b-2 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            关于
          </button>
        </div>

        <div className="p-4">
          {activeTab === 'general' && (
            <div className="space-y-4">
              {/* Theme Setting */}
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold">主题模式</div>
                  <div className="text-xs text-zinc-500">切换亮色或暗色主题</div>
                </div>
                <button
                  onClick={onToggleTheme}
                  className="px-3 py-1.5 text-xs font-medium rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition"
                >
                  {isDark ? '☀ 亮色' : '☾ 暗色'}
                </button>
              </div>

              {/* Announcement */}
              {siteAnnouncement && (
                <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                  <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2 flex items-center gap-2">
                    <span className="text-yellow-500">📢</span> 公告
                  </div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono whitespace-pre-wrap bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700 max-h-32 overflow-y-auto">
                    {siteAnnouncement}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'webdav' && isAdmin && (
            <div className="space-y-4">
              {/* WebDAV Status */}
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold">WebDAV 服务</div>
                  <div className="text-xs text-zinc-500">通过 WebDAV 协议访问存储</div>
                </div>
                <span className={`px-2 py-1 text-xs font-medium rounded ${
                  webdavEnabled 
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' 
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
                }`}>
                  {webdavEnabled ? '已启用' : '未启用'}
                </span>
              </div>

              {webdavEnabled ? (
                <>
                  {/* WebDAV URL */}
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                    <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">访问地址</div>
                    <div className="text-xs text-zinc-500 mb-3">
                      使用 WebDAV 客户端连接以下地址访问存储
                    </div>
                    <div className="bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700">
                      <div className="text-xs text-zinc-500 mb-1.5">根目录 (所有存储):</div>
                      <code className="text-sm text-blue-600 dark:text-blue-400 font-mono break-all">
                        {typeof window !== 'undefined' ? `${window.location.origin}/dav/0/` : '/dav/0/'}
                      </code>
                    </div>
                  </div>

                  {/* Storage List with WebDAV URLs */}
                  {storages.length > 0 && (
                    <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                      <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">存储访问地址</div>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {storages.map((storage) => (
                          <div key={storage.id} className="bg-zinc-50 dark:bg-zinc-800 p-2 rounded border border-zinc-200 dark:border-zinc-700">
                            <div className="text-xs text-zinc-700 dark:text-zinc-300 font-mono mb-1">{storage.name}</div>
                            <code className="text-xs text-blue-600 dark:text-blue-400 font-mono break-all">
                              {typeof window !== 'undefined' ? `${window.location.origin}/dav/${storage.id}/` : `/dav/${storage.id}/`}
                            </code>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Authentication Info */}
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                    <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">认证方式</div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono space-y-1">
                      <p>• 协议: HTTP Basic Authentication</p>
                      <p>• 用户名/密码: 使用 WEBDAV_USERNAME/WEBDAV_PASSWORD 环境变量配置</p>
                      <p>• 默认: 使用管理员账号密码 (ADMIN_USERNAME/ADMIN_PASSWORD)</p>
                    </div>
                  </div>

                  {/* Usage Tips */}
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                    <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2 flex items-center gap-2">
                      <span className="text-blue-500">💡</span> 使用提示
                    </div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono space-y-1">
                      <p>• Windows: 映射网络驱动器，输入 WebDAV 地址</p>
                      <p>• macOS: Finder → 前往 → 连接服务器</p>
                      <p>• Linux: 使用 davfs2 或文件管理器</p>
                      <p>• 移动端: 使用支持 WebDAV 的文件管理 App</p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                  <div className="text-xs text-zinc-500 font-medium space-y-2">
                    <p>WebDAV 服务未启用。要启用 WebDAV，请在 Cloudflare Workers 环境变量中设置:</p>
                    <div className="bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700 mt-2">
                      <code className="text-xs text-zinc-700 dark:text-zinc-300">WEBDAV_ENABLED = "true"</code>
                    </div>
                    <p className="mt-2">可选配置:</p>
                    <div className="bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700">
                      <code className="text-xs text-zinc-700 dark:text-zinc-300 block">WEBDAV_USERNAME = "your_username"</code>
                      <code className="text-xs text-zinc-700 dark:text-zinc-300 block">WEBDAV_PASSWORD = "your_password"</code>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'backup' && isAdmin && (
            <div className="space-y-4">
              {/* Export Section */}
              <div>
                <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">导出备份</div>
                <div className="text-xs text-zinc-500 mb-3">
                  导出所有存储配置到 JSON 文件，包含连接凭证信息。
                </div>
                <button
                  onClick={handleExportBackup}
                  disabled={exporting}
                  className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50 transition rounded"
                >
                  {exporting ? "导出中..." : "导出备份文件"}
                </button>
              </div>

              {/* Import Section */}
              <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-2">恢复备份</div>
                <div className="text-xs text-zinc-500 mb-3">
                  从备份文件恢复存储配置。
                </div>

                {/* Import Mode Selection */}
                <div className="mb-3">
                  <div className="text-xs text-zinc-500 mb-2 font-medium">导入模式:</div>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="importMode"
                        value="merge"
                        checked={importMode === 'merge'}
                        onChange={() => setImportMode('merge')}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">合并</span>
                      <span className="text-xs text-zinc-500">(保留现有)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="importMode"
                        value="replace"
                        checked={importMode === 'replace'}
                        onChange={() => setImportMode('replace')}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">替换</span>
                      <span className="text-xs text-zinc-500">(清空现有)</span>
                    </label>
                  </div>
                </div>

                <label className={`block w-full py-2 px-4 text-center border-2 border-dashed border-zinc-300 dark:border-zinc-600 hover:border-blue-500 dark:hover:border-blue-500 text-sm cursor-pointer transition rounded ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
                  {importing ? "导入中..." : "选择备份文件"}
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleImportBackup}
                    className="hidden"
                    disabled={importing}
                  />
                </label>

                {/* Import Result */}
                {importResult && (
                  <div className={`mt-3 p-3 rounded text-xs font-medium whitespace-pre-wrap ${
                    importResult.success
                      ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800'
                      : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
                  }`}>
                    {importResult.message}
                  </div>
                )}
              </div>

              {/* Warning */}
              <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                <div className="text-xs text-yellow-600 dark:text-yellow-500 font-mono flex items-start gap-2">
                  <span>⚠</span>
                  <span>备份文件包含敏感凭证信息，请妥善保管。</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'audit' && isAdmin && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold">审计日志</div>
                <button
                  onClick={fetchAuditLogs}
                  disabled={auditLoading}
                  className="px-3 py-1 text-xs font-medium rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-50 transition"
                >
                  {auditLoading ? '加载中...' : '刷新'}
                </button>
              </div>
              {auditError && (
                <div className="text-xs text-red-500 dark:text-red-400 font-mono">{auditError}</div>
              )}
              {!auditError && auditLogs.length === 0 && !auditLoading && (
                <div className="text-xs text-zinc-500 font-medium">暂无日志</div>
              )}
              {auditLogs.length > 0 && (
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {auditLogs.map((log) => (
                    <div key={log.id} className="border border-zinc-200 dark:border-zinc-700 rounded p-2 bg-zinc-50 dark:bg-zinc-800/50">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-500 font-medium">{formatDate(log.createdAt)}</span>
                        <span className="text-[11px] text-zinc-400 font-mono">{log.userType}</span>
                      </div>
                      <div className="text-xs text-zinc-800 dark:text-zinc-200 font-mono">{log.action}</div>
                      <div className="text-[11px] text-zinc-500 font-mono">
                        {log.storageId ? `storage #${log.storageId}` : 'storage -'}
                        {log.path ? ` / ${log.path}` : ''}
                      </div>
                      {log.detail && (
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 font-mono mt-1 break-all">{log.detail}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'about' && (
            <div className="space-y-4">
              <div className="text-center py-4">
                <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 font-semibold mb-1">{siteTitle}</div>
                <div className="text-xs text-zinc-500 font-medium">v1.2.0</div>
              </div>
              <div className="text-xs text-zinc-600 dark:text-zinc-400 font-mono space-y-2">
                <p>S3 兼容存储聚合服务</p>
                <p className="text-zinc-500">支持: AWS S3 / Cloudflare R2 / 阿里云 OSS / 腾讯云 COS / MinIO / WebDAV / OneDrive / Google Drive / 阿里云盘 / 百度网盘</p>
                <p>作者: ooyyh</p>
                <p>联系方式: 3266940347@qq.com</p>
              </div>
              <div className="border-t border-zinc-200 dark:border-zinc-800 pt-4 text-xs text-zinc-500 font-medium">
                <p>Powered by Cloudflare Workers && ooyyh</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AnnouncementModal({ announcement, onClose }: { announcement: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-lg rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm flex items-center gap-2">
            <span className="text-yellow-500">📢</span> 公告
          </span>
          <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="关闭"><X /></button>
        </div>
        <div className="p-4">
          <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">
            {announcement}
          </p>
        </div>
        <div className="px-4 pb-4">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded"
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}

interface StorageStats {
  totalSize: number;
  fileCount: number;
  folderCount: number;
  typeDistribution: Record<string, { count: number; size: number }>;
}

const chartColors = ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#84cc16", "#ec4899", "#64748b", "#14b8a6"];

function buildConicGradient(items: Array<{ percentage: number; color: string }>): string {
  if (items.length === 0) {
    return "conic-gradient(#d4d4d8 0deg 360deg)";
  }
  let start = 0;
  const stops = items.map((item) => {
    const end = start + item.percentage * 3.6;
    const stop = `${item.color} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
    start = end;
    return stop;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

function StorageStatsModal({ storage, onClose }: { storage: StorageInfo; onClose: () => void }) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/storage-stats/${storage.id}`);
        if (res.ok) {
          const data = (await res.json()) as { stats: StorageStats };
          setStats(data.stats);
        } else {
          const data = (await res.json()) as { error?: string };
          setError(data.error || "获取统计信息失败");
        }
      } catch {
        setError("网络错误");
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [storage.id]);

  const sortedTypes = stats
    ? Object.entries(stats.typeDistribution)
        .sort((a, b) => b[1].size - a[1].size)
    : [];
  const chartItems = stats
    ? (() => {
        const topTypes = sortedTypes.slice(0, 10);
        const items = topTypes.map(([ext, data], index) => ({
          ext,
          count: data.count,
          size: data.size,
          percentage: stats.totalSize > 0 ? (data.size / stats.totalSize) * 100 : 0,
          color: chartColors[index % chartColors.length],
        }));
        const shownSize = topTypes.reduce((sum, [, data]) => sum + data.size, 0);
        const shownCount = topTypes.reduce((sum, [, data]) => sum + data.count, 0);
        const restSize = stats.totalSize - shownSize;
        const restCount = stats.fileCount - shownCount;
        if (restSize > 0 || restCount > 0) {
          items.push({
            ext: "other",
            count: Math.max(0, restCount),
            size: Math.max(0, restSize),
            percentage: stats.totalSize > 0 ? (Math.max(0, restSize) / stats.totalSize) * 100 : 0,
            color: chartColors[items.length % chartColors.length],
          });
        }
        return items;
      })()
    : [];
  const donutGradient = buildConicGradient(chartItems.map(({ percentage, color }) => ({ percentage, color })));
  const dominantType = chartItems[0];

  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl max-h-[84vh] rounded-xl shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between shrink-0">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-600 shadow-sm dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-300">
              <BarChart3 className="h-[18px] w-[18px]" />
            </span>
            存储统计 - {storage.name}
          </span>
          <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="关闭"><X /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-zinc-400 dark:text-zinc-500 text-sm">正在统计中，请稍候...</span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-red-500 text-sm">{error}</span>
            </div>
          ) : stats ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                  <div className="text-xs text-zinc-500 font-medium mb-1">总大小</div>
                  <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{formatBytes(stats.totalSize)}</div>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                  <div className="text-xs text-zinc-500 font-medium mb-1">文件数量</div>
                  <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{stats.fileCount.toLocaleString()}</div>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                  <div className="text-xs text-zinc-500 font-medium mb-1">文件夹数量</div>
                  <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{stats.folderCount.toLocaleString()}</div>
                </div>
              </div>

              {sortedTypes.length > 0 && (
                <>
                  <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-3">
                    <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-xs text-zinc-500 font-medium">容量构成</div>
                        <div className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">Top {chartItems.length}</div>
                      </div>
                      <div className="flex items-center justify-center">
                        <div
                          className="relative h-40 w-40 rounded-full shadow-inner"
                          style={{ background: donutGradient }}
                          aria-label="文件类型容量环形图"
                        >
                          <div className="absolute inset-5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 flex flex-col items-center justify-center">
                            <div className="text-[11px] text-zinc-500 font-mono">主类型</div>
                            <div className="text-xl text-zinc-900 dark:text-zinc-100 font-semibold">{dominantType ? `.${dominantType.ext}` : "-"}</div>
                            <div className="text-xs text-zinc-500 font-medium">{dominantType ? `${dominantType.percentage.toFixed(1)}%` : "0%"}</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                      <div className="text-xs text-zinc-500 font-medium mb-3">类型占比</div>
                      <div className="h-4 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700 flex">
                        {chartItems.map((item) => (
                          <div
                            key={item.ext}
                            title={`.${item.ext} ${item.percentage.toFixed(1)}%`}
                            style={{ width: `${Math.max(item.percentage, 1)}%`, backgroundColor: item.color }}
                          />
                        ))}
                      </div>
                      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {chartItems.slice(0, 6).map((item) => (
                          <div key={item.ext} className="min-w-0 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                              <span className="truncate text-xs text-zinc-700 dark:text-zinc-300 font-mono">.{item.ext}</span>
                            </div>
                            <div className="mt-1 text-[11px] text-zinc-500 font-mono">{formatBytes(item.size)} · {item.percentage.toFixed(1)}%</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                    <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-3">文件类型排行</div>
                    <div className="space-y-2.5">
                      {chartItems.map((item) => (
                        <div key={item.ext} className="grid grid-cols-[minmax(48px,72px)_minmax(0,1fr)_minmax(84px,112px)] items-center gap-2 sm:gap-3 text-xs font-medium">
                          <div className="truncate text-zinc-700 dark:text-zinc-300">.{item.ext}</div>
                          <div className="h-3 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${Math.max(item.percentage, 1)}%`, backgroundColor: item.color }}
                            />
                          </div>
                          <div className="text-right text-zinc-500">
                            {formatBytes(item.size)} · {item.count.toLocaleString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {stats.fileCount === 0 && (
                <div className="text-center py-8">
                  <span className="text-zinc-400 dark:text-zinc-500 text-sm">此存储为空</span>
                </div>
              )}
            </div>
          ) : null}
        </div>
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderStatsModal({ name, stats, onClose }: { name: string; stats: StorageStats; onClose: () => void }) {
  const sortedTypes = Object.entries(stats.typeDistribution).sort((a, b) => b[1].size - a[1].size);
  const chartItems = (() => {
    const topTypes = sortedTypes.slice(0, 10);
    const items = topTypes.map(([ext, data], index) => ({
      ext, count: data.count, size: data.size,
      percentage: stats.totalSize > 0 ? (data.size / stats.totalSize) * 100 : 0,
      color: chartColors[index % chartColors.length],
    }));
    const shownSize = topTypes.reduce((s, [, d]) => s + d.size, 0);
    const shownCount = topTypes.reduce((s, [, d]) => s + d.count, 0);
    const restSize = stats.totalSize - shownSize;
    const restCount = stats.fileCount - shownCount;
    if (restSize > 0 || restCount > 0) {
      items.push({ ext: "other", count: Math.max(0, restCount), size: Math.max(0, restSize), percentage: stats.totalSize > 0 ? (Math.max(0, restSize) / stats.totalSize) * 100 : 0, color: chartColors[items.length % chartColors.length] });
    }
    return items;
  })();
  const donutGradient = buildConicGradient(chartItems.map(({ percentage, color }) => ({ percentage, color })));
  const dominantType = chartItems[0];

  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl max-h-[84vh] rounded-xl shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between shrink-0">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-600 shadow-sm dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-300">
              <Calculator className="h-[18px] w-[18px]" />
            </span>
            目录统计 - {name}
          </span>
          <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="关闭"><X /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                <div className="text-xs text-zinc-500 font-medium mb-1">总大小</div>
                <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{formatBytes(stats.totalSize)}</div>
              </div>
              <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                <div className="text-xs text-zinc-500 font-medium mb-1">文件数量</div>
                <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{stats.fileCount.toLocaleString()}</div>
              </div>
              <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                <div className="text-xs text-zinc-500 font-medium mb-1">文件夹数量</div>
                <div className="text-2xl tabular-nums font-semibold text-zinc-900 dark:text-zinc-100">{stats.folderCount.toLocaleString()}</div>
              </div>
            </div>
            {sortedTypes.length > 0 ? (
              <>
                <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-3">
                  <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-xs text-zinc-500 font-medium">容量构成</div>
                      <div className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">Top {chartItems.length}</div>
                    </div>
                    <div className="flex items-center justify-center">
                      <div className="relative h-40 w-40 rounded-full shadow-inner" style={{ background: donutGradient }} aria-label="文件类型容量环形图">
                        <div className="absolute inset-5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 flex flex-col items-center justify-center">
                          <div className="text-[11px] text-zinc-500 font-mono">主类型</div>
                          <div className="text-xl text-zinc-900 dark:text-zinc-100 font-semibold">{dominantType ? `.${dominantType.ext}` : "-"}</div>
                          <div className="text-xs text-zinc-500 font-medium">{dominantType ? `${dominantType.percentage.toFixed(1)}%` : "0%"}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                    <div className="text-xs text-zinc-500 font-medium mb-3">类型占比</div>
                    <div className="h-4 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700 flex">
                      {chartItems.map((item) => (
                        <div key={item.ext} title={`.${item.ext} ${item.percentage.toFixed(1)}%`} style={{ width: `${Math.max(item.percentage, 1)}%`, backgroundColor: item.color }} />
                      ))}
                    </div>
                    <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {chartItems.slice(0, 6).map((item) => (
                        <div key={item.ext} className="min-w-0 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                            <span className="truncate text-xs text-zinc-700 dark:text-zinc-300 font-mono">.{item.ext}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-zinc-500 font-mono">{formatBytes(item.size)} · {item.percentage.toFixed(1)}%</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800 p-4 rounded border border-zinc-200 dark:border-zinc-700">
                  <div className="text-sm text-zinc-900 dark:text-zinc-100 font-semibold mb-3">文件类型排行</div>
                  <div className="space-y-2.5">
                    {chartItems.map((item) => (
                      <div key={item.ext} className="grid grid-cols-[minmax(48px,72px)_minmax(0,1fr)_minmax(84px,112px)] items-center gap-2 sm:gap-3 text-xs font-medium">
                        <div className="truncate text-zinc-700 dark:text-zinc-300">.{item.ext}</div>
                        <div className="h-3 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${Math.max(item.percentage, 1)}%`, backgroundColor: item.color }} />
                        </div>
                        <div className="text-right text-zinc-500">{formatBytes(item.size)} · {item.count.toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-8"><span className="text-zinc-400 dark:text-zinc-500 text-sm">此目录为空</span></div>
            )}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button onClick={onClose} className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded">关闭</button>
        </div>
      </div>
    </div>
  );
}

function ScanModal({ results, scanning, onNavigate, onClose }: { results: { bigFiles: S3Object[]; duplicates: Array<{ size: number; files: S3Object[] }> } | null; scanning: boolean; onNavigate: (key: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl max-h-[84vh] rounded-xl shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between shrink-0">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm">存储扫描 · 大文件 / 潜在重复</span>
          <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="关闭"><X /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {scanning ? (
            <div className="flex items-center justify-center gap-2 py-12 text-zinc-400 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" /> 扫描中…大存储请耐心等候
            </div>
          ) : results ? (
            <>
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">大文件 Top {results.bigFiles.length}</div>
                <div className="space-y-1">
                  {results.bigFiles.map((f) => (
                    <button key={f.key} onClick={() => { onNavigate(f.key); onClose(); }} className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
                      <span className="text-zinc-400 shrink-0">{(() => { const Ic = fileTypeIcon(getFileType(f.name)); return <Ic className="h-4 w-4" />; })()}</span>
                      <span className="truncate flex-1 text-sm text-zinc-700 dark:text-zinc-200">{f.name}</span>
                      <span className="text-xs text-zinc-400 tabular-nums shrink-0">{formatBytes(f.size)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">潜在重复 · {results.duplicates.length} 组（按完全相同大小聚类，&gt;1MB）</div>
                {results.duplicates.length === 0 ? (
                  <div className="text-xs text-zinc-400">未发现潜在重复</div>
                ) : (
                  <div className="space-y-2">
                    {results.duplicates.map((g, i) => (
                      <div key={i} className="rounded border border-zinc-200 dark:border-zinc-700 p-2">
                        <div className="text-xs text-zinc-500 mb-1 font-mono">{formatBytes(g.size)} × {g.files.length} 个</div>
                        {g.files.map((f) => (
                          <button key={f.key} onClick={() => { onNavigate(f.key); onClose(); }} className="flex items-center gap-2 w-full text-left px-1 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
                            <span className="truncate flex-1 text-xs text-zinc-700 dark:text-zinc-300">{f.key}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button onClick={onClose} className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded">关闭</button>
        </div>
      </div>
    </div>
  );
}

interface ReleaseItem {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  isPrerelease: boolean;
  author: string;
}

function ChangelogModal({ onClose }: { onClose: () => void }) {
  const [releases, setReleases] = useState<ReleaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchReleases = async () => {
      try {
        const res = await fetch("/api/changelog");
        if (res.ok) {
          const data = await res.json() as { releases: ReleaseItem[] };
          setReleases(data.releases);
        } else {
          setError("获取更新日志失败");
        }
      } catch {
        setError("网络错误");
      } finally {
        setLoading(false);
      }
    };
    fetchReleases();
  }, []);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  };

  const parseBody = (body: string) => {
    // Parse the changelog body and highlight different types
    return body.split("\n").map((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return null;

      let colorClass = "text-zinc-600 dark:text-zinc-400";
      if (trimmed.toLowerCase().startsWith("#update") || trimmed.toLowerCase().startsWith("update")) {
        colorClass = "text-blue-600 dark:text-blue-400";
      } else if (trimmed.toLowerCase().startsWith("#fix") || trimmed.toLowerCase().startsWith("fix")) {
        colorClass = "text-green-600 dark:text-green-400";
      } else if (trimmed.toLowerCase().startsWith("#breaking") || trimmed.toLowerCase().startsWith("breaking")) {
        colorClass = "text-red-600 dark:text-red-400";
      } else if (trimmed.toLowerCase().startsWith("#new") || trimmed.toLowerCase().startsWith("new")) {
        colorClass = "text-purple-600 dark:text-purple-400";
      }

      return (
        <div key={i} className={`${colorClass} text-sm`}>
          {trimmed}
        </div>
      );
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl max-h-[80vh] rounded-xl shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between shrink-0">
          <span className="text-zinc-900 dark:text-zinc-100 font-semibold text-sm flex items-center gap-2">
            <span className="text-blue-500">📋</span> 更新日志
          </span>
          <button onClick={onClose} className="icon-btn h-7 w-7" aria-label="关闭"><X /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-zinc-400 dark:text-zinc-500 text-sm">加载中...</span>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-red-500 text-sm">{error}</span>
            </div>
          ) : releases.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-zinc-400 dark:text-zinc-500 text-sm">暂无更新日志</span>
            </div>
          ) : (
            <div className="space-y-6">
              {releases.map((release, idx) => (
                <div key={release.version} className="relative">
                  {idx > 0 && <div className="absolute -top-3 left-0 right-0 border-t border-zinc-200 dark:border-zinc-700" />}
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                      idx === 0
                        ? "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400"
                        : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                    }`}>
                      {release.version}
                    </span>
                    {idx === 0 && (
                      <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
                        Latest
                      </span>
                    )}
                    {release.isPrerelease && (
                      <span className="px-2 py-0.5 text-xs font-medium rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400">
                        Pre-release
                      </span>
                    )}
                    <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">
                      {formatDate(release.publishedAt)}
                    </span>
                  </div>
                  {release.name && release.name !== release.version && (
                    <h3 className="text-sm text-zinc-800 dark:text-zinc-200 mb-2">{release.name}</h3>
                  )}
                  <div className="space-y-1 pl-2 border-l-2 border-zinc-200 dark:border-zinc-700">
                    {parseBody(release.body)}
                  </div>
                  <a
                    href={release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-2 text-xs text-blue-500 hover:text-blue-400 font-mono"
                  >
                    查看详情 →
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-500 text-white text-sm transition rounded"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function FileBrowser({ storage, isAdmin, isDark, chunkSizeMB }: { storage: StorageInfo; isAdmin: boolean; isDark: boolean; chunkSizeMB: number }) {
  // Permission checks
  const canList = isAdmin || storage.guestList;
  const canDownload = isAdmin || storage.guestDownload;
  const canUpload = isAdmin || storage.guestUpload;

  const [path, setPath] = useState("");
  const [objects, setObjects] = useState<S3Object[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewFile, setPreviewFile] = useState<S3Object | null>(null);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [showOfflineDownload, setShowOfflineDownload] = useState(false);
  const [offlineUrl, setOfflineUrl] = useState("");
  const [offlineFilename, setOfflineFilename] = useState("");
  const [offlineDownloading, setOfflineDownloading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [readme, setReadme] = useState<string | null>(null);
  const [readmeOpen, setReadmeOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [globalSearch, setGlobalSearch] = useState(false);
  const [globalResults, setGlobalResults] = useState<S3Object[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "gallery">("list");
  const [favorites, setFavorites] = useState<Array<{ storageId: number; key: string; name: string; isDirectory: boolean }>>(() => {
    try { return JSON.parse(localStorage.getItem("clist-favorites") || "[]"); } catch { return []; }
  });
  const [favOpen, setFavOpen] = useState(false);
  const [calcSizeKey, setCalcSizeKey] = useState<string | null>(null);
  const [folderStats, setFolderStats] = useState<{ name: string; stats: StorageStats } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; obj: S3Object } | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cursor, setCursor] = useState<number>(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [scanResults, setScanResults] = useState<{ bigFiles: S3Object[]; duplicates: Array<{ size: number; files: S3Object[] }> } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<S3Object | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [moveTarget, setMoveTarget] = useState<S3Object | null>(null);
  const [moveDestPath, setMoveDestPath] = useState("");
  const [moving, setMoving] = useState(false);
  const [allFolders, setAllFolders] = useState<string[]>([]);
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  const [batchMoveDest, setBatchMoveDest] = useState("");
  const [batchMoving, setBatchMoving] = useState(false);
  const [shareTarget, setShareTarget] = useState<S3Object | null>(null);
  const [shareToken, setShareToken] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [shareQrCode, setShareQrCode] = useState("");
  const [customShareToken, setCustomShareToken] = useState("");
  const [shareExpireHours, setShareExpireHours] = useState(0);
  const [sharePassword, setSharePassword] = useState("");
  const [creatingShare, setCreatingShare] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setPath("");
    setSearchQuery("");
  }, [storage.id]);

  useEffect(() => {
    loadFiles();
    setSelectedKeys(new Set()); // Clear selection on path change
    setCursor(-1);
  }, [storage.id, path]);

  // 目录 README.md 自动展示
  useEffect(() => {
    setReadme(null);
    if (!objects.length) return;
    const f = objects.find((o) => !o.isDirectory && /^readme\.md$/i.test(o.name));
    if (!f) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiFileUrl(storage.id, f.key)}?action=download`);
        if (!res.ok) return;
        const text = await res.text();
        marked.setOptions({ gfm: true, breaks: true });
        const html = await marked(text);
        if (!cancelled) setReadme(html);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, [objects, storage.id]);

  const loadFiles = async () => {
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`${apiFileUrl(storage.id, path)}?action=list`);
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
    window.open(`${apiFileUrl(storage.id, key)}?action=download`, "_blank");
  };

  const deleteFile = async (key: string) => {
    if (!confirm(`确定删除 ${key}?`)) return;
    try {
      const res = await fetch(apiFileUrl(storage.id, key), { method: "DELETE" });
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
      const res = await fetch(`${apiFileUrl(storage.id, key)}?action=rmdir`, { method: "DELETE" });
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

  const startRename = (obj: S3Object) => {
    setRenameTarget(obj);
    setRenameValue(obj.name);
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    if (renameValue.includes("/")) {
      alert("名称不能包含 /");
      return;
    }
    if (renameValue === renameTarget.name) {
      setRenameTarget(null);
      return;
    }

    setRenaming(true);
    try {
      const key = renameTarget.isDirectory ? renameTarget.key : renameTarget.key;
      const res = await fetch(`${apiFileUrl(storage.id, key)}?action=rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: renameValue.trim() }),
      });
      if (res.ok) {
        setRenameTarget(null);
        loadFiles();
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "重命名失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setRenaming(false);
    }
  };

  const loadAllFolders = async () => {
    const folders: string[] = [""];
    const listRecursive = async (prefix: string) => {
      try {
        const res = await fetch(`${apiFileUrl(storage.id, prefix)}?action=list`);
        if (res.ok) {
          const data = (await res.json()) as { objects?: S3Object[] };
          for (const obj of data.objects || []) {
            if (obj.isDirectory) {
              folders.push(obj.key);
              await listRecursive(obj.key);
            }
          }
        }
      } catch {
        // Ignore errors
      }
    };
    await listRecursive("");
    setAllFolders(folders);
  };

  const startMove = async (obj: S3Object) => {
    setMoveTarget(obj);
    setMoveDestPath("");
    await loadAllFolders();
  };

  const handleMove = async () => {
    if (!moveTarget) return;

    setMoving(true);
    try {
      const key = moveTarget.isDirectory ? moveTarget.key : moveTarget.key;
      const res = await fetch(`${apiFileUrl(storage.id, key)}?action=move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destPath: moveDestPath }),
      });
      if (res.ok) {
        setMoveTarget(null);
        loadFiles();
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "移动失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setMoving(false);
    }
  };

  const startShare = (obj: S3Object) => {
    setShareTarget(obj);
    setShareToken("");
    setShareUrl("");
    setShareQrCode("");
    setCustomShareToken("");
    setShareExpireHours(0);
    setSharePassword("");
  };

  const handleCreateShare = async () => {
    if (!shareTarget) return;

    setCreatingShare(true);
    try {
      let expiresAt: string | undefined;
      if (shareExpireHours > 0) {
        const expireDate = new Date();
        expireDate.setHours(expireDate.getHours() + shareExpireHours);
        expiresAt = expireDate.toISOString();
      }

      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storageId: storage.id,
          filePath: shareTarget.key,
          isDirectory: shareTarget.isDirectory,
          expiresAt,
          shareToken: customShareToken.trim() || undefined,
          password: sharePassword.trim() || undefined,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { share: { shareToken: string }; shareUrl: string };
        setShareToken(data.share.shareToken);
        setShareUrl(data.shareUrl);
        try {
          const QRCode = await import("qrcode");
          const dataUrl = await QRCode.toDataURL(data.shareUrl, { margin: 1, width: 240 });
          setShareQrCode(dataUrl);
        } catch {
          setShareQrCode("");
        }
      } else {
        const data = (await res.json()) as { error?: string };
        alert(data.error || "创建分享链接失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setCreatingShare(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      alert("已复制到剪贴板");
    }).catch(() => {
      alert("复制失败，请手动复制");
    });
  };

  const toggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const obj of visibleObjects) {
          next.delete(obj.key);
        }
      } else {
        for (const obj of visibleObjects) {
          next.add(obj.key);
        }
      }
      return next;
    });
  };

  const handleBatchDelete = async () => {
    if (selectedKeys.size === 0) return;

    const folders = objects.filter((obj) => obj.isDirectory && selectedKeys.has(obj.key));
    const files = objects.filter((obj) => !obj.isDirectory && selectedKeys.has(obj.key));

    const msg = folders.length > 0
      ? `确定删除 ${files.length} 个文件和 ${folders.length} 个文件夹（含其中所有内容）?`
      : `确定删除 ${files.length} 个文件?`;

    if (!confirm(msg)) return;

    setDeleting(true);
    let failed = 0;

    try {
      // Delete folders first (recursive)
      for (const folder of folders) {
        try {
          const res = await fetch(`${apiFileUrl(storage.id, folder.key)}?action=rmdir`, { method: "DELETE" });
          if (!res.ok) failed++;
        } catch {
          failed++;
        }
      }

      // Delete files
      for (const file of files) {
        try {
          const res = await fetch(apiFileUrl(storage.id, file.key), { method: "DELETE" });
          if (!res.ok) failed++;
        } catch {
          failed++;
        }
      }

      if (failed > 0) {
        alert(`删除完成，${failed} 个项目删除失败`);
      }

      setSelectedKeys(new Set());
      loadFiles();
    } finally {
      setDeleting(false);
    }
  };

  const startBatchMove = async () => {
    if (selectedKeys.size === 0) return;
    setBatchMoveDest("");
    await loadAllFolders();
    setBatchMoveOpen(true);
  };

  const handleBatchMove = async () => {
    if (selectedKeys.size === 0) return;
    setBatchMoving(true);
    let failed = 0;
    try {
      for (const key of selectedKeys) {
        try {
          const res = await fetch(`${apiFileUrl(storage.id, key)}?action=move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ destPath: batchMoveDest }),
          });
          if (!res.ok) failed++;
        } catch {
          failed++;
        }
      }
      if (failed > 0) alert(`移动完成，${failed} 个项目失败`);
      setBatchMoveOpen(false);
      setSelectedKeys(new Set());
      loadFiles();
    } finally {
      setBatchMoving(false);
    }
  };

  const handleBatchDownload = () => {
    const files = objects.filter((obj) => !obj.isDirectory && selectedKeys.has(obj.key));
    const folders = objects.filter((obj) => obj.isDirectory && selectedKeys.has(obj.key));
    if (files.length === 0) {
      alert("未选中可下载的文件（文件夹暂不支持批量下载）");
      return;
    }
    if (folders.length > 0) {
      alert(`已忽略 ${folders.length} 个文件夹，开始下载 ${files.length} 个文件（如被浏览器拦截，请允许弹窗）`);
    }
    // 间隔触发，避免浏览器拦截多窗口
    files.forEach((f, i) => {
      setTimeout(() => window.open(`${apiFileUrl(storage.id, f.key)}?action=download`, "_blank"), i * 400);
    });
  };

  const isFavorite = (key: string) => favorites.some((f) => f.storageId === storage.id && f.key === key);

  const toggleFavorite = (obj: S3Object) => {
    setFavorites((prev) => {
      const exists = prev.some((f) => f.storageId === storage.id && f.key === obj.key);
      const next = exists
        ? prev.filter((f) => !(f.storageId === storage.id && f.key === obj.key))
        : [...prev, { storageId: storage.id, key: obj.key, name: obj.name, isDirectory: obj.isDirectory }];
      try { localStorage.setItem("clist-favorites", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // 递归统计文件夹大小
  const calcFolderSize = async (key: string, name: string) => {
    setCalcSizeKey(key);
    let total = 0, count = 0, dirs = 0;
    const typeDist: Record<string, { count: number; size: number }> = {};
    const queue = [key];
    const visited = new Set<string>();
    try {
      while (queue.length > 0 && dirs < 2000) {
        const prefix = queue.shift()!;
        if (visited.has(prefix)) continue;
        visited.add(prefix);
        dirs++;
        const res = await fetch(`${apiFileUrl(storage.id, prefix)}?action=list`);
        if (!res.ok) continue;
        const data = (await res.json()) as { objects?: S3Object[] };
        for (const obj of data.objects || []) {
          if (obj.isDirectory) queue.push(obj.key);
          else {
            total += obj.size;
            count++;
            const dot = obj.name.lastIndexOf(".");
            const ext = dot > 0 ? obj.name.slice(dot + 1).toLowerCase().slice(0, 12) : "none";
            if (!typeDist[ext]) typeDist[ext] = { count: 0, size: 0 };
            typeDist[ext].count++;
            typeDist[ext].size += obj.size;
          }
        }
      }
      setFolderStats({ name, stats: { totalSize: total, fileCount: count, folderCount: dirs, typeDistribution: typeDist } });
    } catch {
      alert("统计失败");
    } finally {
      setCalcSizeKey(null);
    }
  };

  // 存储扫描：递归收集所有文件，找大文件 Top + 按大小聚类的潜在重复
  const scanStorage = async () => {
    setScanning(true);
    setScanResults(null);
    const all: S3Object[] = [];
    const queue = [""];
    const visited = new Set<string>();
    let dirs = 0;
    try {
      while (queue.length > 0 && dirs < 2000) {
        const prefix = queue.shift()!;
        if (visited.has(prefix)) continue;
        visited.add(prefix);
        dirs++;
        const res = await fetch(`${apiFileUrl(storage.id, prefix)}?action=list`);
        if (!res.ok) continue;
        const data = (await res.json()) as { objects?: S3Object[] };
        for (const obj of data.objects || []) {
          if (obj.isDirectory) queue.push(obj.key);
          else all.push(obj);
        }
      }
      const bigFiles = [...all].sort((a, b) => b.size - a.size).slice(0, 20);
      const bySize = new Map<number, S3Object[]>();
      for (const f of all) {
        if (f.size < 1024 * 1024) continue;
        const arr = bySize.get(f.size);
        if (arr) arr.push(f);
        else bySize.set(f.size, [f]);
      }
      const duplicates = Array.from(bySize.values()).filter((g) => g.length > 1).map((g) => ({ size: g[0].size, files: g })).sort((a, b) => b.size - a.size).slice(0, 20);
      setScanResults({ bigFiles, duplicates });
    } catch {
      alert("扫描失败");
    } finally {
      setScanning(false);
    }
  };

  const navigateToParent = (key: string) => {
    navigateTo(key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "");
  };

  // 全局搜索：从根 BFS 递归列目录，匹配文件名（限流防大存储卡死）
  const searchGlobal = async (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) { setGlobalResults([]); return; }
    setGlobalLoading(true);
    const results: S3Object[] = [];
    const visited = new Set<string>();
    const queue: string[] = [""];
    const MAX_RESULTS = 200;
    const MAX_DIRS = 400;
    let dirs = 0;
    try {
      while (queue.length > 0 && results.length < MAX_RESULTS && dirs < MAX_DIRS) {
        const prefix = queue.shift()!;
        if (visited.has(prefix)) continue;
        visited.add(prefix);
        dirs++;
        try {
          const res = await fetch(`${apiFileUrl(storage.id, prefix)}?action=list`);
          if (!res.ok) continue;
          const data = (await res.json()) as { objects?: S3Object[] };
          for (const obj of data.objects || []) {
            if (results.length >= MAX_RESULTS) break;
            if (obj.name.toLowerCase().includes(q)) results.push(obj);
            if (obj.isDirectory) queue.push(obj.key);
          }
        } catch {
          /* skip unreadable dir */
        }
      }
      setGlobalResults(results);
    } finally {
      setGlobalLoading(false);
    }
  };

  useEffect(() => {
    if (!globalSearch) { setGlobalResults([]); setGlobalLoading(false); return; }
    const q = searchQuery.trim();
    if (q.length < 1) { setGlobalResults([]); return; }
    const t = setTimeout(() => searchGlobal(q), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalSearch, searchQuery, storage.id]);

  // 上传任务统一走 uploadManager：多任务并发 + 断点续传 + 刷新恢复（lib/upload-manager.ts）
  const enqueueUploads = (entries: EnqueueEntry[]) => {
    if (entries.length === 0) return;
    uploadManager.enqueue(entries, {
      storageId: storage.id,
      path,
      chunkSize: chunkSizeMB * 1024 * 1024,
      multipartSupported: supportsMultipart(storage.type),
    });
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    enqueueUploads(Array.from(files, (file) => ({ file })));
    e.target.value = "";
  };

  // Ctrl+V 粘贴图片/文件直接上传到当前目录
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!canUpload) return;
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        enqueueUploads(Array.from(files, (file) => ({ file })));
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUpload, path, storage.id, storage.type, chunkSizeMB]);

  // 上传完成后刷新当前存储的文件列表（防抖合并连续完成；不打断在跑的其他任务）
  const loadFilesRef = useRef(loadFiles);
  useEffect(() => { loadFilesRef.current = loadFiles; });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = uploadManager.onFinish((task) => {
      if (task.storageId !== storage.id) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; loadFilesRef.current(); }, 400);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [storage.id]);

  // ⌘K / Ctrl+K 命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
        setCmdQuery("");
        setCmdIndex(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    setCreatingFolder(true);
    try {
      const folderPath = path ? `${path}/${newFolderName.trim()}` : newFolderName.trim();
      const res = await fetch(`${apiFileUrl(storage.id, folderPath)}?action=mkdir`, {
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
      const res = await fetch(`${apiFileUrl(storage.id, path)}?action=fetch`, {
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

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const globalMode = globalSearch && searchQuery.trim().length > 0;

  // 命令面板：命令 + 当前目录文件 + 收藏，模糊匹配
  const allCommands: Array<{ id: string; label: string; icon: React.ComponentType<{ className?: string }>; action: () => void; admin?: boolean; disabled?: boolean }> = [
    { id: "refresh", label: "刷新文件列表", icon: RefreshCw, action: loadFiles },
    { id: "newfolder", label: "新建文件夹", icon: FolderPlus, action: () => setShowNewFolderInput(true), admin: true },
    { id: "gallery", label: viewMode === "list" ? "切换到网格视图" : "切换到列表视图", icon: LayoutGrid, action: () => setViewMode((v) => (v === "list" ? "gallery" : "list")) },
    { id: "root", label: "回到根目录", icon: Folder, action: () => navigateTo("") },
    { id: "up", label: "返回上级目录", icon: ArrowLeft, action: goUp, disabled: !path },
    { id: "globalsearch", label: "全局搜索文件", icon: Globe, action: () => setGlobalSearch(true) },
    { id: "favorites", label: "打开收藏夹", icon: Star, action: () => setFavOpen(true) },
    { id: "scan", label: "扫描大文件 / 查找重复", icon: Calculator, action: scanStorage },
  ];
  const cmdQ = cmdQuery.trim().toLowerCase();
  const cmdCommands = allCommands.filter((c) => (!c.admin || isAdmin) && (!cmdQ || c.label.toLowerCase().includes(cmdQ)));
  const cmdFiles = cmdQ ? objects.filter((o) => o.name.toLowerCase().includes(cmdQ)).slice(0, 6) : [];
  const cmdFavs = cmdQ ? favorites.filter((f) => f.storageId === storage.id && f.name.toLowerCase().includes(cmdQ)).slice(0, 4) : [];
  type CmdItem =
    | { kind: "cmd"; id: string; label: string; icon: React.ComponentType<{ className?: string }>; action: () => void; disabled?: boolean }
    | { kind: "file"; obj: S3Object }
    | { kind: "fav"; fav: { key: string; name: string; isDirectory: boolean } };
  const flatCmdItems: CmdItem[] = [
    ...cmdCommands.map((c) => ({ kind: "cmd" as const, id: c.id, label: c.label, icon: c.icon, action: c.action, disabled: c.disabled })),
    ...cmdFiles.map((o) => ({ kind: "file" as const, obj: o })),
    ...cmdFavs.map((f) => ({ kind: "fav" as const, fav: { key: f.key, name: f.name, isDirectory: f.isDirectory } })),
  ];
  const execCmdItem = (item: CmdItem) => {
    setCmdOpen(false);
    setCmdQuery("");
    if (item.kind === "cmd") {
      if (!item.disabled) item.action();
    } else if (item.kind === "file") {
      const o = item.obj;
      if (o.isDirectory) navigateTo(o.key);
      else if (isPreviewable(o.name)) handlePreview(o);
      else downloadFile(o.key);
    } else {
      const f = item.fav;
      navigateTo(f.isDirectory ? f.key : (f.key.includes("/") ? f.key.slice(0, f.key.lastIndexOf("/")) : ""));
    }
  };
  const visibleObjects = normalizedQuery
    ? objects.filter((obj) => obj.name.toLowerCase().includes(normalizedQuery))
    : objects;
  const allVisibleSelected = visibleObjects.length > 0 && visibleObjects.every((obj) => selectedKeys.has(obj.key));

  // 键盘流：j/k 选行 h 上级 g 根目录 r 刷新 / 搜索 Esc 取消选中（输入框聚焦时不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        e.preventDefault();
        setCursor((c) => {
          const n = visibleObjects.length;
          if (n === 0) return -1;
          if (k === "j") return c >= n - 1 ? 0 : c + 1;
          return c <= 0 ? n - 1 : c - 1;
        });
      } else if (k === "enter") {
        const obj = visibleObjects[cursor];
        if (obj) {
          e.preventDefault();
          if (obj.isDirectory) navigateTo(obj.key);
          else if (isPreviewable(obj.name)) handlePreview(obj);
          else downloadFile(obj.key);
        }
      } else if (k === "h") { e.preventDefault(); goUp(); }
      else if (k === "g") { e.preventDefault(); navigateTo(""); }
      else if (k === "r") { e.preventDefault(); loadFiles(); }
      else if (k === "/") { e.preventDefault(); searchInputRef.current?.focus(); }
      else if (k === "escape") { setCursor(-1); setSelectedKeys(new Set()); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleObjects, cursor]);

  // Get previewable files for navigation
  const previewableFiles = visibleObjects.filter((obj) => !obj.isDirectory && isPreviewable(obj.name));
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
  const getFileIcon = (fileName: string, className = "h-4 w-4 shrink-0") => {
    const Icon = fileTypeIcon(getFileType(fileName));
    return <Icon className={className} />;
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 py-2 px-4 border-b border-zinc-200 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/40">
        <div className="flex items-center gap-0.5 text-sm overflow-x-auto min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button onClick={() => setPath("")} className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 font-medium text-zinc-600 hover:text-blue-600 dark:text-zinc-300 dark:hover:text-blue-400 shrink-0">
            <Folder className="h-4 w-4 text-blue-500" />
            {storage.name}
          </button>
          {breadcrumbs.map((part, i) => (
            <span key={i} className="flex items-center shrink-0">
              <ChevronRight className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />
              <button
                onClick={() => navigateTo(breadcrumbs.slice(0, i + 1).join("/"))}
                className="rounded px-1.5 py-1 text-zinc-500 hover:text-blue-600 dark:text-zinc-400 dark:hover:text-blue-400"
              >
                {part}
              </button>
            </span>
          ))}
          {/* Selection info */}
          {selectedKeys.size > 0 && (
            <span className="ml-2 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 shrink-0">
              已选 {selectedKeys.size} 项
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索文件..."
              className="w-44 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 py-1.5 pl-7 pr-7 text-xs text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                title="清空搜索"
                aria-label="清空搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={() => { setGlobalSearch((g) => !g); setGlobalResults([]); }}
            className={`icon-btn h-8 w-8 ${globalSearch ? "text-blue-600 dark:text-blue-400 bg-blue-500/10" : ""}`}
            title={globalSearch ? "全局搜索中（点击切回当前目录）" : "全局搜索"}
            aria-label="全局搜索"
          >
            <Globe />
          </button>
          <button
            onClick={() => setViewMode((v) => (v === "list" ? "gallery" : "list"))}
            className={`icon-btn h-8 w-8 ${viewMode === "gallery" ? "text-blue-600 dark:text-blue-400 bg-blue-500/10" : ""}`}
            title={viewMode === "list" ? "网格视图" : "列表视图"}
            aria-label="切换视图"
          >
            {viewMode === "list" ? <LayoutGrid /> : <List />}
          </button>
          <div className="relative">
            <button
              onClick={() => setFavOpen((o) => !o)}
              className={`icon-btn h-8 w-8 ${favOpen ? "text-yellow-500 bg-yellow-500/10" : ""}`}
              title="收藏夹"
              aria-label="收藏夹"
            >
              <Star />
            </button>
            {favOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFavOpen(false)} />
                <div className="absolute right-0 top-9 z-50 min-w-[220px] max-h-80 overflow-auto bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg py-1">
                  {favorites.filter((f) => f.storageId === storage.id).length === 0 ? (
                    <div className="px-3 py-4 text-center text-xs text-zinc-400">暂无收藏（右键或操作列 ☆ 收藏常用目录/文件）</div>
                  ) : favorites.filter((f) => f.storageId === storage.id).map((f) => {
                    const parent = f.key.includes("/") ? f.key.slice(0, f.key.lastIndexOf("/")) : "";
                    return (
                      <div key={f.key} className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700">
                        <button onClick={() => { setFavOpen(false); navigateTo(f.isDirectory ? f.key : parent); }} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                          {f.isDirectory ? <Folder className="h-4 w-4 text-blue-500 shrink-0" /> : <span className="text-zinc-400 shrink-0">{(() => { const Ic = fileTypeIcon(getFileType(f.name)); return <Ic className="h-4 w-4" />; })()}</span>}
                          <span className="truncate text-sm text-zinc-700 dark:text-zinc-200">{f.name}</span>
                        </button>
                        <button onClick={() => toggleFavorite({ key: f.key, name: f.name, isDirectory: f.isDirectory } as S3Object)} className="text-zinc-400 hover:text-red-500 shrink-0" title="移除收藏" aria-label="移除收藏">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          {/* Batch actions */}
          {isAdmin && selectedKeys.size > 0 && (
            <>
              <button onClick={startBatchMove} className="btn btn-sm btn-outline">
                <ArrowRightLeft />
                {`移动 (${selectedKeys.size})`}
              </button>
              <button onClick={handleBatchDownload} className="btn btn-sm btn-outline">
                <Download />
                {`下载 (${objects.filter((o) => !o.isDirectory && selectedKeys.has(o.key)).length})`}
              </button>
              <button
                onClick={handleBatchDelete}
                disabled={deleting}
                className="btn btn-sm btn-danger"
              >
                <Trash2 />
                {deleting ? "删除中..." : `删除 (${selectedKeys.size})`}
              </button>
            </>
          )}
          {path && (
            <button onClick={goUp} className="btn btn-sm btn-ghost" title="返回上级目录">
              <ArrowLeft />
              上级
            </button>
          )}
          <button onClick={loadFiles} className="icon-btn h-8 w-8" title="刷新" aria-label="刷新">
            <RefreshCw />
          </button>
          {isAdmin && (
            <>
              <button
                onClick={() => setShowNewFolderInput(true)}
                className="btn btn-sm btn-ghost"
                title="新建文件夹"
              >
                <FolderPlus />
                文件夹
              </button>
              <button
                onClick={() => setShowOfflineDownload(true)}
                className="btn btn-sm btn-ghost"
                title="离线下载"
              >
                <Download />
                离线下载
              </button>
            </>
          )}
          {canUpload && (
            <label className="btn btn-sm btn-primary cursor-pointer">
              <Upload />上传
              <input type="file" multiple onChange={handleUpload} className="hidden" />
            </label>
          )}
        </div>
      </div>

      {/* New Folder Input */}
      {showNewFolderInput && (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">新建文件夹:</span>
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
              className="field flex-1 py-1.5"
              autoFocus
              disabled={creatingFolder}
            />
            <button
              onClick={handleCreateFolder}
              disabled={creatingFolder || !newFolderName.trim()}
              className="btn btn-sm btn-primary"
            >
              {creatingFolder ? "创建中…" : "创建"}
            </button>
            <button
              onClick={() => {
                setShowNewFolderInput(false);
                setNewFolderName("");
              }}
              className="btn btn-sm btn-ghost"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Offline Download Input */}
      {showOfflineDownload && (
        <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 shrink-0">链接地址:</span>
              <input
                type="url"
                value={offlineUrl}
                onChange={(e) => setOfflineUrl(e.target.value)}
                placeholder="https://example.com/file.zip"
                className="field flex-1 py-1.5"
                autoFocus
                disabled={offlineDownloading}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 shrink-0">文件名称:</span>
              <input
                type="text"
                value={offlineFilename}
                onChange={(e) => setOfflineFilename(e.target.value)}
                placeholder="可选，留空自动识别"
                className="field flex-1 py-1.5"
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
                className="btn btn-sm btn-primary whitespace-nowrap"
              >
                <Download />
                {offlineDownloading ? "下载中…" : "开始下载"}
              </button>
              <button
                onClick={() => {
                  setShowOfflineDownload(false);
                  setOfflineUrl("");
                  setOfflineFilename("");
                }}
                disabled={offlineDownloading}
                className="btn btn-sm btn-ghost"
              >
                取消
              </button>
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500">
              提示: 文件将下载到当前目录，大文件可能需要较长时间
            </p>
          </div>
        </div>
      )}

      {/* Directory README */}
      {readme && (
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
          <button
            onClick={() => setReadmeOpen((o) => !o)}
            className="flex items-center gap-2 w-full px-4 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/40"
          >
            <FileText className="h-4 w-4 text-blue-500 shrink-0" />
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">README</span>
            <span className="text-xs text-zinc-400 ml-auto">{readmeOpen ? "收起" : "展开"}</span>
          </button>
          {readmeOpen && (
            <div className="px-4 pb-4 pt-1 max-w-4xl">
              <div className="docx-content text-sm" dangerouslySetInnerHTML={{ __html: readme }} />
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div
        className="flex-1 overflow-auto relative"
        onDragOver={(e) => { if (!canUpload) return; e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!canUpload) return;
          // 保留文件句柄（拖拽场景），刷新后可一键恢复续传
          void filesFromDataTransfer(e.dataTransfer).then((entries) => enqueueUploads(entries));
        }}
      >
        {dragOver && (
          <div className="absolute inset-2 z-20 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
            <span className="text-blue-600 dark:text-blue-300 font-medium text-lg">松开以上传到当前目录</span>
          </div>
        )}
        {globalMode ? (
          <div className="p-4">
            {globalLoading && (
              <div className="flex items-center justify-center gap-2 h-20 text-zinc-500 text-sm">
                <RefreshCw className="h-4 w-4 animate-spin" />
                搜索中…（已找到 {globalResults.length}）
              </div>
            )}
            {!globalLoading && globalResults.length === 0 && (
              <div className="flex items-center justify-center h-20 text-zinc-400 text-sm">无匹配结果</div>
            )}
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {globalResults.map((obj) => {
                const parent = obj.key.includes("/") ? obj.key.slice(0, obj.key.lastIndexOf("/")) : "";
                return (
                  <button
                    key={obj.key}
                    onClick={() => { setGlobalSearch(false); setSearchQuery(""); navigateTo(parent); }}
                    className="flex items-center gap-2 w-full px-4 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/40"
                  >
                    {obj.isDirectory ? <Folder className="h-4 w-4 shrink-0 text-blue-500" /> : <span className="text-zinc-400">{getFileIcon(obj.name)}</span>}
                    <span className="truncate font-medium text-zinc-700 dark:text-zinc-200">{obj.name}</span>
                    {parent && <span className="truncate text-xs text-zinc-400 ml-auto">/{parent}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 h-32 text-zinc-500 text-sm">
            <RefreshCw className="h-4 w-4 animate-spin" />
            加载中…
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
        ) : viewMode === "gallery" ? (
          <div className="p-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {visibleObjects.map((obj, i) => {
              const isImg = !obj.isDirectory && getFileType(obj.name) === "image";
              const Ic = obj.isDirectory ? null : fileTypeIcon(getFileType(obj.name));
              return (
                <div
                  key={obj.key}
                  onClick={() => (obj.isDirectory ? navigateTo(obj.key) : isPreviewable(obj.name) ? handlePreview(obj) : downloadFile(obj.key))}
                  className={`group relative cursor-pointer rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-sm transition ${selectedKeys.has(obj.key) ? "ring-2 ring-blue-500" : ""} ${cursor === i ? "ring-2 ring-blue-500" : ""}`}
                >
                  <div className="aspect-square flex items-center justify-center bg-zinc-50 dark:bg-zinc-800/50 overflow-hidden">
                    {isImg ? (
                      <img src={apiFileUrl(storage.id, obj.key)} alt={obj.name} loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition" />
                    ) : obj.isDirectory ? (
                      <Folder className="h-10 w-10 text-blue-500" />
                    ) : Ic ? (
                      <Ic className="h-10 w-10 text-zinc-400" />
                    ) : null}
                  </div>
                  <div className="px-2 py-1.5">
                    <div className="truncate text-xs text-zinc-700 dark:text-zinc-200">{obj.name}</div>
                    <div className="truncate text-[10px] text-zinc-400">{obj.isDirectory ? "文件夹" : formatBytes(obj.size)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 bg-zinc-50/95 dark:bg-zinc-900/95 backdrop-blur">
              <tr>
                {isAdmin && (
                  <th className="py-2.5 px-3 w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 accent-blue-600"
                    />
                  </th>
                )}
                <th className="text-left py-2.5 px-4 font-medium uppercase tracking-wider">名称</th>
                <th className="text-right py-2.5 px-4 font-medium uppercase tracking-wider w-28">大小</th>
                <th className="text-right py-2.5 px-4 font-medium uppercase tracking-wider w-44">修改时间</th>
                <th className="text-right py-2.5 px-4 font-medium uppercase tracking-wider w-36">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleObjects.length === 0 ? (
                <tr>
                  <td
                    colSpan={isAdmin ? 5 : 4}
                    className="py-8 text-center text-zinc-400 dark:text-zinc-600"
                  >
                    没有匹配的文件
                  </td>
                </tr>
              ) : visibleObjects.map((obj, i) => (
                <tr
                  key={obj.key}
                  className={`border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40 ${
                    selectedKeys.has(obj.key) ? "bg-blue-50 dark:bg-blue-900/20" : ""
                  } ${cursor === i ? "outline outline-2 -outline-offset-2 outline-blue-500" : ""}`}
                  onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, obj }); }}
                >
                  {isAdmin && (
                    <td className="py-2 px-3">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(obj.key)}
                        onChange={() => toggleSelect(obj.key)}
                        className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 accent-blue-600"
                      />
                    </td>
                  )}
                  <td className="py-2 px-4">
                    {obj.isDirectory ? (
                      <button
                        onClick={() => navigateTo(obj.key)}
                        className="flex items-center gap-2 font-medium text-zinc-700 dark:text-zinc-200 hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        <Folder className="h-4 w-4 shrink-0 text-blue-500" />
                        <span className="truncate">{obj.name}</span>
                      </button>
                    ) : isPreviewable(obj.name) ? (
                      <button
                        onClick={() => handlePreview(obj)}
                        className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        {getFileIcon(obj.name)}
                        <span className="truncate">{obj.name}</span>
                      </button>
                    ) : (
                      <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
                        <span className="text-zinc-400 dark:text-zinc-500">{getFileIcon(obj.name)}</span>
                        <span className="truncate">{obj.name}</span>
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-4 text-right text-zinc-500 tabular-nums">
                    {obj.isDirectory ? "-" : formatBytes(obj.size)}
                  </td>
                  <td className="py-2 px-4 text-right text-zinc-500 tabular-nums">
                    {formatDate(obj.lastModified)}
                  </td>
                  <td className="py-1.5 px-3 text-right">
                    {obj.isDirectory ? (
                      <div className="flex items-center justify-end gap-0.5">
                        <button onClick={() => toggleFavorite(obj)} className={`icon-btn h-7 w-7 ${isFavorite(obj.key) ? "text-yellow-500" : ""}`} title={isFavorite(obj.key) ? "取消收藏" : "收藏"} aria-label="收藏"><Star /></button>
                        {canDownload && (
                          <button onClick={() => calcFolderSize(obj.key, obj.name)} disabled={calcSizeKey === obj.key} className="icon-btn h-7 w-7" title="统计大小" aria-label="统计大小"><Calculator /></button>
                        )}
                        {isAdmin && (
                          <>
                            <button onClick={() => startShare(obj)} className="icon-btn h-7 w-7" title="分享" aria-label="分享"><Share2 /></button>
                            <button onClick={() => startRename(obj)} className="icon-btn h-7 w-7" title="重命名" aria-label="重命名"><Pencil /></button>
                            <button onClick={() => startMove(obj)} className="icon-btn h-7 w-7" title="移动" aria-label="移动"><ArrowRightLeft /></button>
                            <button onClick={() => deleteFolder(obj.key, obj.name)} className="icon-btn h-7 w-7 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10" title="删除文件夹" aria-label="删除文件夹"><Trash2 /></button>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-0.5">
                        {canDownload && isPreviewable(obj.name) && (
                          <button onClick={() => handlePreview(obj)} className="icon-btn h-7 w-7" title="预览" aria-label="预览"><Play /></button>
                        )}
                        {canDownload && (
                          <button onClick={() => downloadFile(obj.key)} className="icon-btn h-7 w-7" title="下载" aria-label="下载"><Download /></button>
                        )}
                        <button onClick={() => toggleFavorite(obj)} className={`icon-btn h-7 w-7 ${isFavorite(obj.key) ? "text-yellow-500" : ""}`} title={isFavorite(obj.key) ? "取消收藏" : "收藏"} aria-label="收藏"><Star /></button>
                        {isAdmin && (
                          <>
                            <button onClick={() => startShare(obj)} className="icon-btn h-7 w-7" title="分享" aria-label="分享"><Share2 /></button>
                            <button onClick={() => startRename(obj)} className="icon-btn h-7 w-7" title="重命名" aria-label="重命名"><Pencil /></button>
                            <button onClick={() => startMove(obj)} className="icon-btn h-7 w-7" title="移动" aria-label="移动"><ArrowRightLeft /></button>
                            <button onClick={() => deleteFile(obj.key)} className="icon-btn h-7 w-7 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10" title="删除" aria-label="删除"><Trash2 /></button>
                          </>
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
          canEdit={canUpload}
          onFileChanged={loadFiles}
        />
      )}

      {/* Rename Modal */}
      {renameTarget && (
        <Modal title="重命名" onClose={() => setRenameTarget(null)}>
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">新名称</label>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRename()}
                className="field"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setRenameTarget(null)} className="btn btn-outline flex-1 py-2">取消</button>
              <button onClick={handleRename} disabled={renaming || !renameValue.trim()} className="btn btn-primary flex-1 py-2">{renaming ? "处理中…" : "确定"}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Share Modal */}
      {shareTarget && (
        <Modal title="生成分享链接" onClose={() => setShareTarget(null)}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500">分享: <span className="text-zinc-700 dark:text-zinc-300">{shareTarget.name}</span></div>

            {!shareUrl ? (
              <>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">自定义分享令牌（可选）</label>
                  <input
                    type="text"
                    value={customShareToken}
                    onChange={(e) => setCustomShareToken(e.target.value)}
                    placeholder="留空则自动生成"
                    className="field"
                  />
                  <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                    仅支持字母、数字、下划线和短横线，且不能重复
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">过期时间</label>
                  <select
                    value={shareExpireHours}
                    onChange={(e) => setShareExpireHours(parseInt(e.target.value, 10))}
                    className="field"
                  >
                    <option value={0}>永不过期</option>
                    <option value={1}>1 小时</option>
                    <option value={24}>1 天</option>
                    <option value={168}>1 周</option>
                    <option value={720}>1 月</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1.5">访问密码（可选）</label>
                  <input
                    type="text"
                    value={sharePassword}
                    onChange={(e) => setSharePassword(e.target.value)}
                    placeholder="留空则无需密码"
                    className="field"
                  />
                  <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                    设置后，访客需输入密码才能访问分享内容
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setShareTarget(null)} className="btn btn-outline flex-1 py-2">取消</button>
                  <button onClick={handleCreateShare} disabled={creatingShare} className="btn btn-primary flex-1 py-2">{creatingShare ? "生成中…" : "生成链接"}</button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1.5">分享令牌</label>
                    <div className="flex gap-2">
                      <input type="text" value={shareToken} readOnly className="field flex-1 text-xs" />
                      <button onClick={() => copyToClipboard(shareToken)} className="btn btn-outline py-2"><Copy />复制</button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-500 mb-1.5">分享链接</label>
                    <div className="flex gap-2">
                      <input type="text" value={shareUrl} readOnly className="field flex-1 text-xs" />
                      <button onClick={() => copyToClipboard(shareUrl)} className="btn btn-outline py-2"><Copy />复制</button>
                    </div>
                  </div>
                  {shareQrCode && (
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1.5">扫码访问</label>
                      <div className="flex justify-center">
                        <img src={shareQrCode} alt="分享二维码" className="w-44 h-44 rounded-lg bg-white p-2" />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setShareTarget(null)} className="btn btn-primary flex-1 py-2">完成</button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* Move Modal */}
      {moveTarget && (
        <Modal title="移动到" onClose={() => setMoveTarget(null)}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500">移动: <span className="text-zinc-700 dark:text-zinc-300">{moveTarget.name}</span></div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">目标文件夹</label>
              <select
                value={moveDestPath}
                onChange={(e) => setMoveDestPath(e.target.value)}
                className="field"
              >
                {allFolders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder === "" ? "/ (根目录)" : "/" + folder}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setMoveTarget(null)} className="btn btn-outline flex-1 py-2">取消</button>
              <button onClick={handleMove} disabled={moving} className="btn btn-primary flex-1 py-2">{moving ? "处理中…" : "确定"}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Batch Move Modal */}
      {batchMoveOpen && (
        <Modal title="批量移动到" onClose={() => setBatchMoveOpen(false)}>
          <div className="space-y-4">
            <div className="text-xs text-zinc-500">将 {selectedKeys.size} 个选中项目移动到：</div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">目标文件夹</label>
              <select
                value={batchMoveDest}
                onChange={(e) => setBatchMoveDest(e.target.value)}
                className="field"
              >
                {allFolders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder === "" ? "/ (根目录)" : "/" + folder}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setBatchMoveOpen(false)} className="btn btn-outline flex-1 py-2">取消</button>
              <button onClick={handleBatchMove} disabled={batchMoving} className="btn btn-primary flex-1 py-2">{batchMoving ? "处理中…" : "确定"}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Context Menu（右键） */}
      {contextMenu && (() => {
        const obj = contextMenu.obj;
        const x = contextMenu.x;
        const y = contextMenu.y;
        const close = () => setContextMenu(null);
        const Item = ({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) => (
          <button onClick={onClick} className={`flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-700 ${danger ? "text-red-600 dark:text-red-400" : "text-zinc-700 dark:text-zinc-200"}`}>
            {icon}<span>{label}</span>
          </button>
        );
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
            <div
              className="fixed z-50 min-w-[160px] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg py-1"
              style={{ left: Math.min(x, window.innerWidth - 180), top: Math.min(y, window.innerHeight - 320) }}
            >
              {obj.isDirectory ? (
                <Item icon={<Folder className="h-4 w-4 text-blue-500" />} label="打开" onClick={() => { navigateTo(obj.key); close(); }} />
              ) : isPreviewable(obj.name) ? (
                <Item icon={<Play className="h-4 w-4" />} label="预览" onClick={() => { handlePreview(obj); close(); }} />
              ) : null}
              {!obj.isDirectory && (
                <Item icon={<Download className="h-4 w-4" />} label="下载" onClick={() => { downloadFile(obj.key); close(); }} />
              )}
              {obj.isDirectory && canDownload && (
                <Item icon={<Calculator className="h-4 w-4" />} label={calcSizeKey === obj.key ? "统计中…" : "统计大小"} onClick={() => { calcFolderSize(obj.key, obj.name); close(); }} />
              )}
              <Item icon={<Star className={`h-4 w-4 ${isFavorite(obj.key) ? "text-yellow-500" : ""}`} />} label={isFavorite(obj.key) ? "取消收藏" : "收藏"} onClick={() => { toggleFavorite(obj); close(); }} />
              {isAdmin && (
                <>
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
                  <Item icon={<Share2 className="h-4 w-4" />} label="分享" onClick={() => { startShare(obj); close(); }} />
                  <Item icon={<Pencil className="h-4 w-4" />} label="重命名" onClick={() => { startRename(obj); close(); }} />
                  <Item icon={<ArrowRightLeft className="h-4 w-4" />} label="移动" onClick={() => { startMove(obj); close(); }} />
                  <Item icon={<Trash2 className="h-4 w-4" />} label="删除" danger onClick={() => { obj.isDirectory ? deleteFolder(obj.key, obj.name) : deleteFile(obj.key); close(); }} />
                </>
              )}
            </div>
          </>
        );
      })()}

      {/* Folder Stats Modal */}
      {folderStats && (
        <FolderStatsModal name={folderStats.name} stats={folderStats.stats} onClose={() => setFolderStats(null)} />
      )}

      {/* ⌘K Command Palette */}
      {cmdOpen && (
        <div className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-sm flex items-start justify-center pt-[12vh] p-4" onClick={() => setCmdOpen(false)}>
          <div className="w-full max-w-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 border-b border-zinc-200 dark:border-zinc-700">
              <Search className="h-4 w-4 text-zinc-400 shrink-0" />
              <input
                autoFocus
                value={cmdQuery}
                onChange={(e) => { setCmdQuery(e.target.value); setCmdIndex(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setCmdIndex((i) => Math.min(i + 1, flatCmdItems.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setCmdIndex((i) => Math.max(i - 1, 0)); }
                  else if (e.key === "Enter") { e.preventDefault(); if (flatCmdItems[cmdIndex]) execCmdItem(flatCmdItems[cmdIndex]); }
                  else if (e.key === "Escape") { setCmdOpen(false); }
                }}
                placeholder="搜索文件或命令…"
                className="w-full py-3 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 outline-none"
              />
              <kbd className="text-[10px] text-zinc-400 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-0.5">ESC</kbd>
            </div>
            <div className="max-h-[50vh] overflow-y-auto py-1">
              {flatCmdItems.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-zinc-400">无匹配结果</div>
              ) : flatCmdItems.map((item, i) => {
                const Icon = item.kind === "cmd" ? item.icon : null;
                const FileIcon = item.kind === "file" && !item.obj.isDirectory ? fileTypeIcon(getFileType(item.obj.name)) : null;
                return (
                  <button
                    key={i}
                    onMouseEnter={() => setCmdIndex(i)}
                    onClick={() => execCmdItem(item)}
                    className={`flex items-center gap-3 w-full px-4 py-2 text-left text-sm ${i === cmdIndex ? "bg-blue-500/10 text-blue-600 dark:text-blue-300" : "text-zinc-700 dark:text-zinc-200"} ${item.kind === "cmd" && item.disabled ? "opacity-40" : ""}`}
                  >
                    {item.kind === "cmd" && Icon ? <Icon className="h-4 w-4 shrink-0" />
                      : item.kind === "file" ? (item.obj.isDirectory ? <Folder className="h-4 w-4 text-blue-500 shrink-0" /> : FileIcon ? <FileIcon className="h-4 w-4 text-zinc-400 shrink-0" /> : null)
                      : <Star className="h-4 w-4 text-yellow-500 shrink-0" />}
                    <span className="truncate flex-1">{item.kind === "cmd" ? item.label : item.kind === "file" ? item.obj.name : item.fav.name}</span>
                    {item.kind === "file" && item.obj.isDirectory && <span className="text-xs text-zinc-400">文件夹</span>}
                    {item.kind === "fav" && <span className="text-xs text-zinc-400">收藏</span>}
                  </button>
                );
              })}
            </div>
            <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-700 flex items-center gap-3 text-[11px] text-zinc-400">
              <span>↑↓ 导航</span><span>↵ 执行</span><span>esc 关闭</span>
              <span className="ml-auto">⌘K 呼出</span>
            </div>
          </div>
        </div>
      )}

      {(scanning || scanResults) && (
        <ScanModal results={scanResults} scanning={scanning} onNavigate={navigateToParent} onClose={() => { setScanResults(null); setScanning(false); }} />
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
  const [showChangelog, setShowChangelog] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [statsStorage, setStatsStorage] = useState<StorageInfo | null>(null);
  const [editingStorage, setEditingStorage] = useState<StorageInfo | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const siteTitle = loaderData.siteTitle || "CList";
  const siteAnnouncement = loaderData.siteAnnouncement || "";
  const chunkSizeMB = loaderData.chunkSizeMB || 50;
  const webdavEnabled = loaderData.webdavEnabled || false;

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

    // 迁移旧版 multipart_* 上传残留为可恢复任务（一次性，键会被清除）
    migrateLegacyUploads(chunkSizeMB);
  }, [siteAnnouncement, chunkSizeMB]);

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
        <div className="px-4 py-2.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/20">
              <Cloud className="h-[18px] w-[18px]" />
            </span>
            <span className="text-lg font-bold tracking-tight">CList</span>
          </div>
          <div className="flex-1 text-center min-w-0">
            <span className="text-sm text-zinc-500 dark:text-zinc-400 truncate block">{siteTitle}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={toggleTheme}
              className="icon-btn h-8 w-8"
              title={isDark ? "切换到亮色" : "切换到暗色"}
              aria-label="切换主题"
            >
              {isDark ? <Sun /> : <Moon />}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="icon-btn h-8 w-8"
              title="设置"
              aria-label="设置"
            >
              <SlidersHorizontal />
            </button>
            {isAdmin ? (
              <>
                <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-1 text-xs font-medium text-green-600 dark:text-green-400">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  管理员
                </span>
                <button
                  onClick={handleLogout}
                  className="btn btn-sm btn-ghost"
                  title="登出"
                >
                  <LogOut />
                  登出
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowLogin(true)}
                className="btn btn-sm btn-ghost"
                title="登录"
              >
                <LogIn />
                登录
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar */}
        <aside className={`${sidebarCollapsed ? "w-0" : "w-64"} border-r border-zinc-200 dark:border-zinc-800 shrink-0 bg-white dark:bg-zinc-900/50 flex flex-col transition-all duration-300 overflow-hidden relative`}>
          <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between shrink-0">
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider whitespace-nowrap">存储列表</span>
            <div className="flex items-center gap-1">
              {isAdmin && (
                <button
                  onClick={() => { setEditingStorage(null); setShowStorageForm(true); }}
                  className="icon-btn h-7 w-7 text-blue-500 hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-500/10"
                  title="添加存储"
                  aria-label="添加存储"
                >
                  <Plus />
                </button>
              )}
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="icon-btn h-7 w-7"
                title="收起侧边栏"
                aria-label="收起侧边栏"
              >
                <PanelLeft />
              </button>
            </div>
          </div>
          <div className="overflow-y-auto flex-1 py-1">
            {storages.length === 0 ? (
              <div className="p-4 text-center text-zinc-400 dark:text-zinc-600 text-xs whitespace-nowrap">
                暂无存储
              </div>
            ) : (
              storages.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-center justify-between mx-1 my-0.5 rounded-lg pl-3 pr-1.5 py-2 cursor-pointer transition-colors ${
                    selectedStorage?.id === s.id
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                  }`}
                  onClick={() => setSelectedStorage(s)}
                  onTouchStart={() => setSelectedStorage(s)}
                >
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm font-medium truncate ${selectedStorage?.id === s.id ? "" : "text-zinc-700 dark:text-zinc-300"}`}>
                      {s.name}
                    </div>
                    <span className={`mt-0.5 inline-flex items-center gap-1 text-xs ${s.isPublic ? "text-green-600 dark:text-green-400" : "text-zinc-400 dark:text-zinc-500"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${s.isPublic ? "bg-green-500" : "bg-zinc-400 dark:bg-zinc-600"}`} />
                      {s.isPublic ? "公开" : "私有"}
                    </span>
                  </div>
                  {isAdmin && (
                    <div 
                        className="flex items-center gap-0.5"
                        onClick={(e) => e.stopPropagation()}
                     >
                      <button
                        onClick={() => { setStatsStorage(s); setShowStats(true); }}
                        className="icon-btn h-7 w-7"
                        title="统计"
                        aria-label="统计"
                      >
                        <BarChart3 />
                      </button>
                      <button
                        onClick={() => { setEditingStorage(s); setShowStorageForm(true); }}
                        className="icon-btn h-7 w-7"
                        title="编辑"
                        aria-label="编辑"
                      >
                        <Pencil />
                      </button>
                      <button
                        onClick={() => handleDeleteStorage(s)}
                        className="icon-btn h-7 w-7 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                        title="删除"
                        aria-label="删除"
                      >
                        <Trash2 />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Sidebar Expand Button - only show when collapsed */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 grid h-10 w-5 place-items-center rounded-r-md bg-white dark:bg-zinc-800 border border-l-0 border-zinc-200 dark:border-zinc-700 text-zinc-500 shadow-sm hover:text-blue-500 transition-colors"
            title="展开侧边栏"
            aria-label="展开侧边栏"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}

        {/* Main */}
        <main className="flex-1 bg-zinc-50 dark:bg-zinc-900 min-w-0 overflow-hidden">
          {selectedStorage ? (
            <FileBrowser storage={selectedStorage} isAdmin={isAdmin} isDark={isDark} chunkSizeMB={chunkSizeMB} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-zinc-400 dark:text-zinc-600">
              <Cloud className="h-12 w-12 text-zinc-300 dark:text-zinc-700" />
              <span className="text-sm">选择左侧存储以浏览文件</span>
            </div>
          )}
        </main>
      </div>

      {/* Footer */}
      <footer className="shrink-0 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-2">
        <div className="flex items-center justify-center gap-3 text-xs text-zinc-500 dark:text-zinc-500">
          <a
            href="https://github.com/ooyyh/Cloudflare-Clist"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-zinc-800 dark:hover:text-zinc-200 transition"
          >
            <Github className="h-3.5 w-3.5" />
            GitHub
          </a>
          <span className="text-zinc-300 dark:text-zinc-700">·</span>
          <button
            onClick={() => setShowChangelog(true)}
            className="hover:text-zinc-800 dark:hover:text-zinc-200 transition"
          >
            更新日志
          </button>
          <span className="text-zinc-300 dark:text-zinc-700">·</span>
          <span>Made by <span className="text-zinc-700 dark:text-zinc-300">ooyyh</span></span>
          <span className="text-zinc-300 dark:text-zinc-700">·</span>
          <span className="inline-flex items-center gap-1">
            Powered by
            <a
              href="https://www.cloudflare.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-orange-500 hover:text-orange-400 transition"
            >
              Cloudflare
            </a>
          </span>
        </div>
      </footer>

      {/* 全局上传任务面板（多任务并发 / 恢复，独立于文件浏览生命周期） */}
      <UploadTaskPanel />

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
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          siteTitle={siteTitle}
          siteAnnouncement={siteAnnouncement}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          isAdmin={isAdmin}
          onRefreshStorages={refreshStorages}
          webdavEnabled={webdavEnabled}
          storages={storages}
        />
      )}
      {showAnnouncement && siteAnnouncement && (
        <AnnouncementModal
          announcement={siteAnnouncement}
          onClose={() => setShowAnnouncement(false)}
        />
      )}
      {showChangelog && (
        <ChangelogModal onClose={() => setShowChangelog(false)} />
      )}
      {showStats && statsStorage && (
        <StorageStatsModal
          storage={statsStorage}
          onClose={() => { setShowStats(false); setStatsStorage(null); }}
        />
      )}
    </div>
  );
}
