/**
 * What a person brings into their account's memory besides a document they wrote: what another AI remembers of them
 * (asked with {@link ANOTHER_AI_PROMPT} and pasted back), and the data export ChatGPT or Claude makes of their
 * conversations. Read where the person is, in their browser: of an export only their own words cross, dated, oldest
 * first, so the one extractor reads them in time order and a later statement replaces an earlier one
 * (`account-import.ts`). Neither vendor documents its export; the shapes read here are the ones public parsers
 * describe (OpenAI community thread 403144, the llm-conversations-viewer format notes), and nothing else of a
 * conversation is read.
 */
import * as v from 'valibot';
import { KinuError, settle } from '../obs/index';
import { Effect } from 'effect';
import { PLATFORM_LIMITS } from '../platform-limits';
import { parseJsonValue, type JsonValue } from '../utils/json';
import { importPieces } from './account-import';
import { ZIP_SLICE_BYTES, zipEntryStream, type RangedSource } from '../utils/zip';

/** What the person asks another AI, whose answer they paste back as a document. */
export const ANOTHER_AI_PROMPT = [
  "I'm moving to a new assistant. List everything you remember about me: who I am, where I live and where I lived before,",
  'my work and projects, the people in my life, my preferences and how I like answers, and any standing instructions I',
  "gave you. One fact per line. Where you know when I told you, put the date first. Don't guess or add anything I didn't say.",
].join(' ');

/** One conversation of an export: its title, when it began, and the person's own messages in it, oldest first. */
interface OwnConversation {
  readonly title: string;
  readonly at: number;
  readonly said: readonly { readonly at: number; readonly text: string }[];
}

const Text = v.pipe(v.string(), v.trim());

/** A ChatGPT export's conversation: a tree of messages, read from the shown branch's end back to its root. */
const ChatGptConversationSchema = v.looseObject({
  title: v.optional(v.nullable(v.string())),
  create_time: v.optional(v.nullable(v.number())),
  current_node: v.optional(v.nullable(v.string())),
  mapping: v.record(v.string(), v.looseObject({
    parent: v.optional(v.nullable(v.string())),
    message: v.optional(v.nullable(v.looseObject({
      author: v.looseObject({ role: v.string() }),
      create_time: v.optional(v.nullable(v.number())),
      content: v.optional(v.nullable(v.looseObject({ parts: v.optional(v.array(v.unknown())) }))),
    }))),
  })),
});

/** A Claude export's conversation: its messages in order, each the person's (`human`) or the assistant's. */
const ClaudeConversationSchema = v.looseObject({
  name: v.optional(v.nullable(v.string())),
  created_at: v.optional(v.nullable(v.string())),
  chat_messages: v.array(v.looseObject({ sender: v.string(), text: v.optional(v.nullable(v.string())), created_at: v.optional(v.nullable(v.string())) })),
});

/** The person's words of one ChatGPT conversation: the branch they left it on, root to end. */
function chatGptOwn(conversation: v.InferOutput<typeof ChatGptConversationSchema>): OwnConversation {
  const started = (conversation.create_time ?? 0) * 1000;
  const said: { at: number; text: string }[] = [];
  const seen = new Set<string>();

  for (let id = conversation.current_node ?? null; id !== null && !seen.has(id); id = conversation.mapping[id]?.parent ?? null) {
    seen.add(id);
    const message = conversation.mapping[id]?.message;
    const text = (message?.content?.parts ?? []).filter((part): part is string => typeof part === 'string').join('\n').trim();

    if (message?.author.role === 'user' && text !== '') said.unshift({ at: (message.create_time ?? 0) * 1000 || started, text });
  }

  return { title: conversation.title ?? '', at: started, said };
}

function claudeOwn(conversation: v.InferOutput<typeof ClaudeConversationSchema>): OwnConversation {
  const started = Date.parse(conversation.created_at ?? '') || 0;

  const said = conversation.chat_messages.flatMap((message) => {
    const text = v.parse(Text, message.text ?? '');

    return message.sender === 'human' && text !== '' ? [{ at: Date.parse(message.created_at ?? '') || started, text }] : [];
  });

  return { title: conversation.name ?? '', at: started, said };
}

/** One element of an export's conversation list as the person's words, by whichever vendor's shape it has. */
function ownWordsOf(conversation: JsonValue): Effect.Effect<OwnConversation, KinuError> {
  const chatGpt = v.safeParse(ChatGptConversationSchema, conversation);

  if (chatGpt.success) return Effect.succeed(chatGptOwn(chatGpt.output));
  const claude = v.safeParse(ClaudeConversationSchema, conversation);

  if (claude.success) return Effect.succeed(claudeOwn(claude.output));

  return Effect.fail(new KinuError('bad_input',
    'This is not a ChatGPT or Claude export: its conversations.json should list conversations, each with a "mapping" of messages (ChatGPT) or "chat_messages" (Claude).'));
}

/** Splits a JSON array of objects into its elements' texts, a character at a time; anything else in the array, or an
 *  array that never closes, is refused, so a cut or foreign file is never read as part of an export. */
class ArrayItems {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private item = '';
  /** Between elements: what the next character may be. */
  private expect: 'open' | 'item' | 'item-or-close' | 'separator' | 'done' = 'open';

  /** The element `char` ends, if it ends one. */
  feed(char: string): Effect.Effect<string | null, KinuError> {
    if (this.depth >= 2) return Effect.succeed(this.inside(char));

    if (/\s/u.test(char)) return Effect.succeed(null);

    return this.between(char);
  }

