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
import type { PartConnections, PartViewer } from '../../src/slates/part-runs';

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

  tool(viewer: PartViewer, call: Parameters<PartConnections['tool']>[1]): Promise<PartConnectionAnswer<JsonValue>> {
    const descriptor = TOOLS.get(call.server)?.get(call.tool);

    if (descriptor === undefined) return Promise.resolve({ kind: 'missing', message: `${viewer.email}'s ${call.server} offers no ${call.tool}` });
    const payload: JsonValue = call.args.length === 1 ? call.args[0] ?? null : call.args;
    const root = partCallRoot(call.server, payload);
    const consent = this.consents.get(JSON.stringify([viewer.email, call.workspace, call.slate, call.server, canonicalRoot(root)])) ?? null;
    const verdict = partCallVerdict(consent, { server: call.server, root, tool: call.tool, contained: containedTool(descriptor) }, call.revision, false);

    if (verdict.kind === 'needs-consent') return Promise.resolve(verdict);
    const effect: EffectCall = { workspace: call.workspace, slate: call.slate, revision: call.revision, server: call.server, tool: call.tool, root, payload };

    if (verdict.kind === 'needs-approval' && !this.book(viewer.email).take(effect)) {
      return Promise.resolve({ kind: 'needs-approval', ask: this.book(viewer.email).ask(effect) });
    }

    this.dispatched.push(`${viewer.email} ${call.server}.${call.tool} ${JSON.stringify(payload)}`);
    const during = this.duringNext;

    this.duringNext = null;
    during?.();

    return Promise.resolve({ kind: 'ran', value: call.tool === 'read_issue' ? { secret: privateIssue(viewer.email) } : `${call.tool} done` });
  }

  ai(viewer: PartViewer): Promise<PartAiAnswer> {
    return Promise.resolve({ kind: 'ran', value: `${viewer.email}'s own model` });
  }
}
