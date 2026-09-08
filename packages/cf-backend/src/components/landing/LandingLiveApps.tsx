import { Button } from '@cloudflare/kumo';
import { ArrowDownIcon, ArrowRightIcon, ArrowsClockwiseIcon, CloudIcon, FileTextIcon, FolderIcon, GitBranchIcon, LaptopIcon, ShieldCheckIcon, SquaresFourIcon } from '@phosphor-icons/react';
import { useState, type ReactElement } from 'react';

const SOURCES = {
  issues: { id: 'issues', label: 'Issue tracker', detail: 'MCP · allowed read tools', icon: GitBranchIcon },
  laptop: { id: 'laptop', label: 'Your laptop', detail: 'Device · approved folder', icon: LaptopIcon },
  workspace: { id: 'workspace', label: 'Workspace files', detail: 'Cloud · durable source', icon: FolderIcon },
} as const;
const SOURCE_OPTIONS = Object.values(SOURCES);
type Source = keyof typeof SOURCES;
type DeviceState = 'online' | 'offline' | 'revoked';

const DEVICE_STATES = {
  online: { label: 'Online', tone: 'p-success', explanation: 'The sample laptop is online. Reads stay inside the approved projects/shop folder.' },
  offline: { label: 'Offline', tone: 'p-warning', explanation: 'The laptop is offline. Its files are unavailable until it reconnects. Cloud work and MCP reads can continue.' },
  revoked: { label: 'Access revoked', tone: 'p-danger', explanation: 'Device consent is revoked. Reconnecting does not restore access. The owner must approve access again.' },
} as const;

const SAMPLE_ISSUES = [
  { id: '#142', title: 'Fix coupon validation', state: 'In progress', nextState: 'Ready for review' },
  { id: '#139', title: 'Check checkout totals', state: 'Open', nextState: 'In progress' },
  { id: '#136', title: 'Update receipt copy', state: 'Ready for review', nextState: 'Ready for review' },
];
const SAMPLE_FILES = {
  laptop: [
    { name: 'src/checkout.ts', detail: 'Checkout handler' },
    { name: 'tests/coupon.test.ts', detail: 'Coupon checks' },
    { name: 'notes/review.txt', detail: 'Local review notes' },
  ],
  workspace: [
    { name: 'package.json', detail: 'Runtime and allowed bindings' },
    { name: 'server.ts', detail: 'Worker routes and source reads' },
    { name: 'client.ts', detail: 'Dashboard interface' },
  ],
};

