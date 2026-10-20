/**
 * The one forwarding policy a program's HTTP request meets, whichever egress carries it (audit SelfishJaguar #6): the
 * container's and a Nimbus workspace's (`KinuEgress`) and a codemode program's or a slate's (`CodemodeEgress`). Whom it
 * runs for decides (`egressAuthority`): the owner's opens the workspace's own previews with its pass, spends the owner's
 * secrets and has its GitHub work recorded; a share's viewer's does none of these. An egress supplies only what its
 * runtime has: this Worker's own fetch, and where the owner's GitHub work is recorded (`githubRecorder`, the same for both).
 */
import { Effect } from 'effect';
import { getAgentByName, type Agent } from 'agents';
import {
  egressAuthority, refusedHostname,
  type EgressPrincipal, type GitHubFact, type GitHubRecorder, type LabelSignerEnv, type PreviewSuffixEnv,
} from '@kinu.run/core';
import { diagnostics, KinuError, logged, settle, type Refusal } from '@kinu.run/core/obs';
import { selfPreviewPass, verifiedPreview } from '../viewer-pass';
import { EGRESS_FAILURE_HEADER, refusal, sendOut, type ContainerEgressEnv } from './send-out';

export type EgressPolicyEnv = PreviewSuffixEnv & LabelSignerEnv & ContainerEgressEnv<unknown>;

type OwnerPrincipal = Extract<EgressPrincipal, { as: 'owner' }>;

export interface EgressSeams {
  /** This Worker's own fetch (`enable_ctx_exports`), which serves the workspace's previews; absent outside workerd. */
  readonly self: Pick<Fetcher, 'fetch'> | undefined;
  /** Where the owner's GitHub work is recorded; asked only for a request whose principal's work is the owner's. */
  readonly github: (owner: OwnerPrincipal) => GitHubRecorder;
  /** Which egress refused, in what it reports. */
  readonly seam: 'container' | 'codemode';
}

/** The workspace object, as far as recording GitHub work needs it; `OrchestratorAgent` is one. */
export type GitHubWorkspace = Agent & { recordGitHubEgress(facts: readonly GitHubFact[], actorId: string | null): Promise<void> };

/** Every egress's recorder: the owner's GitHub work, on its workspace, for the agent the principal names. */
export function githubRecorder<Workspace extends GitHubWorkspace>(workspaces: DurableObjectNamespace<Workspace>, execution: Pick<ExecutionContext, 'waitUntil'>): EgressSeams['github'] {
  return (owner) => new GitHubEgressRecorder(workspaces, execution, owner);
}

class GitHubEgressRecorder<Workspace extends GitHubWorkspace> implements GitHubRecorder {
  constructor(
    private readonly workspaces: DurableObjectNamespace<Workspace>,
    private readonly execution: Pick<ExecutionContext, 'waitUntil'>,
    private readonly principal: OwnerPrincipal,
  ) {}

  waitUntil(work: Promise<unknown>): void {
    this.execution.waitUntil(work);
  }

  record(facts: readonly GitHubFact[]): Promise<void> {
    return settle(logged('egress.github_record_failed', { doing: 'recording GitHub work in its workspace', otherwise: 'unavailable' }, async () => {
      if (facts.length === 0) return;
      const agent = await getAgentByName(this.workspaces, this.principal.workspace);

      await agent.recordGitHubEgress(facts, this.principal.actorId);
    }));
  }
}

/**
 * The workspace's own program fetching one of its previews: the preview opens only for its owner, and this is the owner's
 * workspace asking (`nimbus-route.ts`). The pass goes first, so a cookie of the program's own by its name never shadows it.
 */
async function withSelfPass(request: Request, env: EgressPolicyEnv, workspace: string, url: URL): Promise<Request> {
  const pass = await selfPreviewPass(env, workspace, url);

  if (pass === null) return request;
  const headers = new Headers(request.headers);

  headers.set('cookie', [`${pass.name}=${pass.value}`, request.headers.get('cookie')].filter((part) => part !== null && part !== '').join('; '));

  return new Request(request, { headers });
}

/** One classifier refuses at every seam; one shape keeps them comparable, marked so a program's `fetch` throws it. */
function destinationRefusal(host: string, payload: Refusal, seam: EgressSeams['seam']): Response {
  diagnostics.failure('egress.private_destination', new KinuError('denied', payload.error), { host, seam });

  return Response.json(payload, { status: 403, headers: { [EGRESS_FAILURE_HEADER]: '1' } });
}

/** `request` judged and sent for `principal`; undefined is an egress not configured yet, which forwards nothing. */
export function forwardEgress(request: Request, env: EgressPolicyEnv, principal: EgressPrincipal | undefined, seams: EgressSeams): Promise<Response> {
  return settle(Effect.gen(function* () {
    if (principal === undefined) return refusal(503, 'Egress interception is not configured for this container yet.');
    const url = new URL(request.url);
    const authority = egressAuthority(principal);
    const { self } = seams;
    // Judged first: a local preview host is loopback, which the destination check refuses.
    const ownPreview = self !== undefined && (yield* Effect.promise(async () => verifiedPreview(env, url.hostname)))?.workspace === principal.workspace;

    // Served by this Worker, never the network: with the workspace's pass for the owner's, as no one for a viewer's.
    if (self !== undefined && ownPreview) {
      return yield* Effect.promise(async () => self.fetch(authority.selfPass ? await withSelfPass(request, env, principal.workspace, url) : request));
    }

    const destination = refusedHostname(url.hostname);

    if (destination !== null) return destinationRefusal(url.hostname, destination, seams.seam);
    const github = authority.recordsGitHub && principal.as === 'owner' ? seams.github(principal) : undefined;

    return yield* sendOut(request, env, authority.vault, github);
  }));
}
