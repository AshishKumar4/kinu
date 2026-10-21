/**
 * The deploy page's door (docs/SELF-DEPLOY-FLOW.md § 8): its own sign-in to Cloudflare, held in a cookie of this Kinu,
 * the reads it shows, and the one run it follows. Every answer is read by core's own schema; a refusal comes back in
 * words, with the need the person can meet or Cloudflare's own words, so the page never guesses what went wrong.
 */
import * as v from "valibot";
import { Effect } from "effect";
import {
  DEPLOY_API, DeployDomainsSchema, DeployNeedSchema, DeployPreflightSchema, DeployRefusalSchema, DeployRunViewSchema,
  DeploySessionSchema, MailPreviewSchema,
  type DeployDomain, type DeployNeed, type DeployPreflight, type DeployRefusal, type DeployRunRequest, type DeployRunView,
  type DeploySession, type MailPreview,
} from "@kinu.run/core/deploy";
import { settle, tolerateAsync } from "@kinu.run/core/obs";
import { respond, type HttpRequest } from "./http";

/** A refusal as the page shows it: its sentence, and the need to meet or Cloudflare's words behind it when it has them. */
export interface DeployRefused {
  readonly error: string;
  readonly status: number;
  readonly need: DeployNeed | null;
  readonly refused: DeployRefusal | null;
}

/** The answer, or the refusal in words. */
export type DeployHeard<A> = { readonly answer: A } | { readonly refusal: DeployRefused };

const RefusedSchema = v.object({ error: v.optional(v.string()), need: v.optional(DeployNeedSchema), refused: v.optional(DeployRefusalSchema) });

function heard<Schema extends v.GenericSchema>(schema: Schema, path: string, init: HttpRequest = {}): Effect.Effect<DeployHeard<v.InferOutput<Schema>>> {
  return Effect.gen(function* () {
    const response = yield* respond(`${DEPLOY_API}${path}`, init);

    if (response.ok) return { answer: v.parse(schema, yield* Effect.promise(async () => response.json())) };

    // A refusal's body is the door's words when it has any; a proxy's page in its place says only its status.
    const body = yield* Effect.promise(async () => tolerateAsync(async () => response.json(), "malformed-input"));
    const said = v.safeParse(RefusedSchema, body);
    const words = said.success ? said.output : { error: undefined, need: undefined, refused: undefined };

    return {
      refusal: {
        error: words.error ?? `Kinu could not ${init.method === "POST" ? "do that" : "read that"} (${String(response.status)}).`,
        status: response.status,
        need: words.need ?? null,
        refused: words.refused ?? null,
      },
    };
  });
}

const HandoffSchema = v.object({ location: v.string() });

/** Begins the page's sign-in; the answer is Cloudflare's consent page, which comes back to `/deploy`. */
export function beginSignIn(): Promise<DeployHeard<v.InferOutput<typeof HandoffSchema>>> {
  return settle(heard(HandoffSchema, "/signin", { method: "POST", json: { end: "tab" } }));
}

export function readSession(): Promise<DeployHeard<DeploySession>> {
  return settle(heard(DeploySessionSchema, "/session"));
}

export function readPreflight(account: string): Promise<DeployHeard<DeployPreflight>> {
  return settle(heard(DeployPreflightSchema, `/preflight?${new URLSearchParams({ account }).toString()}`));
}

export function readDomains(account: string, query: string): Promise<DeployHeard<readonly DeployDomain[]>> {
  return settle(heard(DeployDomainsSchema, `/domains?${new URLSearchParams({ account, q: query }).toString()}`));
}

/** What mail at `host` would write and keep, read and never written. */
export function readMailPreview(account: string, host: string): Promise<DeployHeard<MailPreview>> {
  return settle(heard(MailPreviewSchema, `/mail?${new URLSearchParams({ account, host }).toString()}`));
}

const BegunSchema = v.object({ runId: v.string() });

export function beginRun(asked: DeployRunRequest): Promise<DeployHeard<v.InferOutput<typeof BegunSchema>>> {
  return settle(heard(BegunSchema, "/runs", { method: "POST", json: asked }));
}

/** The run this sign-in follows; null when it follows none. */
export function readRun(): Promise<DeployHeard<DeployRunView | null>> {
  return settle(heard(v.nullable(DeployRunViewSchema), "/runs/current"));
}

/** Carries the followed run on: after a refusal's own action, after a sign-in again, or on a resume. */
export function continueRun(): Promise<DeployHeard<DeployRunView | null>> {
  return settle(heard(v.nullable(DeployRunViewSchema), "/runs/current/continue", { method: "POST" }));
}
