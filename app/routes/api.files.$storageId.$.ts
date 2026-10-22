import type { Route } from "./+types/api.files.$storageId.$";
import { getStorageById, initDatabase, updateStorage } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";
import { getShareByToken, verifySharePassword } from "~/lib/shares";
import { S3Client } from "~/lib/s3-client";
import { WebdevClient } from "~/lib/webdev-client";
import { OneDriveClient } from "~/lib/onedrive-client";
import { GoogleDriveClient } from "~/lib/gdrive-client";
import { AliyunDriveClient } from "~/lib/alicloud-client";
import { BaiduYunClient } from "~/lib/baiduyun-client";
import { getRequestMeta, logAudit } from "~/lib/audit";
import { getFileType, getMimeType } from "~/lib/file-utils";

type StorageClient = S3Client | WebdevClient | OneDriveClient | GoogleDriveClient | AliyunDriveClient | BaiduYunClient;
type StatefulClient = {
  getStateUpdates: () => { config?: Record<string, any>; saving?: Record<string, any> } | null;
};

function createClient(storage: {
  type: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  basePath: string;
  config?: Record<string, any>;
  saving?: Record<string, any>;
}): StorageClient {
  if (storage.type === "webdev") {
    return new WebdevClient({
      endpoint: storage.endpoint,
      username: storage.accessKeyId,
      password: storage.secretAccessKey,
      basePath: storage.basePath,
    });
  }
  if (storage.type === "onedrive") {
    return new OneDriveClient({ config: storage.config, saving: storage.saving });
  }
  if (storage.type === "gdrive") {
    return new GoogleDriveClient({ config: storage.config, saving: storage.saving });
  }
  if (storage.type === "alicloud") {
    return new AliyunDriveClient({ config: storage.config, saving: storage.saving });
  }
  if (storage.type === "baiduyun") {
    return new BaiduYunClient({ config: storage.config, saving: storage.saving });
  }
  return new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
    bucket: storage.bucket,
    basePath: storage.basePath,
    forcePathStyle: storage.config?.forcePathStyle === true || storage.config?.addressingStyle === "path",
  });
}

async function persistClientState(
  client: StorageClient,
  db: D1Database,
  storageId: number
): Promise<void> {
  const stateful = client as unknown as StatefulClient;
  if (typeof stateful.getStateUpdates !== "function") {
    return;
  }
  const updates = stateful.getStateUpdates();
  if (!updates) {
    return;
  }
  const input: { config?: Record<string, any>; saving?: Record<string, any> } = {};
  if (updates.config) {
    input.config = updates.config;
  }
  if (updates.saving) {
    input.saving = updates.saving;
  }
  if (Object.keys(input).length === 0) {
    return;
  }
  await updateStorage(db, storageId, input);
}

