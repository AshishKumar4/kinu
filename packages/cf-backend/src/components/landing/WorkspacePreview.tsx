import { Tabs, type TabsItem } from '@cloudflare/kumo';
import { CHANGE_KIND_GLYPH } from '@kinu.run/core';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { UIMessage } from 'ai';
import { KinuLogo } from '@/components/ui/KinuLogo';
import { MessageView } from '@/components/MessageView';
import { FilledButton } from '@/components/ui/FilledButton';
import { DEMO_CUES, discreteAt } from './bugfix-demo-timeline';
const WORKSPACE_MISSION = 'Audit the checkout flow, find why the SAVE20 coupon 500s, and fix it. Deploy to staging when green.';
const EXAMPLE_QUESTION = 'What passed verification?';

const RUN_TABS: TabsItem[] = [{ value: 'run', label: 'Run' }, { value: 'supervise', label: 'Supervise' }];

const WORKSPACE_DEMO_MESSAGES: UIMessage[] = [
  {
    id: 'landing-workspace-user',
    role: 'user',
    parts: [{ type: 'text', text: WORKSPACE_MISSION }],
  },
  {
    id: 'landing-workspace-agent',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'The coupon path goes through /api/cart/apply. I should reproduce first, then inspect the handler and migration.' },
      { type: 'tool-run', toolCallId: 'landing-run', state: 'output-available', input: { runtime: 'sandbox', command: "curl -s -X POST localhost:8788/api/cart/apply -d '{\"code\":\"SAVE20\"}'" }, output: 'HTTP 500' },
      { type: 'tool-execute_tools', toolCallId: 'landing-query', state: 'output-available', input: { code: '// Inspect coupon rows to find the missing kind\nconst rows = await sql`SELECT code, kind, value FROM coupons`;\nreturn rows;' }, output: '[{"code":"SAVE20","kind":null,"value":20}]' },
      { type: 'text', text: "Tuesday's migration backfilled `kind` for fixed coupons only. I will patch the migration, add a regression test, and run the focused suite." },
      { type: 'tool-file', toolCallId: 'landing-read', state: 'output-available', input: { action: 'read', path: 'packages/checkout/migrations/0042_coupon_kind.sql' }, output: '…' },
      { type: 'tool-file', toolCallId: 'landing-edit', state: 'output-available', input: { action: 'edit', path: 'packages/checkout/migrations/0042_coupon_kind.sql', edits: [{}, {}] }, output: { error: 'old_text not found or not unique' } },
      { type: 'tool-file', toolCallId: 'landing-write', state: 'output-available', input: { action: 'write', path: 'packages/checkout/tests/coupon-kind.test.ts' }, output: 'ok' },
      { type: 'tool-tasks', toolCallId: 'landing-task', state: 'output-available', input: { action: 'update', id: 't4', status: 'done' }, output: 'ok' },
    ],
  },
];
const CONVERSATION_TABS: TabsItem[] = [
  { value: 'main', label: 'Main' }, { value: 'coupon', label: 'Coupon tester' }, { value: 'migration', label: 'Migration review' },
];
const SURFACE_TABS: TabsItem[] = ['Work', 'Exploration', 'Agent', 'Files'].map((label) => ({ value: label.toLowerCase(), label }));
const MOBILE_TABS: TabsItem[] = [{ value: 'chat', label: 'Conversation' }, { value: 'workspace', label: 'Workspace' }];
const COMPLETED_DEMO = discreteAt(DEMO_CUES.finalText);
const REVIEW_DEMO = discreteAt(DEMO_CUES.planRevised);
const MIGRATION_FILE = {
  name: '0042_coupon_kind.sql',
  content: "UPDATE coupons\nSET kind = coupon_catalog.kind\nFROM coupon_catalog\nWHERE coupons.code = coupon_catalog.code;\n\n-- Refuse rows with no catalog entry.\nSELECT code FROM coupons WHERE kind IS NULL;",
};
const PREVIEW_FILES = [MIGRATION_FILE, {
  name: 'coupon-kind.test.ts',
  content: "describe('coupon kinds', () => {\n  test('percent keeps its catalog kind', () => {\n    expect(backfill('SAVE20').kind).toBe('percent');\n  });\n  test('fixed keeps its catalog kind', () => {\n    expect(backfill('TAKE10').kind).toBe('fixed');\n  });\n  test('missing catalog rows are refused', () => {\n    expect(() => backfill('UNKNOWN')).toThrow();\n  });\n});",
}, {
  name: 'test-results.txt',
  content: 'bun test packages/checkout\n\n7 pass\n0 fail\n\nPercent coupons use the catalog kind.\nFixed coupons keep their original kind.\nMissing catalog rows are refused.',
}];

