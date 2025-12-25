import type { Route } from "./+types/api.files.$storageId.$";
import { getStorageById, initDatabase } from "~/lib/storage";
import { requireAuth } from "~/lib/auth";
import { S3Client } from "~/lib/s3-client";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  const storageId = parseInt(params.storageId || "0", 10);
  const path = params["*"] || "";

  const storage = await getStorageById(db, storageId);
  if (!storage) {
    return Response.json({ error: "Storage not found" }, { status: 404 });
  }

  const { isAdmin } = await requireAuth(request, db);

  if (!storage.isPublic && !isAdmin) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  const s3Client = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
    bucket: storage.bucket,
    basePath: storage.basePath,
  });

  // List objects
  if (action === "list" || !action) {
    try {
      const result = await s3Client.listObjects(path);
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

  // Download file
  if (action === "download") {
    try {
      const response = await s3Client.getObject(path);
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const contentLength = response.headers.get("content-length");

      const fileName = path.split("/").pop() || "download";

      return new Response(response.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
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
      const signedUrl = await s3Client.getSignedUrl(path);
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
      const info = await s3Client.headObject(path);
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

  const { isAdmin } = await requireAuth(request, db, "admin");
  if (!isAdmin) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  const storageId = parseInt(params.storageId || "0", 10);
  const path = params["*"] || "";

  const storage = await getStorageById(db, storageId);
  if (!storage) {
    return Response.json({ error: "Storage not found" }, { status: 404 });
  }

  const s3Client = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
    bucket: storage.bucket,
    basePath: storage.basePath,
  });

  const method = request.method;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Create folder
  if (method === "POST" && action === "mkdir") {
    try {
      await s3Client.createFolder(path);
      return Response.json({ success: true, path });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to create folder" },
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
      await s3Client.putObject(uploadPath, bodyBuffer, contentType);

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
      await s3Client.putObject(path, bodyBuffer, contentType);
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
            const result = await s3Client.listObjects(prefix, "/", 1000, continuationToken);

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
          await s3Client.deleteObject(key);
        }

        // Also try to delete the folder object itself
        try {
          await s3Client.deleteObject(path.endsWith("/") ? path : path + "/");
        } catch {
          // Folder object might not exist, ignore
        }

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
      await s3Client.deleteObject(path);
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
