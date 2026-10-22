export const GITHUB_IMAGE_HOST_CONFIG_ID_PREFIX = "github-image-host_";
export const MAX_GITHUB_IMAGE_HOST_BYTES = 20 * 1024 * 1024;

export const isGitHubImageHostConfigId = (value: string | null | undefined) =>
  Boolean(value?.startsWith(GITHUB_IMAGE_HOST_CONFIG_ID_PREFIX));

export type GitHubImageHostSettings = {
  enabled: boolean;
  repository: string;
  branch: string;
  objectPrefix: string;
  hasToken: boolean;
  encryptionConfigured: boolean;
};

export type GitHubImageHostSettingsResponse = {
  settings: GitHubImageHostSettings | null;
  encryptionConfigured: boolean;
};
