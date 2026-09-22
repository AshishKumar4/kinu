/**
 * `/deploy` — the guided page (docs/SELF-DEPLOY.md § The Cloudflare door).
 *
 * Public, and with no Kinu account anywhere in it: a person arriving here does
 * not have a Kinu yet, which is the whole point of the page. What authorizes
 * everything it does is the run key it minted, held in this tab.
 *
 * FIVE STATES, and each one is a thing that really happens:
 *   - not configured — this deployment has no OAuth client, so the Cloudflare
 *     door cannot open. Said plainly, with the local door offered instead.
 *   - sign in — before a run exists, and after one exists but holds no token.
 *   - answers — the account, the name, the address, the sign-in email.
 *   - running — one row per step, with Cloudflare's own words on a refusal and
 *     a Retry on that step only.
 *   - done — the address, the sign-in email, and the connect command.
 *
 * A reload re-reads the ledger rather than starting again: the run id is in
 * the query string and the key is in this tab, so the page that comes back is
 * the page that left.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import { CloudArrowUpIcon } from "@phosphor-icons/react";
import {
  DEFAULT_INSTANCE_NAME, DeployFrameSchema, FACT_OWNER_EMAIL,
  deployDoor, deployOptions, mintRun,
  type DeployChoice, type DeployDoor, type DeployInputs, type DeployOptions, type DeploySnapshot,
} from "@kinu.run/core/deploy";
import { renderThrownChain } from "@kinu.run/core/obs";
import * as v from "valibot";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { FilledButton } from "@/components/ui/FilledButton";
import { Field, inputCls } from "@/components/ui/form";
import { StepRow } from "@/components/deploy/DeployStepRow";

/**
 * THE RUN KEY IS A CAPABILITY, so this tab holds it like one: `sessionStorage`
 * under the run's id, handed to the core door, which puts it in an
 * `authorization` header and never in a URL. A closed tab loses it, which is
 * correct — a run nobody holds the key to is a run nobody may drive.
 */
function heldRunKey(runId: string): string {
  return sessionStorage.getItem(`kinu.deploy.run.${runId}`) ?? "";
}

function doorFor(runId: string): DeployDoor {
  return deployDoor({ origin: location.origin, runId, runKey: heldRunKey(runId) });
}

/** The key comes back from the mint once and is not recoverable, so it is
 *  stored before the id is used for anything. */
async function openDeployRun(): Promise<string> {
  const ticket = await mintRun(location.origin);

  sessionStorage.setItem(`kinu.deploy.run.${ticket.runId}`, ticket.runKey);

  return ticket.runId;
}

/** The answers being collected, before they are a `DeployInputs`. Kept as text
 *  because a half-typed email is not an email and the form must still render
 *  it. */
interface Answers {
  accountId: string;
  instanceName: string;
  ownerEmail: string;
  zoneId: string;
  hostname: string;
  sandbox: boolean;
  keys: Record<string, string>;
}

const EMPTY: Answers = {
  accountId: "",
  instanceName: DEFAULT_INSTANCE_NAME,
  ownerEmail: "",
  zoneId: "",
  hostname: "",
  sandbox: false,
  keys: {},
};

function inputsFrom(answers: Answers): DeployInputs {
  const zoned = answers.zoneId !== "" && answers.hostname !== "";

  return {
    accountId: answers.accountId,
    instanceName: answers.instanceName,
    address: zoned
      ? { kind: "zone", hostname: answers.hostname, zoneId: answers.zoneId }
      : { kind: "workers-dev", hostname: "", zoneId: "" },
    ownerEmail: answers.ownerEmail,
    accessEmails: [answers.ownerEmail],
    providerKeyNames: Object.entries(answers.keys).filter(([, value]) => value !== "").map(([name]) => name),
    sandbox: answers.sandbox,
  };
}

