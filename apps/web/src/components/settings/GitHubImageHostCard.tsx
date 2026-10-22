import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Image as ImageIcon, Loader2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiRequestError, api } from "@/lib/api";
import {
  SETTINGS_CARD_DESCRIPTION_CLASSNAME,
  SETTINGS_CARD_HEADER_CLASSNAME,
  SETTINGS_CARD_ICON_CLASSNAME,
  SETTINGS_CARD_TITLE_CLASSNAME,
} from "./settings-ui";

type Draft = {
  enabled: boolean;
  repository: string;
  branch: string;
  objectPrefix: string;
  token: string;
};

const emptyDraft = (): Draft => ({
  enabled: false,
  repository: "",
  branch: "main",
  objectPrefix: "edgeever",
  token: "",
});

export const GitHubImageHostCard = ({ demoMode }: { demoMode: boolean }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["instance-github-image-host"],
    queryFn: api.getGitHubImageHostSettings,
  });
  const [saved, setSaved] = useState<Draft>(emptyDraft);
  const [draft, setDraft] = useState<Draft>(saved);

  useEffect(() => {
    const settings = settingsQuery.data?.settings;
    if (!settings) return;
    const next = {
      enabled: settings.enabled,
      repository: settings.repository,
      branch: settings.branch,
      objectPrefix: settings.objectPrefix,
      token: "",
    };
    setSaved(next);
    setDraft(next);
  }, [settingsQuery.data]);

  const hasSavedToken = settingsQuery.data?.settings?.hasToken ?? false;
  const encryptionConfigured = settingsQuery.data?.encryptionConfigured
    ?? settingsQuery.data?.settings?.encryptionConfigured
    ?? false;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const canSubmit = dirty && Boolean(draft.repository.trim() && draft.branch.trim())
    && Boolean(draft.token.trim() || hasSavedToken);

  const testMutation = useMutation({
    mutationFn: () => api.testGitHubImageHostConnection({
      repository: draft.repository,
      branch: draft.branch,
      objectPrefix: draft.objectPrefix,
      ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
    }),
  });
  const saveMutation = useMutation({
    mutationFn: () => api.updateGitHubImageHostSettings({
      enabled: draft.enabled,
      repository: draft.repository,
      branch: draft.branch,
      objectPrefix: draft.objectPrefix,
      ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
    }),
    onSuccess: async (data) => {
      const settings = data.settings;
      const next = settings ? {
        enabled: settings.enabled,
        repository: settings.repository,
        branch: settings.branch,
        objectPrefix: settings.objectPrefix,
        token: "",
      } : emptyDraft();
      setSaved(next);
      setDraft(next);
      testMutation.reset();
      await queryClient.invalidateQueries({ queryKey: ["instance-github-image-host"] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    saveMutation.mutate();
  };

  const errorMessage = (error: unknown) => {
    if (error instanceof ApiRequestError && error.code === "github_image_host_authentication_required") {
      return t("githubImageHost.authenticationRequired");
    }
    return error instanceof Error ? error.message : t("githubImageHost.failed");
  };
  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    testMutation.reset();
    saveMutation.reset();
  };

  return (
    <Card className="w-full min-w-0 overflow-hidden shadow-none">
      <CardHeader className={SETTINGS_CARD_HEADER_CLASSNAME}>
        <CardTitle className={SETTINGS_CARD_TITLE_CLASSNAME}>
          <ImageIcon className={SETTINGS_CARD_ICON_CLASSNAME} />
          {t("githubImageHost.title")}
        </CardTitle>
        <CardDescription className={SETTINGS_CARD_DESCRIPTION_CLASSNAME}>
          {t("githubImageHost.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:px-5 sm:pb-5">
        {settingsQuery.isLoading ? (
          <p className="flex items-center gap-2 text-xs leading-5 text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}
          </p>
        ) : (
          <form className="grid gap-4" onSubmit={submit}>
            <label className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-card p-3.5 text-xs leading-5 text-slate-700">
              <span>
                <span className="block font-medium">{t("githubImageHost.enable")}</span>
                <span className="mt-0.5 block text-slate-500">{t("githubImageHost.enableHint")}</span>
              </span>
              <Switch disabled={demoMode} checked={draft.enabled} onCheckedChange={(enabled) => update({ enabled })} />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("githubImageHost.repository")}>
                <Input
                  value={draft.repository}
                  onChange={(event) => update({ repository: event.target.value })}
                  placeholder="owner/repository"
                  spellCheck={false}
                  required
                  maxLength={201}
                />
              </Field>
              <Field label={t("githubImageHost.branch")}>
                <Input
                  value={draft.branch}
                  onChange={(event) => update({ branch: event.target.value })}
                  placeholder="main"
                  spellCheck={false}
                  required
                  maxLength={255}
                />
              </Field>
              <Field label={t("githubImageHost.objectPrefix")} hint={t("githubImageHost.objectPrefixHint")}>
                <Input
                  value={draft.objectPrefix}
                  onChange={(event) => update({ objectPrefix: event.target.value })}
                  placeholder="edgeever/images"
                  spellCheck={false}
                  maxLength={500}
                />
              </Field>
              <Field
                label={t("githubImageHost.token")}
                hint={hasSavedToken ? t("githubImageHost.tokenSavedHint") : t("githubImageHost.tokenHint")}
              >
                <Input
                  type="password"
                  value={draft.token}
                  onChange={(event) => update({ token: event.target.value })}
                  placeholder={hasSavedToken ? "••••••••••••" : ""}
                  autoComplete="new-password"
                  spellCheck={false}
                  required={!hasSavedToken}
                />
              </Field>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("githubImageHost.warning")}</span>
            </div>

            {(testMutation.isSuccess || saveMutation.isSuccess) ? (
              <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                {saveMutation.isSuccess ? t("githubImageHost.saved") : t("githubImageHost.testSucceeded")}
              </p>
            ) : null}
            {testMutation.isError ? <p className="text-xs font-medium text-rose-600" role="alert">{errorMessage(testMutation.error)}</p> : null}
            {saveMutation.isError ? <p className="text-xs font-medium text-rose-600" role="alert">{errorMessage(saveMutation.error)}</p> : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={demoMode || !encryptionConfigured || testMutation.isPending || saveMutation.isPending || !draft.repository.trim() || !draft.branch.trim() || (!draft.token.trim() && !hasSavedToken)}
                onClick={() => testMutation.mutate()}
              >
                {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("githubImageHost.test")}
              </Button>
              {!encryptionConfigured ? (
                <TooltipProvider delayDuration={0} skipDelayDuration={0}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex" tabIndex={0}>
                        <Button type="submit" disabled>{t("common.save")}</Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("githubImageHost.authenticationRequired")}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <Button type="submit" disabled={demoMode || !canSubmit || saveMutation.isPending}>
                  {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("common.save")}
                </Button>
              )}
            </div>
            <p className="text-xs leading-5 text-slate-500">
              {demoMode ? t("githubImageHost.demoDisabled") : t("githubImageHost.footerHint")}
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  );
};

const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="grid gap-1.5 text-xs font-normal leading-5 text-slate-700">
    {label}
    {children}
    {hint ? <span className="text-xs font-normal leading-4 text-slate-500">{hint}</span> : null}
  </label>
);
