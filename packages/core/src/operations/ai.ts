/** A model's answer to a prompt, from inside a program: the call a slate's `ai.run` makes, filed as the agent's own spend. */
import * as v from 'valibot';
import { UsageSchema } from '../usage';
import { described, namespace } from './operation';

// A program's alone: a slate asks its own `ai.run`, and the agent itself answers in its turn. Plan keeps it: it changes nothing.
const aiOp = namespace('ai', { slate: false, plan: true });

export const AI = {
  run: aiOp({
    name: 'run',
    help: 'One answer from the model your role names for a tier; billed as your own spend.',
    impact: 'execute',
    tool: false,
    input: v.strictObject({
      prompt: v.pipe(v.string(), v.nonEmpty()),
      system: v.optional(described(v.string(), 'A system prompt for this call alone.')),
      tier: v.optional(described(v.string(), 'A tier of your profile, such as "fast"; your role\'s default tier when omitted.')),
    }),
    output: v.strictObject({ text: v.string(), model: v.string(), tier: v.string(), usage: UsageSchema }),
  }),
} as const;

export type AiRunInput = v.InferOutput<typeof AI.run.input>;

export type AiAnswer = v.InferOutput<typeof AI.run.output>;