function NotConfigured({ reason }: { reason: string }) {
  return (
    <section className="space-y-3" aria-label="The Cloudflare door is not configured">
      <div className="p-card px-5 py-4">
        <h2 className="p-title p-text">The Cloudflare door is not open yet</h2>
        <p className="mt-1 text-sm p-text-2">{reason}</p>
        <p className="mt-3 p-meta p-text-3">
          Registering the OAuth client is the owner's step, and it is a one-time one. Until it is
          done, this page cannot deploy into a Cloudflare account.
        </p>
      </div>
      <div className="p-card px-5 py-4">
        <h2 className="p-title p-text">Your own machine works now</h2>
        <p className="mt-1 text-sm p-text-2">
          The same product runs under local workerd, with no account anywhere.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-[var(--c-surface)] px-3 py-2 font-mono text-xs p-text">
          curl -fsSL https://kinu.run/install-local.sh | bash
        </pre>
      </div>
    </section>
  );
}

function Answered({ options, runId, onStarted }: {
  options: DeployOptions;
  runId: string;
  onStarted: (snapshot: DeploySnapshot) => void;
}) {
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [accounts, setAccounts] = useState<readonly DeployChoice[]>([]);
  const [zones, setZones] = useState<readonly DeployChoice[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const failed = (...rejection: [unknown]): void => { if (live) setErr(renderThrownChain({ cause: rejection[0] })); };

    const door = doorFor(runId);

    door.accounts().then((found) => {
      if (!live) return;
      setAccounts(found);
      setAnswers((held) => ({ ...held, accountId: held.accountId === "" ? found[0]?.id ?? "" : held.accountId }));
    }).catch(failed);
    door.zones().then((found) => { if (live) setZones(found); }).catch(failed);

    return () => { live = false; };
  }, [runId]);

  const deploy = async (): Promise<void> => {
    setBusy(true);
    setErr(null);

    const door = doorFor(runId);

    try {
      for (const [name, value] of Object.entries(answers.keys)) {
        if (value !== "") await door.holdProviderKey(name, value);
      }

      onStarted(await door.start(inputsFrom(answers)));
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4" aria-label="Your deployment">
      <div className="p-card space-y-5 px-5 py-5">
        <Field label="Cloudflare account" hint="Where this Kinu lives. Everything it creates is yours.">
          <select
            className={inputCls}
            aria-label="Cloudflare account"
            value={answers.accountId}
            onChange={(event) => setAnswers({ ...answers, accountId: event.target.value })}
          >
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </Field>
        <Field label="Instance name" hint="Lower-case letters, numbers and dashes. It names the Worker and its resources.">
          <input
            className={inputCls}
            aria-label="Instance name"
            value={answers.instanceName}
            onChange={(event) => setAnswers({ ...answers, instanceName: event.target.value })}
          />
        </Field>
        <Field label="Your email" hint="The one-time PIN goes here, and this address owns the deployment.">
          <input
            className={inputCls}
            type="email"
            aria-label="Your email"
            value={answers.ownerEmail}
            onChange={(event) => setAnswers({ ...answers, ownerEmail: event.target.value })}
          />
        </Field>
        <Field
          label="Address"
          hint={zones.length === 0
            ? "A workers.dev address, derived from your account's subdomain."
            : "A workers.dev address by default, or a hostname in one of your zones."}
        >
          {zones.length > 0 && (
            <div className="space-y-2">
              <select
                className={inputCls}
                aria-label="Zone"
                value={answers.zoneId}
                onChange={(event) => setAnswers({ ...answers, zoneId: event.target.value })}
              >
                <option value="">workers.dev</option>
                {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
              </select>
              {answers.zoneId !== "" && (
                <input
                  className={inputCls}
                  aria-label="Hostname"
                  placeholder="kinu.example.com"
                  value={answers.hostname}
                  onChange={(event) => setAnswers({ ...answers, hostname: event.target.value })}
                />
              )}
            </div>
          )}
        </Field>
        {options.prompts.map((name) => (
          <Field key={name} label={name} hint="Optional. Stored as a secret on your deployment, never here.">
            <input
              className={inputCls}
              type="password"
              aria-label={name}
              value={answers.keys[name] ?? ""}
              onChange={(event) => setAnswers({ ...answers, keys: { ...answers.keys, [name]: event.target.value } })}
            />
          </Field>
        ))}
      </div>
      {err !== null && <div className="p-notice-danger rounded-md px-3 py-2 text-xs" role="alert">{err}</div>}
      <div className="flex items-center justify-between gap-3">
        <p className="p-meta p-text-3">Kinu {options.version} will be uploaded into your account.</p>
        <FilledButton
          onClick={() => void deploy()}
          disabled={busy || answers.accountId === "" || answers.ownerEmail === ""}
          className="!h-9 !px-4 !text-sm"
        >
          <CloudArrowUpIcon size={15} /> Deploy my Kinu
        </FilledButton>
      </div>
    </section>
  );
}

function Done({ snapshot, email }: { snapshot: DeploySnapshot; email: string }) {
  const origin = `https://${snapshot.address}`;

  return (
    <section className="space-y-3" aria-label="Your Kinu is deployed">
      <div className="p-card px-5 py-4">
        <h2 className="p-title p-text">Your Kinu is live</h2>
        <p className="mt-1 text-sm p-text-2">
          <a className="underline" href={origin}>{snapshot.address}</a>
        </p>
        <p className="mt-2 p-meta p-text-3">
          Sign in with {email === "" ? "the email you gave" : email}: Cloudflare Access sends a
          one-time PIN. Kinu {snapshot.version} is what is running, and it updates itself from its
          own Updates page.
        </p>
      </div>
      <div className="p-card px-5 py-4">
        <h2 className="p-title p-text">Connect this computer</h2>
        <pre className="mt-2 overflow-x-auto rounded-md bg-[var(--c-surface)] px-3 py-2 font-mono text-xs p-text">
          curl -fsSL {origin}/install.sh | bash
        </pre>
      </div>
    </section>
  );
}

export default function DeployPage({ fixture, fixtureOptions }: {
  /** A run, for the gallery and for a test: the page renders it rather than
   *  minting one. */
  fixture?: DeploySnapshot;
  fixtureOptions?: DeployOptions;
} = {}) {
  const [options, setOptions] = useState<DeployOptions | null>(fixtureOptions ?? null);
  // The run the URL names. Read once: the authorize leg leaves through a full
  // navigation and comes back as a fresh mount with `?run=` set.
  const [runId] = useState(() => new URLSearchParams(location.search).get("run") ?? "");
  const [snapshot, setSnapshot] = useState<DeploySnapshot | null>(fixture ?? null);
  const [err, setErr] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const live = fixture === undefined && fixtureOptions === undefined;

  useEffect(() => {
    if (!live) return;
    let mounted = true;

    const failed = (...rejection: [unknown]): void => { if (mounted) setErr(renderThrownChain({ cause: rejection[0] })); };

    deployOptions(location.origin).then((offer) => { if (mounted) setOptions(offer); }).catch(failed);

    return () => { mounted = false; };
  }, [live]);

  // A run in the query string with its key in this tab is a run to resume: the
  // ledger is the source of truth and the socket carries what happens next.
  useEffect(() => {
    if (!live || runId === "" || heldRunKey(runId) === "") return;
    let mounted = true;

    const failed = (...rejection: [unknown]): void => { if (mounted) setErr(renderThrownChain({ cause: rejection[0] })); };

    const door = doorFor(runId);

    door.snapshot().then((held) => { if (mounted) setSnapshot(held); }).catch(failed);

    // The key rides the upgrade's subprotocol list: a WebSocket URL cannot
    // carry it, and a browser can set no header on the upgrade.
    const opened = new WebSocket(door.socketUrl(), [...door.socketProtocols()]);

    socket.current = opened;
    opened.addEventListener("message", (event: MessageEvent) => {
      const frame = v.safeParse(DeployFrameSchema, JSON.parse(String(event.data)));

      if (frame.success && frame.output.type === "deploy.snapshot" && mounted) setSnapshot(frame.output.snapshot);
    });

    return () => {
      mounted = false;
      opened.close();
      socket.current = null;
    };
  }, [live, runId]);

  const signIn = async (): Promise<void> => {
    try {
      // An expired run is signed into again rather than replaced: its ledger
      // holds every step that already ran, and a fresh run would create a
      // second set of everything.
      const run = runId !== "" && heldRunKey(runId) !== "" ? runId : await openDeployRun();

      // The door mints the leg and answers where to go; the key authorized
      // that POST in a header and is in nothing the browser navigates to.
      location.assign(await doorFor(run).authorize());
    } catch (cause) {
      setErr(renderThrownChain({ cause }));
    }
  };

  const retry = useCallback((stepId: string): void => {
    const failed = (...rejection: [unknown]): void => setErr(renderThrownChain({ cause: rejection[0] }));

    doorFor(runId).retry(stepId).then(setSnapshot).catch(failed);
  }, [runId]);

  const ownerEmail = snapshot?.steps.flatMap((row) => Object.entries(row.facts))
    .find(([key]) => key === FACT_OWNER_EMAIL)?.[1] ?? "";

  // The form is shown while the run is still collecting answers. A started run
  // has none: `start` answers before its first step exists, so "no rows yet"
  // is a run whose first frame has not arrived, not a run to re-answer.
  const collecting = snapshot !== null
    && (snapshot.state === "collecting" || snapshot.state === "authorizing")
    && snapshot.steps.length === 0;

  return (
    <div className="min-h-screen p-bg p-text">
      <header className="flex h-14 items-center justify-between border-b p-border px-5">
        <a href="/" aria-label="Kinu home" className="flex items-center"><KinuLogo /></a>
        <span className="p-meta p-text-3">Deploy your own Kinu</span>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        <div>
          <h1 className="p-display text-2xl">Your own Kinu, in your own account</h1>
          <p className="mt-1 text-sm p-text-2">
            Sign in with Cloudflare, answer four questions, and watch it deploy. Nothing is built on
            your side, and kinu.run keeps no credential of yours.
          </p>
        </div>
        {err !== null && <div className="p-notice-danger rounded-md px-3 py-2 text-xs" role="alert">{err}</div>}
        {options === null && err === null && <div className="flex justify-center py-16"><Loader size="base" /></div>}
        {options !== null && !options.cloudflare && <NotConfigured reason={options.reason} />}
        {options !== null && options.cloudflare && (snapshot === null || snapshot.state === "expired") && (
          <section className="space-y-3" aria-label="Sign in with Cloudflare">
            <div className="p-card px-5 py-4">
              <h2 className="p-title p-text">Sign in with Cloudflare</h2>
              <p className="mt-1 text-sm p-text-2">
                {snapshot?.state === "expired"
                  ? "This run stopped holding your Cloudflare authorization, which it does an hour"
                    + " after it last moved. Sign in again and it carries on from the step it reached."
                  : "Kinu asks for the permissions it needs to create your Worker, its storage, and"
                    + " its sign-in. The token stays on this run and is wiped when the run ends;"
                    + " your deployment keeps its own from then on."}
              </p>
              <FilledButton onClick={() => void signIn()} className="mt-4 !h-9 !px-4 !text-sm">
                Sign in with Cloudflare
              </FilledButton>
            </div>
            <p className="p-meta p-text-3">Kinu {options.version} is the version a run installs.</p>
          </section>
        )}
        {options !== null && collecting && (
          <Answered options={options} runId={runId === "" ? snapshot.runId : runId} onStarted={setSnapshot} />
        )}
        {snapshot !== null && !collecting && (
          <>
            {snapshot.state === "done" && <Done snapshot={snapshot} email={ownerEmail} />}
            <section className="space-y-2" aria-label="Deployment steps">
              <h2 className="p-eyebrow">{snapshot.state === "done" ? "What it did" : "Deploying"}</h2>
              <ul className="space-y-2">
                {snapshot.steps.map((row) => <StepRow key={row.id} row={row} onRetry={retry} />)}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
