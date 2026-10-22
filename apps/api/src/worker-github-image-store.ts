import { MAX_GITHUB_IMAGE_HOST_BYTES } from "@edgeever/shared";
import type {
  BlobMultipartUploadAdapter,
  BlobObjectAdapter,
  BlobStoreAdapter,
} from "./storage-contract";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_TIMEOUT_MS = 60_000;
const GITHUB_USER_AGENT = "EdgeEver-GitHub-Image-Host";

export type WorkerGitHubImageHostConfig = {
  repository: string;
  branch: string;
  objectPrefix: string;
  token: string;
  fetchImpl?: typeof fetch;
};

type GitHubContentMetadata = {
  sha: string;
  size?: number;
  download_url?: string | null;
};

const splitRepository = (repository: string) => {
  const [owner, repo, ...rest] = repository.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error("GitHub repository must use the owner/repo format.");
  return { owner, repo };
};

const encodePath = (value: string) => value
  .replace(/^\/+|\/+$/g, "")
  .split("/")
  .filter(Boolean)
  .map(encodeURIComponent)
  .join("/");

const fullObjectPath = (prefix: string, objectKey: string) => [prefix, objectKey]
  .map((value) => value.replace(/^\/+|\/+$/g, ""))
  .filter(Boolean)
  .join("/");

const githubHeaders = (token: string, json = false) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "User-Agent": GITHUB_USER_AGENT,
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
  ...(json ? { "Content-Type": "application/json" } : {}),
});

const responseError = async (operation: string, response: Response) => {
  const text = await response.text().catch(() => "");
  let message = text.replace(/\s+/g, " ").trim().slice(0, 300);
  try {
    const data = JSON.parse(text) as { message?: unknown; documentation_url?: unknown };
    if (typeof data.message === "string") message = data.message.slice(0, 300);
  } catch {
    // Some edge failures return plain text or an HTML error page.
  }
  const requestId = response.headers.get("x-github-request-id")?.trim();
  const remaining = response.headers.get("x-ratelimit-remaining")?.trim();
  const sso = response.headers.get("x-github-sso")?.trim();
  const hints = [];
  if (response.status === 401) {
    hints.push("Check that the access token is valid and has not expired.");
  } else if (response.status === 403) {
    hints.push(
      "Check that the fine-grained token can access this repository, has Metadata: Read and Contents: Read and write permissions, and is authorized for organization SSO if required.",
    );
    if (remaining === "0") hints.push("The GitHub API rate limit is exhausted.");
    if (sso) hints.push("Organization SSO authorization is required.");
  } else if (response.status === 404) {
    hints.push("Check the repository name and token repository access; GitHub returns 404 when access is denied.");
  }
  const details = [
    `${operation} failed (${response.status})`,
    message ? `: ${message}` : "",
    ...hints.map((hint) => `. ${hint}`),
    requestId ? `. GitHub Request ID: ${requestId}` : "",
  ].join("");
  return new Error(details);
};

const requestSignal = () => typeof AbortSignal.timeout === "function"
  ? AbortSignal.timeout(GITHUB_TIMEOUT_MS)
  : undefined;

const toBytes = async (value: unknown): Promise<Uint8Array> => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new Error("GitHub image storage received an unsupported request body.");
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string) => {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const sliceBody = (
  body: ReadableStream<Uint8Array>,
  offset: number,
  length: number,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let skip = offset;
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        let chunk = value;
        if (skip > 0) {
          if (chunk.byteLength <= skip) {
            skip -= chunk.byteLength;
            continue;
          }
          chunk = chunk.subarray(skip);
          skip = 0;
        }
        if (chunk.byteLength > remaining) chunk = chunk.subarray(0, remaining);
        if (chunk.byteLength > 0) {
          remaining -= chunk.byteLength;
          controller.enqueue(chunk);
        }
      }
      controller.close();
      await reader.cancel().catch(() => undefined);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
};

const totalSize = (response: Response, fallback = 0) => {
  const rangeMatch = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  return rangeMatch ? Number(rangeMatch[1]) : Number(response.headers.get("content-length") ?? fallback);
};

