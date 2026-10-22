import type { Route } from "./+types/api.storage-stats.$storageId";
import { requireAuth } from "~/lib/auth";
import { getStorageById, initDatabase, updateStorage } from "~/lib/storage";
import { S3Client } from "~/lib/s3-client";
import { WebdevClient } from "~/lib/webdev-client";
import { OneDriveClient } from "~/lib/onedrive-client";
import { GoogleDriveClient } from "~/lib/gdrive-client";
import { AliyunDriveClient } from "~/lib/alicloud-client";
import { BaiduYunClient } from "~/lib/baiduyun-client";
import { getFileExtension } from "~/lib/file-utils";

interface StorageStats {
  totalSize: number;
  fileCount: number;
  folderCount: number;
  typeDistribution: Record<string, { count: number; size: number }>;
}

interface ListedObject {
  name: string;
  size: number;
  isDirectory: boolean;
}

interface ListedObjectsResult {
  objects: ListedObject[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

type StorageClient = S3Client | WebdevClient | OneDriveClient | GoogleDriveClient | AliyunDriveClient | BaiduYunClient;
type StatefulClient = {
  getStateUpdates: () => { config?: Record<string, any>; saving?: Record<string, any> } | null;
};

function isMissingDirectoryError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /(\b404\b|not found)/i.test(error.message);
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

async function collectStats(
  client: StorageClient,
  prefix: string = ""
): Promise<StorageStats> {
  const stats: StorageStats = {
    totalSize: 0,
    fileCount: 0,
    folderCount: 0,
    typeDistribution: {},
  };

  const queue: string[] = [prefix];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentPrefix = queue.shift()!;

    if (visited.has(currentPrefix)) {
      continue;
    }
    visited.add(currentPrefix);

    try {
      const result = await client.listObjects(currentPrefix, "/", 1000);

      // Process files
      for (const obj of result.objects) {
        if (!obj.isDirectory) {
          stats.fileCount++;
          stats.totalSize += obj.size;

          const ext = getFileExtension(obj.name).toLowerCase() || "no-extension";
          if (!stats.typeDistribution[ext]) {
            stats.typeDistribution[ext] = { count: 0, size: 0 };
          }
          stats.typeDistribution[ext].count++;
          stats.typeDistribution[ext].size += obj.size;
        }
      }

      // Process directories
      for (const prefixPath of result.prefixes) {
        stats.folderCount++;
        queue.push(prefixPath);
      }

      // Handle pagination
      if (result.isTruncated && result.nextContinuationToken) {
        let continuationToken: string | undefined = result.nextContinuationToken;
        while (continuationToken) {
          const nextResult: ListedObjectsResult = await client.listObjects(
            currentPrefix,
            "/",
            1000,
            continuationToken
          );

          for (const obj of nextResult.objects) {
            if (!obj.isDirectory) {
              stats.fileCount++;
              stats.totalSize += obj.size;

              const ext = getFileExtension(obj.name).toLowerCase() || "no-extension";
              if (!stats.typeDistribution[ext]) {
                stats.typeDistribution[ext] = { count: 0, size: 0 };
              }
              stats.typeDistribution[ext].count++;
              stats.typeDistribution[ext].size += obj.size;
            }
          }

          for (const prefixPath of nextResult.prefixes) {
            stats.folderCount++;
            queue.push(prefixPath);
          }

          continuationToken = nextResult.isTruncated
            ? nextResult.nextContinuationToken
            : undefined;
        }
      }
    } catch (error) {
      if (currentPrefix && isMissingDirectoryError(error)) {
        console.warn(`Skipping missing directory while collecting stats: ${currentPrefix}`);
        continue;
      }
      console.error(`Error listing objects at ${currentPrefix}:`, error);
      throw error;
    }
  }

  return stats;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;
  await initDatabase(db);

  // Require admin authentication
  const { isAdmin } = await requireAuth(request, db, "admin");
  if (!isAdmin) {
    return Response.json({ error: "Unauthorized" }, { status: 403 });
  }

  const storageId = parseInt(params.storageId, 10);
  if (!storageId) {
    return Response.json({ error: "Invalid storage ID" }, { status: 400 });
  }

  try {
    const storage = await getStorageById(db, storageId);
    if (!storage) {
      return Response.json({ error: "Storage not found" }, { status: 404 });
    }

    let client: StorageClient;

    if (storage.type === "webdev") {
      client = new WebdevClient({
        endpoint: storage.endpoint,
        username: storage.accessKeyId,
        password: storage.secretAccessKey,
        basePath: storage.basePath,
      });
    } else if (storage.type === "onedrive") {
      client = new OneDriveClient({ config: storage.config, saving: storage.saving });
    } else if (storage.type === "gdrive") {
      client = new GoogleDriveClient({ config: storage.config, saving: storage.saving });
    } else if (storage.type === "alicloud") {
      client = new AliyunDriveClient({ config: storage.config, saving: storage.saving });
    } else if (storage.type === "baiduyun") {
      client = new BaiduYunClient({ config: storage.config, saving: storage.saving });
    } else {
      client = new S3Client({
        endpoint: storage.endpoint,
        region: storage.region,
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
        bucket: storage.bucket,
        basePath: storage.basePath,
        forcePathStyle: storage.config?.forcePathStyle === true || storage.config?.addressingStyle === "path",
      });
    }

    const stats = await withClientState(client, db, storageId, () => collectStats(client));
    return Response.json({ stats });
  } catch (error) {
    console.error("Error collecting storage stats:", error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to collect storage statistics",
      },
      { status: 500 }
    );
  }
}
