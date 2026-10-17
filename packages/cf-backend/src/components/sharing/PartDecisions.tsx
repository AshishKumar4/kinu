/**
 * The decisions a personal part leads to, opened in the app page at the top of the slate's window and never in the
 * part's frame, which the slate's script could cover (docs/SLATE-SHARING-NIMBUS.md §3): letting the slate use a grant
 * of the viewer's, approving one effect with its exact payload, and showing everyone a value the part proposed, exactly
 * as it will leave. Each says what it lets happen and what it does not.
 */
import type { ReactNode } from "react";
import { CheckIcon, EyeIcon, PlugIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { type ConsentAsk, type EffectAsk, type JsonValue } from "@kinu.run/core";
import { FilledButton } from "@/components/ui/FilledButton";
import { Modal } from "@/components/ui/Modal";
import { rootWords, serverWords } from "./words";

/** What leaves, as it will leave: the payload's own JSON, never a summary of it. */
function Payload({ value, ...data }: { value: JsonValue; [attribute: `data-${string}`]: string | boolean | undefined }) {
  return (
    <pre {...data} className="max-h-56 overflow-auto rounded-lg p-recessed px-3 py-2 font-mono text-xs leading-5 p-text whitespace-pre-wrap break-words">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Lets({ yes, no }: { yes: readonly ReactNode[]; no: readonly ReactNode[] }) {
  return (
    <ul className="space-y-1.5 p-row-text">
      {yes.map((line, at) => <li key={`yes-${String(at)}`} className="flex gap-2 p-text"><CheckIcon size={15} weight="bold" className="mt-0.5 shrink-0 p-success" />{line}</li>)}
      {no.map((line, at) => <li key={`no-${String(at)}`} className="flex gap-2 p-text-2"><XIcon size={15} weight="bold" className="mt-0.5 shrink-0 p-text-3" />{line}</li>)}
    </ul>
  );
}

/**
 * Letting this slate use a grant of the viewer's, at this revision of its code; `changed`, when the viewer allowed an
 * earlier revision and the code has changed since.
 */
export function ConsentDecision({ slate, ask, changed, onAllow, onClose }: {
  slate: string;
  ask: ConsentAsk;
  changed: boolean;
  onAllow: () => void;
  onClose: () => void;
}) {
  const server = serverWords(ask);

  return (
    <Modal title={changed ? `${slate} changed since you allowed it` : `Let ${slate} use your ${server}?`} icon={<PlugIcon size={18} className="p-accent" />} onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose} data-consent-dismiss>Not now</Button><FilledButton data-consent-allow onClick={onAllow}>{changed ? "Allow again" : "Allow"}</FilledButton></div>}>
      {changed && <p data-consent-changed className="p-row-text p-text-2">Its code changed after you allowed it to use your {server}. Allow it again to keep seeing your part.</p>}
      <Lets
        yes={[
          <span key="reads">Read through your {server}{ask.tools.length > 0 ? <>: {ask.tools.join(", ")}</> : null}</span>,
          <span key="root">Only within {rootWords(ask.root)}</span>,
          ...(ask.effects ? [<span key="effects">Ask to make changes, each one shown to you to approve first</span>] : []),
        ]}
        no={[
          <span key="others">Show what it reads to anyone but you</span>,
          ...(ask.effects ? [] : [<span key="act">Make any change</span>]),
        ]} />
      <p className="p-meta p-text-3">For this slate, at this version of its code. Take it back in Settings → Connections.</p>
    </Modal>
  );
}

/** Approving one effect, with exactly the payload it will run with, once. */
export function ApprovalDecision({ slate, ask, onApprove, onDecline }: {
  slate: string;
  ask: EffectAsk;
  onApprove: () => void;
  onDecline: () => void;
}) {
  return (
    <Modal title={`${slate} wants to make a change`} icon={<WarningCircleIcon size={18} className="p-warning" />} onClose={onDecline}
      footer={<div className="flex justify-end gap-2"><Button size="sm" variant="secondary" data-approval-decline onClick={onDecline}>Decline</Button><FilledButton data-approval-approve onClick={onApprove}>Approve once</FilledButton></div>}>
      <p className="p-row-text p-text-2"><strong data-approval-tool className="font-medium p-text">{ask.toolTitle ?? ask.tool}</strong> on your {serverWords(ask)}, within {rootWords(ask.root)}, with:</p>
      <Payload data-approval-payload value={ask.payload} />
      <p className="p-meta p-text-3">Only this change, with exactly this. It asks again for any other.</p>
    </Modal>
  );
}

/** Showing everyone a value the part proposed, exactly as it will leave; once shown, it cannot be taken back. */
export function ShowDecision({ label, value, onShow, onClose }: {
  label: string;
  value: JsonValue;
  onShow: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Show to everyone?" icon={<EyeIcon size={18} className="p-accent" />} onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose}>Not now</Button><FilledButton data-show-confirm onClick={onShow}>Show to everyone</FilledButton></div>}>
      <p className="p-row-text p-text-2">{label}</p>
      <Payload data-show-payload value={value} />
      <p data-show-final className="flex gap-2 p-row-text p-text"><WarningCircleIcon size={15} className="mt-0.5 shrink-0 p-warning" />Everyone who can open this slate sees exactly this. You can't take it back once it's shown.</p>
    </Modal>
  );
}
