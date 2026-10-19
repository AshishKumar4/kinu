/**
 * A chat draft that holds a secret is not sent as it is. The owner is offered to move it to Secrets, where the
 * workspace's agents get it as `$NAME` without ever seeing it, and the draft keeps `$NAME` in its place; or to send it
 * anyway. Nothing leaves the browser until they choose.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { KeyIcon, ShieldWarningIcon } from "@phosphor-icons/react";
import { pastedSecrets, type PastedSecret } from "@kinu.run/core";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";
import { useLabelledStep } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/Switch";
import { putSecrets } from "@/lib/user-api";
import { rowsReady, secretEntries, SecretRows, type SecretDraft } from "@/components/secrets/SecretRows";

/** What the found secrets look like, in the offer's words. */
function described(found: readonly PastedSecret[]): string {
  const [first] = found;

  if (found.length > 1 || first === undefined) return `${String(found.length)} secrets`;

  return first.provider === null ? "a secret" : `a ${first.provider} credential`;
}

/** The composer's ways to send the draft, each with the check in front of it, and the card to show while one waits. */
export interface PastedSecretGuard {
  /**
   * `act` (a send, a branch, by `key`) runs when the draft holds no secret, or when the owner chose to send this draft as
   * it is; then the `act` of the render they chose in, so what is sent is what they saw.
   */
  readonly guarded: (key: string, act: () => void) => () => void;
  readonly offer: ReactNode;
}

export function usePastedSecretGuard(input: {
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  /** The workspace this chat belongs to: a moved secret is allowed there unless the owner turns that off. */
  readonly workspace: string | undefined;
}): PastedSecretGuard {
  const { draft, setDraft, workspace } = input;
  const [held, setHeld] = useState<{ readonly found: readonly PastedSecret[]; readonly draft: string; readonly key: string } | null>(null);
  const [sendAsIs, setSendAsIs] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const acts = useRef(new Map<string, () => void>());
  // A draft edited since it was held is checked again at its next send: the offer answers only for what it found.
  const waiting = held !== null && held.draft === draft ? held.found : [];

  const guarded = (key: string, act: () => void) => {
    acts.current.set(key, act);

    return () => {
      const found = sendAsIs === draft ? [] : pastedSecrets(draft);

      if (found.length === 0) act();
      else setHeld({ found, draft, key });
    };
  };

  const moved = (names: ReadonlyMap<string, string>) => {
    let next = draft;

    for (const [value, name] of names) next = next.split(value).join(`$${name}`);
    setDraft(next);
    setHeld(null);
    setMoving(false);
  };

  const offer = waiting.length === 0 ? null : (
    <div className="mx-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-border p-overlay px-3 py-2.5" role="status" data-secret-offer>
      <ShieldWarningIcon size={16} className="shrink-0 p-warning" />
      <p className="min-w-[14rem] flex-1 p-row-text p-text">
        This looks like {described(waiting)}. Keep it out of the chat: move it to Secrets and your agents use it without seeing it.
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" data-secret-offer-send onClick={() => {
          setSendAsIs(draft);
          setHeld(null);

          if (held !== null) acts.current.get(held.key)?.();
        }}>Send anyway</Button>
        <FilledButton data-secret-offer-move onClick={() => setMoving(true)}><KeyIcon size={12} /> Move to Secrets</FilledButton>
      </div>
      {moving && <MoveToSecrets found={waiting} workspace={workspace} onClose={() => setMoving(false)} onMoved={moved} />}
    </div>
  );

  return { guarded, offer };
}

/** A move closes its dialog itself, by handing the draft its names. */
const NOTHING_AFTER = (): void => {};

/** The found secrets as rows to name and host, saved together; each value in the draft becomes its `$NAME`. */
function MoveToSecrets({ found, workspace, onClose, onMoved }: {
  found: readonly PastedSecret[];
  workspace: string | undefined;
  onClose: () => void;
  onMoved: (names: ReadonlyMap<string, string>) => void;
}) {
  const [rows, setRows] = useState<SecretDraft[]>(found.map((secret) => ({ name: secret.name, value: secret.value, hosts: secret.hosts.join(", "), position: secret.position })));
  const [allowHere, setAllowHere] = useState(workspace !== undefined);
  const { busy, error, run } = useLabelledStep(NOTHING_AFTER);
  const saving = busy !== null;
  // What the draft will say instead, in the names the rows hold now.
  const said = secretEntries(rows).map(({ name }) => `$${name}`).join(", ") || "$NAME";

  return (
    <Modal title="Move to Secrets" icon={<KeyIcon size={16} className="p-text-3" />} onClose={onClose} busy={saving} maxWidthClass="max-w-2xl"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <FilledButton data-secret-move-save disabled={!rowsReady(rows) || saving} onClick={() => run("save", async () => {
          const entries = secretEntries(rows);

          await putSecrets(entries, allowHere && workspace !== undefined ? [workspace] : []);
          onMoved(new Map(entries.map((entry) => [entry.value, entry.name])));
        })}>{saving ? "Saving…" : `Save and use ${said}`}</FilledButton>
      </>}>
      <p className="p-row-text p-text-2">
        Stored sealed in your account. Your message will say <code>{said}</code> instead, and agents use the stand-in it holds, which becomes the value only when sent over https to these hosts.
      </p>
      <SecretRows rows={rows} onChange={setRows} removable={rows.length > 1} />
      {workspace !== undefined && (
        <label className="flex items-center gap-2 p-row-text p-text">
          <Switch on={allowHere} onChange={setAllowHere} label="Allow in this workspace" data-secret-move-here />
          Allow in this workspace
        </label>
      )}
      {error !== null && <div role="alert" className="p-notice-danger rounded-md px-3 py-2 text-xs">{error}</div>}
    </Modal>
  );
}
