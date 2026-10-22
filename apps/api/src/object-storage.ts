import {
  isGitHubImageHostConfigId,
  type GitHubImageHostSettings,
  type ObjectStorageSettings,
} from "@edgeever/shared";
import { AppError } from "./app-error";
import { decryptSecret, encryptSecret } from "./secret-encryption";
import type { BlobStoreAdapter, DatabaseAdapter } from "./storage-contract";
import {
  createWorkerGitHubImageStore,
  type WorkerGitHubImageHostConfig,
} from "./worker-github-image-store";
import { createWorkerS3BlobStore, type WorkerS3Config } from "./worker-s3-blob-store";

export const BUILTIN_STORAGE_CONFIG_ID = "builtin";
export const S3_STORAGE_CONFIG_ID = "instance-s3";

const resolveCredentialEncryptionKey = (value: string | undefined) => {
  const key = value?.trim();
  return key || undefined;
};

const deriveObjectStorageCredentialKey = (value: string | undefined) => value
  ? `edgeever:object-storage:v1:${value}`
  : undefined;

export type ObjectStorageCredentialEnvironment = {
  EDGE_EVER_AUTH_PASSWORD?: string;
  EDGE_EVER_AUTH_PASSWORD_HASH?: string;
  EDGE_EVER_AUTH_PASSWORD_FALLBACK?: string;
  /** Legacy decryption fallback for credentials saved before auth-derived keys. */
  EDGE_EVER_STORAGE_ENCRYPTION_KEY?: string;
};

const resolveAuthDerivedObjectStorageEncryptionKeys = (
  environment: ObjectStorageCredentialEnvironment,
) => [
  deriveObjectStorageCredentialKey(resolveCredentialEncryptionKey(environment.EDGE_EVER_AUTH_PASSWORD)),
  deriveObjectStorageCredentialKey(resolveCredentialEncryptionKey(environment.EDGE_EVER_AUTH_PASSWORD_HASH)),
].filter(Boolean) as string[];

export const resolveObjectStorageEncryptionKeys = (
  environment: ObjectStorageCredentialEnvironment,
) => [
  ...resolveAuthDerivedObjectStorageEncryptionKeys(environment),
  deriveObjectStorageCredentialKey(resolveCredentialEncryptionKey(environment.EDGE_EVER_AUTH_PASSWORD_FALLBACK)),
  resolveCredentialEncryptionKey(environment.EDGE_EVER_STORAGE_ENCRYPTION_KEY),
].filter(Boolean) as string[];

export const resolvePrimaryObjectStorageEncryptionKey = (
  environment: ObjectStorageCredentialEnvironment,
) => resolveAuthDerivedObjectStorageEncryptionKeys(environment)[0];

export type ObjectStorageConfigRow = {
  id: string;
  provider: "builtin" | "s3";
  display_name: string;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  access_key_id: string | null;
  secret_access_key_encrypted: string | null;
  force_path_style: number;
  object_prefix: string;
  is_active: number;
};

export type GitHubImageHostConfigRow = {
  id: string;
  repository: string;
  branch: string;
  object_prefix: string;
  token_encrypted: string;
  is_enabled: number;
  is_current: number;
};

type ObjectStorageEnvironment = {
  storage: { db: DatabaseAdapter; resources: BlobStoreAdapter };
  EDGE_EVER_AUTH_PASSWORD?: string;
  EDGE_EVER_AUTH_PASSWORD_HASH?: string;
  EDGE_EVER_AUTH_PASSWORD_FALLBACK?: string;
  EDGE_EVER_STORAGE_ENCRYPTION_KEY?: string;
  EDGE_EVER_R2_BUCKET_NAME?: string;
};

const selectConfigSql = `SELECT id, provider, display_name, endpoint, region, bucket, access_key_id,
  secret_access_key_encrypted, force_path_style, object_prefix, is_active FROM object_storage_configs`;

