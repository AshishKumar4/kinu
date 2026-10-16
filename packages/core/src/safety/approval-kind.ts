/**
 * What a parked action is, read off the row it parks as: the one place its text is decoded. A deferred approval
 * (deferred-approval.ts) keeps one `command` column, and each kind of action names itself there exactly enough that
 * an approval answers that action and no other:
 *
 * - `command`: a command an agent asked to run, as it asked it.
 * - `write`: a file write an agent asked to make, naming the bytes it would write and the bytes it would replace
 *   (bound-write.ts).
 * - `slate-effect`: a call a shared slate's server made with its owner's access (docs/SLATE-SHARING-NIMBUS.md §2,
 *   `owner` mode), naming the share, the slate's revision, the tool and its exact payload, and the viewer it ran for.
 *   It is bound to its share as a command is to its machine (`executor` = {@link slateEffectExecutor}), which no machine
 *   is named, so a command whose words merely read like one stays a command. Its own run takes the approval; no agent
 *   is waiting on it.
 *
 * Every reader switches on {@link ApprovalKind}; none reads the text itself.
 */
import * as v from 'valibot';
import type { JsonValue } from '../utils/json';
import { stableStringify } from './argument-digest';

/** A parked write, by the digests of the bytes it would write and of those it would replace. */
export interface BoundFileWrite {
  readonly path: string;
  readonly next: string;
  readonly current: string;
}

/** A call a shared slate's server made with its owner's access, exactly as the owner is asked to approve it. */
export interface SlateEffect {
  readonly share: string;
  readonly slate: string;
  /** The slate's revision the call ran at: an approval of it never admits the call against other code. */
  readonly revision: string;
  readonly server: string;
  readonly tool: string;
  readonly root: Readonly<Record<string, string>>;
  readonly payload: JsonValue;
  /** Who the call ran for: shown to the owner. */
  readonly viewer: string;
}

export type ApprovalKind =
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'write'; readonly write: BoundFileWrite }
  | { readonly kind: 'slate-effect'; readonly effect: SlateEffect };

const BOUND_WRITE = /^file write (.+) sha256:([0-9a-f]{64}) over sha256:([0-9a-f]{64})$/su;

const SLATE_EFFECT = 'slate effect ';

const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() => v.union([
  v.string(), v.number(), v.boolean(), v.null(), v.array(JsonValueSchema), v.record(v.string(), JsonValueSchema),
]));

const SlateEffectSchema = v.strictObject({
  share: v.string(), slate: v.string(), revision: v.string(), server: v.string(), tool: v.string(),
  root: v.record(v.string(), v.string()), payload: JsonValueSchema, viewer: v.string(),
});

/** The text a write parks under, from its digests. */
export function boundWriteText(write: BoundFileWrite): string {
  return `file write ${write.path} sha256:${write.next} over sha256:${write.current}`;
}

/** What a share's effects are bound to, in the row's `executor`. */
export function slateEffectExecutor(share: string): string {
  return `share:${share}`;
}

/** The text a shared slate's effect parks under: its fields in one stable order, so one call is one text. */
export function slateEffectText(effect: SlateEffect): string {
  return `${SLATE_EFFECT}${stableStringify({ ...effect, root: { ...effect.root } })}`;
}

/** What a row parks: a write, or a share's effect bound to that share, where its text names one exactly; else a
 *  command as asked. */
export function approvalKindOf(row: { readonly command: string; readonly executor: string }): ApprovalKind {
  const { command } = row;
  const [, path, next, current] = BOUND_WRITE.exec(command) ?? [];

  if (path !== undefined && next !== undefined && current !== undefined) return { kind: 'write', write: { path, next, current } };

  if (row.executor.startsWith(slateEffectExecutor('')) && command.startsWith(SLATE_EFFECT)) {
    const effect = v.safeParse(v.pipe(v.string(), v.parseJson(), SlateEffectSchema), command.slice(SLATE_EFFECT.length));

    if (effect.success && row.executor === slateEffectExecutor(effect.output.share)) return { kind: 'slate-effect', effect: effect.output };
  }

  return { kind: 'command', command };
}
