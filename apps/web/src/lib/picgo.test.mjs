import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_GITHUB_IMAGE_HOST,
  DEFAULT_PICGO_ENDPOINT,
  PICGO_STORAGE_KEY,
  createGitHubImagePath,
  readPicGoPreference,
  shouldUploadWithGitHub,
  shouldUploadWithPicGo,
  testGitHubImageHost,
  uploadImageWithGitHub,
  uploadImageWithPicGo,
  writePicGoPreference,
} from "./picgo.ts";

const previousWindow = globalThis.window;
afterEach(() => {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});
const setup = (upload) => {
  const storage = new Map();
  globalThis.window = {
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    edgeeverDesktop: upload ? { uploadPicGoImage: upload, testPicGoConnection: async () => true } : undefined,
  };
  return storage;
};
const copy = { title: "Failed", message: "Retry?", retry: "Retry", fallback: "EdgeEver", cancel: "Cancel" };
const file = () => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
const github = { repository: "owner/repo", branch: "main", directory: "images", token: "github_pat_test" };

test("default, corrupt settings and ordinary Web runtime retain attachment uploads", async () => {
  const storage = setup();
  expect(readPicGoPreference()).toEqual({ provider: "edgeever", endpoint: DEFAULT_PICGO_ENDPOINT, github: DEFAULT_GITHUB_IMAGE_HOST });
  storage.set(PICGO_STORAGE_KEY, "corrupt");
  expect(shouldUploadWithPicGo()).toBe(false);
  writePicGoPreference({ provider: "picgo", endpoint: DEFAULT_PICGO_ENDPOINT, github: DEFAULT_GITHUB_IMAGE_HOST });
  expect(shouldUploadWithPicGo()).toBe(false);
  expect(await uploadImageWithPicGo(file(), copy)).toBeNull();
});

test("configured but disabled PicGo never sends an image", async () => {
  setup(() => { throw new Error("Should not upload"); });
  writePicGoPreference({ provider: "edgeever", endpoint: DEFAULT_PICGO_ENDPOINT, github: DEFAULT_GITHUB_IMAGE_HOST });
  expect(shouldUploadWithPicGo()).toBe(false);
  expect(await uploadImageWithPicGo(file(), copy)).toBeNull();
});

test("enabled PicGo passes actual bytes and returns an external image for either editor mode", async () => {
  setup(async (input) => {
    expect(input.endpoint).toBe(DEFAULT_PICGO_ENDPOINT);
    expect(input.bytes).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(input.copy).toEqual(copy);
    return { url: "https://images.example.com/image.png" };
  });
  writePicGoPreference({ provider: "picgo", endpoint: DEFAULT_PICGO_ENDPOINT, github: DEFAULT_GITHUB_IMAGE_HOST });
  expect(shouldUploadWithPicGo()).toBe(true);
  expect(await uploadImageWithPicGo(file(), copy)).toEqual({
    kind: "image", url: "https://images.example.com/image.png", filename: "image.png", mimeType: "image/png", byteSize: 4,
  });
});

test("only explicit fallback returns to attachment storage; cancellation stays a failure", async () => {
  setup(async () => ({ fallback: true }));
  writePicGoPreference({ provider: "picgo", endpoint: DEFAULT_PICGO_ENDPOINT, github: DEFAULT_GITHUB_IMAGE_HOST });
  expect(await uploadImageWithPicGo(file(), copy)).toBeNull();
  window.edgeeverDesktop.uploadPicGoImage = async () => { throw new Error("Cancelled"); };
  await expect(uploadImageWithPicGo(file(), copy)).rejects.toThrow("Cancelled");
});

test("legacy PicGo preferences gain GitHub defaults without losing the existing provider", () => {
  const storage = setup();
  storage.set(PICGO_STORAGE_KEY, JSON.stringify({ provider: "picgo", endpoint: "http://127.0.0.1:36677/upload" }));
  expect(readPicGoPreference()).toEqual({
    provider: "picgo",
    endpoint: "http://127.0.0.1:36677/upload",
    github: DEFAULT_GITHUB_IMAGE_HOST,
  });
});

