export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  basePath?: string;
}

export interface S3Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
  etag?: string;
}

export interface ListObjectsResult {
  objects: S3Object[];
  prefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// S3 URI encoding - encode each path segment (same for signature and URL)
function encodeS3Path(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function getSignatureKey(
  key: string,
  dateStamp: string,
  regionName: string,
  serviceName: string
): Promise<ArrayBuffer> {
  const keyData = new TextEncoder().encode("AWS4" + key);
  const kDate = await hmacSha256(keyData.buffer as ArrayBuffer, dateStamp);
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  return hmacSha256(kService, "aws4_request");
}

export class S3Client {
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
  }

  private getFullPath(path: string): string {
    const basePath = this.config.basePath?.replace(/^\/|\/$/g, "") || "";
    const cleanPath = path.replace(/^\//, "");
    return basePath ? `${basePath}/${cleanPath}` : cleanPath;
  }

  private async signRequest(
    method: string,
    path: string,
    queryParams: Record<string, string> = {},
    headers: Record<string, string> = {},
    payload: string = "",
    useUnsignedPayload: boolean = false
  ): Promise<Record<string, string>> {
    const url = new URL(this.config.endpoint);
    const host = url.host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const payloadHash = useUnsignedPayload ? "UNSIGNED-PAYLOAD" : await sha256(payload);

    // Headers to sign - host is included in signature but not in returned headers
    // because fetch API sets Host header automatically
    const headersToSign: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...headers,
    };

    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((key) => `${key.toLowerCase()}:${headersToSign[key].trim()}`)
      .join("\n");
    const signedHeadersStr = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";");

    const sortedQueryKeys = Object.keys(queryParams).sort();
    const canonicalQueryString = sortedQueryKeys
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`)
      .join("&");

    const rawCanonicalUri = path.startsWith("/") ? path : "/" + path;
    const canonicalUri = encodeS3Path(rawCanonicalUri);
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders + "\n",
      signedHeadersStr,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      await sha256(canonicalRequest),
    ].join("\n");

    const signingKey = await getSignatureKey(
      this.config.secretAccessKey,
      dateStamp,
      this.config.region,
      "s3"
    );
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

    // Return headers to send with request (exclude host - fetch sets it automatically)
    return {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...headers,
      Authorization: authorization,
    };
  }

  async listObjects(
    prefix: string = "",
    delimiter: string = "/",
    maxKeys: number = 1000,
    continuationToken?: string
  ): Promise<ListObjectsResult> {
    // Ensure prefix ends with / when listing a directory (not root)
    let normalizedPrefix = prefix;
    if (normalizedPrefix && !normalizedPrefix.endsWith("/")) {
      normalizedPrefix = normalizedPrefix + "/";
    }

    const fullPrefix = this.getFullPath(normalizedPrefix);
    const path = `/${this.config.bucket}`;

    const queryParams: Record<string, string> = {
      "list-type": "2",
      prefix: fullPrefix,
      delimiter,
      "max-keys": maxKeys.toString(),
    };

    if (continuationToken) {
      queryParams["continuation-token"] = continuationToken;
    }

    const headers = await this.signRequest("GET", path, queryParams);

    const queryString = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const response = await fetch(`${this.config.endpoint}${path}?${queryString}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`S3 ListObjects failed: ${response.status} ${text}`);
    }

    const xml = await response.text();
    return this.parseListObjectsResponse(xml, fullPrefix);
  }

  private parseListObjectsResponse(xml: string, fullPrefix: string): ListObjectsResult {
    const objects: S3Object[] = [];
    const prefixes: string[] = [];
    const basePath = this.config.basePath?.replace(/^\/|\/$/g, "") || "";

    // Decode XML entities
    const decodeXml = (str: string) => str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");

    const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    const prefixRegex = /<CommonPrefixes>[\s\S]*?<Prefix>(.*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g;

    let match;
    while ((match = contentsRegex.exec(xml)) !== null) {
      const content = match[1];
      const key = decodeXml(content.match(/<Key>(.*?)<\/Key>/)?.[1] || "");
      const size = parseInt(content.match(/<Size>(.*?)<\/Size>/)?.[1] || "0", 10);
      const lastModified = content.match(/<LastModified>(.*?)<\/LastModified>/)?.[1] || "";
      const etag = content.match(/<ETag>"?(.*?)"?<\/ETag>/)?.[1] || "";

      // Remove basePath prefix to get display key
      const displayKey = basePath && key.startsWith(basePath + "/")
        ? key.slice(basePath.length + 1)
        : key;

      // Remove the current folder prefix to get just the name
      const relativePrefix = basePath && fullPrefix.startsWith(basePath + "/")
        ? fullPrefix.slice(basePath.length + 1)
        : fullPrefix;

      const name = displayKey.startsWith(relativePrefix)
        ? displayKey.slice(relativePrefix.length)
        : displayKey;

      if (name && !name.endsWith("/")) {
        objects.push({
          key: displayKey,
          name,
          size,
          lastModified,
          isDirectory: false,
          etag,
        });
      }
    }

    while ((match = prefixRegex.exec(xml)) !== null) {
      const p = decodeXml(match[1]);

      // Remove basePath prefix to get display prefix
      const displayPrefix = basePath && p.startsWith(basePath + "/")
        ? p.slice(basePath.length + 1)
        : p;

      // Remove the current folder prefix to get just the name
      const relativePrefix = basePath && fullPrefix.startsWith(basePath + "/")
        ? fullPrefix.slice(basePath.length + 1)
        : fullPrefix;

      const name = displayPrefix.startsWith(relativePrefix)
        ? displayPrefix.slice(relativePrefix.length).replace(/\/$/, "")
        : displayPrefix.replace(/\/$/, "");

      if (name) {
        prefixes.push(displayPrefix);
        objects.push({
          key: displayPrefix,
          name,
          size: 0,
          lastModified: "",
          isDirectory: true,
        });
      }
    }

    const isTruncated = xml.includes("<IsTruncated>true</IsTruncated>");
    const nextToken = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1];

    return {
      objects: objects.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      }),
      prefixes,
      isTruncated,
      nextContinuationToken: nextToken,
    };
  }

  async getObject(key: string): Promise<Response> {
    const fullKey = this.getFullPath(key);
    const path = `/${this.config.bucket}/${fullKey}`;
    const headers = await this.signRequest("GET", path);
    const encodedPath = encodeS3Path(path);

    const response = await fetch(`${this.config.endpoint}${encodedPath}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(`S3 GetObject failed: ${response.status}`);
    }

    return response;
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const fullKey = this.getFullPath(key);
    const path = `/${this.config.bucket}/${fullKey}`;
    const encodedPath = encodeS3Path(path);
    const url = new URL(this.config.endpoint);
    const host = url.host;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const queryParams: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.config.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": expiresIn.toString(),
      "X-Amz-SignedHeaders": "host",
    };

    const sortedQueryKeys = Object.keys(queryParams).sort();
    const canonicalQueryString = sortedQueryKeys
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`)
      .join("&");

    const canonicalRequest = [
      "GET",
      encodedPath,
      canonicalQueryString,
      `host:${host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      await sha256(canonicalRequest),
    ].join("\n");

    const signingKey = await getSignatureKey(
      this.config.secretAccessKey,
      dateStamp,
      this.config.region,
      "s3"
    );
    const signature = toHex(await hmacSha256(signingKey, stringToSign));

    return `${this.config.endpoint}${encodedPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  }

  async putObject(key: string, body: ArrayBuffer | string, contentType?: string): Promise<void> {
    const fullKey = this.getFullPath(key);
    const path = `/${this.config.bucket}/${fullKey}`;
    const encodedPath = encodeS3Path(path);

    let bodyData: ArrayBuffer;
    if (typeof body === "string") {
      bodyData = new TextEncoder().encode(body).buffer as ArrayBuffer;
    } else {
      bodyData = body;
    }

    // Use UNSIGNED-PAYLOAD for binary uploads
    const headers = await this.signRequest("PUT", path, {}, {}, "", true);

    const response = await fetch(`${this.config.endpoint}${encodedPath}`, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": contentType || "application/octet-stream",
      },
      body: bodyData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`S3 PutObject failed: ${response.status} ${text}`);
    }
  }

  async deleteObject(key: string): Promise<void> {
    const fullKey = this.getFullPath(key);
    const path = `/${this.config.bucket}/${fullKey}`;
    const encodedPath = encodeS3Path(path);
    const headers = await this.signRequest("DELETE", path);

    const response = await fetch(`${this.config.endpoint}${encodedPath}`, {
      method: "DELETE",
      headers,
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new Error(`S3 DeleteObject failed: ${response.status} ${text}`);
    }
  }

  async createFolder(folderPath: string): Promise<void> {
    // S3 folders are represented by empty objects with trailing slash
    const normalizedPath = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    await this.putObject(normalizedPath, "", "application/x-directory");
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string; lastModified: string } | null> {
    const fullKey = this.getFullPath(key);
    const path = `/${this.config.bucket}/${fullKey}`;
    const encodedPath = encodeS3Path(path);
    const headers = await this.signRequest("HEAD", path);

    const response = await fetch(`${this.config.endpoint}${encodedPath}`, {
      method: "HEAD",
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`S3 HeadObject failed: ${response.status}`);
    }

    return {
      contentLength: parseInt(response.headers.get("content-length") || "0", 10),
      contentType: response.headers.get("content-type") || "application/octet-stream",
      lastModified: response.headers.get("last-modified") || "",
    };
  }
}
