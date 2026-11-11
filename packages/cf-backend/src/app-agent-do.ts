/**
 * One app agent's conversation (core slates/app-agent.ts): an object of its own, named by `appAgentKey`, where its turns
 * run on its payer's model and its messages are kept, and nowhere else. Only the Worker's own code holds its stub: a
 * slate's host asks it, the payer's account ends it when they take their consent back, and its owner's workspace ends
 * it with its share, slate or workspace, and reads it for the owner where the owner lends the model, never otherwise.
 *
 * The payer's account is asked only for what it owns, once per ask: its word on the ask (consent, default model), each
 * provider's credential (`askCredentials`), and what the ask spent. A turn's steps and words never cross to it, but for
 * a provider its machine carries (Codex), whose every request crosses its device socket as it does everywhere.
 */
import { DurableObject } from 'cloudflare:workers';
import type { ModelMessage } from 'ai';
import {
  actorAffinity, ModelCatalogSession, objectNamed, ownerCaller, specModelInfo,
  type AccountSpend, type AuthResolution, type CredentialSummary, type JsonValue, type ModelCallReport, type UserCaller,
} from '@kinu.run/core';
import {
  appAgentKey, appAgentMessage, appAgentSystem, appAgentTranscript, appAgentTurn, fittedHistory,
  type AppAgentConversation, type AppAgentEntry, type AppAgentSession,
} from '@kinu.run/core/slates';
import { KinuError, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { createAgentProviderRegistry, userCredentials, type UserCredentialSource } from './providers/agent-registry';
import { accountNamed } from './user/workspace-placement';
import { recordSlateAi } from './user/slate-ai-account';

export interface AppAgentAskRequest {
  readonly conversation: AppAgentConversation;
  /** The app's revision now, which a visitor's consent names. */
  readonly revision: string;
  readonly text: string;
  readonly data?: JsonValue;
}

/** The reply as its text is written, or the payer's consent it waits for. */
export type AppAgentAnswer = { readonly kind: 'reply'; readonly reply: ReadableStream<Uint8Array> } | { readonly kind: 'needs-consent' };

/** Who pays for the conversation, written at its first ask: what its transcript's reader is held to. */
const PAYER_KEY = 'payer';

/** The next message's number. */
const NEXT_KEY = 'next';

/** Each message, under its number, so a listing reads them in order. */
const MESSAGE_PREFIX = 'm:';

function messageKey(at: number): string {
  return `${MESSAGE_PREFIX}${String(at).padStart(10, '0')}`;
}

/**
 * The payer's credentials for one ask: each provider's asked of their account once, as their listing; a renewal after a
 * provider refused one is asked again, and replaces it.
 */
function askCredentials(source: UserCredentialSource): UserCredentialSource {
  const auths = new Map<string, Promise<AuthResolution | null>>();
  let listed: Promise<CredentialSummary[]> | undefined;

  const asked = (key: string, held: Promise<AuthResolution | null>) => {
    auths.set(key, held);
    // A failed read is no credential: the next request asks again.
    held.catch(() => { if (auths.get(key) === held) auths.delete(key); });

    return held;
  };

  return {
    ...source,
    getAuth: async (key, opts) => (opts === undefined ? auths.get(key) ?? asked(key, source.getAuth(key)) : asked(key, source.getAuth(key, opts))),
    listCredentials: async () => {
      listed ??= source.listCredentials();

      return listed;
    },
  };
}

/** A session as Workers RPC hands it in: a stub, which goes with its call unless kept. */
interface SessionStub {
  dup(): AppAgentSession & Disposable;
}

function isStub(session: AppAgentSession): session is AppAgentSession & SessionStub {
  return 'dup' in session && typeof session.dup === 'function';
}

/** An ask's session kept for its turn, and how it is let go once the turn ends. */
interface HeldSession {
  readonly session: AppAgentSession;
  readonly release: () => void;
}

/** The ask's session kept for its turn, which outlives the ask's call. */
function heldSession(session: AppAgentSession): HeldSession {
  if (!isStub(session)) return { session, release: () => {} };
  const held = session.dup();

  return { session: held, release: () => { held[Symbol.dispose](); } };
}

function messagesOf(storage: DurableObjectStorage): ModelMessage[] {
  return [...storage.kv.list<ModelMessage>({ prefix: MESSAGE_PREFIX })].map(([, message]) => message);
}

/** Messages appended in one write, each under the next number. */
function keep(storage: DurableObjectStorage, messages: readonly ModelMessage[]): void {
  storage.transactionSync(() => {
    let next = storage.kv.get<number>(NEXT_KEY) ?? 0;

    for (const message of messages) {
      storage.kv.put(messageKey(next), message);
      next += 1;
    }

    storage.kv.put(NEXT_KEY, next);
  });
}

/**
 * One turn of the conversation `storage` keeps, on the model its payer's account named for it: the person's message,
 * each step admitted by the session first, its spend told to the share it was lent on and kept in the payer's account.
 */
async function turnOf(env: Env, storage: DurableObjectStorage, input: {
  readonly conversation: AppAgentConversation;
  readonly caller: UserCaller;
  readonly grant: { readonly spec: string; readonly tier: string };
  readonly request: AppAgentAskRequest;
  readonly session: AppAgentSession;
  readonly signal: AbortSignal;
  readonly write: (text: string) => void;
}): Promise<void> {
  const { conversation, caller, session } = input;
  const { payer, workspace } = conversation;
  const account = accountNamed(env.UserDO, payer.userId);
  const registry = createAgentProviderRegistry({ env, userDO: askCredentials(userCredentials(() => account, caller)), appTitle: 'Kinu' });
  const spec = registry.normalizeSpecSync(input.grant.spec);
  const pricing = new ModelCatalogSession({ effectiveSpec: () => spec, lookup: async (named) => specModelInfo(registry.registry, registry.deps, named), measured: () => null });
  const spends: AccountSpend[] = [];
  const reports: ModelCallReport[] = [];

  const record = (report: ModelCallReport): void => {
    recordSlateAi({ env, spent: (spend) => { spends.push(spend); } }, workspace, report, pricing);
    reports.push(report);
  };

  // A step's spend is told to the share it was lent on before the next step is admitted, so the share's day bounds it.
  const told = async (): Promise<void> => {
    for (const report of reports.splice(0)) await session.spent(report.usage);
  };

  const [about] = await Promise.all([session.about(), pricing.warm([spec])]);
  const system = appAgentSystem(about);

  try {
    await appAgentTurn({
      model: registry.resolveModel(spec, actorAffinity({ name: `app-agent:${appAgentKey(conversation)}`, workspaceId: workspace })), spec, system,
      history: fittedHistory(messagesOf(storage), pricing.window(spec).contextWindow, system),
      asked: appAgentMessage(input.request.text, input.request.data),
      session: {
        about: async () => about,
        call: async (method, args) => session.call(method, args),
        spent: async (usage) => session.spent(usage),
        admit: async () => { await told(); await session.admit(); },
      },
      signal: input.signal,
      spend: { source: 'slate', report: record, operations: () => {} },
      write: input.write,
      keep: (messages) => { keep(storage, messages); },
    });
    await told();
  } finally {
    if (spends.length > 0) await account.appAgentSpent(caller, spends);
  }
}

/** The object `conversation` is kept in. */
export function appAgentObject(env: Pick<Env, 'APP_AGENT'>, conversation: AppAgentConversation): DurableObjectStub<AppAgentDO> {
  return objectNamed(env.APP_AGENT, appAgentKey(conversation));
}

export class AppAgentDO extends DurableObject<Env> {
  /** The conversation's turns, one at a time: a second ask waits for the first to end. */
  private turns: Promise<void> = Promise.resolve();
  /** Every ask not yet ended, running or waiting its turn. */
  private readonly running = new Set<AbortController>();

  /** One ask: the payer's account's word on it, then the turn, its reply streamed as it is written. */
  async ask(request: AppAgentAskRequest, session: AppAgentSession): Promise<AppAgentAnswer> {
    const { conversation } = request;
    const { payer, workspace, slate } = conversation;
    const caller = await ownerCaller(this.env);
    const account = accountNamed(this.env.UserDO, payer.userId);
    const grant = await account.appAgentGrant(caller, { workspace, slate, revision: request.revision, visitor: payer.kind === 'own' });

    if (grant.kind === 'needs-consent') return { kind: 'needs-consent' };
    // The object's name holds the payer's kind, so this only ever writes what it already holds.
    this.ctx.storage.kv.put(PAYER_KEY, payer.kind);
    const stop = new AbortController();
    const held = heldSession(session);
    const encoder = new TextEncoder();

    // Held from the ask, not the turn: an end while it waits for the turn before it stops it too.
    this.running.add(stop);

    const reply = new ReadableStream<Uint8Array>({
      start: (stream) => {
        const turn = async () => {
          try {
            stop.signal.throwIfAborted();
            await turnOf(this.env, this.ctx.storage, { conversation, caller, grant, request, session: held.session, signal: stop.signal, write: (text) => { stream.enqueue(encoder.encode(text)); } });
            stream.close();
          } catch (cause) {
            stream.error(cause);
          } finally {
            this.running.delete(stop);
            held.release();
          }
        };

        this.turns = this.turns.then(turn, turn);
      },
      // The asker went away (a page closed, a share ended): the model call stops where it is.
      cancel: () => { stop.abort(new KinuError('denied', 'The ask was let go')); },
    });

    return { kind: 'reply', reply };
  }

  /** What the share it was asked on no longer lends stops now, running or waiting its turn; what was said stays. */
  stop(): void {
    for (const stop of this.running) stop.abort(new KinuError('denied', 'This app is no longer shared this way'));
  }

  /** The conversation ends: what runs stops, and every message goes. */
  async end(): Promise<void> {
    this.stop();
    await this.turns;
    await this.ctx.storage.deleteAll();
  }

  /** The conversation for the owner who lent its model; one on its visitor's own models is no one else's to read. */
  transcript(): AppAgentEntry[] {
    const payer = this.ctx.storage.kv.get(PAYER_KEY);

    if (payer === undefined) return [];

    if (payer !== 'lent') return settleSync(Effect.fail(new KinuError('denied', 'This conversation is its visitor\'s alone')));

    return appAgentTranscript(messagesOf(this.ctx.storage));
  }
}
