import { afterEach, describe, expect, test } from "bun:test";
import { createWorkerGitHubImageStore, testWorkerGitHubImageHostConnection } from "./worker-github-image-store.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const config = (fetchImpl) => ({
  repository: "owner/repo",
  branch: "main",
  objectPrefix: "edgeever/images",
  token: "github_pat_test",
  fetchImpl,
});

describe("worker GitHub image store", () => {
  test("verifies a public repository, branch, and push permission", async () => {
    const requests = [];
    const fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname,
        authorization: init.headers.Authorization,
        userAgent: init.headers["User-Agent"],
        redirect: init.redirect,
      });
      if (url.pathname === "/repos/owner/repo") return Response.json({ private: false, permissions: { push: true } });
      if (url.pathname === "/repos/owner/repo/branches/main") return Response.json({ name: "main" });
      return Response.json({ message: "Not Found" }, { status: 404 });
    };

    expect(await testWorkerGitHubImageHostConnection(config(fetchImpl))).toBe(true);
    expect(requests).toEqual([
      { path: "/repos/owner/repo", authorization: "Bearer github_pat_test", userAgent: "EdgeEver-GitHub-Image-Host", redirect: "manual" },
      { path: "/repos/owner/repo/branches/main", authorization: "Bearer github_pat_test", userAgent: "EdgeEver-GitHub-Image-Host", redirect: "manual" },
    ]);
  });

  test("rejects redirects instead of treating them as successful", async () => {
    await expect(testWorkerGitHubImageHostConnection(config(async () => new Response(null, {
      status: 302,
      headers: { location: "https://example.com/redirected" },
    })))).rejects.toThrow("failed (302)");
  });

  test("reports actionable GitHub permission failures without leaking credentials", async () => {
    const failure = testWorkerGitHubImageHostConnection(config(async () => Response.json({
      message: "Resource not accessible by personal access token",
    }, {
      status: 403,
      headers: {
        "x-github-request-id": "REQ-123",
        "x-ratelimit-remaining": "0",
      },
    })));

    await expect(failure).rejects.toThrow("Resource not accessible by personal access token");
    await expect(failure).rejects.toThrow("Metadata: Read and Contents: Read and write");
    await expect(failure).rejects.toThrow("rate limit is exhausted");
    await expect(failure).rejects.toThrow("GitHub Request ID: REQ-123");
    await expect(failure).rejects.not.toThrow("github_pat_test");
  });

  test("uploads, reads with a range, and deletes an image through the Contents API", async () => {
    const requests = [];
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({ url: url.href, method: init.method ?? "GET", body: init.body });
      if (url.pathname === "/repos/owner/repo/contents/edgeever/images/workspaces/ws/memos/memo/image.png") {
        if ((init.method ?? "GET") === "PUT") return Response.json({ content: { sha: "new-sha" } }, { status: 201 });
        return Response.json({
          sha: "file-sha",
          size: 4,
          download_url: "https://raw.githubusercontent.com/owner/repo/main/edgeever/images/workspaces/ws/memos/memo/image.png",
        });
      }
      if (url.hostname === "raw.githubusercontent.com") {
        return new Response(new Uint8Array([2, 3]), {
          status: 206,
          headers: { "content-type": "image/png", "content-range": "bytes 1-2/4", "content-length": "2" },
        });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    };
    const store = createWorkerGitHubImageStore(config(fetchImpl));

    await store.put("workspaces/ws/memos/memo/image.png", new Uint8Array([1, 2, 3, 4]));
    const object = await store.get("workspaces/ws/memos/memo/image.png", { range: { offset: 1, length: 2 } });
    expect(object?.size).toBe(4);
    expect(object?.range).toEqual({ offset: 1, length: 2 });
    expect(new Uint8Array(await new Response(object?.body).arrayBuffer())).toEqual(new Uint8Array([2, 3]));

    await store.delete("workspaces/ws/memos/memo/image.png");
    const put = requests.find((request) => request.method === "PUT");
    expect(JSON.parse(put.body)).toMatchObject({
      message: "upload image: image.png",
      content: "AQIDBA==",
      branch: "main",
    });
    expect(requests.at(-1)).toMatchObject({ method: "DELETE" });
    expect(JSON.parse(requests.at(-1).body)).toMatchObject({ sha: "file-sha", branch: "main" });
  });

  test("stages multipart parts as Git blobs and commits the combined image", async () => {
    const requests = [];
    const blobValues = new Map();
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({ path: url.pathname, method: init.method ?? "GET", body: init.body });
      if (url.pathname === "/repos/owner/repo/git/blobs" && init.method === "POST") {
        const payload = JSON.parse(init.body);
        const sha = `blob-${blobValues.size + 1}`;
        blobValues.set(sha, payload.content);
        return Response.json({ sha }, { status: 201 });
      }
      if (url.pathname.startsWith("/repos/owner/repo/git/blobs/")) {
        const sha = decodeURIComponent(url.pathname.split("/").at(-1));
        return Response.json({ content: blobValues.get(sha), encoding: "base64" });
      }
      if (url.pathname === "/repos/owner/repo/contents/edgeever/images/workspaces/ws/memos/memo/image.webp" && init.method === "PUT") {
        return Response.json({ content: { sha: "final" } }, { status: 201 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    };
    const store = createWorkerGitHubImageStore(config(fetchImpl));
    const multipart = await store.createMultipartUpload("workspaces/ws/memos/memo/image.webp");
    const first = await multipart.uploadPart(1, new Uint8Array([1, 2]));
    const second = await multipart.uploadPart(2, new Uint8Array([3, 4]));
    await store.resumeMultipartUpload("workspaces/ws/memos/memo/image.webp", multipart.uploadId).complete([first, second]);

    const finalPut = requests.find((request) => request.path.endsWith("/contents/edgeever/images/workspaces/ws/memos/memo/image.webp"));
    expect(JSON.parse(finalPut.body).content).toBe("AQIDBA==");
    expect(requests.filter((request) => request.path === "/repos/owner/repo/git/blobs")).toHaveLength(2);
  });
});
