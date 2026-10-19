/**
 * Settings › Secrets: the account's keys and tokens, each allowed in the workspaces the owner chooses. A value is written
 * once and never shown again; in a workspace it is allowed in, an agent holds a stand-in the egress turns into the value
 * only when it is sent over https to the hosts listed.
 */
import { useCallback, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { CaretDownIcon, CaretRightIcon, KeyIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { parseDotenv, positionWords } from "@kinu.run/core";
import { Card, Field, inputCls } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { FilledButton } from "@/components/ui/FilledButton";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useConfirmation, useLabelledStep } from "@/components/ui/ConfirmDialog";
import { SECRET_REGION } from "@/components/ui/SecretValue";
import { useAsyncResource } from "@/hooks/use-async-resource";
import {
  deleteSecret, grantSecret, listSecrets, putSecrets, revokeSecretGrant, setSecretDestination, type SecretSummary,
} from "@/lib/user-api";
import {
  AUTHORIZATION, BLANK, hostList, PositionField, rowsReady, secretEntries, SecretRows, withProvider, WorkspaceAdder, WorkspaceChooser,
  type ChosenWorkspace, type SecretDraft,
} from "@/components/secrets/SecretRows";


/** What turning reading on lets an agent do; said where the switch is turned, and again as it is asked. */
const REVEAL_WARNING = "On that workspace's computer and in its eval programs, the value can then enter its agent context, "
  + "files, logs and transcripts, and be sent to any host; its own shell keeps the stand-in. Turn it on only where the "
  + "stand-in cannot work: a request body, a database password, or a request the program signs itself. If it leaks, "
  + "rotate the key.";

export function SecretsPanel() {
  const loadSecrets = useCallback(() => listSecrets(), []);
  const { resource, reload } = useAsyncResource(loadSecrets);

  return (
    <>
      <Card title="Your secrets" icon={KeyIcon}
        description={<>In a workspace you allow, each is <code>$NAME</code> in commands and <code>env.NAME</code> in programs. It holds a stand-in that becomes the value only when sent over https to its hosts.</>}>
        <CardSlot resource={resource} what="your secrets" onRetry={reload}>
          {(secrets) => (secrets.length === 0
            ? <p className="p-row-text p-text-3" data-secrets-empty>No secrets yet. Add one below, or paste a .env file.</p>
            : (
              <ul className="-mx-5 -my-5 divide-y divide-[var(--c-border)]" data-secrets-list>
                {secrets.map((secret) => <SecretItem key={secret.name} secret={secret} onChanged={reload} />)}
              </ul>
            ))}
        </CardSlot>
      </Card>
      <Card title="Add secrets" icon={PlusIcon}>
        <AddSecrets onSaved={reload} />
      </Card>
    </>
  );
}

function grantedWhere(secret: SecretSummary): string {
  if (secret.grants.length === 0) return "In no workspace";

  return secret.grants.length === 1 ? `In ${secret.grants[0]?.title ?? ""}` : `In ${String(secret.grants.length)} workspaces`;
}

/** One secret: a line, and opened, its hosts, a new value, its workspaces and its removal. */
function SecretItem({ secret, onChanged }: { secret: SecretSummary; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const Caret = open ? CaretDownIcon : CaretRightIcon;

  return (
    <li data-secret={secret.name}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-left hover:bg-[var(--c-neutral-tint)]">
        <Caret size={12} className="shrink-0 p-text-3" />
        <span className="font-mono p-row-text font-medium p-text">{secret.name}</span>
        <span className="flex min-w-0 flex-wrap gap-1">
          {secret.hosts.map((host) => <span key={host} className="rounded-sm p-recessed px-1.5 py-0.5 font-mono p-meta p-text-2">{host}</span>)}
          {secret.position.kind !== "authorization" && <span className="self-center p-meta p-text-3">in {positionWords(secret.position)}</span>}
        </span>
        <span className="ml-auto p-meta p-text-3">
          {grantedWhere(secret)}
          {secret.grants.some((grant) => grant.reveal) && <span className="p-warning"> · value readable</span>}
        </span>
      </button>
      {open && <SecretDetails secret={secret} onChanged={onChanged} />}
    </li>
  );
}

function SecretDetails({ secret, onChanged }: { secret: SecretSummary; onChanged: () => void }) {
  const [hosts, setHosts] = useState(secret.hosts.join(", "));
  const [position, setPosition] = useState(secret.position);
  const [value, setValue] = useState("");
  const { busy, error, run } = useLabelledStep(onChanged);
  const { ask, dialog } = useConfirmation();

  const destinationMoved = hostList(hosts).join(" ") !== secret.hosts.join(" ") || JSON.stringify(position) !== JSON.stringify(secret.position);

  return (
    <div className="space-y-5 border-t border-[var(--c-border)] px-5 py-4" data-secret-details={secret.name}>
      <Field label="Where it may go" hint="The hosts it may be sent to, over https only (*.example.com covers a domain), and the one place in a request its API reads it from.">
        <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault();
          run("destination", async () => { await setSecretDestination(secret.name, hostList(hosts), position); });
        }}>
          <div className="flex gap-2">
            <input value={hosts} onChange={(e) => setHosts(e.target.value)} spellCheck={false} aria-label={`Hosts ${secret.name} may be sent to`}
              className={`${inputCls} h-9 min-w-0 flex-1 font-mono`} />
            <button type="submit" disabled={!destinationMoved || busy !== null} className="p-btn-quiet inline-flex h-9 shrink-0 items-center px-3 text-xs">
              {busy === "destination" ? "Saving…" : "Save"}
            </button>
          </div>
          <PositionField position={position} onChange={setPosition} label={secret.name} />
        </form>
      </Field>

      <Field label="Value" hint="Stored sealed and never shown again. A new value reaches every workspace at its next request.">
        <form className="flex gap-2" onSubmit={(event) => {
          event.preventDefault();
          run("value", async () => { await putSecrets([{ name: secret.name, hosts: secret.hosts, position: secret.position, value }], []); setValue(""); });
        }}>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" placeholder="Paste a new value"
            aria-label={`New value of ${secret.name}`} className={`${inputCls} h-9 min-w-0 flex-1`} />
          <button type="submit" disabled={value === "" || busy !== null} className="p-btn-quiet inline-flex h-9 shrink-0 items-center px-3 text-xs">
            {busy === "value" ? "Replacing…" : "Replace"}
          </button>
        </form>
      </Field>

      <Field label="Workspaces" hint="Only these workspaces' agents can use it. Reading the value is off unless you turn it on for one, and then only on its computer and in eval.">
        <div className="space-y-2">
          {secret.grants.map((grant) => (
            <div key={grant.workspace} className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-secret-grant={grant.workspace}>
              <span className="min-w-0 truncate p-row-text p-text">{grant.title}</span>
              <span className="font-mono p-meta p-text-3">{grant.workspace}</span>
              <label className="ml-auto flex items-center gap-2 p-meta p-text-2">
                Agents may read the value
                <Switch on={grant.reveal} label={`Agents in ${grant.title} may read ${secret.name}`} disabled={busy !== null} data-secret-reveal={grant.workspace}
                  onChange={(on) => (on
                    ? ask({
                      title: `Let agents in ${grant.title} read ${secret.name}?`, body: REVEAL_WARNING, action: "Let them read it",
                      run: async () => { await grantSecret(secret.name, grant.workspace, true); onChanged(); },
                    })
                    : run(`reveal:${grant.workspace}`, async () => { await grantSecret(secret.name, grant.workspace, false); }))} />
              </label>
              <button type="button" disabled={busy !== null} onClick={() => run(`revoke:${grant.workspace}`, async () => { await revokeSecretGrant(secret.name, grant.workspace); })}
                className="p-meta p-text-3 hover:p-danger">Remove</button>
            </div>
          ))}
          <WorkspaceAdder held={secret.grants.map(({ workspace }) => workspace)} placeholder="Allow in another workspace…"
            onAdd={(added) => run(`grant:${added.workspace}`, async () => { await grantSecret(secret.name, added.workspace, false); })} />
        </div>
      </Field>

      <div className="flex items-center justify-between gap-3">
        {error === null ? <span /> : <p role="alert" className="p-meta p-danger">{error}</p>}
        <Button size="sm" variant="ghost" icon={<TrashIcon size={12} />} disabled={busy !== null}
          onClick={() => ask({
            title: `Delete ${secret.name}?`, action: "Delete",
            body: "Every workspace loses it at once: a request naming it is refused, and its variable is gone from the next command.",
            run: async () => { await deleteSecret(secret.name); onChanged(); },
          })}>Delete secret</Button>
      </div>
      {dialog}
    </div>
  );
}

