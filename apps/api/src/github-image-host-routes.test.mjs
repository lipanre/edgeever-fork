import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { AppError } from "./app-error.ts";
import { registerGitHubImageHostRoutes } from "./github-image-host-routes.ts";
import { apiError } from "./http-errors.ts";
import { resolvePrimaryObjectStorageEncryptionKey } from "./object-storage.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { decryptSecret } from "./secret-encryption.ts";

const auth = {
  kind: "user",
  actorType: "user",
  actorId: "usr_owner",
  username: "owner",
  displayName: "Owner",
  scopes: [],
  workspaceId: "ws_owner",
  role: "owner",
};
const authPassword = "fake-instance-auth-password";
const primaryKey = resolvePrimaryObjectStorageEncryptionKey({ EDGE_EVER_AUTH_PASSWORD: authPassword });
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

const githubSettings = (overrides = {}) => ({
  enabled: true,
  repository: "owner/repo",
  branch: "main",
  objectPrefix: "edgeever/images",
  token: "github_pat_test_token",
  ...overrides,
});

const installation = ({ currentAuth = auth, demoMode = false } = {}) => {
  const sqlite = new Database(":memory:");
  for (const path of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(path, "utf8"));
  const app = new Hono();
  app.onError((error, context) => error instanceof AppError
    ? apiError(context, error.code, error.message, error.status)
    : context.json({ error: { code: "internal_error", message: error.message } }, 500));
  app.use("/api/v1/*", async (context, next) => {
    context.set("auth", currentAuth);
    await next();
  });
  registerGitHubImageHostRoutes(app, { isDemoMode: () => demoMode });
  const environment = {
    EDGE_EVER_AUTH_PASSWORD: authPassword,
    storage: createSelfHostedStorageAdapter(sqlite, "/tmp/edgeever-github-image-host-route-test-unused"),
  };
  const request = (path, { method = "GET", body } = {}) => app.request(
    path,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    environment,
  );
  return { sqlite, request };
};

const stubGitHub = ({ privateRepository = false, push = true } = {}) => {
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, method: init.method ?? "GET" });
    if (url.pathname === "/repos/owner/repo") {
      return Response.json({ private: privateRepository, permissions: { push } });
    }
    if (url.pathname === "/repos/owner/repo/branches/main") return Response.json({ name: "main" });
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return requests;
};

describe("instance GitHub image host routes", () => {
  test("only owners can read or change the instance image host", async () => {
    const { request, sqlite } = installation({ currentAuth: { ...auth, role: "member" } });
    const read = await request("/api/v1/instance/github-image-host");
    const write = await request("/api/v1/instance/github-image-host", { method: "PUT", body: githubSettings() });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM github_image_host_configs").get().count).toBe(0);
    sqlite.close();
  });

  test("returns an empty state before configuration", async () => {
    const { request, sqlite } = installation();
    const response = await request("/api/v1/instance/github-image-host");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: null, encryptionConfigured: true });
    sqlite.close();
  });

  test("tests repository and branch access without saving credentials", async () => {
    const { request, sqlite } = installation();
    const requests = stubGitHub();

    const response = await request("/api/v1/instance/github-image-host/test", {
      method: "POST",
      body: githubSettings(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(requests).toEqual([
      { path: "/repos/owner/repo", method: "GET" },
      { path: "/repos/owner/repo/branches/main", method: "GET" },
    ]);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM github_image_host_configs").get().count).toBe(0);
    sqlite.close();
  });

  test("saves an encrypted token and keeps it when disabling the image host", async () => {
    const { request, sqlite } = installation();
    const requests = stubGitHub();
    const saved = await request("/api/v1/instance/github-image-host", {
      method: "PUT",
      body: githubSettings(),
    });

    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({
      enabled: true,
      repository: "owner/repo",
      branch: "main",
      objectPrefix: "edgeever/images",
      hasToken: true,
      encryptionConfigured: true,
    });
    const row = sqlite.query(
      "SELECT id, repository, branch, object_prefix, token_encrypted, is_enabled, is_current FROM github_image_host_configs WHERE is_current = 1",
    ).get();
    expect(row).toMatchObject({ repository: "owner/repo", branch: "main", object_prefix: "edgeever/images", is_enabled: 1, is_current: 1 });
    expect(row.id).toStartWith("github-image-host_");
    expect(row.token_encrypted).not.toContain(githubSettings().token);
    expect(await decryptSecret(row.token_encrypted, primaryKey)).toBe(githubSettings().token);
    expect(requests).toHaveLength(2);

    const disabled = await request("/api/v1/instance/github-image-host", {
      method: "PUT",
      body: githubSettings({ enabled: false, token: undefined }),
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).settings).toMatchObject({ enabled: false, hasToken: true });
    expect(requests).toHaveLength(2);
    sqlite.close();
  });

  test("creates a new configuration version when the storage location changes", async () => {
    const { request, sqlite } = installation();
    stubGitHub();
    await request("/api/v1/instance/github-image-host", { method: "PUT", body: githubSettings() });
    const first = sqlite.query(
      "SELECT id FROM github_image_host_configs WHERE is_current = 1",
    ).get();

    const moved = await request("/api/v1/instance/github-image-host", {
      method: "PUT",
      body: githubSettings({ objectPrefix: "edgeever/new-images", token: undefined }),
    });
    expect(moved.status).toBe(200);
    const rows = sqlite.query(
      "SELECT id, object_prefix, is_current FROM github_image_host_configs ORDER BY created_at, rowid",
    ).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: first.id, is_current: 0 });
    expect(rows[1]).toMatchObject({ object_prefix: "edgeever/new-images", is_current: 1 });
    expect(rows[1].id).not.toBe(first.id);
    sqlite.close();
  });

  test("rejects private repositories and members before persistence", async () => {
    const { request, sqlite } = installation();
    stubGitHub({ privateRepository: true });
    const response = await request("/api/v1/instance/github-image-host", {
      method: "PUT",
      body: githubSettings(),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "github_image_host_connection_failed" } });
    expect(sqlite.query("SELECT COUNT(*) AS count FROM github_image_host_configs").get().count).toBe(0);
    sqlite.close();
  });
});
