/**
 * Each viewer's own account as a personal part reaches it, faked where it holds the connections and decided as the real
 * account decides: `resolvePartCall` over their connections' tools, `partCallVerdict` on their consents, and one effect per
 * approval (`EffectApprovals`). Every call a connection received is logged, so a test sees what was dispatched.
 */
import {
  canonicalRoot, EffectApprovals, partCallVerdict, resolvePartCall,
  type EffectCall, type SlateConsent } from '@kinu.run/core/slates';
import type { JsonValue } from '@kinu.run/core';
import type { PartAiAnswer, PartConnectionAnswer } from '@kinu.run/core/slates';
import type { PartConnections, PartToolCall, PartViewer } from '../../src/slates/part-runs';

/**
 * Each viewer's connections' tools, as their account's descriptors name them: GitHub is the GitHub preset, whose tools
 * are scoped to the repository their owner and repo name (share-policy.ts); its reads are read-only and closed-world.
 * Fetch is no preset's, and its get may reach anywhere.
 */
const TOOLS = [
  { serverName: 'GitHub', name: 'issue_read', presetId: 'github', readOnly: true, closedWorld: true },
  { serverName: 'GitHub', name: 'add_issue_comment', presetId: 'github' },
  { serverName: 'GitHub', name: 'search_issues', presetId: 'github', readOnly: true, closedWorld: true },
  { serverName: 'Fetch', name: 'get', readOnly: true },
] as const;

/** What a viewer's private issue says: theirs alone. */
export function privateIssue(email: string): string {
  return `${email}-private-17`;
}

export class FakeViewerAccounts implements PartConnections {
  readonly dispatched: string[] = [];
  /** Run once, while the next call is out at its viewer's account: what happens meanwhile (a revoke, say). */
  duringNext: (() => void) | null = null;
  /** Holds the next model call until a tool call is answered: a slow model and a fast read made at once. */
  private modelHeld: ReturnType<typeof Promise.withResolvers<undefined>> | null = null;

  /** The next model call answers only after the next tool call has: completion order unlike the order they were made in. */
  holdModelForNextTool(): void {
    this.modelHeld = Promise.withResolvers<undefined>();
  }

  /** The next model call streams only once let go (`releaseStream`), and the next tool call is read only after it was asked. */
  private streamHeld: { readonly asked: ReturnType<typeof Promise.withResolvers<undefined>>; readonly bytes: ReturnType<typeof Promise.withResolvers<undefined>> } | null = null;

  holdStreamOnce(): void {
    this.streamHeld = { asked: Promise.withResolvers<undefined>(), bytes: Promise.withResolvers<undefined>() };
  }

  releaseStream(): void {
    this.streamHeld?.bytes.resolve(undefined);
    this.streamHeld = null;
  }

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
    await this.streamHeld?.asked.promise;
    await Promise.resolve();
    before?.();
    admit();
    const resolved = resolvePartCall(TOOLS, call);

    if (resolved.kind === 'missing') return { kind: 'missing', message: `${viewer.email}'s ${call.server} offers no ${call.tool}` };

    if (resolved.kind === 'malformed') return Promise.reject(new Error(`${call.server}.${call.tool} takes one JSON object argument.`));
    const { payload, call: { root } } = resolved;
    const consent = this.consents.get(JSON.stringify([viewer.email, call.workspace, call.slate, call.server, canonicalRoot(root)])) ?? null;
    const verdict = partCallVerdict(consent, resolved.call, call.revision, false);

    if (verdict.kind === 'needs-consent') return verdict;
    const effect: EffectCall = { workspace: call.workspace, slate: call.slate, revision: call.revision, server: call.server, tool: call.tool, root, payload };

    if (verdict.kind === 'needs-approval' && !this.book(viewer.email).take(effect)) {
      return { kind: 'needs-approval', ask: this.book(viewer.email).ask(effect) };
    }

    this.dispatched.push(`${viewer.email} ${call.server}.${call.tool} ${JSON.stringify(payload)}`);
    const during = this.duringNext;

    this.duringNext = null;
    during?.();

    // Answered: a model held for it may answer now, after this.
    this.modelHeld?.resolve(undefined);

    return { kind: 'ran', value: call.tool === 'issue_read' ? { secret: privateIssue(viewer.email) } : `${call.tool} done` };
  }

  async ai(viewer: PartViewer, call: Parameters<PartConnections['ai']>[1], admit: () => void): Promise<PartAiAnswer> {
    const held = this.modelHeld;

    // Held until a tool call answers (which resolves it), then let go for good.
    await held?.promise;

    if (this.modelHeld === held) this.modelHeld = null;
    admit();
    this.modelAsked += 1;
    this.dispatched.push(`${viewer.email} ai ${call.route.stream === true ? 'stream' : 'run'}`);
    const text = `${viewer.email}'s own model, reply ${this.modelAsked}`;

    if (call.route.stream !== true) return { kind: 'ran', value: text };
    const streamHeld = this.streamHeld;

    streamHeld?.asked.resolve(undefined);

    return { kind: 'ran', value: new ReadableStream<Uint8Array>({ async pull(controller) { await streamHeld?.bytes.promise; controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }) };
  }

  consented(viewer: PartViewer, calls: readonly PartToolCall[]): Promise<readonly boolean[]> {
    return Promise.resolve(calls.map((call) => {
      if (call.server === 'ai') return true;
      const resolved = resolvePartCall(TOOLS, call);

      if (resolved.kind !== 'resolved') return false;
      const consent = this.consents.get(JSON.stringify([viewer.email, call.workspace, call.slate, call.server, canonicalRoot(resolved.call.root)])) ?? null;

      return partCallVerdict(consent, resolved.call, call.revision, true).kind === 'run';
    }));
  }

  /** Takes back a consent, as its viewer may at any time. */
  withdraw(email: string, consent: Pick<SlateConsent, 'workspace' | 'slate' | 'server' | 'root'>): void {
    this.consents.delete(JSON.stringify([email, consent.workspace, consent.slate, consent.server, canonicalRoot(consent.root)]));
  }
}
