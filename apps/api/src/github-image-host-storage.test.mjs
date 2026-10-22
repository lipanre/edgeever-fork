import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { globSync, readFileSync } from "node:fs";
import { MAX_GITHUB_IMAGE_HOST_BYTES } from "@edgeever/shared";
import {
  resolveImageObjectStorage,
  resolveObjectStorage,
  resolvePrimaryObjectStorageEncryptionKey,
} from "./object-storage.ts";
import { assertObjectStorageSizeLimit } from "./resource-service.ts";
import { encryptSecret } from "./secret-encryption.ts";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";

const authPassword = "fake-instance-auth-password";
const configId = "github-image-host_test";
const primaryKey = resolvePrimaryObjectStorageEncryptionKey({ EDGE_EVER_AUTH_PASSWORD: authPassword });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const installation = async ({ enabled = true } = {}) => {
  const sqlite = new Database(":memory:");
  for (const path of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(path, "utf8"));
  sqlite.query(
    `INSERT INTO github_image_host_configs (
       id, repository, branch, object_prefix, token_encrypted, is_enabled, is_current
     ) VALUES (?, 'owner/repo', 'main', 'edgeever/images', ?, ?, 1)`,
  ).run(
    configId,
    await encryptSecret("github_pat_test", primaryKey),
    enabled ? 1 : 0,
  );
  const storage = createSelfHostedStorageAdapter(sqlite, "/tmp/edgeever-github-image-host-storage-test-unused");
  return {
    sqlite,
    environment: { EDGE_EVER_AUTH_PASSWORD: authPassword, storage },
  };
};

describe("instance GitHub image storage resolution", () => {
  test("upgrades an existing database without changing built-in object storage", () => {
    const sqlite = new Database(":memory:");
    const migrationPaths = globSync("migrations/*.sql").sort();
    const latest = migrationPaths.find((path) => path.endsWith("0073_instance_github_image_host.sql"));
    expect(latest).toBeTruthy();
    for (const path of migrationPaths.filter((item) => item !== latest)) {
      sqlite.exec(readFileSync(path, "utf8"));
    }
    const before = sqlite.query(
      "SELECT id, provider, is_active FROM object_storage_configs WHERE is_active = 1",
    ).all();

    sqlite.exec(readFileSync(latest, "utf8"));

    expect(sqlite.query(
      "SELECT id, provider, is_active FROM object_storage_configs WHERE is_active = 1",
    ).all()).toEqual(before);
    expect(sqlite.query("SELECT COUNT(*) AS count FROM github_image_host_configs").get().count).toBe(0);
    sqlite.close();
  });

  test("routes new images to GitHub while attachments and existing resources keep their stores", async () => {
    const { sqlite, environment } = await installation();

    const imageStore = await resolveImageObjectStorage(environment);
    expect(imageStore.configId).toBe(configId);
    expect(imageStore.bucketName).toBe("github:owner/repo");
    expect(imageStore.store.maxObjectBytes).toBe(MAX_GITHUB_IMAGE_HOST_BYTES);

    const attachmentStore = await resolveObjectStorage(environment);
    expect(attachmentStore.configId).toBe("builtin");
    expect(attachmentStore.store).toBe(environment.storage.resources);

    sqlite.exec("UPDATE github_image_host_configs SET is_enabled = 0");
    expect((await resolveImageObjectStorage(environment)).configId).toBe("builtin");
    expect((await resolveObjectStorage(environment, configId)).configId)
      .toBe(configId);

    sqlite.exec("UPDATE github_image_host_configs SET is_current = 0");
    sqlite.query(
      `INSERT INTO github_image_host_configs (
         id, repository, branch, object_prefix, token_encrypted, is_enabled, is_current
       ) VALUES ('github-image-host_new', 'owner/repo', 'main', 'edgeever/new-images', ?, 1, 1)`,
    ).run(await encryptSecret("github_pat_test", primaryKey));
    expect((await resolveImageObjectStorage(environment)).configId).toBe("github-image-host_new");
    expect((await resolveObjectStorage(environment, configId)).configId).toBe(configId);
    sqlite.close();
  });

  test("rejects images above the GitHub provider limit before upload", async () => {
    const { sqlite, environment } = await installation();
    const imageStore = await resolveImageObjectStorage(environment);

    expect(() => assertObjectStorageSizeLimit(imageStore.store, MAX_GITHUB_IMAGE_HOST_BYTES)).not.toThrow();
    expect(() => assertObjectStorageSizeLimit(imageStore.store, MAX_GITHUB_IMAGE_HOST_BYTES + 1))
      .toThrow("20 MiB");
    sqlite.close();
  });
});
