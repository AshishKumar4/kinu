/**
 * FIRST RUN: a workspace's settings page reads and writes the workspace.
 *
 * THE ASK. Every user-facing surface has a deployed row. The workspace's
 * settings page names it, writes its SOUL.md, picks how shell commands are
 * approved, tunes the advisor, and exports the whole workspace as the archive
 * `kinu import` reads. This row does each of those over the workspace's own
 * socket, with the RPCs the page calls, and reads every write back the way
 * the page hydrates it.
 *
 * WHY NO OTHER ROW GUARDS THIS. The chat rows read what a turn left; none
 * writes a setting, so a write the object acknowledged and then dropped, or a
 * snapshot that stopped carrying the soul the page shows, passed them all.
 *
 * NO MODEL. The workspace opens without its genesis turn.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import { JsonValueSchema, ORCHESTRATOR_AGENT_SLUG, type JsonValue } from '../../packages/core/src/index';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { ask, openPublicSocket, rpcDetail, type PublicSocket } from './public-socket';

const SUITE = 'First-run · workspace-settings';

const CASE = 'workspace-settings' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const SnapshotSchema = v.looseObject({
  status: v.looseObject({ displayName: v.string(), soul: v.optional(v.nullable(v.string())) }),
});

const ModeSchema = v.object({ mode: v.picklist(['strict', 'allow_all', 'deny_all']) });

const EvolutionSchema = v.looseObject({ advisorEnabled: v.boolean() });

const ArchivePageSchema = v.object({ lines: v.array(v.string()), next: v.nullable(JsonValueSchema) });

/** One file record of the archive: its bytes travel base64 (`identity/archive.ts`). */
const ArchiveFileSchema = v.object({ t: v.literal('file'), path: v.string(), data: v.string() });

/** The text of every file the archive lines carry, by path. */
function archivedFiles(lines: readonly string[]): ReadonlyMap<string, string> {
  const files = new Map<string, string>();

  for (const line of lines) {
    const record = v.safeParse(ArchiveFileSchema, JSON.parse(line));

    if (record.success) files.set(record.output.path, Buffer.from(record.output.data, 'base64').toString('utf8'));
  }

  return files;
}

type ArchivePage = v.InferOutput<typeof ArchivePageSchema>;

/** One RPC as the page calls it, parsed as the page parses it. */
async function read<S extends v.GenericSchema>(
  socket: PublicSocket, schema: S, method: string, args: readonly JsonValue[],
): Promise<{ readonly value: v.InferOutput<S> | null; readonly detail: string }> {
  const answer = await ask(socket, method, args);
  const parsed = answer.ok ? v.safeParse(schema, answer.value) : null;

  return parsed !== null && parsed.success
    ? { value: parsed.output, detail: `${method} answered ${JSON.stringify(answer.ok ? answer.value : null).slice(0, 200)}` }
    : { value: null, detail: rpcDetail({ rpc: method, answer, refusal: 'refused', said: null }) };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', genesis: false,
      purpose: 'Disposable workspace-settings probe; no model task.',
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const socket = openPublicSocket(plan.origin, plan.identity, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`, budget);

        try {
          if (!(await socket.opened)) {
            subgoals.push({ what: 'settings-open', reached: false, detail: `${socket.path} refused the upgrade` });

            return subgoals;
          }

          const title = `Settings probe ${String(Date.now())}`;
          const soul = `# Settings probe\n\nThis workspace was named and given this SOUL.md at ${String(Date.now())}.`;
          const named = await ask(socket, 'setDisplayName', [title]);
          const souled = await ask(socket, 'setSoul', [soul]);
          const snapshot = await read(socket, SnapshotSchema, 'getWorkspaceSnapshot', []);

          subgoals.push({
            what: 'name-persisted',
            reached: named.ok && snapshot.value?.status.displayName === title,
            detail: `${rpcDetail({ rpc: 'setDisplayName', answer: named, refusal: 'refused', said: null })}; then ${snapshot.detail}`,
          });
          subgoals.push({
            what: 'soul-persisted',
            reached: souled.ok && snapshot.value?.status.soul?.trim() === soul.trim(),
            detail: souled.ok ? `the snapshot carries soul ${JSON.stringify(snapshot.value?.status.soul?.slice(0, 80) ?? null)}`
              : rpcDetail({ rpc: 'setSoul', answer: souled, refusal: 'refused', said: null }),
          });

          const mode = await read(socket, ModeSchema, 'getShellApprovalMode', []);
          const next = mode.value?.mode === 'deny_all' ? 'strict' : 'deny_all';
          const moded = await ask(socket, 'setShellApprovalMode', [next]);
          const remode = await read(socket, ModeSchema, 'getShellApprovalMode', []);

          subgoals.push({
            what: 'approval-mode-persisted',
            reached: mode.value !== null && moded.ok && remode.value?.mode === next,
            detail: `${mode.detail}; set ${next}; then ${remode.detail}`,
          });

          const advisor = await read(socket, EvolutionSchema, 'getEvolutionConfig', []);
          const flipped = advisor.value === null ? null : !advisor.value.advisorEnabled;
          const written = flipped === null ? null : await read(socket, EvolutionSchema, 'setEvolutionConfig', [{ advisorEnabled: flipped }]);
          const reread = await read(socket, EvolutionSchema, 'getEvolutionConfig', []);

          subgoals.push({
            what: 'advisor-setting-persisted',
            reached: flipped !== null && written?.value?.advisorEnabled === flipped && reread.value?.advisorEnabled === flipped,
            detail: `${advisor.detail}; then ${reread.detail}`,
          });

          // The archive is paged; the soul just written is one of its files.
          const lines: string[] = [];
          let cursor: JsonValue | null = null;
          let detail = '';

          for (let pages = 0; ; pages += 1) {
            const page: { readonly value: ArchivePage | null; readonly detail: string } = await read(
              socket, ArchivePageSchema, 'exportWorkspaceArchive', cursor === null ? [] : [cursor],
            );

            detail = page.detail;

            if (page.value === null) break;
            lines.push(...page.value.lines);

            if (page.value.next === null) break;
            cursor = page.value.next;
          }

          const files = archivedFiles(lines);
          const carrier = [...files].find(([, text]) => text.trim() === soul.trim())?.[0];

          subgoals.push({
            what: 'archive-exports-the-workspace',
            reached: carrier !== undefined,
            detail: carrier !== undefined
              ? `${String(lines.length)} archive line(s); ${carrier} carries the soul written above`
              : `${String(lines.length)} archive line(s), ${String(files.size)} file(s) (${[...files.keys()].slice(0, 8).join(', ')}), none the soul written above; last page: ${detail}`,
          });

          return subgoals;
        } finally {
          socket.close('the row is done');
        }
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