function PreviewFiles(): ReactElement {
  const [selected, setSelected] = useState(MIGRATION_FILE);
  return <div className="space-y-3" data-preview-files>
    <p className="p-annotation p-text-3">packages / checkout</p>
    <div className="overflow-hidden rounded-xl border p-border p-surface">
      {PREVIEW_FILES.map((file) => <button key={file.name} type="button" aria-pressed={selected.name === file.name} onClick={() => setSelected(file)} className={`block w-full break-words border-b p-border px-3 py-2 text-left font-mono text-[10.5px] last:border-b-0 ${selected.name === file.name ? 'p-elevated p-accent' : 'p-text-3 hover:p-text'}`}>
        <span aria-hidden="true">{selected.name === file.name ? '▾' : '▸'}</span> {file.name}
      </button>)}
    </div>
    <div className="overflow-hidden rounded-xl border p-border p-surface">
      <div className="border-b p-border px-3 py-2 font-mono text-[10px] p-text-3">{selected.name}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-[1.7] p-text-2">{selected.content}</pre>
    </div>
  </div>;
}

function PreviewExploration(): ReactElement {
  return <div className="space-y-3" data-preview-exploration>
    <div><h3 className="text-sm font-semibold p-text">Three candidate patches</h3><p className="mt-1 text-xs leading-relaxed p-text-3">The focused suite chooses what lands. Open a candidate to inspect its result.</p></div>
    {COMPLETED_DEMO.candidates?.map((candidate) => <details key={candidate.id} className="rounded-xl border p-border p-surface">
      <summary className="cursor-pointer px-3 py-3 text-xs p-text"><span className="font-semibold">{candidate.name}</span><span className={`ml-2 text-[10px] ${candidate.selected ? 'p-success' : 'p-danger'}`}>{candidate.selected ? 'selected' : 'failed'}</span></summary>
      <div className="space-y-2 border-t p-border px-3 py-3 text-xs leading-relaxed"><p className="p-text-2">{candidate.approach}</p><p className="font-mono p-text-3">{candidate.result}</p></div>
    </details>)}
  </div>;
}

function PreviewAgent(): ReactElement {
  return <div className="space-y-4" data-preview-agent>
    <div><h3 className="text-sm font-semibold p-text">Jarvis</h3><p className="mt-1 text-xs p-text-3">checkout-svc · durable workspace</p></div>
    <div className="rounded-xl border p-border p-surface p-3"><div className="mb-2 p-annotation p-accent">Mission</div><p className="text-xs leading-relaxed p-text-2">{WORKSPACE_MISSION}</p></div>
    <details className="rounded-xl border p-border p-surface"><summary className="cursor-pointer px-3 py-3 text-xs font-semibold p-text">Remembered from this work</summary><p className="border-t p-border px-3 py-3 text-xs leading-relaxed p-text-2">Coupon values do not identify their kind. Read coupon_catalog before changing the migration.</p></details>
    <div className="rounded-xl border p-border p-surface p-3 text-xs leading-relaxed p-text-3">Files, memory, and conversation stay with this workspace when you close the browser.</div>
  </div>;
}

