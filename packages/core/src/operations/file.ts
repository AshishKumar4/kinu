/** The workspace's files: read, edit, write, list, stat, search, and which machine a path is on. */
import * as v from 'valibot';
import { ImageCarrierSchema } from '../types/tool-images';
import { described, namespace } from './operation';
import { FILE_READ_LINE_CHARS, FILE_READ_LINES, FILE_READ_MAX_CHARS } from '../types/file-edits';

const Path = described(v.pipe(v.string(), v.trim(), v.nonEmpty()), 'Relative paths resolve at the workspace root.');

const Lines = (text: string) => v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(1)), text));

const Truncated = v.optional(described(v.strictObject({ shown: v.number(), total: v.number() }), 'Present when not all of it is shown.'));

const ListTruncated = v.optional(described(v.strictObject({ shown: v.number(), total: v.number(), next: v.number() }),
  'Present when not all of it is shown; `next` is the offset that continues the listing.'));

/** A write into a slate's directory: whether the slate builds now, in the compiler's words when it does not. */
export const SlateBuildNoteSchema = described(v.strictObject({ slate: v.string(), builds: v.boolean(), error: v.optional(v.string()) }),
  'A write under /slates/<id>/: whether that slate still builds. One that does not keeps showing its last working version.');

const Written = {
  path: v.string(), reference: described(v.string(), 'The file as results name it, root://path.'), undo: v.optional(described(v.string(), 'Why undo cannot restore this change.')),
  checked: described(v.picklist(['revision', 'digest', 'digest-remote']),
    'What made sure no newer write was lost: the revision you read (0 for a new file), or the content you read (digest-remote: compared a round trip before the write).'),
  build: v.optional(SlateBuildNoteSchema),
};

/** One replacement. The input format may change; every other operation reads files as they are. */
const FileEditSchema = v.strictObject({
  old_text: described(v.string(), 'Text copied exactly from the file, with enough context to occur once: from a read, the text after each line\'s number and tab.'),
  new_text: described(v.string(), 'The replacement; empty deletes.'),
});

/** How a whole file's content is given: as text, or as base64 of its bytes, which a file that is not UTF-8 text keeps. */
const Encoding = v.optional(described(v.picklist(['utf8', 'base64']), 'utf8 (the default) as text; base64, the file\'s bytes exactly, for a file that is not text.'));

/** Interpolated, so the help states the window the executor shows. */
const READ_WINDOW = `${String(FILE_READ_LINES)} lines or ${String(FILE_READ_MAX_CHARS)} characters, whichever ends first`;

const fileOp = namespace('file', { slate: true });

export const FILE = {
  read: fileOp({
    name: 'read',
    help: `A text file, up to ${READ_WINDOW}, each line as its number, a tab, then the line; a line past ${String(FILE_READ_LINE_CHARS)} characters is cut, with how much follows. A footer names the lines shown and their total, and the offset that continues a read that stopped early. An image is shown to you.`,
    impact: 'observe',
    input: v.strictObject({ path: Path, offset: Lines('The first line, 1-indexed; default 1.'), limit: Lines(`Lines to return; default ${String(FILE_READ_LINES)}.`) }),
    output: v.union([v.string(), ImageCarrierSchema]),
  }),
  text: fileOp({
    name: 'text', tool: false,
    help: 'A file whole, as a string, with no line numbers and nothing cut; a later write or edit counts it as read in full. For a program, which holds the value: the file tool reads a window.',
    impact: 'observe',
    input: v.strictObject({ path: Path, encoding: Encoding }),
    output: v.string(),
  }),
  edit: fileOp({
    name: 'edit',
    help: 'Replace text in a file you have read since the conversation was last compacted, every edit applied together or none; refused when the file changed since.',
    impact: 'mutate',
    input: v.strictObject({ path: Path, edits: described(v.pipe(v.array(FileEditSchema), v.minLength(1)), 'Matched against the file as last read.') }),
    output: v.strictObject({ ...Written, applied: v.array(v.strictObject({ line: v.number(), removedLines: v.number(), addedLines: v.number() })) }),
  }),
  write: fileOp({
    name: 'write',
    help: 'Create a file, or replace one you have read whole.',
    impact: 'mutate',
    input: v.strictObject({ path: Path, content: v.string(), encoding: Encoding }),
    output: v.strictObject({ ...Written, bytes: v.number(), action: v.picklist(['created', 'replaced']) }),
  }),
  list: fileOp({
    name: 'list',
    help: "A directory's entries, a page at a time.",
    impact: 'observe',
    input: v.strictObject({ path: Path, offset: v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(0)), 'The first entry, 0-indexed; default 0.')) }),
    output: v.strictObject({ path: v.string(), entries: v.array(v.string()), truncated: ListTruncated }),
  }),
  stat: fileOp({
    name: 'stat',
    help: "A path's size, modification time and kind.",
    impact: 'observe',
    input: v.strictObject({ path: Path }),
    output: v.strictObject({ path: v.string(), size: v.number(), mtimeMs: v.number(), isDir: v.boolean() }),
  }),
  search: fileOp({
    name: 'search',
    help: 'The lines of a file containing literal text, with their numbers.',
    impact: 'observe',
    input: v.strictObject({ path: Path, query: v.pipe(v.string(), v.nonEmpty()) }),
    output: v.strictObject({ path: v.string(), matches: v.array(v.strictObject({ line: v.number(), text: v.string() })), truncated: Truncated }),
  }),
  machine: fileOp({
    name: 'machine', tool: false,
    help: 'Which machine a path is on, and the path there: a command whose cwd it is runs on that machine.',
    impact: 'observe',
    input: v.strictObject({ path: Path }),
    output: v.strictObject({
      machine: v.picklist(['workspace', 'computer', 'device']), device: v.optional(described(v.string(), 'Which device, on `device`.')), path: v.string(),
    }),
  }),
} as const;