async function withClientState<T>(
  client: StorageClient,
  db: D1Database,
  storageId: number,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } finally {
    try {
      await persistClientState(client, db, storageId);
    } catch (error) {
      console.error("Failed to persist storage state:", error);
    }
  }
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);
  const meta = getRequestMeta(request);

  const storageId = parseInt(params.storageId || "0", 10);
  const path = params["*"] || "";

  const storage = await getStorageById(db, storageId);
  if (!storage) {
    return Response.json({ error: "Storage not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const shareToken = url.searchParams.get("token");
  const isInlineImageRequest = !action && path && getFileType(path) === "image";

  let isAdmin = false;
  let shareVerified = false;
  let userType: "admin" | "guest" | "share" = "guest";

  if (shareToken) {
    const share = await getShareByToken(db, shareToken);
    if (share && share.storageId === storageId) {
      // 规范化：去掉尾部斜杠，避免 "photos/" + "/" = "photos//" 导致子路径匹配失败
      const sharePath = (share.filePath || "").replace(/\/+$/, "");
      const sharePathPrefix = sharePath ? sharePath + "/" : "";
      if (path === sharePath || path === sharePath + "/" || path.startsWith(sharePathPrefix)) {
        shareVerified = true;
      }
      // 若分享设了访问密码，必须校验通过
      if (shareVerified && share.passwordHash) {
        const password = url.searchParams.get("password") || undefined;
        const ok = await verifySharePassword(db, shareToken, password);
        if (!ok) {
          return Response.json({ error: "需要访问密码或密码错误" }, { status: 403 });
        }
      }
    }
    if (!shareVerified) {
      return Response.json({ error: "分享令牌无效或已过期" }, { status: 403 });
    }
    userType = "share";
  } else {
    const authResult = await requireAuth(request, db);
    isAdmin = authResult.isAdmin;
    userType = isAdmin ? "admin" : "guest";
  }

  // Permission checks based on action
  const canList = isAdmin || shareVerified || storage.guestList;
  const canDownload = isAdmin || shareVerified || storage.guestDownload;

  // List objects - requires list permission
  if (action === "list" || (!action && !isInlineImageRequest)) {
    if (!canList) {
      return Response.json({ error: "没有浏览权限" }, { status: 403 });
    }
  } else {
    // Download, signed-url, info - requires download permission
    if (!canDownload) {
      return Response.json({ error: "没有下载权限" }, { status: 403 });
    }
  }

  const client = createClient(storage);

  // List objects
  if (action === "list" || (!action && !isInlineImageRequest)) {
    try {
      const result = await withClientState(client, db, storageId, () => client.listObjects(path));
      return Response.json({
        storage: { id: storage.id, name: storage.name },
        path,
        ...result,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to list objects" },
        { status: 500 }
      );
    }
  }

  // Inline image preview via direct file URL, e.g. /api/files/7/images/1.jpg
  if (isInlineImageRequest) {
    try {
      const response = await withClientState(client, db, storageId, () => client.getObject(path));
      const upstreamContentType = response.headers.get("content-type") || "";
      const contentType = upstreamContentType.startsWith("image/")
        ? upstreamContentType
        : getMimeType(path);
      const contentLength = response.headers.get("content-length");
      const fileName = path.split("/").pop() || "image";

      await logAudit(db, {
        action: "file.preview",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { fileName, contentLength, contentType },
      });

      return new Response(response.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
          ...(contentLength ? { "Content-Length": contentLength } : {}),
        },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to preview image" },
        { status: 500 }
      );
    }
  }

  // Download file
  if (action === "download") {
    try {
      const response = await withClientState(client, db, storageId, () => client.getObject(path));
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const contentLength = response.headers.get("content-length");

      const fileName = path.split("/").pop() || "download";

      await logAudit(db, {
        action: "file.download",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { fileName, contentLength },
      });

      const inline = url.searchParams.get("inline") === "1";
      return new Response(response.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(fileName)}"`,
          ...(contentLength ? { "Content-Length": contentLength } : {}),
        },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to download file" },
        { status: 500 }
      );
    }
  }

  // Get signed URL
  if (action === "signed-url") {
    try {
      const signedUrl = await withClientState(client, db, storageId, () => client.getSignedUrl(path));
      await logAudit(db, {
        action: "file.signed_url",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
      });
      return Response.json({ url: signedUrl });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to generate signed URL" },
        { status: 500 }
      );
    }
  }

  // Get file info (HEAD)
  if (action === "info") {
    try {
      const info = await withClientState(client, db, storageId, () => client.headObject(path));
      if (!info) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
      return Response.json(info);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to get file info" },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);
  const meta = getRequestMeta(request);

  const storageId = parseInt(params.storageId || "0", 10);
  const path = params["*"] || "";

  const storage = await getStorageById(db, storageId);
  if (!storage) {
    return Response.json({ error: "Storage not found" }, { status: 404 });
  }

  const { isAdmin } = await requireAuth(request, db);
  const userType = isAdmin ? "admin" : "guest";

  const method = request.method;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Permission check: upload operations can be done by guests with guestUpload permission
  const canUpload = isAdmin || storage.guestUpload;
  const uploadActions = ["multipart-init", "multipart-urls", "multipart-upload", "multipart-complete", "multipart-abort"];
  const isUploadAction = uploadActions.includes(action || "") || (method === "PUT" && !action) || (method === "POST" && !action);

  if (isUploadAction) {
    if (!canUpload) {
      return Response.json({ error: "没有上传权限" }, { status: 403 });
    }
  } else {
    // All other actions (mkdir, rename, move, delete, fetch) require admin
    if (!isAdmin) {
      return Response.json({ error: "Unauthorized" }, { status: 403 });
    }
  }

  const client = createClient(storage);

  // Initialize multipart upload
  if (method === "POST" && action === "multipart-init") {
    try {
      const body = await request.json() as { contentType?: string; size?: number; chunkSize?: number };
      const contentType = body.contentType || "application/octet-stream";
      const uploadId = await withClientState(
        client,
        db,
        storageId,
        () => client.initiateMultipartUpload(path, contentType, { size: body.size, chunkSize: body.chunkSize })
      );
      await logAudit(db, {
        action: "file.multipart_init",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { uploadId, contentType },
      });
      return Response.json({ uploadId });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to initialize multipart upload" },
        { status: 500 }
      );
    }
  }

  // Get signed URLs for multipart upload parts (batch)
  if (method === "POST" && action === "multipart-urls") {
    try {
      const body = await request.json() as {
        uploadId?: string;
        partNumbers?: number[];
      };

      if (!body.uploadId || !body.partNumbers || body.partNumbers.length === 0) {
        return Response.json({ error: "uploadId and partNumbers are required" }, { status: 400 });
      }
      const uploadId = body.uploadId;
      const partNumbers = body.partNumbers;

      const urls = await withClientState(client, db, storageId, async () => {
        const result: Record<number, string> = {};
        for (const partNumber of partNumbers) {
          try {
            result[partNumber] = await client.getSignedUploadPartUrl(path, uploadId, partNumber);
          } catch {
            // ignore and fallback to proxy upload
          }
        }
        return result;
      });

      return Response.json({ urls });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to generate signed URLs" },
        { status: 500 }
      );
    }
  }

  // Upload part (streaming) - kept as fallback
  if (method === "PUT" && action === "multipart-upload") {
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = parseInt(url.searchParams.get("partNumber") || "0", 10);

    if (!uploadId || partNumber < 1) {
      return Response.json({ error: "uploadId and partNumber are required" }, { status: 400 });
    }

    if (!request.body) {
      return Response.json({ error: "No part body provided" }, { status: 400 });
    }

    try {
      const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
      const etag = await withClientState(
        client,
        db,
        storageId,
        () => client.uploadPart(path, uploadId, partNumber, request.body as ReadableStream, contentLength)
      );
      return Response.json({ etag, partNumber });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to upload part" },
        { status: 500 }
      );
    }
  }

  // Complete multipart upload
  if (method === "POST" && action === "multipart-complete") {
    try {
      const body = await request.json() as {
        uploadId?: string;
        parts?: { partNumber: number; etag: string }[];
      };

      if (!body.uploadId || !body.parts || body.parts.length === 0) {
        return Response.json({ error: "uploadId and parts are required" }, { status: 400 });
      }
      const uploadId = body.uploadId;
      const parts = body.parts;

      await withClientState(
        client,
        db,
        storageId,
        () => client.completeMultipartUpload(path, uploadId, parts)
      );
      await logAudit(db, {
        action: "file.multipart_complete",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { uploadId, parts: parts.length },
      });
      return Response.json({ success: true, path });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to complete multipart upload" },
        { status: 500 }
      );
    }
  }

  // Abort multipart upload
  if (method === "POST" && action === "multipart-abort") {
    try {
      const body = await request.json() as { uploadId?: string };

      if (!body.uploadId) {
        return Response.json({ error: "uploadId is required" }, { status: 400 });
      }
      const uploadId = body.uploadId;

      await withClientState(
        client,
        db,
        storageId,
        () => client.abortMultipartUpload(path, uploadId)
      );
      await logAudit(db, {
        action: "file.multipart_abort",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { uploadId },
      });
      return Response.json({ success: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to abort multipart upload" },
        { status: 500 }
      );
    }
  }

  // Create folder
  if (method === "POST" && action === "mkdir") {
    try {
      await withClientState(client, db, storageId, () => client.createFolder(path));
      await logAudit(db, {
        action: "file.mkdir",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
      });
      return Response.json({ success: true, path });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to create folder" },
        { status: 500 }
      );
    }
  }

  // Rename file or folder
  if (method === "POST" && action === "rename") {
    try {
      const body = await request.json() as { newName?: string };
      const { newName } = body;

      if (!newName || newName.includes("/")) {
        return Response.json({ error: "Invalid new name" }, { status: 400 });
      }

      const isDirectory = path.endsWith("/");
      const cleanPath = path.replace(/\/$/, "");
      const parentPath = cleanPath.includes("/")
        ? cleanPath.substring(0, cleanPath.lastIndexOf("/") + 1)
        : "";
      const newPath = parentPath + newName + (isDirectory ? "/" : "");

      const canDirectRename = typeof (client as { renameObject?: (path: string, name: string) => Promise<void> }).renameObject === "function";
      if (canDirectRename) {
        await withClientState(
          client,
          db,
          storageId,
          () => (client as { renameObject: (path: string, name: string) => Promise<void> }).renameObject(path, newName)
        );
        await logAudit(db, {
          action: "file.rename",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory },
        });
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory },
        });
        return Response.json({ success: true, newPath });
      }

      if (isDirectory) {
        // Rename folder: copy all objects with new prefix, then delete old ones
        const listAll = async (prefix: string): Promise<string[]> => {
          const keys: string[] = [];
          let continuationToken: string | undefined;

          do {
            const result = await withClientState(
              client,
              db,
              storageId,
              () => client.listObjects(prefix, "", 1000, continuationToken)
            );
            for (const obj of result.objects) {
              keys.push(obj.key);
            }
            continuationToken = result.nextContinuationToken;
          } while (continuationToken);

          return keys;
        };

        const oldPrefix = cleanPath + "/";
        const newPrefix = parentPath + newName + "/";
        const keysToMove = await listAll(oldPrefix);

        // Copy all objects to new location
        for (const key of keysToMove) {
          const newKey = newPrefix + key.substring(oldPrefix.length);
          await withClientState(client, db, storageId, () => client.copyObject(key, newKey));
        }

        // Delete old objects
        for (const key of keysToMove) {
          await withClientState(client, db, storageId, () => client.deleteObject(key));
        }

        // Try to delete the old folder object
        try {
          await withClientState(client, db, storageId, () => client.deleteObject(oldPrefix));
        } catch {
          // Ignore if not exists
        }

        await logAudit(db, {
          action: "file.rename",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath: newPrefix, moved: keysToMove.length, isDirectory: true },
        });
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath: newPrefix, moved: keysToMove.length, isDirectory: true },
        });
        return Response.json({ success: true, newPath: newPrefix, moved: keysToMove.length });
      } else {
        // Rename single file
        await withClientState(client, db, storageId, () => client.copyObject(path, newPath));
        await withClientState(client, db, storageId, () => client.deleteObject(path));
        await logAudit(db, {
          action: "file.rename",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory: false },
        });
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory: false },
        });
        return Response.json({ success: true, newPath });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to rename" },
        { status: 500 }
      );
    }
  }

  // Move file or folder
  if (method === "POST" && action === "move") {
    try {
      const body = await request.json() as { destPath?: string };
      const { destPath } = body;

      if (destPath === undefined) {
        return Response.json({ error: "destPath is required" }, { status: 400 });
      }

      const isDirectory = path.endsWith("/");
      const cleanPath = path.replace(/\/$/, "");
      const fileName = cleanPath.includes("/")
        ? cleanPath.substring(cleanPath.lastIndexOf("/") + 1)
        : cleanPath;

      // destPath is the target directory, fileName is preserved
      const targetDir = destPath.endsWith("/") ? destPath : (destPath ? destPath + "/" : "");
      const newPath = targetDir + fileName + (isDirectory ? "/" : "");

      const canDirectMove = typeof (client as { moveObject?: (path: string, destPath: string) => Promise<void> }).moveObject === "function";
      if (canDirectMove) {
        await withClientState(
          client,
          db,
          storageId,
          () => (client as { moveObject: (path: string, destPath: string) => Promise<void> }).moveObject(path, newPath)
        );
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory },
        });
        return Response.json({ success: true, newPath });
      }

      if (isDirectory) {
        // Move folder: copy all objects with new prefix, then delete old ones
        const listAll = async (prefix: string): Promise<string[]> => {
          const keys: string[] = [];
          let continuationToken: string | undefined;

          do {
            const result = await withClientState(
              client,
              db,
              storageId,
              () => client.listObjects(prefix, "", 1000, continuationToken)
            );
            for (const obj of result.objects) {
              keys.push(obj.key);
            }
            continuationToken = result.nextContinuationToken;
          } while (continuationToken);

          return keys;
        };

        const oldPrefix = cleanPath + "/";
        const newPrefix = targetDir + fileName + "/";
        const keysToMove = await listAll(oldPrefix);

        // Copy all objects to new location
        for (const key of keysToMove) {
          const newKey = newPrefix + key.substring(oldPrefix.length);
          await withClientState(client, db, storageId, () => client.copyObject(key, newKey));
        }

        // Delete old objects
        for (const key of keysToMove) {
          await withClientState(client, db, storageId, () => client.deleteObject(key));
        }

        // Try to delete the old folder object
        try {
          await withClientState(client, db, storageId, () => client.deleteObject(oldPrefix));
        } catch {
          // Ignore if not exists
        }

        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath: newPrefix, moved: keysToMove.length, isDirectory: true },
        });
        return Response.json({ success: true, newPath: newPrefix, moved: keysToMove.length });
      } else {
        // Move single file
        await withClientState(client, db, storageId, () => client.copyObject(path, newPath));
        await withClientState(client, db, storageId, () => client.deleteObject(path));
        await logAudit(db, {
          action: "file.move",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { newPath, isDirectory: false },
        });
        return Response.json({ success: true, newPath });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to move" },
        { status: 500 }
      );
    }
  }

  // Offline download from URL
  if (method === "POST" && action === "fetch") {
    try {
      const body = await request.json() as { url?: string; filename?: string };
      const { url: remoteUrl, filename } = body;

      if (!remoteUrl) {
        return Response.json({ error: "URL is required" }, { status: 400 });
      }

      // Validate URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(remoteUrl);
      } catch {
        return Response.json({ error: "Invalid URL" }, { status: 400 });
      }

      // Fetch the remote file
      const remoteResponse = await fetch(parsedUrl.href, {
        headers: {
          "User-Agent": "CList/1.0",
        },
      });

      if (!remoteResponse.ok) {
        return Response.json(
          { error: `Failed to fetch: ${remoteResponse.status} ${remoteResponse.statusText}` },
          { status: 400 }
        );
      }

      // Get filename from URL or Content-Disposition header or use provided filename
      let finalFilename = filename;
      if (!finalFilename) {
        const contentDisposition = remoteResponse.headers.get("content-disposition");
        if (contentDisposition) {
          const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
          if (match) {
            finalFilename = match[1].replace(/['"]/g, "");
          }
        }
        if (!finalFilename) {
          finalFilename = parsedUrl.pathname.split("/").pop() || "download";
        }
      }

      // Get content type
      const contentType = remoteResponse.headers.get("content-type") || "application/octet-stream";

      // Read the body as ArrayBuffer
      const bodyBuffer = await remoteResponse.arrayBuffer();

      // Upload to S3
      const uploadPath = path ? `${path}/${finalFilename}` : finalFilename;
      await withClientState(client, db, storageId, () => client.putObject(uploadPath, bodyBuffer, contentType));
      await logAudit(db, {
        action: "file.fetch",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path: uploadPath,
        detail: { sourceUrl: remoteUrl, size: bodyBuffer.byteLength },
      });

      return Response.json({
        success: true,
        path: uploadPath,
        filename: finalFilename,
        size: bodyBuffer.byteLength,
        contentType,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to fetch and upload file" },
        { status: 500 }
      );
    }
  }

  // Upload file
  if (method === "POST" || method === "PUT") {
    const contentType = request.headers.get("content-type") || "application/octet-stream";

    try {
      // Read body as ArrayBuffer first
      const bodyBuffer = await request.arrayBuffer();
      if (bodyBuffer.byteLength === 0) {
        return Response.json({ error: "No file body provided" }, { status: 400 });
      }
      await withClientState(client, db, storageId, () => client.putObject(path, bodyBuffer, contentType));
      await logAudit(db, {
        action: "file.upload",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
        detail: { size: bodyBuffer.byteLength, contentType },
      });
      return Response.json({ success: true, path });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to upload file" },
        { status: 500 }
      );
    }
  }

  // Delete file or folder
  if (method === "DELETE") {
    // Recursive folder deletion
    if (action === "rmdir") {
      try {
        // List all objects in the folder
        const listAll = async (prefix: string): Promise<string[]> => {
          const keys: string[] = [];
          let continuationToken: string | undefined;

          do {
            const result = await withClientState(
              client,
              db,
              storageId,
              () => client.listObjects(prefix, "/", 1000, continuationToken)
            );

            // Add files
            for (const obj of result.objects) {
              if (!obj.isDirectory) {
                keys.push(obj.key);
              }
            }

            // Recursively list subfolders
            for (const obj of result.objects) {
              if (obj.isDirectory) {
                const subKeys = await listAll(obj.key);
                keys.push(...subKeys);
                // Also add the folder itself (empty object with trailing slash)
                keys.push(obj.key);
              }
            }

            continuationToken = result.nextContinuationToken;
          } while (continuationToken);

          return keys;
        };

        const keysToDelete = await listAll(path);

        // Delete all objects
        for (const key of keysToDelete) {
          await withClientState(client, db, storageId, () => client.deleteObject(key));
        }

        // Also try to delete the folder object itself
        try {
          await withClientState(client, db, storageId, () => client.deleteObject(path.endsWith("/") ? path : path + "/"));
        } catch {
          // Folder object might not exist, ignore
        }

        await logAudit(db, {
          action: "file.rmdir",
          userType,
          ip: meta.ip,
          userAgent: meta.userAgent,
          storageId,
          path,
          detail: { deleted: keysToDelete.length },
        });
        return Response.json({ success: true, deleted: keysToDelete.length });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Failed to delete folder" },
          { status: 500 }
        );
      }
    }

    // Single file deletion
    try {
      await withClientState(client, db, storageId, () => client.deleteObject(path));
      await logAudit(db, {
        action: "file.delete",
        userType,
        ip: meta.ip,
        userAgent: meta.userAgent,
        storageId,
        path,
      });
      return Response.json({ success: true });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to delete file" },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