export function WorkspacePreview(): ReactElement {
  const [altitude, setAltitude] = useState('run');
  const [decision, setDecision] = useState<'pending' | 'retried' | 'dismissed'>('pending');
  const [followup, setFollowup] = useState(false);
  const answerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (followup) answerRef.current?.scrollIntoView({ block: 'nearest' }); }, [followup]);
  const [conversation, setConversation] = useState('main');
  const [surface, setSurface] = useState('work');
  const [mobilePane, setMobilePane] = useState('chat');
  const messages = conversation === 'main' ? WORKSPACE_DEMO_MESSAGES
    : conversation === 'coupon' ? COMPLETED_DEMO.messages : REVIEW_DEMO.messages;
  return (
    <div data-workspace-mode={altitude} aria-label="Kinu workspace interface preview" className="relative overflow-hidden rounded-2xl border p-border bg-[var(--c-bg)] shadow-[0_40px_110px_-50px_rgba(0,0,0,.95)]">
      <div className="flex min-h-[46px] flex-wrap items-center justify-between gap-3 border-b p-border p-recessed px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <KinuLogo compact />
          <span className="h-4 w-px p-fill" />
          <span className="text-[13px] font-semibold p-text">Jarvis</span>
          <span className="inline-flex items-center gap-1.5 text-[11.5px] p-text-4"><span className="size-[5px] rounded-full p-dot-accent" />Live</span>
          <span className="hidden text-[11.5px] p-text-4 sm:inline">deepseek-v4-pro</span>
        </div>
        <Tabs
          tabs={RUN_TABS}
          value={altitude}
          onValueChange={setAltitude}
          variant="segmented"
          activateOnFocus
          className="landing-tabs shrink-0 [&>div:first-child]:!h-9 [&>div:first-child]:!rounded-full [&>div:first-child]:!bg-[var(--c-fill)] [&_[role=tab]]:!my-0 [&_[role=tab]]:!h-[30px] [&_[role=tab]]:!rounded-full"
          listClassName="!h-9 !rounded-full !border !border-[var(--c-border-strong)] !bg-[var(--c-fill)] !p-[3px] !ring-0"
          indicatorClassName="!rounded-full !bg-[var(--c-accent)] !shadow-none !ring-0"
        />
      </div>
      <div className="border-b p-border px-3 py-2 md:hidden" role="group" aria-label="Preview panes">
        <Tabs tabs={MOBILE_TABS} value={mobilePane} onValueChange={setMobilePane} variant="segmented" activateOnFocus className="landing-tabs" />
      </div>
      <div className="grid min-h-[760px] grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px] lg:grid-cols-[190px_minmax(0,1fr)_330px]">
        <aside className="hidden border-r p-border p-recessed px-3 py-3.5 lg:block">
          <div className="px-2 pb-2.5 text-[11px] p-text-4">Workspaces</div>
          <div className="flex items-center gap-2 rounded-lg bg-[var(--c-elevated)] px-2.5 py-2">
            <span className="size-[5px] rounded-full p-dot-accent" /><span className="flex-1 text-[12.5px] font-semibold">Jarvis</span><span className="text-[10.5px] p-text-4">4h</span>
          </div>
          <div className="ml-[18px] mt-0.5 border-l p-border pl-[9px]">
            <div className="flex justify-between px-2 py-1.5 text-xs"><span>Scout</span><span className="text-[10px] p-text-4">research</span></div>
            <div className="flex justify-between px-2 py-1.5 text-xs"><span>Sentry</span><span className="text-[10px] p-text-4">PR review</span></div>
          </div>
          <div className="mt-1.5 flex items-center gap-2 px-2.5 py-2 text-[12.5px] p-text-3"><span className="size-[5px] rounded-full p-fill" />checkout-svc</div>
        </aside>
        <div className={`min-w-0 flex-col border-r p-border ${mobilePane === 'chat' ? 'flex' : 'hidden md:flex'}`}>
          <Tabs tabs={CONVERSATION_TABS} value={conversation} onValueChange={setConversation} variant="underline" activateOnFocus className="landing-preview-tabs shrink-0 border-b p-border p-recessed" />
          <div data-workspace-panel={altitude} data-preview-conversation={conversation} className="flex h-[660px] flex-col gap-3.5 overflow-y-auto px-4 py-5 sm:px-6">
            {altitude === 'run' ? (
              <div className="space-y-5">
                {messages.map((message, index) => (
                  <MessageView
                    key={message.id}
                    message={message}
                    isLast={index === messages.length - 1}
                    isStreaming={false}
                  />
                ))}
                {conversation === 'migration' && REVIEW_DEMO.plan !== null && <MessageView message={{ id: 'preview-reviewed-plan', role: 'assistant', parts: [{ type: 'text', text: REVIEW_DEMO.plan.markdown }] }} isLast isStreaming={false} />}
                {followup && <div ref={answerRef} data-preview-answer className="space-y-4">
                  <MessageView message={{ id: 'preview-question', role: 'user', parts: [{ type: 'text', text: EXAMPLE_QUESTION }] }} isLast={false} isStreaming={false} />
                  <MessageView message={{ id: 'preview-answer', role: 'assistant', parts: [{ type: 'text', text: 'All seven focused tests pass. The patch backfills kind from coupon_catalog and refuses missing catalog rows.' }] }} isLast isStreaming={false} />
                </div>}
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-4"><div><div className="text-[11px] uppercase tracking-[.14em] p-accent">Supervise</div><h3 className="mt-1.5 text-lg font-semibold p-text">Three agents are working</h3></div><span className="rounded-full p-accent-subtle px-3 py-1 text-[11px] p-accent">2 active · 1 waiting</span></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[['Scout', 'Researching the hot path', '3 sources', 'active'], ['Builder', 'Editing the one-pass dedupe', 'src/dedupe.ts', 'active'], ['Verifier', 'Waiting for Builder', 'bun test summary', 'waiting']].map(([name, task, detail, state]) => (
                    <div key={name} className="rounded-xl border p-border p-surface p-4">
                      <div className="mb-3 flex items-center justify-between gap-3"><strong className="text-[13px] p-text">{name}</strong><span className={`text-[10px] uppercase tracking-[.1em] ${state === 'active' ? 'p-success' : 'p-warning'}`}>{state}</span></div>
                      <p className="text-[12.5px] leading-[1.55] p-text-2">{task}</p><code className="mt-2 block truncate text-[10.5px] p-text-4">{detail}</code>
                    </div>
                  ))}
                </div>
                <div className="mt-1 rounded-xl border p-border p-recessed p-4"><div className="mb-3 flex justify-between text-[11px] p-text-4"><span>Branch progress</span><span>2 of 3 settled</span></div><div className="h-1.5 overflow-hidden rounded-full p-fill"><span className="block h-full w-2/3 rounded-full p-dot-accent" /></div><p className="mt-3 text-[12.5px] leading-[1.55] p-text-3">Builder's patch will wake Verifier automatically. The best measured result returns to this conversation.</p></div>
              </>
            )}
          </div>
          <div className="border-t p-border p-recessed px-4 py-3">
            <form onSubmit={(event) => { event.preventDefault(); setAltitude('run'); setConversation('main'); setFollowup(true); }} className="flex items-center gap-2.5 rounded-xl border border-[var(--c-border-strong)] bg-[var(--c-input-bg)] px-3.5 py-2.5">
              <input aria-label="Example message in the scripted preview" readOnly value={EXAMPLE_QUESTION} className="min-w-0 flex-1 bg-transparent text-[13px] p-text-3 outline-none" />
              <FilledButton type="submit" disabled={followup}>{followup ? 'Sent' : 'Send'}</FilledButton>
            </form>
            <div className="mt-2 flex items-center justify-between gap-2 text-[10px] p-text-4"><span>Scripted preview · no model request</span>{followup && <button type="button" onClick={() => setFollowup(false)} className="p-accent">Reset example</button>}</div>
          </div>
        </div>
        <aside className={`min-w-0 flex-col p-recessed ${mobilePane === 'workspace' ? 'flex' : 'hidden md:flex'}`}>
          <Tabs tabs={SURFACE_TABS} value={surface} onValueChange={setSurface} variant="underline" activateOnFocus className="landing-preview-tabs shrink-0 border-b p-border" />
          {surface === 'files' ? <div className="p-3.5"><PreviewFiles /></div>
            : surface === 'exploration' ? <div className="p-3.5"><PreviewExploration /></div>
            : surface === 'agent' ? <div className="p-3.5"><PreviewAgent /></div> : (
          <div className="flex flex-col gap-3.5 overflow-hidden p-3.5">
            <div data-decision-state={decision} className="overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--c-accent)_30%,transparent)] p-surface">
              {decision === 'pending' ? (
                <>
                  <div className="border-b border-dashed border-[var(--c-dash)] px-3.5 py-2 text-[11.5px] font-semibold p-accent">Needs you · 1</div>
                  <div className="px-3.5 py-3"><div className="mb-2 text-[12.5px]">Swarm search stopped early</div><div className="flex gap-2 text-[11px]"><button type="button" onClick={() => setDecision('retried')} className="rounded-full border border-[color-mix(in_srgb,var(--c-accent)_35%,transparent)] px-2.5 py-0.5 p-accent">Retry</button><button type="button" onClick={() => setDecision('dismissed')} className="rounded-full border p-border px-2.5 py-0.5 p-text-4">Dismiss</button></div></div>
                </>
              ) : (
                <div className="flex items-center justify-between gap-3 px-3.5 py-3"><span className={`text-[11.5px] ${decision === 'retried' ? 'p-success' : 'p-text-4'}`}>{decision === 'retried' ? 'Search restarted' : 'Decision dismissed'}</span><button type="button" onClick={() => setDecision('pending')} className="text-[10.5px] p-accent">Reset</button></div>
              )}
            </div>
            <div>
              <div className="mb-2 text-[11.5px] font-semibold p-text-4">Now · 2 active</div>
              <div className="overflow-hidden rounded-xl border p-border p-surface">
                <div className="flex items-start gap-2.5 px-3.5 py-2.5"><span className="mt-1 size-2 rounded-full p-dot-accent" /><span className="flex-1 text-xs p-text-2">Patch the slow dedupe path</span></div>
                <div className="flex items-start gap-2.5 border-t border-dashed border-[var(--c-dash)] px-3.5 py-2.5"><span className="mt-1 size-2 rounded-full p-dot-success" /><span className="flex-1 text-xs p-text-2">Add the regression case</span></div>
              </div>
            </div>
            <div>
              <div className="mb-2 text-[11.5px] font-semibold p-text-4">Journal</div>
              <div className="overflow-hidden rounded-xl border p-border p-surface">
                {[[CHANGE_KIND_GLYPH.tool, 'Crafted a tool: dedupe-bench', '2m'], [CHANGE_KIND_GLYPH.outcomes, 'Graded 2 turns', '18h'], [CHANGE_KIND_GLYPH.fact, 'Remembered the coupon schema', '19h']].map(([icon, label, age], index) => (
                  <div key={label} className={`flex items-baseline gap-2 px-3.5 py-2.5 ${index < 2 ? 'border-b border-dashed border-[var(--c-dash)]' : ''}`}><span className="text-[10px] p-accent">{icon}</span><span className="flex-1 text-xs p-text-2">{label}</span><span className="text-[10px] p-text-4">{age}</span></div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2.5 text-[11px] p-text-4"><span>612 MB</span><span className="h-1 flex-1 overflow-hidden rounded-full p-fill"><span className="block h-full w-[6%] p-dot-accent" /></span><span>10 GB</span></div>
          </div>
          )}
        </aside>
      </div>
    </div>
  );
}
