/**
 * Labels: where a value came from, and who it may reach. This is `Model.lean`'s release rule, over the room's rows.
 *
 * A tag is a source read through someone's authority: the holder whose grant read it, the service, and the scope the
 * grant is fixed to. A label lists tags with the function and image that read each first-hand. A value reaches a
 * person only if, for every element, they read the source directly (they are its holder, or a reader check found they
 * can) or a live show by the element's holder covers them (`flows`). Owning the slate, running a lend or writing its code
 * is no such authority.
 */

/** People are named by email throughout a room; `holder` is the email of the person whose connection read the source. */
export interface Tag {
  readonly holder: string;
  readonly server: string;
  /** The grant's fixed tool arguments as canonical JSON, `{}` for the whole service. */
  readonly root: string;
}

export interface Elem extends Tag {
  readonly fn: string;
  readonly image: string;
}

/** Everyone who can open the slate, or the people named. */
export type Audience = 'anyone' | readonly string[];

/** A holder's consent that values of their tag reach an audience: anything derived, or what one function computed at the
 *  listed images. The holder is the tag's: a row is only ever written by its holder (`RoomCaretaker.show`). */
export interface Show extends Tag {
  readonly id: number;
  readonly fn: string | null;
  readonly images: readonly string[] | null;
  readonly audience: Audience;
}

export interface LabelFacts {
  /** Whether a reader check found `email` reads the source directly. */
  reads(email: string, tag: Tag): boolean;
  readonly shows: readonly Show[];
}

export function sameTag(a: Tag, b: Tag): boolean {
  return a.holder === b.holder && a.server === b.server && a.root === b.root;
}

export function sameElem(a: Elem, b: Elem): boolean {
  return sameTag(a, b) && a.fn === b.fn && a.image === b.image;
}

export function covers(audience: Audience, email: string): boolean {
  return audience === 'anyone' || audience.includes(email);
}

/** A show that covers an element, whatever its audience. */
export function showsElem(show: Show, elem: Elem): boolean {
  return sameTag(show, elem) && (show.fn === null || (show.fn === elem.fn && (show.images ?? []).includes(elem.image)));
}

export function canRead(facts: LabelFacts, email: string, tag: Tag): boolean {
  return email === tag.holder || facts.reads(email, tag);
}

/** `Model.mayRead`. A visitor who has not signed in reads nobody's source and is covered only by shows to anyone. */
export function mayRead(facts: LabelFacts, email: string | null, elem: Elem): boolean {
  if (email !== null && canRead(facts, email, elem)) return true;

  return facts.shows.some((show) => showsElem(show, elem) && (email === null ? show.audience === 'anyone' : covers(show.audience, email)));
}

/** `Model.flows`: every element of the label may reach the person. */
export function flows(facts: LabelFacts, label: readonly Elem[], email: string | null): boolean {
  return label.every((elem) => mayRead(facts, email, elem));
}

/** `Model.audFlows`: every member of an audience may see the label; for anyone, each element's holder showed it to anyone. */
export function audienceFlows(facts: LabelFacts, label: readonly Elem[], audience: Audience): boolean {
  if (audience !== 'anyone') return audience.every((email) => flows(facts, label, email));

  return label.every((elem) => facts.shows.some((show) => showsElem(show, elem) && show.audience === 'anyone'));
}

/** The elements a person may not read, whose holders a placeholder asks (`Friction.toAsk`). */
export function hidden(facts: LabelFacts, label: readonly Elem[], email: string | null): Elem[] {
  return label.filter((elem) => !mayRead(facts, email, elem));
}

/** A label lists each element once, however often it arrived. */
export function dedup(label: readonly Elem[]): Elem[] {
  const kept: Elem[] = [];

  for (const elem of label) if (!kept.some((seen) => sameElem(seen, elem))) kept.push(elem);

  return kept;
}

/** Every element of `inner` is in `outer`: what a run may observe. */
export function within(inner: readonly Elem[], outer: readonly Elem[]): boolean {
  return inner.every((elem) => outer.some((each) => sameElem(each, elem)));
}

/** Who observes what a call through a grant sends: its holder, and its sink. */
export function observers(holder: string, sink: Audience): Audience {
  return sink === 'anyone' ? 'anyone' : [holder, ...sink.filter((email) => email !== holder)];
}

/** Canonical JSON for a grant's root: keys sorted, so equal roots compare equal as text. */
export function canonicalRoot(root: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(root).sort(([a], [b]) => a.localeCompare(b))));
}
