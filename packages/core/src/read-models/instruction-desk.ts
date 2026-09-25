/**
 * The owner's instruction-file desk (KINU-N028), one for both backends.
 *
 * The read model beside it (instruction-approvals.ts) stays pure; this is where
 * a host's planes meet it. What differs per backend is only where AGENTS.md is
 * discovered: the workspace planes and their sandbox on a Durable Object, the
 * working directory on the CLI.
 */

import {
  admitInstructionDecision,
  type AdmittedInstructionDecision, type InstructionApprovalStore, type InstructionTrustResolver,
} from '../safety/instruction-trust';
import type { SkillsVfs } from '../skills/discover';
import type { Page, PageRequest } from '../session/page';
import type { AgentsMdSources } from '../prompting/agents-md';
import { stepContextLimit, type ModelWindow } from '../context-window';
import {
  gatherApprovableInstructions, listInstructionApprovals, openInstructionSource,
  type InstructionSourceRow, type InstructionSourceView,
} from './instruction-approvals';

/** What the desk reads, per backend: where AGENTS.md is discovered, the skills
 *  plane, and the one approval store the turn classifies with. */
export interface InstructionDeskPort {
  /** Discovered fresh on every call: a digest shown from a stale read would
   *  authorize bytes that already moved. */
  readonly agentsMd: (window: ModelWindow, trust: InstructionTrustResolver) => Promise<AgentsMdSources>;
  readonly skillsVfs: SkillsVfs;
  readonly approvals: InstructionApprovalStore;
  readonly window: () => ModelWindow;
}

export class InstructionApprovalDesk {
  private readonly trust: InstructionTrustResolver;

  constructor(private readonly port: InstructionDeskPort) {
    this.trust = (path, content) => port.approvals.trustOf(path, content);
  }

  /** Every instruction file this workspace would carry, with what approving it
   *  would bind. A file with no owner decision is unverified however long it
   *  has sat on disk. */
  async list(request: PageRequest = {}): Promise<Page<InstructionSourceRow>> {
    const window = this.port.window();

    return listInstructionApprovals({
      ...request,
      sources: await gatherApprovableInstructions({
        agentsMd: await this.port.agentsMd(window, this.trust),
        skillsVfs: this.port.skillsVfs,
        admissionTokens: stepContextLimit(window),
      }),
      decisions: this.port.approvals.list(),
    });
  }

  /** One row, opened: the bytes of THAT file and nothing else. */
  async read(path: string): Promise<InstructionSourceView | null> {
    const clean = path.trim();

    if (clean === '') return null;
    const window = this.port.window();

    return openInstructionSource({
      path: clean,
      agentsMd: await this.port.agentsMd(window, this.trust),
      skillsVfs: this.port.skillsVfs,
      trust: this.trust,
      decisions: this.port.approvals.list(),
      admissionTokens: stepContextLimit(window),
    });
  }

  /**
   * The owner grants THESE bytes at THIS path system placement. The digest is
   * the one the owner was shown, re-checked against the file now, so the
   * approve/preview gap fails closed instead of granting force to bytes nobody
   * read.
   */
  async approve(path: string, reviewedDigest: string): Promise<AdmittedInstructionDecision> {
    const admitted = admitInstructionDecision(path, reviewedDigest);

    if (!admitted.ok) return admitted;
    const current = await this.read(admitted.path);

    if (!current || current.digest !== admitted.digest) {
      return { ok: false, error: 'the file changed or could not be read after review; read it again before approving' };
    }

    this.port.approvals.approve(admitted.path, admitted.digest);

    return admitted;
  }

  /** The owner withdraws trust from a path. The refusal is KEPT, so nothing
   *  re-grants it without the owner saying so again. */
  revoke(path: string): AdmittedInstructionDecision {
    const admitted = admitInstructionDecision(path);

    if (!admitted.ok) return admitted;
    this.port.approvals.revoke(admitted.path);

    return admitted;
  }
}