test("GitHub settings are detected and repository plus branch access are verified", async () => {
  setup();
  writePicGoPreference({ provider: "github", endpoint: DEFAULT_PICGO_ENDPOINT, github });
  expect(shouldUploadWithGitHub()).toBe(true);
  const requests = [];
  const fetchImpl = async (input, init) => {
    requests.push([String(input), init]);
    return requests.length === 1
      ? Response.json({ private: false, permissions: { push: true } })
      : Response.json({ name: "main" });
  };
  expect(await testGitHubImageHost(github, { fetchImpl })).toBe(true);
  expect(requests.map(([url]) => url)).toEqual([
    "https://api.github.com/repos/owner/repo",
    "https://api.github.com/repos/owner/repo/branches/main",
  ]);
  expect(requests[0][1].headers.Authorization).toBe("Bearer github_pat_test");
  expect(requests[0][1].headers.Accept).toBe("application/vnd.github+json");
});

test("GitHub connection test rejects private or read-only repositories", async () => {
  setup();
  await expect(testGitHubImageHost(github, {
    fetchImpl: async () => Response.json({ private: true, permissions: { push: true } }),
  })).rejects.toThrow("public GitHub repository");
  await expect(testGitHubImageHost(github, {
    fetchImpl: async () => Response.json({ private: false, permissions: { push: false } }),
  })).rejects.toThrow("cannot write");
});

test("GitHub upload sends image bytes to the selected branch and returns the external URL", async () => {
  setup();
  writePicGoPreference({ provider: "github", endpoint: DEFAULT_PICGO_ENDPOINT, github });
  let request;
  const fetchImpl = async (input, init) => {
    request = { url: String(input), init };
    return Response.json({ content: { download_url: "https://raw.githubusercontent.com/owner/repo/main/images/photo.png" } });
  };
  const uploaded = await uploadImageWithGitHub(
    new File([new Uint8Array([0, 1, 2, 255])], "照片.png", { type: "image/png" }),
    { fetchImpl, now: new Date("2026-10-22T14:30:00.000Z"), nonce: "abc-123" },
  );
  expect(request.url).toBe("https://api.github.com/repos/owner/repo/contents/images/2026/10/20261022T143000Z-abc123-%E7%85%A7%E7%89%87.png");
  expect(request.init.method).toBe("PUT");
  expect(request.init.headers.Authorization).toBe("Bearer github_pat_test");
  expect(JSON.parse(request.init.body)).toEqual({
    message: "upload image: 照片.png",
    content: "AAEC/w==",
    branch: "main",
  });
  expect(uploaded).toEqual({
    kind: "image",
    url: "https://raw.githubusercontent.com/owner/repo/main/images/photo.png",
    filename: "照片.png",
    mimeType: "image/png",
    byteSize: 4,
  });
});

test("GitHub upload validates file type, configuration and API failures", async () => {
  setup();
  writePicGoPreference({ provider: "github", endpoint: DEFAULT_PICGO_ENDPOINT, github });
  await expect(uploadImageWithGitHub(new File(["pdf"], "file.pdf", { type: "application/pdf" }), {
    fetchImpl: () => { throw new Error("Should not fetch"); },
  })).rejects.toThrow("only accepts image files");
  await expect(uploadImageWithGitHub(file(), {
    fetchImpl: async () => Response.json({ message: "Bad credentials" }, { status: 401 }),
  })).rejects.toThrow("GitHub API 401: Bad credentials");
  writePicGoPreference({ provider: "github", endpoint: DEFAULT_PICGO_ENDPOINT, github: { ...github, token: "" } });
  expect(shouldUploadWithGitHub()).toBe(false);
  await expect(uploadImageWithGitHub(file())).rejects.toThrow("access token");
});

test("GitHub image paths remove traversal and unsafe filename characters", () => {
  expect(createGitHubImagePath("/images//", "../shot one?.png", "image/png", {
    now: new Date("2026-01-02T03:04:05.000Z"), nonce: "../../fixed",
  })).toBe("images/2026/01/20260102T030405Z-fixed-shot-one-.png");
  expect(() => createGitHubImagePath("../secret", "image.png", "image/png")).toThrow("storage path");
});
