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
import type { LanguageModel, ModelMessage } from 'ai';
import {
  actorAffinity, DynamicContextLedger, ExtensionHost, ModelCatalogSession, ownerCaller, parseModelSpec, runAppAgentTurn, specModelInfo,
  type AccountSpend, type AuthResolution, type CredentialSummary, type JsonValue, type ModelCallReport, type Usage, type UserCaller,
} from '@kinu.run/core';
import {
  appAgentKey, appAgentMessage, appAgentSystem, appAgentTranscript,
  type AppAgentConversation, type AppAgentEntry, type AppAgentModel, type AppAgentSession,
} from '@kinu.run/core/slates';
import { attemptInItsWords, KinuError, settle, settleSync } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import {
  compactionDiagnostics, compactionTranscriptPath, createCompactionExtension, createModelSummarizer,
  type ArchiveIndexStore, type ArchiveRange, type CompactionExtensionDeps,
} from '@kinu.run/compaction';
import { createAgentProviderRegistry, routedModelReads, userCredentials, type UserCredentialSource } from './providers/agent-registry';
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

/** The conversation's name to the chat loop's compaction, the same in every object. */
const APP_AGENT_CONVERSATION = 'app-agent';

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
  const auths = new Map<string, AuthResolution | null>();
  let listed: CredentialSummary[] | undefined;

  return {
    ...source,
    getAuth: async (key, opts) => {
      const held = opts === undefined ? auths.get(key) : undefined;

      if (held !== undefined) return held;
      const auth = await source.getAuth(key, opts);

      auths.set(key, auth);

      return auth;
    },
    listCredentials: async () => {
      listed ??= await source.listCredentials();

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

/** Where compaction keeps a conversation's plan, archive index and folded transcripts: the conversation's own object. */
const PLAN_PREFIX = 'c:plan:';

const ARCHIVE_PREFIX = 'c:archive:';

const TRANSCRIPT_PREFIX = 'c:transcript:';

/**
 * The compaction every agent's turn runs (`@kinu.run/compaction`), its stores this conversation's own: an app agent has
 * no files of its own, and its chat carries none to move, since the app answers it JSON alone.
 */
function conversationCompaction(storage: DurableObjectStorage, summarizer: { readonly model: () => LanguageModel; readonly spec: string; readonly report: (report: ModelCallReport) => void }): ExtensionHost {
  const archive: ArchiveIndexStore = {
    list: (sessionKey) => storage.kv.get<ArchiveRange[]>(`${ARCHIVE_PREFIX}${sessionKey}`) ?? [],
    append: (sessionKey, range) => {
      const held = storage.kv.get<ArchiveRange[]>(`${ARCHIVE_PREFIX}${sessionKey}`) ?? [];

      if (!held.some((each) => each.rangeHash === range.rangeHash)) storage.kv.put(`${ARCHIVE_PREFIX}${sessionKey}`, [...held, range]);
    },
    clear: (sessionKey) => { storage.kv.delete(`${ARCHIVE_PREFIX}${sessionKey}`); },
  };

  const plans: CompactionExtensionDeps['ports']['plans'] = {
    load: (sessionKey) => storage.kv.get(`${PLAN_PREFIX}${sessionKey}`) ?? null,
    save: (sessionKey, snapshot) => {
      if (snapshot === null) storage.kv.delete(`${PLAN_PREFIX}${sessionKey}`);
      else storage.kv.put(`${PLAN_PREFIX}${sessionKey}`, snapshot);
    },
  };

  const transcripts: CompactionExtensionDeps['ports']['transcripts'] = {
    citablePath: compactionTranscriptPath,
    write: async (relativePath, content) => {
      storage.kv.put(`${TRANSCRIPT_PREFIX}${relativePath}`, content);

      return { absolutePath: relativePath };
    },
  };

  return new ExtensionHost().register(createCompactionExtension({
    ports: { transcripts, plans, logger: compactionDiagnostics },
    archive,
    summarize: createModelSummarizer(summarizer.model, { source: 'compaction', report: summarizer.report }, () => summarizer.spec),
    ephemeral: new DynamicContextLedger(),
    attachments: { files: () => null },
  }));
}

/**
 * One turn of the conversation `storage` keeps, on the model its payer's account named for it, through the chat loop
 * every agent's turn runs (core orchestrator/app-agent-turn.ts); its spend kept in the payer's account once it ends.
 */
async function turnOf(env: Env, storage: DurableObjectStorage, input: {
  readonly conversation: AppAgentConversation;
  readonly caller: UserCaller;
  readonly grant: AppAgentModel;
  readonly request: AppAgentAskRequest;
  readonly session: AppAgentSession;
  readonly signal: AbortSignal;
  readonly write: (text: string) => void;
}): Promise<void> {
  const { conversation, caller, grant, session } = input;
  const { payer, workspace } = conversation;
  const account = accountNamed(env.UserDO, payer.userId);
  const registry = createAgentProviderRegistry({ env, userDO: askCredentials(userCredentials(() => account, caller)), appTitle: 'Kinu' });
  const key = appAgentKey(conversation);
  const affinity = actorAffinity({ name: `app-agent:${key}`, workspaceId: workspace });
  const spec = registry.normalizeSpecSync(grant.spec);
  const fallbacks = grant.fallbacks.map((fallback) => ({ ...fallback, spec: registry.normalizeSpecSync(fallback.model) }));
  const pricing = new ModelCatalogSession({ effectiveSpec: () => spec, lookup: async (named) => specModelInfo(registry.registry, registry.deps, named), measured: () => null });
  const spends: AccountSpend[] = [];

  const report = (call: ModelCallReport): void => {
    recordSlateAi({ env, spent: (spend) => { spends.push(spend); } }, workspace, call, pricing);
  };

  // A fold's summary is the payer's model too: told to the share it was lent on before the next step is admitted.
  const folded: Usage[] = [];

  const told: AppAgentSession = {
    about: async () => session.about(),
    call: async (method, args) => session.call(method, args),
    spent: async (usage) => session.spent(usage),
    admit: async () => {
      for (const usage of folded.splice(0)) await session.spent(usage);
      await session.admit();
    },
  };

  const [about] = await Promise.all([session.about(), pricing.warm([spec, ...fallbacks.map((fallback) => fallback.spec)])]);
  const model = registry.resolveModel(spec, affinity);
  const routed = routedModelReads(registry);

  try {
    await runAppAgentTurn({
      chat: {
        model, modelSpec: spec, modelContext: { ...await pricing.contextFor(spec), provider: parseModelSpec(spec).provider },
        retries: grant.retries,
        ...(grant.reasoning !== null && { reasoning: grant.reasoning }),
        fallbacks: fallbacks.map((fallback) => ({
          spec: fallback.spec, accepts: pricing.acceptedMedia(fallback.spec), window: pricing.window(fallback.spec),
          bind: () => ({ model: registry.resolveModel(fallback.spec, affinity), provider: parseModelSpec(fallback.spec).provider, ...(fallback.reasoning !== null && { reasoning: fallback.reasoning }) }),
        })),
        attemptOf: async (served) => routed.attemptFor(served),
        countInputTokens: async (counted) => routed.countInputTokens(spec, counted),
        extensions: conversationCompaction(storage, { model: () => model, spec, report: (call) => { report(call); folded.push(call.usage); } }),
        // One object is one conversation: what compaction names it by need tell the model nothing of whose it is.
        conversationKey: APP_AGENT_CONVERSATION,
        signal: input.signal,
      },
      system: appAgentSystem(about),
      history: messagesOf(storage),
      asked: appAgentMessage(input.request.text, input.request.data),
      session: told,
      keep: (messages) => { keep(storage, messages); },
      write: input.write,
      report,
    });
  } finally {
    if (spends.length > 0) await account.appAgentSpent(caller, spends);
  }
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
    const stop = new AbortController();

    const caller = await ownerCaller(this.env);
    const account = accountNamed(this.env.UserDO, payer.userId);

    // Held from here: an end while its payer's account weighs it, or while it waits its turn, stops it.
    this.running.add(stop);

    const grant = await account.appAgentGrant(caller, { workspace, slate, revision: request.revision, visitor: payer.kind === 'own' })
      .finally(() => { this.running.delete(stop); });

    if (grant.kind === 'needs-consent') return { kind: 'needs-consent' };

    if (stop.signal.aborted) return settleSync(Effect.fail(new KinuError('denied', 'This conversation ended while it was asked')));
    this.running.add(stop);

    // Written once: the object's name holds the payer's kind, so no later ask could name another.
    if (this.ctx.storage.kv.get(PAYER_KEY) === undefined) this.ctx.storage.kv.put(PAYER_KEY, payer.kind);
    const held = heldSession(session);
    const encoder = new TextEncoder();

    const reply = new ReadableStream<Uint8Array>({
      start: (stream) => {
        // Never fails: a turn's failure errors its reply (a no-op once its reader let it go, where closing would throw),
        // and the next ask's turn starts after it all the same.
        this.turns = this.turns.then(async () => settle(Effect.ensuring(
          Effect.match(attemptInItsWords('io', async () => {
            stop.signal.throwIfAborted();
            await turnOf(this.env, this.ctx.storage, { conversation, caller, grant, request, session: held.session, signal: stop.signal, write: (text) => { stream.enqueue(encoder.encode(text)); } });
            stream.close();
          }), { onFailure: (failure) => { stream.error(failure); }, onSuccess: () => {} }),
          Effect.sync(() => {
            this.running.delete(stop);
            held.release();
          }),
        )));
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
