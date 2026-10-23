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
import { KinuError, tolerate } from '../obs/index';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import { GOOGLE } from '../operations/google';
import { describeGoogle, googleRequest, googleWrites, searchGoogle, type GoogleMethodRef, type GoogleRequest } from '../google/catalog';
import type { GoogleAnswer } from '../google/calls';
import type { ParsedMail } from '../mail/store';
import { base64ToBytes } from '../utils/base64';
import type { JsonValue } from '../utils/json';

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
  /** A message as Kinu's Mailbox reads one (postal-mime), for a write's card. */
  readonly readMail: (raw: Uint8Array) => Promise<Pick<ParsedMail, 'to' | 'cc' | 'subject' | 'text'> & { readonly bcc: ParsedMail['cc'] }>;
  /** Whether the account holds the Google connection now: a write asks its owner only where it could be made. */
  readonly held: () => Promise<boolean>;
  readonly approvals: GoogleWriteApprovals;
}

const RawSchema = v.object({ raw: v.optional(v.string()) });

/** How much of a message's text a card shows. */
const START_CHARS = 400;

function bytesOf(raw: string | undefined): Uint8Array | undefined {
  const standard = (raw ?? '').replaceAll('-', '+').replaceAll('_', '/');

  return standard === '' ? undefined : tolerate(() => base64ToBytes(standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')), 'malformed-input');
}

/** A message as a write's card draws it, from Gmail's base64url `raw`; null for none, or one that does not decode. */
function mailCardOf(deps: GoogleDeps, raw: string | undefined): Effect.Effect<GoogleWrite['mail']> {
  return Effect.gen(function* () {
    const bytes = bytesOf(raw);

    if (bytes === undefined) return null;
    const read = yield* Effect.promise(() => deps.readMail(bytes));
    const named = (parties: typeof read.to) => parties.map((party) => (party.name === null ? party.address : `${party.name} <${party.address}>`)).join(', ');

    return { to: named(read.to), cc: named(read.cc), bcc: named(read.bcc), subject: read.subject, start: read.text.replace(/\s+/gu, ' ').trim().slice(0, START_CHARS) };
  });
}

const MessageBodySchema = v.object({ raw: v.optional(v.string()), message: v.optional(RawSchema) });

/** What a Gmail write's card shows, and for a draft sent by id, the digest of the whole message it holds now and the
 *  body that sends exactly that message (`{ id, message: { raw } }`), whatever the draft becomes after it was read. */
interface MessageSeen {
  readonly mail: GoogleWrite['mail'];
  readonly content: string | null;
  readonly sends?: JsonValue;
}

/** The message a Gmail write sends or keeps; a draft sent by id is read from Google first, so its card shows it and its
 *  approval is bound to it whole. */
function messageOf(deps: GoogleDeps, found: GoogleMethodRef, params: Readonly<Record<string, JsonValue>>, body: JsonValue | undefined): Effect.Effect<MessageSeen, KinuError> {
  return Effect.gen(function* () {
    const none: MessageSeen = { mail: null, content: null };

    if (!found.id.startsWith('gmail.users.messages.') && !found.id.startsWith('gmail.users.drafts.')) return none;
    const held = v.safeParse(MessageBodySchema, body);

    if (found.id !== 'gmail.users.drafts.send' || !held.success || held.output.message?.raw !== undefined) {
      return held.success ? { mail: yield* mailCardOf(deps, held.output.raw ?? held.output.message?.raw), content: null } : none;
    }

    const draft = v.safeParse(v.object({ id: v.string() }), body);

    if (!draft.success) return none;
    // Built from the pinned table, which holds drafts.get beside drafts.send.
    const { request } = yield* Effect.orDie(googleRequest('gmail.users.drafts.get', { userId: params['userId'] ?? 'me', id: draft.output.id, format: 'raw' }, undefined));
    const answer = yield* Effect.promise(() => deps.send(request));
    const kept = v.safeParse(v.object({ message: v.object({ raw: v.string() }) }), answer.status === 200 ? answer.body : null);

    // A draft that cannot be read is not sent on a guess of what it holds.
    if (!kept.success) return yield* new KinuError('unavailable', `The draft ${draft.output.id} could not be read to show its owner; send it again once it can be.`);

    const { raw } = kept.output.message;

    return { mail: yield* mailCardOf(deps, raw), content: sha256Hex(raw), sends: { id: draft.output.id, message: { raw } } };
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

      if (!(yield* Effect.promise(() => deps.held()))) return yield* new KinuError('denied', NOT_HELD);
      const { sends, ...seen } = yield* messageOf(deps, found, asked, body);
      const write: GoogleWrite = { by: deps.by(), method, does: found.method.d ?? method, params: asked, body: body ?? null, ...seen };
      // A draft goes as it was read and shown, never as whatever it holds by the time it is sent.
      const made = sends === undefined ? request : (yield* googleRequest(method, asked, sends)).request;
      const id = `google-${sha256Hex(googleWriteText(write), 32)}`;
      const verdict = deps.approvals.ask(id, write);

      if (verdict.outcome !== 'approved') return { status: verdict.outcome, approval: verdict.approval } as const;
      const spend = deps.approvals.take(id);

      // Approved a moment ago and taken since: another call of the same write went first.
      if (spend === null) return { status: 'asked' as const, approval: id };

      // Spent whatever Google answers: the request may have reached it, so the next call of it asks anew.
      const answer = yield* Effect.ensuring(sent(made), Effect.promise(async () => deps.approvals.settle(spend, 'spent')));

      return { status: 'done' as const, answer };
    })),
  ];
}

const NOT_HELD = 'Google is not connected to this account. Its owner connects it in Settings > MCP servers; then call again.';

/** `google.*` for an agent's programs. */
export function createGoogleCodemodeProvider(deps: GoogleDeps): CodemodeProvider {
  return codemodeNamespace('google', 'Gmail, Calendar, Drive, Docs, Sheets, Slides and contacts through the account\'s Google connection: search, describe, read; a write asks the owner.', serveGoogle(deps));
}
