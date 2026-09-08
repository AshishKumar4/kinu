import type { AgentRuntime } from '../types/agent-runtime';
import type { WorkMode } from '../prompting/surface';
import { readVersionedScaffoldSource } from '../scaffold/shadow';
import { assertScaffoldActive, type ScaffoldRunControl } from '../scaffold/executor';
import { sha256Hex } from '../safety/argument-digest';
import { KinuError } from '../obs/error';

/** Selected entry source, not a snapshot of imports or environment data.
 * Builtin identity needs real installed-build provenance, not fabricated source. */
export type ActorTurnProgram =
  | { readonly kind: 'builtin'; readonly version: 0 }
  | { readonly kind: 'scaffold'; readonly version: number; readonly source: string; readonly digest: string };

const BUILTIN_PROGRAM: ActorTurnProgram = Object.freeze({ kind: 'builtin', version: 0 });

/** Pin only the selected immutable version. Neither transform reads a live alias. */
export async function prepareActorProgram(input: ScaffoldRunControl & {
  readonly runtime: AgentRuntime;
  readonly mode: WorkMode;
  readonly version: number;
}): Promise<ActorTurnProgram> {
  assertScaffoldActive(input);
  if (input.mode === 'plan' || input.version <= 0) return BUILTIN_PROGRAM;
  const source = await readVersionedScaffoldSource(input.runtime, input.version);
  assertScaffoldActive(input);
  if (source === null) throw new KinuError('missing', 'scaffold version ' + input.version + ' has no source');
  return Object.freeze({ kind: 'scaffold', version: input.version, source, digest: sha256Hex(source) });
}
