// Legacy PicGo names and the v1 storage key are retained so existing desktop
// image-host preferences migrate in place when GitHub support is enabled.
export const PICGO_STORAGE_KEY = "edgeever.desktop.picgo.v1";
export const DEFAULT_PICGO_ENDPOINT = "http://127.0.0.1:36677/upload";
export type ImageHostProvider = "edgeever" | "picgo" | "github";

export type GitHubImageHostConfig = {
  repository: string;
  branch: string;
  directory: string;
  token: string;
};

export type PicGoPreference = {
  provider: ImageHostProvider;
  endpoint: string;
  github: GitHubImageHostConfig;
};

export const DEFAULT_GITHUB_IMAGE_HOST: GitHubImageHostConfig = {
  repository: "",
  branch: "main",
  directory: "edgeever",
  token: "",
};

const readString = (value: unknown, fallback: string) => typeof value === "string" ? value : fallback;

export const readPicGoPreference = (): PicGoPreference => {
  const fallback: PicGoPreference = {
    provider: "edgeever",
    endpoint: DEFAULT_PICGO_ENDPOINT,
    github: DEFAULT_GITHUB_IMAGE_HOST,
  };
  try {
    const value = JSON.parse(window.localStorage.getItem(PICGO_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const provider: ImageHostProvider = value.provider === "picgo" || value.provider === "github"
      ? value.provider
      : "edgeever";
    return {
      provider,
      endpoint: readString(value.endpoint, DEFAULT_PICGO_ENDPOINT),
      github: {
        repository: readString(value.github?.repository, DEFAULT_GITHUB_IMAGE_HOST.repository),
        branch: readString(value.github?.branch, DEFAULT_GITHUB_IMAGE_HOST.branch),
        directory: readString(value.github?.directory, DEFAULT_GITHUB_IMAGE_HOST.directory),
        token: readString(value.github?.token, DEFAULT_GITHUB_IMAGE_HOST.token),
      },
    };
  } catch { return fallback; }
};

export const writePicGoPreference = (value: PicGoPreference) => {
  // Fail visibly when persistence is unavailable; never claim a provider changed.
  window.localStorage.setItem(PICGO_STORAGE_KEY, JSON.stringify(value));
};

export const hasPicGoBridge = () => Boolean(window.edgeeverDesktop?.uploadPicGoImage && window.edgeeverDesktop?.testPicGoConnection);

export const shouldUploadWithPicGo = () => hasPicGoBridge() && readPicGoPreference().provider === "picgo";

export type PicGoFailureCopy = { title: string; message: string; retry: string; fallback: string; cancel: string };

export const uploadImageWithPicGo = async (file: File, copy: PicGoFailureCopy) => {
  const preference = readPicGoPreference();
  if (preference.provider !== "picgo" || !hasPicGoBridge()) return null;
  const result = await window.edgeeverDesktop!.uploadPicGoImage({
    endpoint: preference.endpoint, bytes: new Uint8Array(await file.arrayBuffer()),
    filename: file.name, mimeType: file.type, copy,
  });
  return "url" in result ? {
    kind: "image" as const, url: result.url, filename: file.name, mimeType: file.type, byteSize: file.size,
  } : null;
};

const GITHUB_API_BASE = "https://api.github.com";
export const MAX_GITHUB_IMAGE_BYTES = 50 * 1024 * 1024;

type NormalizedGitHubImageHostConfig = GitHubImageHostConfig & {
  owner: string;
  repo: string;
  directory: string;
};

export type GitHubRequestOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const hasControlCharacter = (value: string, includeWhitespace = false) => Array.from(value).some((character) => {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127 || (includeWhitespace && /\s/u.test(character));
});

const normalizePathSegment = (value: string) => {
  if (!value || value === "." || value === ".." || hasControlCharacter(value) || value.includes("\\")) {
    throw new Error("GitHub storage path is invalid");
  }
  return value;
};

const normalizeDirectory = (value: string) => value
  .trim()
  .replace(/^\/+|\/+$/g, "")
  .split("/")
  .filter(Boolean)
  .map(normalizePathSegment)
  .join("/");

const parseGitHubRepository = (value: string) => {
  const repository = value.trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = repository.split("/");
  if (parts.length !== 2) throw new Error("GitHub repository must use the owner/repo format");
  const [owner, repo] = parts.map((part) => part.trim());
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)
    || owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new Error("GitHub repository must use the owner/repo format");
  }
  return { owner, repo };
};

const normalizeGitHubImageHostConfig = (value: GitHubImageHostConfig): NormalizedGitHubImageHostConfig => {
  const { owner, repo } = parseGitHubRepository(value.repository);
  const branch = value.branch.trim();
  const invalidBranchCharacter = Array.from(branch).some((character) => "~^:?*[]\\".includes(character));
  if (!branch || branch.length > 255 || hasControlCharacter(branch, true) || invalidBranchCharacter
    || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/") || branch.startsWith(".") || branch.endsWith(".")) {
    throw new Error("GitHub branch name is invalid");
  }
  const directory = normalizeDirectory(value.directory);
  if (directory.length > 500) throw new Error("GitHub storage directory is too long");
  const token = value.token.trim();
  if (!token || token.length > 4096 || /\s/u.test(token)) throw new Error("GitHub access token is invalid");
  return { ...value, owner, repo, branch, directory, token };
};

