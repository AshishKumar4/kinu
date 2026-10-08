/**
 * FIRST RUN: a workspace's settings page reads and writes the workspace.
 *
 * THE ASK. Every user-facing surface has a deployed row. The workspace's
 * settings page names it, writes its SOUL.md, picks how shell commands are
 * approved, tunes the advisor, sizes its sandbox, and exports the whole
 * workspace as the archive `kinu import` reads. The sandbox size starts at the
 * owner's account default, which User settings writes through
 * `/api/user/config/sandbox_size`; this row writes a size there, sees the
 * workspace's Environment card read it, sizes this workspace's stopped box
 * apart from it, and puts the account's own choice back. This row does each of those over the workspace's own
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
import { webHeaders, type PublicWebIdentity } from '../../evals/src/session';

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

const SIZES = ['small', 'medium', 'large'] as const;

const SizeSchema = v.picklist(SIZES);

/** What the Environment card reads (`getSandboxSize`); a deployment with no sandbox answers null. */
const SandboxSizeSchema = v.nullable(v.object({
  account: v.nullable(SizeSchema), chosen: v.nullable(SizeSchema), size: SizeSchema, running: v.nullable(SizeSchema), startRefused: v.nullable(v.string()),
}));

const AccountSizeSchema = v.object({ key: v.literal('sandbox_size'), value: v.nullable(v.string()) });

/** The account default as User settings reads and writes it; each answer is its status and its body. */
function accountSize(origin: string, identity: PublicWebIdentity, signal: AbortSignal) {
  const at = `${origin}/api/user/config/sandbox_size`;
  const headers = webHeaders(identity);
  const said = async (response: Response) => ({ status: response.status, body: (await response.text()).slice(0, 240) });

  return {
    read: async () => said(await fetch(at, { headers, signal })),
    write: async (value: string) => said(await fetch(at, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ value }), signal,
    })),
  };
}

/** The account's stored size, or null when the read failed or holds none. */
function storedSize(answer: { readonly status: number; readonly body: string }): string | null {
  if (answer.status !== 200) return null;
  const parsed = v.safeParse(AccountSizeSchema, JSON.parse(answer.body));

  return parsed.success ? parsed.output.value : null;
}

/** The archive's records a cloud export carries the workspace in (`identity/archive.ts`): its rows, then its store's
 *  trees, each page of files followed by the chunks those files name. */
const ArchiveRecordSchema = v.variant('t', [
  v.object({ t: v.literal('row'), table: v.string(), values: v.record(v.string(), JsonValueSchema) }),
  v.object({
    t: v.literal('page'),
    page: v.object({ root: v.string(), rows: v.array(v.object({ path: v.string(), kind: v.string(), pieces: v.array(v.tuple([v.string(), v.number()])) })) }),
  }),
  v.object({ t: v.literal('chunks'), chunks: v.array(v.object({ hash: v.string(), data: v.string() })) }),
]);

/** What the archive lines carry: every file's path and its bytes as its chunks spell them, and the chunks its files
 *  name that no `chunks` record brought. */
function archived(lines: readonly string[]) {
  const pieces = new Map<string, readonly string[]>();
  const named = new Set<string>();
  const brought = new Map<string, Uint8Array>();

  for (const line of lines) {
    const record = v.safeParse(ArchiveRecordSchema, JSON.parse(line));

    if (!record.success) continue;
    const { output } = record;

    if (output.t === 'page') {
      for (const row of output.page.rows) {
        // A page rooted at a file names it by an empty path.
        if (row.kind === 'file') pieces.set([output.page.root, row.path].filter((part) => part !== '').join('/'), row.pieces.map(([hash]) => hash));

        for (const [hash] of row.pieces) named.add(hash);
      }
    } else if (output.t === 'chunks') {
      for (const chunk of output.chunks) brought.set(chunk.hash, Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0)));
    }
  }

  /** A file's text as the archive carries it, or null when a chunk it names never came. */
  const text = (path: string): string | null => {
    const parts = (pieces.get(path) ?? []).map((hash) => brought.get(hash));

    return parts.every((part) => part !== undefined) ? new TextDecoder().decode(Buffer.concat(parts)) : null;
  };

  return { files: [...pieces.keys()], text, owed: [...named].filter((hash) => !brought.has(hash)) };
}

function archiveSubgoal(lines: readonly string[], soul: string, lastPage: string): EvalSubgoal {
  const { files, text, owed } = archived(lines);
  // The soul lives in the file plane: the archive carries it as the workspace's SOUL.md, byte for byte.
  const soulFile = files.find((path) => path === 'SOUL.md' || path.endsWith('/SOUL.md')) ?? null;
  const carried = soulFile === null ? null : text(soulFile);

  return {
    what: 'archive-exports-the-workspace',
    reached: carried?.trim() === soul.trim() && owed.length === 0,
    detail: `${String(lines.length)} archive line(s); SOUL.md ${soulFile === null ? 'not among the files' : `at ${soulFile} reads ${JSON.stringify(carried?.slice(0, 80) ?? null)}`}; `
      + `${String(files.length)} file(s) (${files.slice(0, 8).join(', ')}), ${String(owed.length)} chunk(s) they name never carried; last page: ${lastPage}`,
  };
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

/**
 * The sandbox size: a size the table does not name is refused; one it names becomes the account default the workspace's
 * Environment card reads; this workspace's stopped box takes a size of its own and gives it back; the account's own
 * choice is put back. A choice never made reads as Medium, the default, so that is what goes back for it.
 */
async function sandboxSizeSubgoals(socket: PublicSocket, account: ReturnType<typeof accountSize>): Promise<EvalSubgoal[]> {
  const prior = storedSize(await account.read());
  const probe = prior === 'small' ? 'medium' : 'small';
  const own = probe === 'small' ? 'medium' : 'small';
  const refused = await account.write('huge');
  const written = await account.write(probe);
  const reread = await account.read();
  const followed = await read(socket, SandboxSizeSchema, 'getSandboxSize', []);
  const chosen = await read(socket, SandboxSizeSchema, 'resizeSandbox', [own]);
  const cleared = await read(socket, SandboxSizeSchema, 'resizeSandbox', [null]);
  const restored = await account.write(prior ?? 'medium');

  return [
    {
      what: 'account-size-persisted',
      reached: refused.status === 400 && written.status === 200 && storedSize(reread) === probe,
      detail: `PUT huge answered ${String(refused.status)} ${refused.body}; PUT ${probe} answered ${String(written.status)}; then read ${reread.body}`,
    },
    {
      what: 'workspace-reads-account-size',
      reached: followed.value?.account === probe && followed.value.chosen === null && followed.value.size === probe,
      detail: followed.detail,
    },
    {
      what: 'stopped-box-sized-apart',
      reached: chosen.value?.chosen === own && chosen.value.size === own && chosen.value.running === null
        && cleared.value?.chosen === null && cleared.value.size === probe,
      detail: `resizeSandbox(${own}): ${chosen.detail}; resizeSandbox(null): ${cleared.detail}`,
    },
    { what: 'account-size-restored', reached: restored.status === 200, detail: `PUT ${prior ?? 'medium'} answered ${String(restored.status)} ${restored.body}` },
  ];
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

          // The archive is paged: the soul just written travels as SOUL.md among the store's pages and chunks.
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

          subgoals.push(archiveSubgoal(lines, soul, detail));
          subgoals.push(...await sandboxSizeSubgoals(socket, accountSize(plan.origin, plan.identity, budget)));

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