const selectGitHubImageHostSql = `SELECT id, repository, branch, object_prefix, token_encrypted, is_enabled, is_current
  FROM github_image_host_configs`;

export const getActiveObjectStorageConfig = (db: DatabaseAdapter) =>
  db.prepare(`${selectConfigSql} WHERE is_active = 1 LIMIT 1`).first<ObjectStorageConfigRow>();

export const getObjectStorageConfig = (db: DatabaseAdapter, id: string) =>
  db.prepare(`${selectConfigSql} WHERE id = ?`).bind(id).first<ObjectStorageConfigRow>();

export const getGitHubImageHostConfig = (db: DatabaseAdapter, id: string) =>
  db.prepare(`${selectGitHubImageHostSql} WHERE id = ?`).bind(id).first<GitHubImageHostConfigRow>();

export const getCurrentGitHubImageHostConfig = (db: DatabaseAdapter) =>
  db.prepare(`${selectGitHubImageHostSql} WHERE is_current = 1 LIMIT 1`).first<GitHubImageHostConfigRow>();

export const mapObjectStorageSettings = (
  row: ObjectStorageConfigRow,
  encryptionConfigured: boolean,
): ObjectStorageSettings => ({
  provider: row.provider,
  displayName: row.display_name,
  endpoint: row.endpoint,
  region: row.region,
  bucket: row.bucket,
  accessKeyId: row.access_key_id,
  hasSecretAccessKey: Boolean(row.secret_access_key_encrypted),
  forcePathStyle: Boolean(row.force_path_style),
  objectPrefix: row.object_prefix,
  encryptionConfigured,
});

export const mapGitHubImageHostSettings = (
  row: GitHubImageHostConfigRow | null,
  encryptionConfigured: boolean,
): GitHubImageHostSettings | null => row ? {
  enabled: Boolean(row.is_enabled),
  repository: row.repository,
  branch: row.branch,
  objectPrefix: row.object_prefix,
  hasToken: Boolean(row.token_encrypted),
  encryptionConfigured,
} : null;

const decryptObjectStorageCredential = async (
  encryptedValue: string,
  environment: ObjectStorageCredentialEnvironment,
) => {
  const keys = resolveObjectStorageEncryptionKeys(environment);
  for (const [index, key] of keys.entries()) {
    try {
      return { value: await decryptSecret(encryptedValue, key), needsMigration: index > 0 };
    } catch {
      // Try the next key so credentials encrypted by the legacy OSS key remain usable.
    }
  }
  throw new AppError(
    "object_storage_unavailable",
    "The external object storage credential cannot be decrypted. Restore the instance authentication secret.",
    503,
  );
};

export const resolveStoredObjectStorageSecret = async (
  db: DatabaseAdapter,
  row: ObjectStorageConfigRow,
  environment: ObjectStorageCredentialEnvironment,
) => {
  if (!row.secret_access_key_encrypted) {
    throw new AppError("object_storage_unavailable", "The external object storage credential is missing.", 503);
  }

  const resolved = await decryptObjectStorageCredential(row.secret_access_key_encrypted, environment);
  const primaryKey = resolvePrimaryObjectStorageEncryptionKey(environment);
  if (resolved.needsMigration && primaryKey) {
    const migratedSecret = await encryptSecret(resolved.value, primaryKey);
    await db.prepare(
      `UPDATE object_storage_configs SET secret_access_key_encrypted = ? WHERE id = ?`,
    ).bind(migratedSecret, row.id).run();
    row.secret_access_key_encrypted = migratedSecret;
  }
  return resolved.value;
};

