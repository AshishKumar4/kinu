/** `ai.*` for programs: the model call a slate's `ai.run` makes, answered by the actor's own account. */
import type * as v from 'valibot';
import type { CodemodeProvider } from '../types/codemode';
import { attemptInItsWords } from '../obs/index';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace } from './operation-surfaces';
import { AI } from '../operations/ai';

export type AiRunInput = v.InferOutput<typeof AI.run.input>;

export type AiAnswer = v.InferOutput<typeof AI.run.output>;

/** Where an actor's program asks a model: its backend resolves the tier and files the spend as the actor's own. */
export interface AiDeps {
  run(input: AiRunInput): Promise<AiAnswer>;
}

function serveAi(deps: AiDeps): readonly Served[] {
  return [serve(AI.run, (input) => attemptInItsWords('unavailable', () => deps.run(input)))];
}

export function createAiCodemodeProvider(deps: AiDeps): CodemodeProvider {
  return codemodeNamespace('ai', 'Ask a model for one answer; billed as your own spend.', serveAi(deps));
}