export function LandingLiveApps(): ReactElement {
  const [source, setSource] = useState<Source>('issues');
  const [device, setDevice] = useState<DeviceState>('online');
  const [snapshot, setSnapshot] = useState(0);
  const deviceStatus = DEVICE_STATES[device];
  const laptopUnavailable = source === 'laptop' && device !== 'online';
  const selectedSource = SOURCES[source];

  return (
    <section id="devices" aria-labelledby="live-apps-title" className="border-t p-border py-20 lg:py-[104px]">
      <div className="landing-shell">
        <div className="mb-4 text-[13px] font-semibold p-accent">03 · Devices &amp; live apps</div>
        <div className="mb-10 grid gap-5 lg:grid-cols-[1.1fr_1fr] lg:items-end lg:gap-16">
          <h2 id="live-apps-title" className="max-w-[650px] text-[clamp(30px,3.4vw,44px)] font-semibold leading-[1.08] tracking-[-.03em] text-pretty">
            Your tools and files.<br /><span className="p-accent">An app built around them.</span>
          </h2>
          <p className="max-w-[540px] text-[17px] leading-[1.65] p-text-3">
            Let your agent build a live app, called a slate, from workspace files, MCP tools, and connected devices.
            You choose what it can access.
          </p>
        </div>

        <ol aria-label="From agent to live app" className="mb-6 grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center">
          <li className="flex items-center gap-3"><CloudIcon size={23} className="shrink-0 p-accent" aria-hidden="true" /><div><div className="text-sm font-semibold">Agent authors the app</div><div className="mt-0.5 text-xs p-text-3">Source stays in the workspace</div></div></li>
          <li aria-hidden="true" className="pl-1 p-text-4"><ArrowRightIcon size={18} className="hidden sm:block" /><ArrowDownIcon size={18} className="sm:hidden" /></li>
          <li className="flex items-center gap-3"><ShieldCheckIcon size={23} className="shrink-0 p-accent" aria-hidden="true" /><div><div className="text-sm font-semibold">Allowed sources only</div><div className="mt-0.5 text-xs p-text-3">Files · MCP tools · devices</div></div></li>
          <li aria-hidden="true" className="pl-1 p-text-4"><ArrowRightIcon size={18} className="hidden sm:block" /><ArrowDownIcon size={18} className="sm:hidden" /></li>
          <li className="flex items-center gap-3"><SquaresFourIcon size={23} className="shrink-0 p-accent" aria-hidden="true" /><div><div className="text-sm font-semibold">Open the live app</div><div className="mt-0.5 text-xs p-text-3">Compiled Worker preview</div></div></li>
        </ol>

        <div className="overflow-hidden rounded-2xl border p-border p-surface shadow-[0_24px_70px_-40px_var(--c-shadow-drop)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-border p-recessed px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3"><SquaresFourIcon size={21} className="p-accent" aria-hidden="true" /><h3 className="text-sm font-semibold">Workspace operations</h3></div>
            <span className="rounded-full border p-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.08em] p-text-3">Interactive example</span>
          </div>
          <div className="grid md:grid-cols-[248px_minmax(0,1fr)]">
            <aside className="min-w-0 border-b p-border p-recessed p-5 md:border-b-0 md:border-r">
              <div className="mb-3 font-mono text-[10px] uppercase tracking-[.14em] p-text-4">Sources</div>
              <div aria-label="Dashboard source" className="grid gap-1.5">
                {SOURCE_OPTIONS.map(({ id, label, detail, icon: Icon }) => (
                  <button key={id} type="button" aria-pressed={source === id} onClick={() => setSource(id)} className={`flex min-h-16 items-start gap-3 rounded-lg border px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-accent)] ${source === id ? 'p-border p-elevated' : 'border-transparent hover:p-elevated'}`}>
                    <Icon size={18} className={`mt-0.5 shrink-0 ${source === id ? 'p-accent' : 'p-text-3'}`} aria-hidden="true" />
                    <span className="min-w-0"><span className="block text-[13px] font-semibold">{label}</span><span className={`mt-1 block text-[11px] ${id === 'laptop' ? deviceStatus.tone : 'p-text-3'}`}>{id === 'laptop' ? deviceStatus.label : detail}</span></span>
                  </button>
                ))}
              </div>
              <div className="mt-5 border-t p-border pt-4">
                <label htmlFor="sample-device-state" className="mb-2 block text-xs font-medium p-text-2">Try a device state</label>
                <select id="sample-device-state" value={device} onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value === 'online' || value === 'offline' || value === 'revoked') {
                    setDevice(value);
                    setSource('laptop');
                  }
                }} className="min-h-10 w-full rounded-lg border p-border p-surface px-2.5 text-xs p-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-accent)]">
                  <option value="online">Online · consent granted</option>
                  <option value="offline">Offline</option>
                  <option value="revoked">Consent revoked</option>
                </select>
                <p className="mt-2 text-[11px] leading-relaxed p-text-4">Sample device only. No connection to your machine.</p>
              </div>
            </aside>

            <div className="min-w-0 p-5 sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><div className="mb-1.5 font-mono text-[10px] uppercase tracking-[.12em] p-accent">Shop / operations</div><h4 className="text-[24px] font-semibold tracking-[-.025em]">{selectedSource.label}</h4></div>
                <Button variant="secondary" size="sm" icon={<ArrowsClockwiseIcon size={15} />} onClick={() => setSnapshot((value) => value + 1)}>Refresh sample</Button>
              </div>
              <p role="status" className="mb-6 mt-2 text-xs leading-relaxed p-text-3">
                Sample read {snapshot + 1} · {laptopUnavailable ? 'Device read refused. No file data returned.' : 'Simulated data. No network request.'}
              </p>

              {source === 'issues' ? (
                <>
                  <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-y p-border py-4">
                    <div><span className="text-3xl font-semibold tracking-tight">3</span><span className="ml-2 text-xs p-text-3">tracked issues</span></div>
                    <span className="text-xs p-text-3">{snapshot % 2 === 0 ? '1 ready for review' : '2 ready for review'} · sample snapshot {snapshot % 2 + 1}</span>
                  </div>
                  <ul aria-label="Sample issues" className="divide-y divide-[var(--c-border)]">
                    {SAMPLE_ISSUES.map((issue) => (
                      <li key={issue.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                        <div className="flex items-start gap-3"><span className="pt-0.5 font-mono text-[11px] p-text-4">{issue.id}</span><span className="text-[13px] font-medium">{issue.title}</span></div>
                        <span className="rounded-md p-accent-subtle px-2 py-1 text-[11px] p-accent">{snapshot % 2 === 0 ? issue.state : issue.nextState}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed p-text-3"><ShieldCheckIcon size={16} className="shrink-0 p-accent" aria-hidden="true" />MCP reads use allowed tools on an owner-configured connection.</p>
                </>
              ) : (
                <>
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-y p-border py-4">
                    <code className="break-all text-xs p-text-3">{source === 'laptop' ? '~/projects/shop' : '/home/user/slates/operations'}</code>
                    <span className={`text-xs font-medium ${source === 'laptop' ? deviceStatus.tone : 'p-success'}`}>{source === 'laptop' ? deviceStatus.label : 'Source saved'}</span>
                  </div>
                  {laptopUnavailable ? (
                    <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-border p-recessed px-5 py-6 text-center">
                      <LaptopIcon size={30} className={deviceStatus.tone} aria-hidden="true" />
                      <h5 className="text-sm font-semibold">{device === 'offline' ? 'Laptop files are unavailable' : 'Device access is blocked'}</h5>
                      <p className="max-w-[390px] text-xs leading-relaxed p-text-3">{deviceStatus.explanation}</p>
                    </div>
                  ) : (
                    <ul aria-label="Sample files" className="divide-y divide-[var(--c-border)]">
                      {SAMPLE_FILES[source].map((file) => <li key={file.name} className="flex items-start gap-3 py-3.5"><FileTextIcon size={18} className="mt-0.5 shrink-0 p-text-4" aria-hidden="true" /><div className="min-w-0"><code className="block break-all text-xs p-text-2">{file.name}</code><span className="mt-1 block text-[11px] p-text-3">{file.detail}</span></div></li>)}
                    </ul>
                  )}
                  <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed p-text-3"><ShieldCheckIcon size={16} className="shrink-0 p-accent" aria-hidden="true" />{source === 'laptop' ? 'Remote access needs device consent and an online machine. You can revoke consent.' : 'Source and versions are durable. App memory is not durable storage.'}</p>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap justify-between gap-2 border-t p-border p-recessed px-5 py-3 text-[11px] leading-relaxed p-text-3 sm:px-6"><span>Example UI and sample data, not a running slate.</span><span>Refresh cycles two issue snapshots.</span></div>
        </div>

        <details className="mt-6 border-b p-border pb-5">
          <summary className="w-fit cursor-pointer rounded text-[13px] font-medium p-text-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--c-accent)]">How a live app runs</summary>
          <div className="mt-4 grid gap-4 text-[13px] leading-[1.7] p-text-3 md:grid-cols-2 md:gap-12">
            <p>The agent writes a Worker app. Kinu compiles it and opens a preview. Bindings expose only admitted files, MCP tools, and device actions. A binding declaration does not grant permission.</p>
            <p>Raw credentials do not go to the preview iframe. Save lasting app state in workspace files or another allowed storage capability. A cloud agent can continue without your laptop; its device files remain unavailable while offline.</p>
          </div>
        </details>
      </div>
    </section>
  );
}
