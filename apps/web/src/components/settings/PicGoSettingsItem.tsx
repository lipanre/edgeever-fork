import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Image } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  hasPicGoBridge,
  readPicGoPreference,
  testGitHubImageHost,
  writePicGoPreference,
  type PicGoPreference,
} from "@/lib/picgo";
import { SETTINGS_ITEM_DESCRIPTION_CLASSNAME, SETTINGS_ITEM_TITLE_CLASSNAME } from "./settings-ui";

export const PicGoSettingsItem = () => {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(readPicGoPreference);
  const [draft, setDraft] = useState(saved);
  const [testedTarget, setTestedTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const desktopAvailable = hasPicGoBridge();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const githubTarget = `github:${JSON.stringify(draft.github)}`;
  const picgoTarget = `picgo:${draft.endpoint}`;
  const canSave = dirty && (
    draft.provider === "edgeever"
    || (draft.provider === "github" && testedTarget === githubTarget)
    || (draft.provider === "picgo" && desktopAvailable && testedTarget === picgoTarget)
  );

  const testConnection = async () => {
    setBusy(true);
    setTestedTarget(null);
    setStatus("");
    try {
      if (draft.provider === "github") {
        await testGitHubImageHost(draft.github);
        setTestedTarget(githubTarget);
        setStatus(t("settings.picgo.githubConnected"));
      } else {
        await window.edgeeverDesktop!.testPicGoConnection(draft.endpoint);
        setTestedTarget(picgoTarget);
        setStatus(t("settings.picgo.connected"));
      }
    } catch {
      setStatus(t(draft.provider === "github" ? "settings.picgo.githubConnectionFailed" : "settings.picgo.connectionFailed"));
    } finally { setBusy(false); }
  };
  const save = () => {
    try {
      writePicGoPreference(draft);
      setSaved(draft);
      setStatus(t("settings.picgo.saved"));
    } catch { setStatus(t("settings.picgo.saveFailed")); }
  };

  return (
    <div className="grid gap-3 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Image className="h-4 w-4 shrink-0 text-slate-500" />
          <div className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("settings.picgo.title")}</div>
        </div>
        <Select value={draft.provider} disabled={busy} onValueChange={(provider) => {
          setDraft({ ...draft, provider: provider as PicGoPreference["provider"] });
          setTestedTarget(null);
          setStatus("");
        }}>
          <SelectTrigger className="h-9 w-full sm:w-80" aria-label={t("settings.picgo.title")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="edgeever">{t("settings.picgo.builtin")}</SelectItem>
            <SelectItem value="github">{t("settings.picgo.github")}</SelectItem>
            <SelectItem value="picgo">{t("settings.picgo.external")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {draft.provider === "github" ? (
        <div className="grid gap-3 sm:ml-7">
          <p className={SETTINGS_ITEM_DESCRIPTION_CLASSNAME}>{t("settings.picgo.githubDescription")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("settings.picgo.githubRepository")}</span>
              <Input value={draft.github.repository} disabled={busy} placeholder="owner/repository" spellCheck={false} onChange={(event) => {
                setDraft({ ...draft, github: { ...draft.github, repository: event.target.value } });
                setTestedTarget(null);
                setStatus("");
              }} />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("settings.picgo.githubBranch")}</span>
              <Input value={draft.github.branch} disabled={busy} placeholder="main" spellCheck={false} onChange={(event) => {
                setDraft({ ...draft, github: { ...draft.github, branch: event.target.value } });
                setTestedTarget(null);
                setStatus("");
              }} />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm">
            <span className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("settings.picgo.githubDirectory")}</span>
            <Input value={draft.github.directory} disabled={busy} placeholder="edgeever" spellCheck={false} onChange={(event) => {
              setDraft({ ...draft, github: { ...draft.github, directory: event.target.value } });
              setTestedTarget(null);
              setStatus("");
            }} />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("settings.picgo.githubToken")}</span>
            <Input type="password" value={draft.github.token} disabled={busy} autoComplete="new-password" spellCheck={false} onChange={(event) => {
              setDraft({ ...draft, github: { ...draft.github, token: event.target.value } });
              setTestedTarget(null);
              setStatus("");
            }} />
          </label>
          <p className={SETTINGS_ITEM_DESCRIPTION_CLASSNAME}>{t("settings.picgo.githubTokenHint")}</p>
          <p className={SETTINGS_ITEM_DESCRIPTION_CLASSNAME}>{t("settings.picgo.githubExternalImages")}</p>
        </div>
      ) : null}
      {draft.provider === "picgo" ? (
        <div className="grid gap-2 sm:ml-7">
          {!desktopAvailable ? <p className={SETTINGS_ITEM_DESCRIPTION_CLASSNAME}>{t("settings.picgo.webPreview")}</p> : null}
          <p className={SETTINGS_ITEM_DESCRIPTION_CLASSNAME}>{t("settings.picgo.description")}</p>
          <label htmlFor="picgo-endpoint" className={SETTINGS_ITEM_TITLE_CLASSNAME}>{t("settings.picgo.endpoint")}</label>
          <Input id="picgo-endpoint" value={draft.endpoint} disabled={busy} onChange={(event) => {
            setDraft({ ...draft, endpoint: event.target.value.trim() });
            setTestedTarget(null);
            setStatus("");
          }} spellCheck={false} />
          <p className={SETTINGS_ITEM_DESCRIPTION_CLASSNAME}>{t("settings.picgo.externalImages")}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 sm:ml-7">
        {draft.provider !== "edgeever" ? <Button variant="outline" size="sm" disabled={busy || (draft.provider === "picgo" && !desktopAvailable)} onClick={() => void testConnection()}>
          {t(busy ? "settings.picgo.testing" : "settings.picgo.test")}
        </Button> : null}
        {dirty ? <Button size="sm" disabled={busy || !canSave} onClick={save}>{t("settings.picgo.save")}</Button> : null}
        <span role="status" className="text-xs text-slate-500">{status}</span>
      </div>
    </div>
  );
};