type AddMode = "one" | "env";

/** One secret, or every line of a pasted .env, each with its hosts, allowed in the workspaces chosen. */
function AddSecrets({ onSaved }: { onSaved: () => void }) {
  const [mode, setMode] = useState<AddMode>("one");
  const [rows, setRows] = useState<SecretDraft[]>([BLANK]);
  const [pasted, setPasted] = useState("");
  const [workspaces, setWorkspaces] = useState<ChosenWorkspace[]>([]);
  const { busy, error, run } = useLabelledStep(onSaved);
  const saving = busy !== null;
  const ready = rowsReady(rows);
  const count = secretEntries(rows).length;
  let action = count > 1 ? `Save ${String(count)} secrets` : "Save secret";

  if (saving) action = "Saving…";

  return (
    <form className="space-y-4" data-add-secrets onSubmit={(event) => {
      event.preventDefault();
      run("save", async () => {
        await putSecrets(secretEntries(rows), workspaces.map(({ workspace }) => workspace));
        setRows([BLANK]);
        setPasted("");
      });
    }}>
      <Segmented<AddMode> label="How to add" value={mode}
        segments={[{ id: "one", label: "One secret" }, { id: "env", label: "Paste .env" }]}
        onChange={(next) => { setMode(next); setRows([BLANK]); setPasted(""); }} />

      {mode === "env" && (
        <textarea {...SECRET_REGION} value={pasted} rows={5} spellCheck={false} aria-label="A .env file"
          placeholder={"OPENAI_API_KEY=sk-…\nDATABASE_PASSWORD=…"}
          onChange={(e) => {
            setPasted(e.target.value);
            setRows(parseDotenv(e.target.value).map((entry) => withProvider({ name: entry.name, value: entry.value, hosts: "", position: AUTHORIZATION })));
          }}
          className={`${inputCls} font-mono`} />
      )}

      {(mode === "one" || rows.length > 0) && <SecretRows rows={rows} onChange={setRows} removable={mode === "env"} />}

      <Field label="Use in" hint="Agents in these workspaces get it. You can allow more workspaces later.">
        <WorkspaceChooser chosen={workspaces} onChange={setWorkspaces} placeholder="Choose workspaces…" />
      </Field>

      <div className="flex items-center justify-between gap-3">
        {error === null ? <span /> : <p role="alert" className="p-meta p-danger">{error}</p>}
        <FilledButton type="submit" disabled={!ready || saving}>
          {action}
        </FilledButton>
      </div>
    </form>
  );
}