export const isGitHubImageHostConfigured = (value: GitHubImageHostConfig) => {
  try {
    normalizeGitHubImageHostConfig(value);
    return true;
  } catch {
    return false;
  }
};

export const shouldUploadWithGitHub = () => {
  const preference = readPicGoPreference();
  return preference.provider === "github" && isGitHubImageHostConfigured(preference.github);
};

const githubHeaders = (token: string, json = false) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  ...(json ? { "Content-Type": "application/json" } : {}),
});

const githubError = async (response: Response) => {
  const data = await response.json().catch(() => null) as { message?: unknown } | null;
  const detail = typeof data?.message === "string" && data.message.length <= 300 ? `: ${data.message}` : "";
  return new Error(`GitHub API ${response.status}${detail}`);
};

const requestSignal = (timeoutMs: number) => typeof AbortSignal.timeout === "function"
  ? AbortSignal.timeout(timeoutMs)
  : undefined;

export const testGitHubImageHost = async (
  value: GitHubImageHostConfig,
  { fetchImpl = fetch, timeoutMs = 15_000 }: GitHubRequestOptions = {},
) => {
  const config = normalizeGitHubImageHostConfig(value);
  const repositoryUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const repositoryResponse = await fetchImpl(repositoryUrl, {
    headers: githubHeaders(config.token), redirect: "error", signal: requestSignal(timeoutMs),
  });
  if (!repositoryResponse.ok) throw await githubError(repositoryResponse);
  const repository = await repositoryResponse.json().catch(() => null) as {
    private?: boolean;
    permissions?: { push?: boolean };
  } | null;
  if (repository?.private) throw new Error("Use a public GitHub repository for external images");
  if (repository?.permissions?.push === false) throw new Error("The GitHub token cannot write to this repository");

  const branchResponse = await fetchImpl(
    `${repositoryUrl}/branches/${encodeURIComponent(config.branch)}`,
    { headers: githubHeaders(config.token), redirect: "error", signal: requestSignal(timeoutMs) },
  );
  if (!branchResponse.ok) throw await githubError(branchResponse);
  return true;
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const encodeGitHubPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const sanitizeFilename = (filename: string, mimeType: string) => {
  const fallbackExtension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  const withoutUnsafeSeparators = Array.from(filename.trim(), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === "/" || character === "\\" ? "-" : character;
  }).join("");
  const trimmed = withoutUnsafeSeparators
    .replace(/\.\.+/g, "-")
    .replace(/[<>:"|?*]+/g, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const safe = trimmed && trimmed !== "." && trimmed !== ".." ? trimmed : `image.${fallbackExtension}`;
  return safe.slice(-160);
};

const createUploadNonce = () => typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export const createGitHubImagePath = (
  directory: string,
  filename: string,
  mimeType: string,
  { now = new Date(), nonce = createUploadNonce() }: { now?: Date; nonce?: string } = {},
) => {
  const date = now.toISOString().slice(0, 10).split("-");
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeNonce = nonce.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "image";
  return [normalizeDirectory(directory), date[0], date[1], `${timestamp}-${safeNonce}-${sanitizeFilename(filename, mimeType)}`]
    .filter(Boolean)
    .join("/");
};

export const uploadImageWithGitHub = async (
  file: File,
  { fetchImpl = fetch, timeoutMs = 60_000, now, nonce }: GitHubRequestOptions & { now?: Date; nonce?: string } = {},
) => {
  const preference = readPicGoPreference();
  if (preference.provider !== "github") return null;
  const config = normalizeGitHubImageHostConfig(preference.github);
  if (!file.type.startsWith("image/")) throw new Error("GitHub image hosting only accepts image files");
  if (file.size <= 0 || file.size > MAX_GITHUB_IMAGE_BYTES) throw new Error("GitHub images must be between 1 byte and 50 MB");

  const filename = sanitizeFilename(file.name, file.type);
  const path = createGitHubImagePath(config.directory, filename, file.type, { now, nonce });
  const response = await fetchImpl(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodeGitHubPath(path)}`,
    {
      method: "PUT",
      headers: githubHeaders(config.token, true),
      body: JSON.stringify({
        message: `upload image: ${filename}`,
        content: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        branch: config.branch,
      }),
      redirect: "error",
      signal: requestSignal(timeoutMs),
    },
  );
  if (!response.ok) throw await githubError(response);
  const data = await response.json().catch(() => null) as { content?: { download_url?: unknown } } | null;
  const downloadUrl = data?.content?.download_url;
  if (typeof downloadUrl !== "string") throw new Error("GitHub did not return an image URL");
  const url = new URL(downloadUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("GitHub returned an invalid image URL");
  return {
    kind: "image" as const,
    url: url.href,
    filename: file.name,
    mimeType: file.type,
    byteSize: file.size,
  };
};