export const createWorkerGitHubImageStore = (
  config: WorkerGitHubImageHostConfig,
): BlobStoreAdapter => {
  const { owner, repo } = splitRepository(config.repository);
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const fetchImpl = config.fetchImpl ?? fetch;

  const request = (path: string, init: RequestInit = {}) => fetchImpl(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      ...githubHeaders(config.token, Boolean(init.body)),
      ...(init.headers as Record<string, string> | undefined),
    },
    redirect: "manual",
    signal: requestSignal(),
  });

  const contentMetadata = async (objectKey: string): Promise<GitHubContentMetadata | null> => {
    const path = fullObjectPath(config.objectPrefix, objectKey);
    const response = await request(`${repositoryPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError("GitHub file lookup", response);
    return await response.json() as GitHubContentMetadata;
  };

  const putFile = async (objectKey: string, bytes: Uint8Array) => {
    if (bytes.byteLength > MAX_GITHUB_IMAGE_HOST_BYTES) {
      throw new Error(`GitHub image host supports images up to ${MAX_GITHUB_IMAGE_HOST_BYTES / 1024 / 1024} MiB.`);
    }
    const path = fullObjectPath(config.objectPrefix, objectKey);
    const response = await request(`${repositoryPath}/contents/${encodePath(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `upload image: ${objectKey.split("/").at(-1) ?? "image"}`,
        content: bytesToBase64(bytes),
        branch: config.branch,
      }),
    });
    if (!response.ok) throw await responseError("GitHub image upload", response);
  };

  const resumeMultipartUpload = (objectKey: string, uploadId: string): BlobMultipartUploadAdapter => ({
    uploadId,
    async uploadPart(partNumber, value) {
      const bytes = await toBytes(value);
      if (bytes.byteLength <= 0 || bytes.byteLength > MAX_GITHUB_IMAGE_HOST_BYTES) {
        throw new Error("GitHub image upload part is invalid.");
      }
      const response = await request(`${repositoryPath}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: bytesToBase64(bytes), encoding: "base64" }),
      });
      if (!response.ok) throw await responseError("GitHub image staging", response);
      const data = await response.json() as { sha?: unknown };
      if (typeof data.sha !== "string" || !data.sha) throw new Error("GitHub did not return an image staging SHA.");
      return { partNumber, etag: data.sha };
    },
    async complete(parts) {
      const chunks: Uint8Array[] = [];
      let byteSize = 0;
      for (const part of [...parts].sort((left, right) => left.partNumber - right.partNumber)) {
        const response = await request(`${repositoryPath}/git/blobs/${encodeURIComponent(part.etag)}`);
        if (!response.ok) throw await responseError("GitHub staged image read", response);
        const data = await response.json() as { content?: unknown; encoding?: unknown };
        if (typeof data.content !== "string" || data.encoding !== "base64") {
          throw new Error("GitHub returned invalid staged image data.");
        }
        const chunk = base64ToBytes(data.content);
        byteSize += chunk.byteLength;
        if (byteSize > MAX_GITHUB_IMAGE_HOST_BYTES) {
          throw new Error(`GitHub image host supports images up to ${MAX_GITHUB_IMAGE_HOST_BYTES / 1024 / 1024} MiB.`);
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(byteSize);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await putFile(objectKey, bytes);
    },
    async abort() {
      // Git blobs are unreachable without a commit and expire through GitHub's
      // normal object lifecycle. Aborting only clears the application session.
    },
  });

  return {
    maxObjectBytes: MAX_GITHUB_IMAGE_HOST_BYTES,

    async get(objectKey, options): Promise<BlobObjectAdapter | null> {
      const metadata = await contentMetadata(objectKey);
      if (!metadata) return null;
      if (!metadata.download_url) throw new Error("GitHub did not return a public image URL.");
      const headers = new Headers();
      if (options?.range) {
        headers.set("Range", `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`);
      }
      const response = await fetchImpl(metadata.download_url, { headers, redirect: "follow" });
      if (response.status === 404) return null;
      if (!response.ok || !response.body) throw await responseError("GitHub image download", response);
      const range = options?.range;
      const body = range && response.status !== 206
        ? sliceBody(response.body, range.offset, range.length)
        : response.body;
      return {
        body,
        size: totalSize(response, metadata.size ?? 0),
        range: range
          ? {
              offset: range.offset,
              length: response.status === 206
                ? Number(response.headers.get("content-length") ?? range.length)
                : range.length,
            }
          : undefined,
        writeHttpMetadata: (target) => {
          for (const name of ["content-type", "cache-control", "content-disposition", "etag", "last-modified"]) {
            const value = response.headers.get(name);
            if (value) target.set(name, value);
          }
        },
      };
    },

    put: async (objectKey, value) => putFile(objectKey, await toBytes(value)),
    createMultipartUpload: async (objectKey) => resumeMultipartUpload(objectKey, crypto.randomUUID()),
    resumeMultipartUpload,

    async delete(objectKeys) {
      for (const objectKey of Array.isArray(objectKeys) ? objectKeys : [objectKeys]) {
        const metadata = await contentMetadata(objectKey);
        if (!metadata) continue;
        const path = fullObjectPath(config.objectPrefix, objectKey);
        const response = await request(`${repositoryPath}/contents/${encodePath(path)}`, {
          method: "DELETE",
          body: JSON.stringify({
            message: `delete image: ${objectKey.split("/").at(-1) ?? "image"}`,
            sha: metadata.sha,
            branch: config.branch,
          }),
        });
        if (!response.ok && response.status !== 404) throw await responseError("GitHub image deletion", response);
      }
    },
  };
};

export const testWorkerGitHubImageHostConnection = async (
  config: WorkerGitHubImageHostConfig,
) => {
  const { owner, repo } = splitRepository(config.repository);
  const fetchImpl = config.fetchImpl ?? fetch;
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const request = (path: string) => fetchImpl(`${GITHUB_API_BASE}${path}`, {
    headers: githubHeaders(config.token),
    redirect: "manual",
    signal: requestSignal(),
  });

  const repositoryResponse = await request(repositoryPath);
  if (!repositoryResponse.ok) throw await responseError("GitHub repository check", repositoryResponse);
  const repository = await repositoryResponse.json().catch(() => null) as {
    private?: boolean;
    permissions?: { push?: boolean };
  } | null;
  if (repository?.private) throw new Error("Use a public GitHub repository for instance image hosting.");
  if (repository?.permissions?.push === false) throw new Error("The GitHub token cannot write to this repository.");

  const branchResponse = await request(`${repositoryPath}/branches/${encodeURIComponent(config.branch)}`);
  if (!branchResponse.ok) throw await responseError("GitHub branch check", branchResponse);
  return true;
};
