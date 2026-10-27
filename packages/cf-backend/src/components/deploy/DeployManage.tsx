/**
 * An existing Kinu (`session.deployments`): where it lives, whether an update is out, the changes it can have here (a
 * domain, mail, a new setup link) and its connectors. Several Kinus are listed first, each opening its own.
 */
import { useState } from "react";
import {
  ArrowSquareOutIcon, ArrowsClockwiseIcon, CaretRightIcon, CheckIcon, EnvelopeSimpleIcon, GlobeHemisphereWestIcon, LinkIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { DeployChoice, DeployedKinu, DeploySession, UpdateBuild } from "@kinu.run/core/deploy";
import { Button, buttonClass } from "@/components/ui/Button";
import { DeployConnectors, type GithubReturn } from "@/components/deploy/DeployConnectors";
import { Pressable } from "@/components/ui/Pressable";
import { Loader } from "@/components/ui/Loader";
import { accountName, DeployShell, Refused, Unreadable, type RefusalActions } from "@/components/deploy/DeployParts";
import type { DeployRefused } from "@/lib/deploy-page-api";
import { IconTile } from "@/components/ui/IconTile";

/** What a change asks of the page, for the Kinu it is about. */
export type KinuChange = "update" | "domain" | "mail" | "github" | "link";

/** A build's day, as a person says it ("20 October"); the stamp itself when it is not a date. */
function dayOf(build: UpdateBuild): string {
  const at = new Date(build.builtAt);

  return Number.isNaN(at.getTime()) ? build.builtAt : at.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

/** Whether a Kinu answers on a domain of its own rather than workers.dev: mail needs one. */
function onOwnDomain(kinu: DeployedKinu): boolean {
  return URL.canParse(kinu.url) && !new URL(kinu.url).hostname.endsWith(".workers.dev");
}

/** One change an existing Kinu can have: what it is, what it needs, and where it goes. */
function Change({ Icon, title, copy, onPick, disabled = false, change }: {
  Icon: PhosphorIcon; title: string; copy: string; onPick: () => void; disabled?: boolean; change: string;
}) {
  return (
    <li>
      <Pressable onClick={onPick} disabled={disabled} data-deploy-change={change} className="-mx-3 flex w-auto items-center gap-3 px-3 py-3 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent">
        <IconTile size="xl"><Icon size={18} className="p-accent-fg" /></IconTile>
        <span className="min-w-0 flex-1">
          <span className="block t-public-item">{title}</span>
          <span className="mt-px block t-meta">{copy}</span>
        </span>
        {!disabled && <CaretRightIcon size={14} className="shrink-0 p-text-3" />}
      </Pressable>
    </li>
  );
}

/** The update line: what you have, what is out, and the one action; or that it is current, or why it can't start here. */
function UpdateChange({ kinu, onPick }: { kinu: DeployedKinu; onPick: () => void }) {
  const { current, available, upToDate, installable, reason } = kinu.update;

  // The release channel unread: nothing to compare against, which is not the same as current.
  if (available === null) return <Change change="update" Icon={ArrowsClockwiseIcon} title="Can't check for updates" copy={reason} disabled onPick={onPick} />;

  if (upToDate) {
    return (
      <li data-deploy-update="current" className="flex items-center gap-3 py-3">
        <IconTile size="xl"><CheckIcon size={16} className="p-success" /></IconTile>
        <span className="min-w-0 flex-1">
          <span className="block t-public-item">Up to date</span>
          {current !== null && <span className="mt-px block t-meta">{current.version}, built {dayOf(current)}</span>}
        </span>
      </li>
    );
  }

  const had = current === null ? "" : `You have ${current.version}, built ${dayOf(current)}. `;
  const versions = `${had}The latest is ${available.version}, built ${dayOf(available)}.`;

  return installable
    ? <Change change="update" Icon={ArrowsClockwiseIcon} title="Update to the latest" copy={versions} onPick={onPick} />
    : <Change change="update" Icon={ArrowsClockwiseIcon} title="An update is out" copy={`${versions} ${reason}`} disabled onPick={onPick} />;
}

function KinuChanges({ kinu, accounts, onChange }: { kinu: DeployedKinu; accounts: readonly DeployChoice[]; onChange: (change: KinuChange) => void }) {
  const domain = onOwnDomain(kinu);
  const host = URL.canParse(kinu.url) ? new URL(kinu.url).hostname : kinu.url;

  return (
    <>
      <p className="t-public-body">It's live at <a href={kinu.url} target="_blank" rel="noopener noreferrer" data-deploy-kinu={kinu.name} className="t-public-item hover:underline">{host}</a>, in {accountName(accounts, kinu.account)}.</p>
      <ul className="mt-4 space-y-1">
        <UpdateChange kinu={kinu} onPick={() => onChange("update")} />
        <Change change="domain" Icon={GlobeHemisphereWestIcon} title={domain ? "Move to another domain" : "Add a domain"}
          copy={domain ? "Move it to another address of your own." : "Move it to an address of your own. This one keeps working."} onPick={() => onChange("domain")} />
        <Change change="mail" Icon={EnvelopeSimpleIcon} title="Add mail" copy={domain ? "An inbox for you and your agents at your domain." : "Needs a domain first."}
          disabled={!domain} onPick={() => onChange("mail")} />
        <Change change="link" Icon={LinkIcon} title="Get a new setup link" copy="If the first one ran out or went missing." onPick={() => onChange("link")} />
      </ul>
    </>
  );
}

export function DeployManage({ session, starting, refusal, refusalActions, github, onChange, onCheckUpdates }: {
  session: DeploySession;
  /** An update or a new link asked for and not yet begun. */
  starting: boolean;
  refusal: DeployRefused | null;
  refusalActions: RefusalActions;
  /** GitHub's return, when this page was arrived at from it. */
  github: GithubReturn | null;
  onChange: (kinu: DeployedKinu, change: KinuChange) => void;
  /** Reads every Kinu again: its build against the channel's, and its connectors. */
  onCheckUpdates: () => void;
}) {
  const { deployments, accounts } = session;
  const keyOf = (kinu: DeployedKinu) => `${kinu.account}/${kinu.name}`;
  const returnedTo = github !== null && "made" in github ? deployments.find((kinu) => kinu.name === github.kinu) : undefined;
  const first = returnedTo ?? (deployments.length === 1 ? deployments[0] : undefined);
  // By its key, so a read of the session again shows the same Kinu as it is now.
  const [pickedKey, setPicked] = useState<string | null>(first === undefined ? null : keyOf(first));
  const picked = deployments.find((kinu) => keyOf(kinu) === pickedKey) ?? null;

  // Back only from one Kinu to the list of several: the list is where a signed-in person starts.
  return (
    <DeployShell dot={1} screen="manage" title={picked === null ? "Your Kinus" : "Your Kinu"}
      footer={(
        <>
          {picked !== null && deployments.length > 1 && <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setPicked(null)}>Back</Button>}
          <Button variant="ghost" size="sm" data-deploy-check onClick={onCheckUpdates}>Check for updates</Button>
          {picked !== null && (
            <a href={picked.url} target="_blank" rel="noopener noreferrer" data-deploy-open className={buttonClass({ variant: "primary", size: "sm" })}>
              Open Kinu<ArrowSquareOutIcon size={14} />
            </a>
          )}
        </>
      )}>
      <Unreadable session={session} />
      {starting && <p className="mb-4 inline-flex items-center gap-2 t-meta"><Loader size="sm" />Starting…</p>}
      {refusal !== null && <div className="mb-4"><Refused refusal={refusal} actions={refusalActions} /></div>}
      {github !== null && "error" in github && <p role="alert" className="mb-4 t-public-body p-danger" data-deploy-github="refused">Couldn't connect GitHub: {github.error}</p>}
      {picked === null
        ? (
          <ul className="space-y-1">
            {deployments.map((kinu) => (
              <Change key={`${kinu.account}/${kinu.name}`} change="pick" Icon={GlobeHemisphereWestIcon}
                title={URL.canParse(kinu.url) ? new URL(kinu.url).hostname : kinu.url} copy={accountName(accounts, kinu.account)} onPick={() => setPicked(keyOf(kinu))} />
            ))}
          </ul>
        )
        : (
          <>
            <KinuChanges kinu={picked} accounts={accounts} onChange={(change) => onChange(picked, change)} />
            <DeployConnectors kinu={picked} github={github} busy={starting} onConnectGithub={() => onChange(picked, "github")} onChanged={onCheckUpdates} />
          </>
        )}
    </DeployShell>
  );
}