  /** The array closed, whole. */
  finished(): Effect.Effect<void, KinuError> {
    return this.expect === 'done' ? Effect.void : Effect.fail(refused('it ends before its list of conversations does: the file is cut short'));
  }

  private between(char: string): Effect.Effect<null, KinuError> {
    if (this.expect === 'open' && char === '[') this.expect = 'item-or-close';
    else if (this.expect !== 'open' && this.expect !== 'separator' && this.expect !== 'done' && char === '{') {
      this.depth = 2;
      this.item = char;
    } else if (this.expect === 'item-or-close' && char === ']') this.expect = 'done';
    else if (this.expect === 'separator' && char === ',') this.expect = 'item';
    else if (this.expect === 'separator' && char === ']') this.expect = 'done';
    else return Effect.fail(refused(this.expect === 'open' ? 'it is not a list of conversations' : 'its list holds something other than conversations'));

    return Effect.succeed(null);
  }

  private inside(char: string): string | null {
    this.item += char;

    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (char === '\\') this.escaped = true;
      else if (char === '"') this.inString = false;
    } else if (char === '"') {
      this.inString = true;
    } else if (char === '{' || char === '[') {
      this.depth += 1;
    } else if (char === '}' || char === ']') {
      return this.closed();
    }

    return null;
  }

  private closed(): string | null {
    this.depth -= 1;

    if (this.depth !== 1) return null;
    const done = this.item;

    this.item = '';
    this.expect = 'separator';

    return done;
  }
}

const refused = (why: string): KinuError => new KinuError('bad_input', `This conversations.json cannot be read: ${why}.`);

/**
 * Each element of an export's list of conversations as the person's words, read from a stream of its text one
 * conversation at a time: what else a conversation holds (the assistant's answers) is never kept.
 */
function ownConversations(chunks: AsyncIterable<string>): Effect.Effect<OwnConversation[], KinuError> {
  return Effect.gen(function* () {
    const items = new ArrayItems();
    const conversations: OwnConversation[] = [];
    const iterator = chunks[Symbol.asyncIterator]();

    for (let next = yield* Effect.promise(() => iterator.next()); next.done !== true; next = yield* Effect.promise(() => iterator.next())) {
      for (const char of next.value) {
        const done = yield* items.feed(char);

        if (done === null) continue;
        const parsed = yield* Effect.try({ try: () => parseJsonValue(done), catch: (cause) => new KinuError('bad_input', 'conversations.json is not JSON', { cause }) });

        conversations.push(yield* ownWordsOf(parsed));
      }
    }

    yield* items.finished();

    return conversations;
  });
}

/** What an export becomes for the import: its pieces, and its scale for the person's preview. */
export interface ExportPieces {
  readonly pieces: readonly string[];
  readonly conversations: number;
  /** Conversations read: every one, unless their words passed what one import carries, when the newest are. */
  readonly read: number;
  readonly chars: number;
}

/** What one import carries to the account: one call's argument (`rpc.arg_bytes`), its pieces at four bytes a character
 *  at most (UTF-8). */
export const IMPORT_CARRIED_CHARS = PLATFORM_LIMITS['rpc.arg_bytes'].value / 4;

const day = (at: number): string => (at > 0 ? new Date(at).toISOString().slice(0, 10) : 'undated');

/**
 * The person's words of an export as pieces the extractor reads whole, in time order: the oldest conversation first
 * and each message dated. Where all of them pass what one import carries, the newest conversations are read, still
 * oldest first.
 */
function exportPieces(conversations: readonly OwnConversation[]): ExportPieces {
  const spoken = conversations.filter((conversation) => conversation.said.length > 0)
    .map((conversation) => ({
      conversation,
      text: [`## ${conversation.title.trim() || 'Untitled conversation'} (started ${day(conversation.at)})`,
        ...conversation.said.map((message) => `${day(message.at)}: ${message.text.replace(/\s+/gu, ' ')}`)].join('\n'),
    }))
    .sort((a, b) => a.conversation.at - b.conversation.at);

  const kept: string[] = [];
  let chars = 0;

  // Newest first while choosing, so a partial read keeps the latest; read back oldest first.
  for (const { text } of [...spoken].reverse()) {
    if (chars + text.length > IMPORT_CARRIED_CHARS) break;
    kept.unshift(text);
    chars += text.length;
  }

  // Short conversations share a piece, a conversation never split while it fits one: a call reads as much as it can.
  return { pieces: importPieces(kept.join('\n\n')), conversations: spoken.length, read: kept.length, chars };
}

/** An export's conversations, from its zip (`conversations.json` within it) or from that file itself. */
export function readExport(source: RangedSource, zipped: boolean): Promise<ExportPieces> {
  return settle(Effect.gen(function* () {
    const stream = zipped ? yield* zipEntryStream(source, (path) => path.split('/').at(-1) === 'conversations.json') : wholeStream(source);

    if (stream === null) return yield* new KinuError('bad_input', 'This archive holds no conversations.json: export your data from ChatGPT or Claude and choose the zip it sends.');
    const conversations = yield* ownConversations(textChunks(stream));

    return exportPieces(conversations);
  }));
}

async function* textChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();

  for (let read = await reader.read(); !read.done; read = await reader.read()) yield decoder.decode(read.value, { stream: true });
  yield decoder.decode();
}

function wholeStream(source: RangedSource): ReadableStream<Uint8Array> {
  let at = 0;

  return new ReadableStream({
    async pull(controller) {
      if (at >= source.size) {
        controller.close();

        return;
      }

      const length = Math.min(ZIP_SLICE_BYTES, source.size - at);

      controller.enqueue(await source.read(at, length));
      at += length;
    },
  });
}

