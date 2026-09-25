/**
 * The device daemon (`packages/pc-agent/src/index.js`) in process: each frame runs through its own
 * `handle` over its own checkpoint store under scratch, and the reply settles the answer.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';

const require_ = createRequire(import.meta.url);

const pcAgent = v.parse(
  v.object({ handle: v.function(), createCheckpoints: v.function() }),
  require_(join(import.meta.dir, '../../../pc-agent/src/index.js')),
);

const ReplySchema = v.object({ id: v.string(), result: v.optional(JsonValueSchema), error: v.optional(v.string()) });

export interface DaemonFrame {
  readonly id: string;
  readonly method: string;
  readonly params: JsonValue[];
  readonly sandbox?: JsonValue;
  readonly checkpoint?: JsonValue;
}

/** The hint a mutating frame carries; the daemon snapshots `dir` once per turn under it. */
export interface DaemonSnapshotHint {
  readonly agent: string;
  readonly dir: string;
  readonly turnId: string;
  readonly sessionId: string;
}

export interface PcAgentDaemon {
  answer(frame: DaemonFrame): Promise<JsonValue | undefined>;
  /** The snapshot the daemon takes before a turn's first mutation of `dir`. */
  snapshot(hint: DaemonSnapshotHint): Promise<void>;
}

export function pcAgentDaemon(opts: { gitBin?: string } = {}): PcAgentDaemon {
  const checkpoints = pcAgent.createCheckpoints({ base: join(scratchDir('device-checkpoint-store'), 'store'), gitBin: opts.gitBin });
  const store = v.parse(v.object({ ensure: v.function() }), checkpoints);
  const ctx = { checkpoints };

  return {
    answer: (frame) => {
      const { promise, resolve, reject } = Promise.withResolvers<JsonValue | undefined>();

      pcAgent.handle(frame, {
        readyState: 1,
        send(data: string) {
          const reply = v.parse(ReplySchema, JSON.parse(data));

          if (reply.error !== undefined) reject(new Error(reply.error));
          else resolve(reply.result);
        },
      }, ctx);

      return promise;
    },
    snapshot: async (hint) => {
      v.parse(v.nullable(v.string()), await store.ensure(hint, hint.dir));
    },
  };
}
