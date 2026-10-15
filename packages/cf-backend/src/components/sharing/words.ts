/**
 * The sentences sharing says, built from the facts the room gives (room-api.ts; docs/SLATE-SHARING-SECURITY.md §6):
 * a grant's service, its tools, its scope, whether it acts. One place, so the sheet, a part and an ask say the same
 * thing the same way. Hosted only, so locked in `capability-parity.lock.json`: rooms live in the cf worker, and the
 * local CLI has no slate to share.
 */
import type { GalleryCategory, RoomPerson, RoomReach, RoomSource, RoomTool } from "@kinu.run/core";

export const CATEGORY_WORDS: Record<GalleryCategory, string> = { work: "Work", money: "Money", home: "Home", developer: "Developer", fun: "Fun" };

/** A person as others see them: their name once they have opened the slate, else the email they were invited at. */
export const nameOf = (person: RoomPerson) => person.name ?? person.email;

/** A first name, as presence, asks and placeholders use it. */
export const firstName = (person: RoomPerson) => {
  const name = nameOf(person);

  return person.name === null ? name : name.trim().split(/\s+/u)[0] ?? name;
};

/** "acme-metrics", or "acme-metrics deploys" when the grant is bound to a scope inside it. */
const reached = (reach: RoomReach) => (reach.scope === null ? reach.service.title : `${reach.service.title} ${reach.scope}`);

/** A tool's title in the middle of a sentence: "Start deploy job" becomes "start deploy job". */
const midSentence = (title: string) => (title.length === 0 ? title : `${title[0]?.toLowerCase() ?? ""}${title.slice(1)}`);

/** The first tool of a grant that changes something; none for a grant that only reads. */
const acting = (tools: readonly RoomTool[]) => tools.find((tool) => !tool.readOnly);

/** What a lend does, after its function's name: "reads acme-metrics deploys", or "start deploy job on acme-ci". */
export function reachOf(reach: RoomReach): string {
  const tool = acting(reach.tools);

  if (!reach.effect || tool === undefined) return `reads ${reached(reach)}`;

  return `${midSentence(tool.title)} on ${reached(reach)}`;
}

/** What the grant ask says a slate may do with a person's own connection. */
export function canOf(reach: RoomReach): string {
  const tools = reach.tools.filter((tool) => !tool.readOnly);
  const what = reach.scope === null ? `your ${reach.service.title}` : `${reach.scope} in your ${reach.service.title}`;

  if (!reach.effect || tools.length === 0) return `Read ${what}`;

  return `Read and ${names(tools.map((tool) => midSentence(tool.title)))} in ${what}`;
}

/** What it may not, always: anything else of theirs. */
export function cannotOf(reach: RoomReach): string {
  return reach.effect
    ? "Reach your other servers, files or memory"
    : "Change anything, or reach your other servers, files or memory";
}

/** What the grant ask asks for, finishing "Let <slate> …": "read your Linear", "use your GitHub". */
export function askOf(reach: RoomReach): string {
  const what = reach.scope === null ? `your ${reach.service.title}` : `${reach.scope} in your ${reach.service.title}`;

  return reach.effect ? `use ${what}` : `read ${what}`;
}

/** "Sam", "Sam and Alice", "Sam, Alice and Ben". */
export function names(people: readonly string[]): string {
  if (people.length <= 1) return people[0] ?? "";

  return `${people.slice(0, -1).join(", ")} and ${people.at(-1) ?? ""}`;
}

/** "Alice's and Ben's", whose private items stay hidden from link visitors. */
export const possessives = (people: readonly RoomPerson[]) => names(people.map((person) => `${firstName(person)}'s`));

/** The holders of the sources a part hides, once each, by first name. */
export function holdersOf(sources: readonly RoomSource[]): string[] {
  return [...new Set(sources.map((source) => firstName(source.holder)))];
}

/** Where a part's data comes from, once each: "acme/secret", "notes.md and acme/secret". */
export const sourcesOf = (sources: readonly RoomSource[]) => names([...new Set(sources.map((source) => source.label))]);

/** How long ago, as a row has room for: "now", "5m ago", "2h ago", "yesterday", "3 days ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  if (minutes < 1) return "now";

  if (minutes < 60) return `${String(minutes)}m ago`;

  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${String(hours)}h ago`;

  const days = Math.floor(hours / 24);

  return days === 1 ? "yesterday" : `${String(days)} days ago`;
}
