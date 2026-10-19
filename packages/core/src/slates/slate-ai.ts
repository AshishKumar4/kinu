/**
 * A slate's `workspace.ai` call, answered once, by whichever account answers it: the workspace's own actor for its
 * owner's code (cf `ActorAgent.slateAiRun`), a collaborator's own account for theirs (cf `UserDO.slateAi`). The profile is
 * that account's, so is the model it names; the call is filed as a `slate` model call where that account files them.
 */
import type { LanguageModel } from 'ai';
import * as v from 'valibot';
import { generateReported, streamTextReported, type GenerateRequest, type StreamRequest } from '../providers/model-invocation';
import type { ModelCallReport, ModelOperationSink } from '../events/model-call';
import { normalizeUsage } from '../usage';
import { JsonValueSchema } from '../utils/json';
import type { SlateRoute } from './surface';
import type { SlateSurfaceValue } from './rpc';

export type SlateAiRoute = Extract<SlateRoute, { kind: 'ai' }>;

/** Where one account's call goes: its own model registry, and its own record of what the call cost. */
export interface SlateAiSeams {
  readonly resolveModel: (spec: string) => LanguageModel;
  readonly report: (report: ModelCallReport) => void;
  readonly operations: ModelOperationSink;
}

/** The model the answering account's resolved profile names for the call: its spec, and the tier that named it. */
export interface SlateAiModel {
  readonly spec: string;
  readonly tier: string;
}

/** `ai.run`'s answer, or `ai.stream`'s text as UTF-8 bytes, from the model the answering account's profile names. */
export async function slateAiAnswer(route: SlateAiRoute, named: SlateAiModel, seams: SlateAiSeams): Promise<SlateSurfaceValue> {
  const { spec } = named;
  const model = seams.resolveModel(spec);
  const spend = { source: 'slate' as const, report: seams.report, operations: seams.operations };

  if (route.stream === true) return slateAiStream({ model, prompt: route.prompt, ...(route.system !== undefined && { system: route.system }) }, { spend, spec });
  const input: GenerateRequest = { model, prompt: route.prompt, ...(route.system !== undefined && { system: route.system }) };
  const answer = await generateReported(input, { spend, spec });

  return v.parse(JsonValueSchema, { text: answer.text, model: spec, tier: named.tier, usage: normalizeUsage(answer.usage) });
}

/**
 * `ai.stream`: the answer's text as UTF-8 bytes, each written as the model writes it, which the slate's class reads as
 * text. Its spend is filed once the stream drains, as any streamed call's is; a reader that stops early ends the call.
 */
function slateAiStream(request: StreamRequest, options: Parameters<typeof streamTextReported>[1]): ReadableStream<Uint8Array> {
  const chunks = streamTextReported(request, options);
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();

      if (next.done === true) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() { await chunks.return(undefined); },
  });
}
