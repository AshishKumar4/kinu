/**
 * `google.*` for an agent's programs: Google's own APIs through the account's Google connection, served from the pinned
 * method table with no code per method. A read goes at once; a write goes only with the owner's approval of that exact
 * call, which its next call takes, so one approval makes it once and a changed field asks anew.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import type { CodemodeProvider } from '../types/codemode';
import { googleWriteText, type GoogleWrite } from '../safety/approval-kind';
import type { ApprovalSpend, ApprovalSpendOutcome } from '../safety/approval-gate';
import { sha256Hex } from '../safety/argument-digest';
import { KinuError } from '../obs/index';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import { GOOGLE } from '../operations/google';
import { describeGoogle, googleRequest, googleWrites, searchGoogle, type GoogleMethodRef, type GoogleRequest } from '../google/catalog';
import { mailCardOf } from '../google/mail-card';
import type { JsonValue } from '../utils/json';

/** Google's answer to one request, whatever its status: its JSON (or its text, where it sent none), and what a caller
 *  paces or revalidates by. */
export interface GoogleAnswer {
  readonly status: number;
  readonly body: JsonValue;
  readonly headers: { readonly etag?: string; readonly retryAfter?: string };
}

/** Google's refusal in its own words: `error.message` of its JSON, else its status. */
function refusalOf(answer: GoogleAnswer): KinuError {
  const said = v.safeParse(v.object({ error: v.object({ message: v.string() }) }), answer.body);
  const words = said.success ? said.output.error.message : `HTTP ${answer.status}`;
  const later = answer.headers.retryAfter === undefined ? '' : ` Try again after ${answer.headers.retryAfter} s.`;

  return new KinuError(answer.status === 429 ? 'budget' : 'unavailable', `Google refused it: ${words}${later}`);
}

/** Where an agent's Google write waits on the owner: the workspace's approval queue, as every parked action does. */
export interface GoogleWriteApprovals {
  ask(id: string, write: GoogleWrite): { readonly outcome: 'approved' } | { readonly outcome: 'asked' | 'denied'; readonly approval: string };
  /** The approval taken as the call is made; null where it is no longer approved. */
  take(id: string): ApprovalSpend | null;
  settle(spend: ApprovalSpend, outcome: ApprovalSpendOutcome): Promise<boolean>;
}

export interface GoogleDeps {
  /** The agent that asks, by name, as its write's card says. */
  readonly by: () => string;
  /** One request through the account's Google connection, made by the account: the token never reaches the workspace. */
  readonly send: (request: GoogleRequest) => Promise<GoogleAnswer>;
  readonly approvals: GoogleWriteApprovals;
}

const RawSchema = v.object({ raw: v.optional(v.string()) });

const MessageBodySchema = v.object({ raw: v.optional(v.string()), message: v.optional(RawSchema) });

/** The message a Gmail write sends or keeps, as its card draws it; a draft sent by id is read first, so its card shows it. */
function mailOf(deps: GoogleDeps, found: GoogleMethodRef, params: Readonly<Record<string, JsonValue>>, body: JsonValue | undefined): Effect.Effect<GoogleWrite['mail']> {
  return Effect.gen(function* () {
    if (!found.id.startsWith('gmail.users.messages.') && !found.id.startsWith('gmail.users.drafts.')) return null;
    const held = v.safeParse(MessageBodySchema, body);

    if (found.id !== 'gmail.users.drafts.send' || !held.success || held.output.message?.raw !== undefined) {
      return held.success ? mailCardOf(held.output.raw ?? held.output.message?.raw) : null;
    }

    const draft = v.safeParse(v.object({ id: v.string() }), body);

    if (!draft.success) return null;
    // Built from the pinned table, which holds drafts.get beside drafts.send.
    const { request } = yield* Effect.orDie(googleRequest('gmail.users.drafts.get', { userId: params['userId'] ?? 'me', id: draft.output.id, format: 'raw' }, undefined));
    const answer = yield* Effect.promise(() => deps.send(request));
    const kept = v.safeParse(v.object({ message: RawSchema }), answer.status === 200 ? answer.body : null);

    return kept.success ? mailCardOf(kept.output.message.raw) : null;
  });
}

function serveGoogle(deps: GoogleDeps): readonly Served[] {
  // An agent's call answers with Google's status and JSON, or fails in Google's words.
  const sent = (request: GoogleRequest) => Effect.flatMap(Effect.promise(() => deps.send(request)), (answer) => (
    answer.status >= 200 && answer.status < 300 ? Effect.succeed({ status: answer.status, body: answer.body }) : Effect.fail(refusalOf(answer))
  ));

  return [
    serve(GOOGLE.search, ({ query, limit }) => Effect.succeed(searchGoogle(query, limit ?? 8))),
    serve(GOOGLE.describe, ({ name }) => {
      const declared = describeGoogle(name);

      return declared === null ? Effect.fail(new KinuError('missing', `No Google method or type is named ${name}. Find one with google.search.`)) : Effect.succeed(declared);
    }),
    serve(GOOGLE.read, ({ method, params }) => Effect.gen(function* () {
      const { found, request } = yield* googleRequest(method, params ?? {}, undefined);

      if (googleWrites(found.method)) return yield* new KinuError('bad_input', `${method} changes something at Google (${found.method.verb}); call it with google.write.`);

      return yield* sent(request);
    })),
    serve(GOOGLE.write, ({ method, params, body }) => Effect.gen(function* () {
      const asked = params ?? {};
      const { found, request } = yield* googleRequest(method, asked, body);

      if (!googleWrites(found.method)) return yield* new KinuError('bad_input', `${method} only reads; call it with google.read.`);
      const mail = yield* mailOf(deps, found, asked, body);
      const write: GoogleWrite = { by: deps.by(), method, does: found.method.d ?? method, params: asked, body: body ?? null, mail };
      const id = `google-${sha256Hex(googleWriteText(write), 32)}`;
      const verdict = deps.approvals.ask(id, write);

      if (verdict.outcome !== 'approved') return { status: verdict.outcome, approval: verdict.approval } as const;
      const spend = deps.approvals.take(id);

      // Approved a moment ago and taken since: another call of the same write went first.
      if (spend === null) return { status: 'asked' as const, approval: id };
      const answer = yield* sent(request);

      yield* Effect.promise(async () => deps.approvals.settle(spend, 'spent'));

      return { status: 'done' as const, answer };
    })),
  ];
}

/** `google.*` for an agent's programs. */
export function createGoogleCodemodeProvider(deps: GoogleDeps): CodemodeProvider {
  return codemodeNamespace('google', 'Gmail, Calendar, Drive, Docs, Sheets, Slides and contacts through the account\'s Google connection: search, describe, read; a write asks the owner.', serveGoogle(deps));
}
