/**
 * Installing a workspace blueprint: what the new workspace is called, what it reaches of yours (each connection
 * already yours, or one to connect in Plugins first), and for the personal assistant its brief and whether it becomes
 * Home. Install makes the workspace and opens it.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Effect } from "effect";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { DownloadSimpleIcon, KeyIcon } from "@phosphor-icons/react";
import { APP_ROUTES, PERSONAL_ASSISTANT_ID } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { Modal } from "@/components/ui/Modal";
import { Choice, Field } from "@/components/ui/form";
import { Switch } from "@/components/ui/Switch";
import { Status } from "@/components/ui/Status";
import { BrandMark } from "@/components/ui/BrandMark";
import { connectionTitle, presetBrand } from "@/components/plugins/McpPresetCards";
import { installBlueprint, type BlueprintPage } from "@/lib/explore-api";
import { DEFAULT_ASSISTANT } from "@/components/assistant/AssistantStep";
import { TextInput } from "@/components/ui/Field";
import { Surface } from "@/components/ui/Surface";

/** The brief times Install offers; the blueprint's own is 08:00. */
const BRIEF_TIMES = ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30"] as const;

export function InstallDialog({ page, connected, onClose }: { page: BlueprintPage; connected: (preset: string | null) => boolean | null; onClose: () => void }) {
  const navigate = useNavigate();
  const assistant = page.workspace.id === PERSONAL_ASSISTANT_ID;
  const [name, setName] = useState(assistant ? DEFAULT_ASSISTANT.name : page.workspace.title);
  const [brief, setBrief] = useState<string>("08:00");
  const [home, setHome] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const install = () => Effect.catchCause(Effect.gen(function* () {
    setBusy(true);
    setFailure(null);
    const workspace = yield* Effect.promise(() => installBlueprint(page.workspace.id, assistant ? { displayName: name, agent: name, brief, home } : { displayName: name }));

    yield* Effect.promise(async () => navigate(assistant && home ? APP_ROUTES.home : `/workspace/${encodeURIComponent(workspace)}`));
  }), showing((chain) => { setFailure(chain); setBusy(false); }));

  return (
    <Modal title={`Install ${page.workspace.title}`} icon={<DownloadSimpleIcon size={16} className="p-accent-fg" />} onClose={onClose} busy={busy} maxWidthClass="max-w-lg"
      footer={(
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="md" onClick={() => detach(install())} disabled={busy || name.trim() === ""} data-install-confirm>{busy && <Loader size="sm" />}Install</Button>
        </>
      )}>
      <div className="space-y-4" data-install-dialog={page.workspace.id}>
        <Field label={assistant ? "Its name" : "Workspace name"} hint={assistant ? "What you call it; its workspace is “Personal assistant”." : undefined}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} maxLength={60} aria-label={assistant ? "Its name" : "Workspace name"} />
        </Field>
        {assistant && (
          <>
            <Field label="Its brief" hint="Each day, in its chat." inline>
              <Choice label="Brief time" size="sm" className="w-28" value={brief} options={BRIEF_TIMES.map((time) => ({ value: time, label: time }))} onChange={setBrief} />
            </Field>
            <Field label="Make it your Home" hint="Home opens on its chat." inline>
              <Switch on={home} onChange={setHome} label="Make it your Home" />
            </Field>
          </>
        )}
        <div>
          <div className="t-item mb-2 p-text">What it reaches</div>
          <Surface look="outlined" as="ul" className="p-rows-ruled overflow-hidden">
            {page.workspace.needs.map((need) => {
              const brand = presetBrand(need.connection);
              const title = need.connection === null ? (need.secret ?? "A secret") : connectionTitle(need.connection);
              const has = connected(need.connection);

              return (
                <li key={`${need.connection ?? ""}${need.secret ?? ""}`} className="flex items-center gap-3 px-3 py-2">
                  <Surface look="wash" as="span" className="flex size-6 shrink-0 items-center justify-center">
                    {brand !== undefined ? <BrandMark brand={brand} size={12} bare /> : <KeyIcon size={12} className="p-text-2" />}
                  </Surface>
                  <span className="min-w-0 flex-1">
                    <span className="t-body block p-text">{title} <span className="t-meta p-text-3">{need.access === "read" ? "to read" : "to read and write"}</span></span>
                  </span>
                  {has === true && <Status tone="success">Connected</Status>}
                  {has === false && <a href={`${APP_ROUTES.plugins}?add=${need.connection ?? ""}`} className="t-meta shrink-0 p-accent-fg hover:underline">Connect</a>}
                  {has === null && <span className="t-meta shrink-0 p-text-3" data-need-unread>Not checked yet</span>}
                </li>
              );
            })}
          </Surface>
          <p className="t-meta mt-2 p-text-3">Install now and connect the rest later: it asks for what it can't reach yet.</p>
        </div>
        {failure !== null && <p className="t-meta p-danger">{failure}</p>}
      </div>
    </Modal>
  );
}
