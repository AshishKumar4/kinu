/**
 * Each viewer's own account as a personal part reaches it, faked where it holds the connections and decided as the real
 * account decides: `partCallVerdict` on their consents, `containedTool` on the tool's own marks, and one effect per
 * approval (`EffectApprovals`). Every call a connection received is logged, so a test sees what was dispatched.
 */
import {
  canonicalRoot, containedTool, EffectApprovals, partCallRoot, partCallVerdict,
  type EffectCall, type SlateConsent,
} from '@kinu.run/core/slates';
import type { JsonValue } from '@kinu.run/core';
import type { PartAiAnswer, PartConnectionAnswer } from '@kinu.run/core/slates';
import type { PartConnections, PartToolCall, PartViewer } from '../../src/slates/part-runs';

/** Each server's tools by their own marks: GitHub's read is read-only and closed-world; Fetch's get may reach anywhere. */
interface ToolMarks {
  readonly readOnly?: true;
  readonly closedWorld?: true;
}

const TOOLS = new Map<string, ReadonlyMap<string, ToolMarks>>([
  ['mcp.GitHub', new Map<string, ToolMarks>([['read_issue', { readOnly: true, closedWorld: true }], ['create_issue', {}]])],
  ['mcp.Fetch', new Map<string, ToolMarks>([['get', { readOnly: true }]])],
]);

/** What a viewer's private issue says: theirs alone. */
export function privateIssue(email: string): string {
  return `${email}-private-17`;
}

export class FakeViewerAccounts implements PartConnections {
  readonly dispatched: string[] = [];
  /** Run once, while the next call is out at its viewer's account: what happens meanwhile (a revoke, say). */
  duringNext: (() => void) | null = null;
  /** Run once, while the next call is being prepared, before the run's word is read again at the send. */
  beforeNextSend: (() => void) | null = null;
  private readonly consents = new Map<string, SlateConsent>();
  private readonly approvals = new Map<string, EffectApprovals>();

  private book(email: string): EffectApprovals {
    const book = this.approvals.get(email) ?? new EffectApprovals();

    this.approvals.set(email, book);

    return book;
  }

  consent(email: string, consent: SlateConsent): void {
    this.consents.set(JSON.stringify([email, consent.workspace, consent.slate, consent.server, canonicalRoot(consent.root)]), consent);
  }

  decide(email: string, id: string, approve: boolean): boolean {
    return this.book(email).decide(id, approve);
  }

  /** How many times each viewer's own model was asked: each reply is new text, so a replay shows whether it was asked again. */
  private modelAsked = 0;

  async tool(viewer: PartViewer, call: Parameters<PartConnections['tool']>[1], admit: () => void): Promise<PartConnectionAnswer<JsonValue>> {
    // Prepared as the orchestrator prepares the viewer's account (its caller awaited), then the send's word.
    const before = this.beforeNextSend;

    this.beforeNextSend = null;
    await Promise.resolve();
    before?.();
    admit();
    const descriptor = TOOLS.get(call.server)?.get(call.tool);

    if (descriptor === undefined) return { kind: 'missing', message: `${viewer.email}'s ${call.server} offers no ${call.tool}` };
    const payload: JsonValue = call.args.length === 1 ? call.args[0] ?? null : call.args;
    const root = partCallRoot(call.server, payload);
    const consent = this.consents.get(JSON.stringify([viewer.email, call.workspace, call.slate, call.server, canonicalRoot(root)])) ?? null;
    const verdict = partCallVerdict(consent, { server: call.server, root, tool: call.tool, contained: containedTool(descriptor) }, call.revision, false);

    if (verdict.kind === 'needs-consent') return verdict;
    const effect: EffectCall = { workspace: call.workspace, slate: call.slate, revision: call.revision, server: call.server, tool: call.tool, root, payload };

    if (verdict.kind === 'needs-approval' && !this.book(viewer.email).take(effect)) {
      return { kind: 'needs-approval', ask: this.book(viewer.email).ask(effect) };
    }

    this.dispatched.push(`${viewer.email} ${call.server}.${call.tool} ${JSON.stringify(payload)}`);
    const during = this.duringNext;

    this.duringNext = null;
    during?.();

    return { kind: 'ran', value: call.tool === 'read_issue' ? { secret: privateIssue(viewer.email) } : `${call.tool} done` };
  }

  ai(viewer: PartViewer, call: Parameters<PartConnections['ai']>[1], admit: () => void): Promise<PartAiAnswer> {
    admit();
    this.modelAsked += 1;
    this.dispatched.push(`${viewer.email} ai ${call.route.stream === true ? 'stream' : 'run'}`);
    const text = `${viewer.email}'s own model, reply ${this.modelAsked}`;

    if (call.route.stream !== true) return Promise.resolve({ kind: 'ran', value: text });

    return Promise.resolve({ kind: 'ran', value: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }) });
  }

  consented(viewer: PartViewer, calls: readonly PartToolCall[]): Promise<readonly boolean[]> {
    return Promise.resolve(calls.map((call) => {
      if (call.server === 'ai') return true;
      const descriptor = TOOLS.get(call.server)?.get(call.tool);
      const root = partCallRoot(call.server, call.args.length === 1 ? call.args[0] ?? null : call.args);
      const consent = this.consents.get(JSON.stringify([viewer.email, call.workspace, call.slate, call.server, canonicalRoot(root)])) ?? null;

      return descriptor !== undefined && partCallVerdict(consent, { server: call.server, root, tool: call.tool, contained: containedTool(descriptor) }, call.revision, true).kind === 'run';
    }));
  }

  /** Takes back a consent, as its viewer may at any time. */
  withdraw(email: string, consent: Pick<SlateConsent, 'workspace' | 'slate' | 'server' | 'root'>): void {
    this.consents.delete(JSON.stringify([email, consent.workspace, consent.slate, consent.server, canonicalRoot(consent.root)]));
  }
}
