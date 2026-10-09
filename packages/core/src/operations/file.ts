/** The workspace's files: read, edit, write, list, stat and search. */
import * as v from 'valibot';
import { ImageCarrierSchema } from '../types/tool-images';
import { defineOperation, type Operation } from './operation';
import { FILE_READ_LINE_CHARS, FILE_READ_LINES, FILE_READ_MAX_CHARS } from '../types/file-edits';

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const Path = described(v.pipe(v.string(), v.trim(), v.nonEmpty()), 'Relative paths resolve at the workspace root.');

const Lines = (text: string) => v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(1)), text));

const Truncated = v.optional(described(v.strictObject({ shown: v.number(), total: v.number() }), 'Present when not all of it is shown.'));

/** A write into a slate's directory: whether the slate builds now, in the compiler's words when it does not. */
export const SlateBuildNoteSchema = described(v.strictObject({ slate: v.string(), builds: v.boolean(), error: v.optional(v.string()) }),
  'A write under /slates/<id>/: whether that slate still builds. One that does not keeps showing its last working version.');

const Written = {
  path: v.string(), reference: described(v.string(), 'The file as results name it, root://path.'), undo: v.optional(described(v.string(), 'Why undo cannot restore this change.')),
  build: v.optional(SlateBuildNoteSchema),
};

/** One replacement. The input format may change; every other operation reads files as they are. */
const FileEditSchema = v.strictObject({
  old_text: described(v.string(), 'Text copied exactly from the file, with enough context to occur once: from a read, the text after each line\'s number and tab.'),
  new_text: described(v.string(), 'The replacement; empty deletes.'),
});

/** Interpolated, so the help states the window the executor shows. */
const READ_WINDOW = `${String(FILE_READ_LINES)} lines or ${String(FILE_READ_MAX_CHARS)} characters, whichever ends first`;

const fileOp = <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'impact' | 'input' | 'output'>,
) => defineOperation({ ns: 'file', slate: true, ...op });

export const FILE = {
  read: fileOp({
    name: 'read',
    help: `A text file, up to ${READ_WINDOW}, each line as its number, a tab, then the line; a line past ${String(FILE_READ_LINE_CHARS)} characters is cut, with how much follows. A footer names the lines shown and their total, and the offset that continues a read that stopped early. An image is shown to you.`,
    impact: 'observe',
    input: v.strictObject({ path: Path, offset: Lines('The first line, 1-indexed; default 1.'), limit: Lines(`Lines to return; default ${String(FILE_READ_LINES)}.`) }),
    output: v.union([v.string(), ImageCarrierSchema]),
  }),
  edit: fileOp({
    name: 'edit',
    help: 'Replace text in a file you have read, every edit applied together or none; refused when the file changed since.',
    impact: 'mutate',
    input: v.strictObject({ path: Path, edits: described(v.pipe(v.array(FileEditSchema), v.minLength(1)), 'Matched against the file as last read.') }),
    output: v.strictObject({ ...Written, applied: v.array(v.strictObject({ line: v.number(), removedLines: v.number(), addedLines: v.number() })) }),
  }),
  write: fileOp({
    name: 'write',
    help: 'Create a file, or replace one you have read whole.',
    impact: 'mutate',
    input: v.strictObject({ path: Path, content: v.string() }),
    output: v.strictObject({ ...Written, bytes: v.number(), action: v.picklist(['created', 'replaced']) }),
  }),
  list: fileOp({
    name: 'list',
    help: "A directory's entries.",
    impact: 'observe',
    input: v.strictObject({ path: Path }),
    output: v.strictObject({ path: v.string(), entries: v.array(v.string()), truncated: Truncated }),
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
} as const;
