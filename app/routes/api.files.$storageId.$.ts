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

  // Delete file
  if (method === "DELETE") {
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
