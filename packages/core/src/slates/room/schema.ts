/**
 * A slate room's tables and the rows they hold, as the caretaker (`caretaker.ts`) reads and writes them. Ids and
 * generations come from `room.next`, which only grows: a grant's id is its generation, so a re-mint is a new grant.
 */
import * as v from 'valibot';
import type { RawSqlExec, SqlExecRow } from '../../types/primitives';
import { parseJsonValue, type JsonValue } from '../../utils/json';
import { CodecSchema, type Codec } from '../codec';
import type { Audience, Elem, Show, Tag } from './labels';

export function initSlateRoomTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    workspace TEXT NOT NULL,
    slate TEXT NOT NULL,
    title TEXT NOT NULL,
    link INTEGER NOT NULL,
    link_gen INTEGER NOT NULL,
    image TEXT,
    image_author TEXT,
    secret TEXT,
    source TEXT,
    foreign_code INTEGER NOT NULL,
    parent TEXT,
    next INTEGER NOT NULL
  )`);
  // Each image the slate was published at: its modules by content digest, as its workspace stores them, and the input
  // contract each function declares. Keyed by the image, so a run loads the very image it was admitted at.
  execRaw(`CREATE TABLE IF NOT EXISTS room_images (
    image TEXT PRIMARY KEY,
    modules TEXT NOT NULL,
    contracts TEXT NOT NULL
  )`);
  // name: a display copy, written when the person opens the slate; NULL while only invited.
  execRaw(`CREATE TABLE IF NOT EXISTS room_members (
    email TEXT PRIMARY KEY,
    name TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'edit', 'use', 'removed')),
    gen INTEGER NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS room_grants (
    id INTEGER PRIMARY KEY,
    holder TEXT NOT NULL,
    personal INTEGER NOT NULL,
    server TEXT NOT NULL,
    root TEXT NOT NULL,
    tools TEXT NOT NULL,
    fn TEXT NOT NULL,
    image TEXT NOT NULL,
    domain TEXT NOT NULL,
    effect INTEGER NOT NULL,
    sink TEXT NOT NULL
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS room_shows (
    id INTEGER PRIMARY KEY,
    holder TEXT NOT NULL,
    server TEXT NOT NULL,
    root TEXT NOT NULL,
    fn TEXT,
    images TEXT,
    audience TEXT NOT NULL
  )`);
  // A check is of one tag, the holder's read of the source included: what one person's connection reads of a source
  // need not be what another's does (`Model.Core.readers`).
  execRaw(`CREATE TABLE IF NOT EXISTS room_readers (
    email TEXT NOT NULL,
    holder TEXT NOT NULL,
    server TEXT NOT NULL,
    root TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (email, holder, server, root)
  )`);
  // Public state: what unlabelled runs post. It carries no label, so nothing labelled is ever written here.
  execRaw(`CREATE TABLE IF NOT EXISTS room_cells (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  // Each run's own output (the model's `Run.out`): allocated at its admission with its label, which never changes, and
  // written by that run alone. A part shows its newest run's output; an older run's late write lands in its own row.
  execRaw(`CREATE TABLE IF NOT EXISTS room_outputs (
    run INTEGER PRIMARY KEY,
    part TEXT NOT NULL,
    fn TEXT NOT NULL,
    input TEXT NOT NULL,
    requester TEXT,
    label TEXT NOT NULL,
    value TEXT,
    written INTEGER NOT NULL
  )`);
  execRaw('CREATE INDEX IF NOT EXISTS room_outputs_part ON room_outputs (part, run)');
  execRaw(`CREATE TABLE IF NOT EXISTS room_asks (
    asker TEXT NOT NULL,
    holder TEXT NOT NULL,
    server TEXT NOT NULL,
    root TEXT NOT NULL,
    fn TEXT NOT NULL,
    PRIMARY KEY (asker, holder, server, root, fn)
  )`);
  execRaw(`CREATE TABLE IF NOT EXISTS room_lend_uses (
    fn TEXT NOT NULL,
    email TEXT NOT NULL,
    calls INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    PRIMARY KEY (fn, email)
  )`);
  // The slate's Gallery listing while it is listed: its owner's words for it. Only while its link is on.
  execRaw(`CREATE TABLE IF NOT EXISTS room_listing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    line TEXT NOT NULL,
    category TEXT NOT NULL,
    listed_at INTEGER NOT NULL,
    picture TEXT
  )`);
}

const AudienceSchema = v.union([v.literal('anyone'), v.array(v.string())]);

const SecretSightingSchema = v.object({ file: v.string(), line: v.number(), kind: v.string() });

export type SecretSighting = v.InferOutput<typeof SecretSightingSchema>;

const RoomRow = v.object({
  workspace: v.string(), slate: v.string(), title: v.string(), link: v.number(), link_gen: v.number(), image: v.nullable(v.string()),
  modules: v.nullable(v.string()),
  image_author: v.nullable(v.string()), secret: v.nullable(v.string()), source: v.nullable(v.string()), foreign_code: v.number(), parent: v.nullable(v.string()),
  next: v.number(),
});

export interface RoomRecord {
  readonly workspace: string;
  readonly slate: string;
  /** The slate's title, from the image running: written with the image. */
  readonly title: string;
  readonly link: boolean;
  readonly linkGen: number;
  readonly image: string | null;
  /** The running image's modules, each by its content digest, as its workspace stores them. */
  readonly modules: Readonly<Record<string, string>> | null;
  readonly imageAuthor: string | null;
  readonly secret: SecretSighting | null;
  /** The version of the slate's files the image was built from: what a fork gets. Null for a page that has no files. */
  readonly source: string | null;
  /** Code by someone other than the owner has entered: no grant is implied by authorship from then on. */
  readonly foreign: boolean;
  readonly parent: string | null;
}

export function roomRecord(row: SqlExecRow): RoomRecord {
  const parsed = v.parse(RoomRow, row);

  return {
    workspace: parsed.workspace, slate: parsed.slate, title: parsed.title, link: parsed.link === 1, linkGen: parsed.link_gen,
    image: parsed.image, imageAuthor: parsed.image_author, modules: parsed.modules === null ? null : modulesOf(parsed.modules),
    secret: parsed.secret === null ? null : v.parse(SecretSightingSchema, JSON.parse(parsed.secret)), source: parsed.source,
    foreign: parsed.foreign_code === 1, parent: parsed.parent,
  };
}

export function modulesOf(text: string): Readonly<Record<string, string>> {
  return v.parse(v.record(v.string(), v.string()), JSON.parse(text));
}

export function contractsOf(text: string): Readonly<Record<string, Codec>> {
  return v.parse(v.record(v.string(), CodecSchema), JSON.parse(text));
}

const MemberRow = v.object({
  email: v.string(), name: v.nullable(v.string()), role: v.picklist(['owner', 'edit', 'use', 'removed'] as const), gen: v.number(),
});

export type RoomMember = v.InferOutput<typeof MemberRow>;

export function memberRow(row: SqlExecRow): RoomMember {
  return v.parse(MemberRow, row);
}

const GrantRow = v.object({
  id: v.number(), holder: v.string(), personal: v.number(), server: v.string(), root: v.string(), tools: v.string(),
  fn: v.string(), image: v.string(), domain: v.string(), effect: v.number(), sink: v.string(),
});

/**
 * A durable grant: a lend (`personal` false) or a person's own connection, bound to one function's image. Its id is
 * its generation: taking it back deletes it, and granting again makes a new one, so a run holding the old id stops.
 */
export interface Grant extends Tag {
  readonly id: number;
  readonly personal: boolean;
  readonly tools: readonly string[];
  readonly fn: string;
  readonly image: string;
  readonly domain: Codec;
  readonly effect: boolean;
  readonly sink: Audience;
}

export function grantRow(row: SqlExecRow): Grant {
  const parsed = v.parse(GrantRow, row);

  return {
    id: parsed.id, holder: parsed.holder, personal: parsed.personal === 1, server: parsed.server, root: parsed.root,
    tools: v.parse(v.array(v.string()), JSON.parse(parsed.tools)), fn: parsed.fn, image: parsed.image,
    domain: v.parse(CodecSchema, JSON.parse(parsed.domain)), effect: parsed.effect === 1, sink: v.parse(AudienceSchema, JSON.parse(parsed.sink)),
  };
}

const ShowRow = v.object({
  id: v.number(), holder: v.string(), server: v.string(), root: v.string(), fn: v.nullable(v.string()),
  images: v.nullable(v.string()), audience: v.string(),
});

export function showRow(row: SqlExecRow): Show {
  const parsed = v.parse(ShowRow, row);

  return {
    id: parsed.id, holder: parsed.holder, server: parsed.server, root: parsed.root, fn: parsed.fn,
    images: parsed.images === null ? null : v.parse(v.array(v.string()), JSON.parse(parsed.images)),
    audience: v.parse(AudienceSchema, JSON.parse(parsed.audience)),
  };
}

const ElemSchema = v.object({
  holder: v.string(), server: v.string(), root: v.string(), fn: v.string(), image: v.string(),
});

function elemsOf(text: string): Elem[] {
  return v.parse(v.array(ElemSchema), JSON.parse(text));
}

/** State as a run or a person reads it: public state (an empty label), or one run's output with the run's label. */
export interface Cell {
  readonly key: string;
  readonly label: readonly Elem[];
  /** Null until the run that owns the cell writes it. */
  readonly value: JsonValue;
}

const PublicRow = v.object({ key: v.string(), value: v.string() });

export function publicCell(row: SqlExecRow): Cell {
  const parsed = v.parse(PublicRow, row);

  return { key: parsed.key, label: [], value: parseJsonValue(parsed.value) };
}

const OutputRow = v.object({
  run: v.number(), part: v.string(), fn: v.string(), input: v.string(), requester: v.nullable(v.string()), label: v.string(),
  value: v.nullable(v.string()), written: v.number(),
});

/** One run's output: the part it belongs to, what it was asked, by whom, and what it wrote. */
export interface Output extends Cell {
  readonly run: number;
  readonly fn: string;
  readonly input: JsonValue;
  readonly requester: string | null;
  readonly written: boolean;
}

export function outputRow(row: SqlExecRow): Output {
  const parsed = v.parse(OutputRow, row);

  return {
    key: parsed.part, run: parsed.run, fn: parsed.fn, input: parseJsonValue(parsed.input), requester: parsed.requester,
    label: elemsOf(parsed.label), value: parsed.value === null ? null : parseJsonValue(parsed.value), written: parsed.written === 1,
  };
}
