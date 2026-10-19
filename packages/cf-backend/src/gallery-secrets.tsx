/**
 * Gallery secrets: the `/api/user/secrets` routes as the account object answers them, kept in this page (Settings ›
 * Secrets is `usersettingsstate&section=secrets`, `&secrets=empty` an account with none), and `secretpaste`, the real
 * composer with the chat's paste check in front of its send. What the page saved and sent is on the root's dataset.
 */
import { useState } from "react";
import * as v from "valibot";
import type { SecretSummary } from "@/lib/user-api";
import { Composer } from "@/components/Composer";
import { usePastedSecretGuard } from "@/components/secrets/PasteOffer";
import type { TurnLiveness } from "@kinu.run/core";

const DAY = 864e5;

const NOW = Date.now();

/** The roster's own titles, so a grant reads as the workspace the owner knows. */
const TITLES = new Map([["checkout-fixes", "Storefront"], ["perf-audit", "Dew"], ["email-triage", "Support inbox"], ["design-sys", "Kinu website"]]);

const STOCK: SecretSummary[] = [
  { name: "DATABASE_PASSWORD", hosts: ["db.storefront.dev"], updatedAt: NOW - 12 * DAY, grants: [{ workspace: "checkout-fixes", title: "Storefront", reveal: true }] },
  {
    name: "GITHUB_TOKEN", hosts: ["api.github.com", "github.com"], updatedAt: NOW - 3 * DAY,
    grants: [{ workspace: "design-sys", title: "Kinu website", reveal: false }, { workspace: "checkout-fixes", title: "Storefront", reveal: false }],
  },
  { name: "OPENAI_API_KEY", hosts: ["api.openai.com"], updatedAt: NOW - 40 * DAY, grants: [] },
  { name: "STRIPE_SECRET_KEY", hosts: ["api.stripe.com"], updatedAt: NOW - DAY, grants: [{ workspace: "checkout-fixes", title: "Storefront", reveal: false }] },
];

let held: SecretSummary[] = new URLSearchParams(location.search).get("secrets") === "empty" ? [] : STOCK;

/** Every write the page sent, names and hosts only, for a flow to read back. */
const saved: { readonly names: readonly string[]; readonly grantTo: readonly string[] }[] = [];

const PutSchema = v.object({
  entries: v.array(v.object({ name: v.string(), hosts: v.array(v.string()), value: v.string() })),
  grantTo: v.array(v.string()),
});

function answer(body: SecretSummary[] | { readonly ok: boolean } | { readonly error: string }, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function withGrant(secret: SecretSummary, workspace: string, reveal: boolean): SecretSummary {
  const grants = secret.grants.filter((grant) => grant.workspace !== workspace);

  return { ...secret, grants: [...grants, { workspace, title: TITLES.get(workspace) ?? workspace, reveal }] };
}

export function secretsFixture(path: string, method: string, body: BodyInit | null | undefined): Response | null {
  if (!path.startsWith("/api/user/secrets")) return null;

  if (path === "/api/user/secrets" && method === "GET") return answer(held);

  if (path === "/api/user/secrets" && method === "POST") {
    const put = v.parse(PutSchema, JSON.parse(v.parse(v.string(), body)));

    if (put.entries.some((entry) => entry.hosts.length === 0)) return answer({ error: "Each secret needs at least one host it may be sent to." }, 400);

    for (const entry of put.entries) {
      const before = held.find((secret) => secret.name === entry.name);
      let next: SecretSummary = { name: entry.name, hosts: entry.hosts, updatedAt: Date.now(), grants: before?.grants ?? [] };

      for (const workspace of put.grantTo) next = next.grants.some((grant) => grant.workspace === workspace) ? next : withGrant(next, workspace, false);
      held = [...held.filter((secret) => secret.name !== entry.name), next].sort((a, b) => a.name.localeCompare(b.name));
    }

    saved.push({ names: put.entries.map((entry) => entry.name), grantTo: put.grantTo });
    document.documentElement.dataset.gallerySecretsSaved = JSON.stringify(saved);

    return answer({ ok: true });
  }

  const [, name = "", rest = "", workspace = ""] = /^\/api\/user\/secrets\/([^/]+)(?:\/(hosts|grants)(?:\/([^/]+))?)?$/.exec(path) ?? [];
  const secretName = decodeURIComponent(name);

  if (rest === "hosts" && method === "PUT") {
    const { hosts } = v.parse(v.object({ hosts: v.array(v.string()) }), JSON.parse(v.parse(v.string(), body)));

    held = held.map((secret) => (secret.name === secretName ? { ...secret, hosts } : secret));

    return answer({ ok: true });
  }

  if (rest === "grants" && method === "PUT") {
    const { reveal } = v.parse(v.object({ reveal: v.boolean() }), JSON.parse(v.parse(v.string(), body)));

    held = held.map((secret) => (secret.name === secretName ? withGrant(secret, decodeURIComponent(workspace), reveal) : secret));

    return answer({ ok: true });
  }

  if (rest === "grants" && method === "DELETE") {
    held = held.map((secret) => (secret.name === secretName ? { ...secret, grants: secret.grants.filter((grant) => grant.workspace !== decodeURIComponent(workspace)) } : secret));

    return answer({ ok: true });
  }

  if (rest === "" && method === "DELETE") {
    held = held.filter((secret) => secret.name !== secretName);

    return answer({ ok: true });
  }

  return null;
}

const IDLE: TurnLiveness = { kind: "idle" };

/** The draft as the composer holds it, a GitHub token pasted in; what the chat sent lands on the root's dataset. */
export function SecretPasteFrame() {
  const [draft, setDraft] = useState(`push the fix with this token ${["ghp_", "R8q2LmZx7KbV4nT1sWc9YdE3uHf6JpA0gN5o"].join("")} please`);
  const [sent, setSent] = useState<string[]>([]);
  const guard = usePastedSecretGuard({ draft, setDraft, workspace: "checkout-fixes" });

  const send = () => {
    const next = [...sent, draft];

    setSent(next);
    document.documentElement.dataset.gallerySent = JSON.stringify(next);
    setDraft("");
  };

  return (
    <div className="p-bg p-text flex min-h-screen flex-col justify-end">
      <div className="mx-auto w-full max-w-[820px] flex-1 space-y-2 px-5 py-8">
        {sent.map((text, index) => <div key={index} className="ml-auto max-w-[80%] rounded-lg p-recessed px-3 py-2 p-row-text">{text}</div>)}
      </div>
      <Composer value={draft} onValueChange={setDraft} onSend={guard.guarded(send)} onStop={() => {}} placeholder="Send a message..."
        disabled={false} liveness={IDLE} attention={guard.offer} />
    </div>
  );
}
