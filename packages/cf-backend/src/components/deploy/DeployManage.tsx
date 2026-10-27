/**
 * An existing Kinu (`session.deployments`): where it lives, whether an update is out, and the changes it can have here
 * (a domain, mail, a GitHub App of its own, a new setup link). Several Kinus are listed first, each opening its own changes.
 */
import { useState } from "react";
import {
  ArrowSquareOutIcon, ArrowsClockwiseIcon, CaretRightIcon, CheckIcon, EnvelopeSimpleIcon, GithubLogoIcon, GlobeHemisphereWestIcon, LinkIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { DeployChoice, DeployedKinu, DeploySession, UpdateBuild } from "@kinu.run/core/deploy";
import { Button } from "@/components/ui/Button";
import { Pressable } from "@/components/ui/Pressable";
import { Loader } from "@/components/ui/Loader";
import { accountName, DeployShell, Refused, Unreadable, type RefusalActions } from "@/components/deploy/DeployParts";
import type { DeployRefused } from "@/lib/deploy-page-api";
import { IconTile } from "@/components/ui/IconTile";

/** What a change asks of the page, for the Kinu it is about. */
export type KinuChange = "update" | "domain" | "mail" | "github" | "link";

/** GitHub's return to the page once it made a Kinu's app: the app, for the Kinu named, or GitHub's or Cloudflare's words. */
export type GithubReturn = { readonly made: string; readonly kinu: string } | { readonly error: string };

/** The app GitHub just made, and the one step left: installing it where its agents may work. */
function GithubMade({ app }: { app: string }) {
  return (
    <li data-deploy-github="made" className="flex items-center gap-3 py-3">
      <IconTile size="xl"><CheckIcon size={16} className="p-success" /></IconTile>
      <span className="min-w-0 flex-1">
        <span className="block t-public-item">Its GitHub App is made</span>
        <span className="mt-px block t-meta">Install it on the repositories its agents may work in.</span>
      </span>
      <a href={`https://github.com/apps/${encodeURIComponent(app)}/installations/new`} target="_blank" rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 t-public-item p-accent-fg hover:underline">
        Install<ArrowSquareOutIcon size={14} />
      </a>
    </li>
  );
}

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

function KinuChanges({ kinu, accounts, madeApp, onChange }: {
  kinu: DeployedKinu;
  accounts: readonly DeployChoice[];
  /** The GitHub App GitHub returned from making for this Kinu, when it did. */
  madeApp: string | null;
  onChange: (change: KinuChange) => void;
}) {
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
        {madeApp === null
          ? (
            <Change change="github" Icon={GithubLogoIcon} title={kinu.github ? "Make a new GitHub App" : "Add GitHub"}
              copy={kinu.github ? "It has an app of its own on GitHub. A new one replaces it." : "An app of your own on GitHub, so its agents work in your repositories."}
              onPick={() => onChange("github")} />
          )
          : <GithubMade app={madeApp} />}
        <Change change="link" Icon={LinkIcon} title="Get a new setup link" copy="If the first one ran out or went missing." onPick={() => onChange("link")} />
      </ul>
    </>
  );
}

export function DeployManage({ session, starting, refusal, refusalActions, github, onChange, onDeployAnother }: {
  session: DeploySession;
  /** An update or a new link asked for and not yet begun. */
  starting: boolean;
  refusal: DeployRefused | null;
  refusalActions: RefusalActions;
  /** GitHub's return, when this page was arrived at from it. */
  github: GithubReturn | null;
  onChange: (kinu: DeployedKinu, change: KinuChange) => void;
  onDeployAnother: () => void;
}) {
  const { deployments, accounts } = session;
  const returnedTo = github !== null && "made" in github ? deployments.find((kinu) => kinu.name === github.kinu) : undefined;
  const [picked, setPicked] = useState<DeployedKinu | null>(returnedTo ?? (deployments.length === 1 ? deployments[0] ?? null : null));

  // Back only from one Kinu to the list of several: the list is where a signed-in person starts.
  return (
    <DeployShell dot={1} screen="manage" title={picked === null ? "Your Kinus" : "Your Kinu"}
      footer={(
        <>
          {picked !== null && deployments.length > 1 && <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setPicked(null)}>Back</Button>}
          <Button variant="ghost" size="sm" data-deploy-another onClick={onDeployAnother}>Deploy another Kinu</Button>
        </>
      )}>
      <Unreadable session={session} />
      {starting && <p className="mb-4 inline-flex items-center gap-2 t-meta"><Loader size="sm" />Starting…</p>}
      {refusal !== null && <div className="mb-4"><Refused refusal={refusal} actions={refusalActions} /></div>}
      {github !== null && "error" in github && <p role="alert" className="mb-4 t-public-body p-danger" data-deploy-github="refused">Couldn't add GitHub: {github.error}</p>}
      {picked === null
        ? (
          <ul className="space-y-1">
            {deployments.map((kinu) => (
              <Change key={`${kinu.account}/${kinu.name}`} change="pick" Icon={GlobeHemisphereWestIcon}
                title={URL.canParse(kinu.url) ? new URL(kinu.url).hostname : kinu.url} copy={accountName(accounts, kinu.account)} onPick={() => setPicked(kinu)} />
            ))}
          </ul>
        )
        : <KinuChanges kinu={picked} accounts={accounts} madeApp={picked === returnedTo && github !== null && "made" in github ? github.made : null}
          onChange={(change) => onChange(picked, change)} />}
    </DeployShell>
  );
}
