import {
  GitHubImageHostConnectionTestSchema,
  GitHubImageHostSettingsUpdateSchema,
} from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { auditStatement } from "./audit";
import type { AppContext, AppEnv, Bindings } from "./api-context";
import { AppError } from "./app-error";
import { createId, isoNow } from "./entity-utils";
import { apiError, forbidden } from "./http-errors";
import {
  getCurrentGitHubImageHostConfig,
  mapGitHubImageHostSettings,
  resolvePrimaryObjectStorageEncryptionKey,
  resolveStoredGitHubImageHostToken,
} from "./object-storage";
import { requireOwner } from "./request-auth";
import { encryptSecret } from "./secret-encryption";
import { testWorkerGitHubImageHostConnection } from "./worker-github-image-store";

type GitHubImageHostRouteDependencies = {
  isDemoMode: (environment: Bindings) => boolean;
};

const hasEncryptionKey = (context: AppContext) => Boolean(
  resolvePrimaryObjectStorageEncryptionKey(context.env),
);

const requireEncryptionKey = (context: AppContext) => {
  const key = resolvePrimaryObjectStorageEncryptionKey(context.env);
  if (!key) {
    throw new AppError(
      "github_image_host_authentication_required",
      "Instance authentication is required before saving GitHub credentials.",
      400,
    );
  }
  return key;
};

const resolveStoredToken = async (context: AppContext) => {
  const existing = await getCurrentGitHubImageHostConfig(context.env.storage.db);
  if (!existing?.token_encrypted) {
    throw new AppError("github_image_host_token_required", "GitHub access token is required.", 400);
  }
  return resolveStoredGitHubImageHostToken(context.env.storage.db, existing, context.env);
};

const connectionErrorResponse = (context: AppContext, error: unknown) => {
  if (error instanceof AppError) return apiError(context, error.code, error.message, error.status);
  return apiError(
    context,
    "github_image_host_connection_failed",
    error instanceof Error ? error.message : "GitHub image host connection failed.",
    400,
  );
};

export const registerGitHubImageHostRoutes = (
  app: Hono<AppEnv>,
  dependencies: GitHubImageHostRouteDependencies,
) => {
  app.get("/api/v1/instance/github-image-host", async (context) => {
    const denied = requireOwner(context);
    if (denied) return denied;
    const existing = await getCurrentGitHubImageHostConfig(context.env.storage.db);
    const encryptionConfigured = hasEncryptionKey(context);
    return context.json({
      settings: mapGitHubImageHostSettings(existing, encryptionConfigured),
      encryptionConfigured,
    });
  });

  app.post(
    "/api/v1/instance/github-image-host/test",
    zValidator("json", GitHubImageHostConnectionTestSchema),
    async (context) => {
      const denied = requireOwner(context);
      if (denied) return denied;
      try {
        const input = context.req.valid("json");
        await testWorkerGitHubImageHostConnection({
          repository: input.repository,
          branch: input.branch,
          objectPrefix: input.objectPrefix,
          token: input.token ?? await resolveStoredToken(context),
        });
        return context.json({ ok: true });
      } catch (error) {
        return connectionErrorResponse(context, error);
      }
    },
  );

  app.put(
    "/api/v1/instance/github-image-host",
    zValidator("json", GitHubImageHostSettingsUpdateSchema),
    async (context) => {
      const denied = requireOwner(context);
      if (denied) return denied;
      if (dependencies.isDemoMode(context.env)) {
        return forbidden(context, "GitHub image hosting cannot be changed in demo mode.");
      }

      const input = context.req.valid("json");
      try {
        const encryptionKey = requireEncryptionKey(context);
        const existing = await getCurrentGitHubImageHostConfig(context.env.storage.db);
        if (!existing && !input.token) {
          throw new AppError("github_image_host_token_required", "GitHub access token is required.", 400);
        }
        if (input.enabled) {
          await testWorkerGitHubImageHostConnection({
            repository: input.repository,
            branch: input.branch,
            objectPrefix: input.objectPrefix,
            token: input.token ?? await resolveStoredToken(context),
          });
        }

        const encryptedToken = input.token
          ? await encryptSecret(input.token, encryptionKey)
          : existing!.token_encrypted;
        const normalizedPrefix = input.objectPrefix.replace(/^\/+|\/+$/g, "");
        const locationChanged = Boolean(existing) && (
          existing!.repository !== input.repository
          || existing!.branch !== input.branch
          || existing!.object_prefix !== normalizedPrefix
        );
        const configId = existing && !locationChanged
          ? existing.id
          : createId("github-image-host");
        const now = isoNow();
        await context.env.storage.db.batch([
          context.env.storage.db.prepare(
            "UPDATE github_image_host_configs SET is_current = 0 WHERE is_current = 1",
          ),
          context.env.storage.db.prepare(
            `INSERT INTO github_image_host_configs (
               id, repository, branch, object_prefix, token_encrypted, is_enabled, is_current, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               repository = excluded.repository,
               branch = excluded.branch,
               object_prefix = excluded.object_prefix,
               token_encrypted = excluded.token_encrypted,
               is_enabled = excluded.is_enabled,
               is_current = 1,
               updated_at = excluded.updated_at`,
          ).bind(
            configId,
            input.repository,
            input.branch,
            normalizedPrefix,
            encryptedToken,
            input.enabled ? 1 : 0,
            now,
            now,
          ),
          auditStatement(
            context.env.storage.db,
            "user",
            context.get("auth").actorId,
            "instance.github_image_host.update",
            "github_image_host",
            configId,
            { enabled: input.enabled, repository: input.repository, branch: input.branch },
          ),
        ]);
        const saved = await getCurrentGitHubImageHostConfig(context.env.storage.db);
        return context.json({
          settings: mapGitHubImageHostSettings(saved, hasEncryptionKey(context)),
          encryptionConfigured: hasEncryptionKey(context),
        });
      } catch (error) {
        return connectionErrorResponse(context, error);
      }
    },
  );
};
