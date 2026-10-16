/**
 * A personal part (docs/SLATE-SHARING-NIMBUS.md §3): one viewer's own data, computed by the slate's code in a confined
 * Nimbus process holding only that viewer's grants, and drawn by Kinu, never by the slate's script. The contract the
 * client route, the part frame and the "Show to everyone" prompt build against.
 */
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '../utils/json';
import { CodecSchema } from './codec';
import { SlateConsentSchema } from './share-modes';

const Name = v.pipe(v.string(), v.minLength(1));

/**
 * `package.json` `slate.parts.<name>`. `fn` is the Slate class method that computes the part; `input` the contract of
 * the arguments the shared page passes it; `show` the shared server's method that receives what a viewer chose to
 * show everyone, called as `show(value, from)`.
 */
export const PartDeclarationSchema = v.strictObject({
  fn: Name,
  input: v.optional(CodecSchema),
  show: v.optional(Name),
});

export type PartDeclaration = v.InferOutput<typeof PartDeclarationSchema>;

/** A Kinu-owned control under a part: pressing it runs the part again with `{ id, input }`; no slate script runs. */
const PartActionSchema = v.object({
  id: Name,
  label: v.string(),
  /** What the control asks the viewer for; absent, it is a button. */
  input: v.optional(CodecSchema),
});

export type PartAction = v.InferOutput<typeof PartActionSchema>;

/**
 * What a part's `fn` returns. `html` is the slate author's markup, cut down by Kinu to script-free, resource-free
 * elements (`room-parts.ts` `sealedPart`); `show`, a payload it proposes the viewer show everyone, which leaves only
 * if the viewer confirms it in Kinu's prompt, exactly as shown there.
 */
export const PartOutputSchema = v.object({
  html: v.string(),
  actions: v.optional(v.array(PartActionSchema), []),
  show: v.optional(v.nullable(v.object({ label: v.string(), value: JsonValueSchema })), null),
});

export type PartOutput = v.InferOutput<typeof PartOutputSchema>;

/** `POST slatePartRunPath`: the part run as the signed-in viewer, from the app's own page, never the slate's. */
export const PartRunRequestSchema = v.object({
  /** From the shared page, checked against the declaration's `input`: public data going in. */
  args: v.array(JsonValueSchema),
  action: v.nullable(v.object({ id: Name, input: JsonValueSchema })),
  /** An effect the viewer approved (`needs-approval`): admits that one effect, with that payload, once. */
  approval: v.nullable(Name),
});

export type PartRunRequest = v.InferOutput<typeof PartRunRequestSchema>;

const RootSchema = v.record(v.string(), v.string());

/** What a person sees a connection and its tool called, where their account knows it; absent, the ids stand. */
const Titles = { serverTitle: v.optional(Name), toolTitle: v.optional(Name) };

/** What the viewer is asked to let this slate use of theirs, for this revision. */
const ConsentAskSchema = v.object({ server: Name, root: RootSchema, tools: v.array(Name), effects: v.boolean(), revision: Name, ...Titles });

export type ConsentAsk = v.InferOutput<typeof ConsentAskSchema>;

/** An effect the part's run reached with the viewer's grant, waiting for them: the tool and the exact payload. */
const EffectAskSchema = v.object({ id: Name, server: Name, tool: Name, root: RootSchema, payload: JsonValueSchema, ...Titles });

export type EffectAsk = v.InferOutput<typeof EffectAskSchema>;

/**
 * The run's answer, to the viewer alone. `html` is already cut; `stub` is what someone without a session, or of a
 * share whose slate declares no such part, sees, with what they can do about it; `failed` is the run's own failure,
 * shown only to its viewer.
 */
export const PartRunAnswerSchema = v.variant('kind', [
  v.object({
    kind: v.literal('shown'), revision: Name, html: v.string(), actions: v.array(PartActionSchema),
    show: v.nullable(v.object({ label: v.string(), value: JsonValueSchema })),
  }),
  v.object({ kind: v.literal('needs-consent'), ask: ConsentAskSchema }),
  v.object({ kind: v.literal('needs-approval'), ask: EffectAskSchema }),
  v.object({ kind: v.literal('stub'), reason: v.picklist(['signed-out', 'no-part']), message: v.string() }),
  v.object({ kind: v.literal('failed'), message: v.string() }),
]);

export type PartRunAnswer = v.InferOutput<typeof PartRunAnswerSchema>;

/** `GET slateConsentsPath`: this viewer's consents for the slate, at whatever revision each was given. */
export const SlateConsentsAnswerSchema = v.object({ consents: v.array(SlateConsentSchema) });

export type SlateConsentsAnswer = v.InferOutput<typeof SlateConsentsAnswerSchema>;

/** `POST slatePartShowPath`: what the viewer confirmed in Kinu's prompt, to the slate's declared `show` method. */
export const PartShowRequestSchema = v.object({
  revision: Name,
  label: v.string(),
  value: JsonValueSchema,
});

export type PartShowRequest = v.InferOutput<typeof PartShowRequestSchema>;

/** `POST slateApprovalPath`: the viewer's decision on one effect. */
export const EffectDecisionSchema = v.object({ decision: v.picklist(['approve', 'decline']) });

function slateApiPath(workspace: string, slate: string): string {
  return `/api/slates/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}`;
}

export function slatePartRunPath(workspace: string, slate: string, part: string): string {
  return `${slateApiPath(workspace, slate)}/parts/${encodeURIComponent(part)}/run`;
}

export function slatePartShowPath(workspace: string, slate: string, part: string): string {
  return `${slateApiPath(workspace, slate)}/parts/${encodeURIComponent(part)}/show`;
}

/** `POST` a `SlateConsent` for this slate; `GET` this viewer's; `DELETE ?server=&root=` takes one back. */
export function slateConsentsPath(workspace: string, slate: string): string {
  return `${slateApiPath(workspace, slate)}/consents`;
}

export function slateApprovalPath(workspace: string, slate: string, approval: string): string {
  return `${slateApiPath(workspace, slate)}/approvals/${encodeURIComponent(approval)}`;
}

/** The app's own frame for one part, embedded by the slate's page; `args` is the page's public input to it. */
export function slatePartFramePath(workspace: string, slate: string, part: string, args: readonly JsonValue[]): string {
  return `/s/${encodeURIComponent(workspace)}/${encodeURIComponent(slate)}/parts/${encodeURIComponent(part)}?args=${encodeURIComponent(JSON.stringify(args))}`;
}
