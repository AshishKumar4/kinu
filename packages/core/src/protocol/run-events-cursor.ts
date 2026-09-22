/**
 * The run-event stream's cursor: the one rule the SSE route and its tests
 * share, kept out of the route because the route reaches `agents` and
 * therefore `cloudflare:*`.
 */
/**
 * The event index an SSE reconnect resumes AFTER, from its `Last-Event-ID`.
 *
 * Lives beside the wire it is a cursor over, and not inside the route, because
 * the route reaches `agents` and therefore `cloudflare:*`: a subject nothing can
 * import is a subject a suite ends up re-implementing, and a re-implemented copy
 * asserts nothing about the shipped rule.
 *
 * `-1` is both the replay-from-the-start sentinel and the floor. Any other
 * negative, any fraction, and anything unparseable replays from the start rather
 * than seeking to a position no event can occupy — a NaN cursor compares false
 * against every index, so it would re-deliver the whole run on each reconnect.
 *
 * A BLANK header is absent, not zero. `Number('')` is 0, so a rule that trusts
 * it reads `Last-Event-ID:` with no value — what a client sends when its
 * last-event buffer is empty — as "I have seen event 0" and resumes AFTER it,
 * silently dropping the first event of the run. A test copy of this rule that
 * never exercises the empty string is how that survives unseen.
 */
export function resumeIndexFromLastEventId(lastEventId: string | null): number {
  if (lastEventId === null || lastEventId.trim() === '') return -1;
  const index = Number(lastEventId);

  return Number.isInteger(index) && index >= -1 ? index : -1;
}
