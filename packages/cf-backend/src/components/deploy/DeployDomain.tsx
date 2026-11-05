/**
 * The Domain step: a domain already in the account, found as it is typed, or one registered elsewhere, which the run adds
 * to the account and waits on. Buying one is Cloudflare's own checkout; a bought domain is found here once it is in.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GlobeHemisphereWestIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { DeployDomain, DeployZone } from "@kinu.run/core/deploy";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/Field";
import { Loader } from "@/components/ui/Loader";
import { HandOff } from "@/components/deploy/DeployParts";
import { readDomains } from "@/lib/deploy-page-api";
import { readingOf } from "@/components/deploy/deploy-reading";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { Group } from "@/components/ui/Group";

/** The address a domain gives a Kinu named `name`: its own host on it. */
export interface PickedDomain {
  readonly name: string;
  /** The account's zone for it; null for a domain registered elsewhere, which the run adds. */
  readonly zone: string | null;
  readonly host: string;
}

/** How long typing rests before the account is searched. */
const SEARCH_REST_MS = 300;

function DomainRow({ name, note, action }: { name: string; note: string; action: ReactNode }) {
  return (
    <li data-deploy-domain={name} className="flex items-center gap-3 py-2">
      <GlobeHemisphereWestIcon size={16} className="shrink-0 p-text-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate t-public-item">{name}</span>
        <span className="block t-meta">{note}</span>
      </span>
      {action}
    </li>
  );
}

function noteOf(domain: DeployDomain, kinu: string): string {
  if (domain.state === "elsewhere") return "Yours, registered somewhere else";

  return domain.status === "pending" ? `Waiting for its nameservers · Kinu would live at ${kinu}.${domain.name}` : `Kinu would live at ${kinu}.${domain.name}`;
}

/** `value` once it has stood unchanged for `rest`: what a search asks is the typing, not each key. */
function useRested<T>(value: T, rest: number): T {
  const [rested, setRested] = useState(value);

  useEffect(() => {
    const settled = setTimeout(() => { setRested(value); }, rest);

    return () => clearTimeout(settled);
  }, [value, rest]);

  return rested;
}

/** The account's domains like `asked`, read once the typing rests. */
function Looking() {
  return <p className="mt-4 inline-flex items-center gap-2 t-meta"><Loader size="sm" />Looking in your account…</p>;
}

function FoundDomains({ account, asked, name, pick }: {
  account: string; asked: string; name: string; pick: (domain: DeployDomain) => void;
}) {
  const load = useCallback(async () => readDomains(account, asked), [account, asked]);
  const found = readingOf(useAsyncResource(load, undefined, `${account}/${asked}`).resource);

  if (found.state === "reading") return <Looking />;

  if (found.state === "refused") return <p role="alert" className="mt-4 t-public-body p-danger">{found.refusal.error}</p>;

  return found.answer.length === 0
    ? <p className="mt-4 t-meta">No domain like that in your account. Type a whole domain you own, like example.com, to use it.</p>
    : (
      <div className="mt-3"><Group list>
        {found.answer.map((domain) => (
          <DomainRow key={domain.name} name={domain.name} note={noteOf(domain, name)}
            action={<Button size="sm" onClick={() => pick(domain)}>{domain.state === "elsewhere" ? "Use it" : "Use"}</Button>} />
        ))}
      </Group></div>
    );
}

export function DeployDomain({ account, name, zones, onPick }: {
  account: string;
  /** The Kinu's name: its host on a domain is this under it. */
  name: string;
  zones: readonly DeployZone[];
  onPick: (picked: PickedDomain) => void;
}) {
  const [query, setQuery] = useState("");
  const typed = query.trim().toLowerCase();
  const asked = useRested(typed, SEARCH_REST_MS);
  const pick = (domain: DeployDomain) => onPick({ name: domain.name, zone: domain.zone ?? null, host: `${name}.${domain.name}` });

  return (
    <div data-deploy-domain-step>
      <label className="relative block">
        <MagnifyingGlassIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 p-text-3" />
        <TextInput aria-label="Find a domain" placeholder="Find a domain in your account, or type one you own" value={query}
          onChange={(event) => setQuery(event.target.value)} className="pl-8" />
      </label>

      {typed !== "" && (typed === asked ? <FoundDomains account={account} asked={asked} name={name} pick={pick} /> : <Looking />)}

      {typed === "" && (
        <div className="mt-5">
          {zones.length > 0 && (
            <>
              <p className="t-meta">In your Cloudflare account</p>
              <div className="mt-1"><Group list>
                {zones.map((zone) => (
                  <DomainRow key={zone.id} name={zone.name} note={noteOf({ name: zone.name, state: "yours", zone: zone.id, status: zone.status }, name)}
                    action={<Button size="sm" onClick={() => onPick({ name: zone.name, zone: zone.id, host: `${name}.${zone.name}` })}>Use</Button>} />
                ))}
              </Group></div>
            </>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="t-meta">No domain yet? Buy one through Cloudflare, at cost, then find it here.</p>
            <HandOff action={{ label: "Buy a domain", href: `https://dash.cloudflare.com/${account}/domains/register` }} />
          </div>
        </div>
      )}
    </div>
  );
}