export const resolveStoredGitHubImageHostToken = async (
  db: DatabaseAdapter,
  row: GitHubImageHostConfigRow,
  environment: ObjectStorageCredentialEnvironment,
) => {
  if (!row.token_encrypted) {
    throw new AppError("github_image_host_unavailable", "The GitHub image host token is missing.", 503);
  }
  const resolved = await decryptObjectStorageCredential(row.token_encrypted, environment);
  const primaryKey = resolvePrimaryObjectStorageEncryptionKey(environment);
  if (resolved.needsMigration && primaryKey) {
    const migratedToken = await encryptSecret(resolved.value, primaryKey);
    await db.prepare(
      `UPDATE github_image_host_configs SET token_encrypted = ? WHERE id = ?`,
    ).bind(migratedToken, row.id).run();
    row.token_encrypted = migratedToken;
  }
  return resolved.value;
};

const toWorkerS3Config = async (
  db: DatabaseAdapter,
  row: ObjectStorageConfigRow,
  environment: ObjectStorageCredentialEnvironment,
): Promise<WorkerS3Config> => {
  if (!row.endpoint || !row.region || !row.bucket || !row.access_key_id) {
    throw new AppError("object_storage_unavailable", "The external object storage configuration is incomplete.", 503);
  }

  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.access_key_id,
    secretAccessKey: await resolveStoredObjectStorageSecret(db, row, environment),
    forcePathStyle: Boolean(row.force_path_style),
    objectPrefix: row.object_prefix,
  };
};

const toWorkerGitHubImageHostConfig = async (
  db: DatabaseAdapter,
  row: GitHubImageHostConfigRow,
  environment: ObjectStorageCredentialEnvironment,
): Promise<WorkerGitHubImageHostConfig> => ({
  repository: row.repository,
  branch: row.branch,
  objectPrefix: row.object_prefix,
  token: await resolveStoredGitHubImageHostToken(db, row, environment),
});

export const resolveImageObjectStorage = async (env: ObjectStorageEnvironment) => {
  const github = await getCurrentGitHubImageHostConfig(env.storage.db);
  if (!github?.is_enabled) return resolveObjectStorage(env);
  return {
    configId: github.id,
    bucketName: `github:${github.repository}`,
    store: createWorkerGitHubImageStore(await toWorkerGitHubImageHostConfig(env.storage.db, github, env)),
  };
};

export const resolveObjectStorage = async (env: ObjectStorageEnvironment, configId?: string | null) => {
  if (isGitHubImageHostConfigId(configId)) {
    const github = await getGitHubImageHostConfig(env.storage.db, configId!);
    if (!github) {
      throw new AppError("object_storage_unavailable", "The resource's GitHub image host configuration no longer exists.", 503);
    }
    return {
      configId: github.id,
      bucketName: `github:${github.repository}`,
      store: createWorkerGitHubImageStore(await toWorkerGitHubImageHostConfig(env.storage.db, github, env)),
    };
  }
  const row = configId
    ? await getObjectStorageConfig(env.storage.db, configId)
    : await getActiveObjectStorageConfig(env.storage.db);

  if (!row && configId) {
    throw new AppError("object_storage_unavailable", "The resource's object storage configuration no longer exists.", 503);
  }

  if (!row || row.provider === "builtin") {
    return {
      configId: BUILTIN_STORAGE_CONFIG_ID,
      bucketName: env.EDGE_EVER_R2_BUCKET_NAME?.trim() || "edgeever-resources",
      store: env.storage.resources,
    };
  }

  return {
    configId: row.id,
    bucketName: row.bucket ?? "external-object-storage",
    store: createWorkerS3BlobStore(await toWorkerS3Config(env.storage.db, row, env)),
  };
};

export const deleteStoredObjects = async (
  env: ObjectStorageEnvironment,
  resources: Array<{ storage_config_id?: string | null; object_key: string }>,
) => {
  const groups = new Map<string, string[]>();
  for (const resource of resources) {
    const id = resource.storage_config_id || BUILTIN_STORAGE_CONFIG_ID;
    groups.set(id, [...(groups.get(id) ?? []), resource.object_key]);
  }

  for (const [configId, objectKeys] of groups) {
    const { store } = await resolveObjectStorage(env, configId);
    await store.delete(objectKeys);
  }
};
