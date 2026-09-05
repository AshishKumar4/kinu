/**
 * What each binding kind lets a gadget server do — the pure half.
 *
 * The host mints one loopback stub per manifest entry into the isolate's
 * `env`, and every call on a stub comes back to the owning object, which
 * asks THIS module what the call may reach before it touches anything:
 *
 *   files      a path, resolved under the binding's root and refused if it
 *              would leave it (`resolveGadgetFilePath`)
 *   workspace  a read model name, refused unless `sources.ts` lists it
 *              (`resolveGadgetDataSource`)
 *   mcp        a tool call, reviewed for the approval ladder
 *              (`reviewGadgetMcpCall`)
 *
 * The review for `mcp` is the gatekeeper. It answers the same question the
 * shell gate answers about a command — allow, or ask the owner — so it feeds
 * `decideApproval` (safety/approval-gate.ts) rather than a second ladder:
 * mode, then standing grants, then the interactive channel, then the deferral
 * queue. A read-only tool (the MCP `readOnlyHint` annotation) is an
 * observation and runs; anything else is a side effect and is the owner's
 * decision. Kinu does not simulate an outcome while the owner decides: the
 * gadget is told the call is queued and NOT run, which is the honesty rule
 * `safety/deferred-approval.ts` states for the agent's own commands.
 */

import type { JsonValue } from '../utils/json';
import { KinuError, refusalOf, type Refusal } from '../obs/index';
import type { ApprovalResult } from '../safety/approval-gate';
import { isGadgetDataSource, type GadgetDataSource } from './sources';
import type { GadgetMcpBinding } from './manifest';

/** The rule a side-effecting MCP call trips. One rule, so an owner's
 *  `always` grant scopes to "this gadget may act on this connection". */
export const GADGET_MCP_ACTION_RULE = 'gadget_mcp_action';

/** The executor a gadget's calls are judged on. Prefixed so a grant given
 *  to a gadget never answers for the agent's own shell, or the reverse. */
export function gadgetExecutor(slug: string): string {
  return `gadget:${slug}`;
}

/**
 * A path a `files` binding may touch: `requested` joined under `root`, with
 * every `.` and `..` segment resolved, refused when the result leaves the
 * root. Absolute paths are refused outright rather than re-rooted — a
 * gadget that wrote `/home/user/SOUL.md` meant that file, and a silent
 * rewrite would hide the refusal it deserves.
 */
export function resolveGadgetFilePath(root: string, requested: string): { ok: true; path: string } | ({ ok: false } & Refusal) {
  if (requested.startsWith('/') || requested.includes('\0')) {
    return { ok: false, ...refusalOf(new KinuError('denied',
      `"${requested}" is outside this binding: paths are relative to ${root}/`)) };
  }
  const segments: string[] = [];
  for (const segment of requested.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        return { ok: false, ...refusalOf(new KinuError('denied',
          `"${requested}" leaves ${root}/, which is all this binding reaches`)) };
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { ok: true, path: segments.length === 0 ? root : `${root}/${segments.join('/')}` };
}

/** The read model a `workspace` binding may read, or the refusal. */
export function resolveGadgetDataSource(name: string): { ok: true; source: GadgetDataSource } | ({ ok: false } & Refusal) {
  if (!isGadgetDataSource(name)) {
    return { ok: false, ...refusalOf(new KinuError('denied',
      `"${name}" is not a workspace read model a gadget may read`)) };
  }
  return { ok: true, source: name };
}

/** An MCP tool as the connection describes it: the one annotation the
 *  gatekeeper reads. Absent annotations are a side effect until proven
 *  otherwise. */
export interface GadgetMcpTool {
  readonly name: string;
  readonly readOnly: boolean;
}

export interface GadgetMcpReview {
  /** What the owner is shown, and what a standing grant is keyed on. */
  readonly subject: { readonly command: string; readonly executor: string };
  readonly review: ApprovalResult;
}

/**
 * Review one MCP call from a gadget.
 *
 * Refused before any ladder runs when the manifest did not introduce the
 * tool (`denied`) or the connection does not offer it (`missing`). Otherwise
 * the review says whether the owner is asked.
 */
export function reviewGadgetMcpCall(input: {
  readonly slug: string;
  readonly binding: GadgetMcpBinding;
  readonly tool: string;
  readonly args: JsonValue;
  /** The connection's tools, as the owner's UserDO describes them. */
  readonly tools: readonly GadgetMcpTool[];
}): { ok: true; review: GadgetMcpReview } | ({ ok: false } & Refusal) {
  const { slug, binding, tool, args } = input;
  if (binding.tools !== undefined && !binding.tools.includes(tool)) {
    return { ok: false, ...refusalOf(new KinuError('denied',
      `gadget "${slug}" did not introduce tool "${tool}" on ${binding.server}: its manifest lists ${binding.tools.join(', ') || 'no tools'}`)) };
  }
  const described = input.tools.find((candidate) => candidate.name === tool);
  if (!described) {
    return { ok: false, ...refusalOf(new KinuError('missing',
      `connection ${binding.server} offers no tool named "${tool}"`)) };
  }
  const subject = {
    command: `mcp ${binding.server}/${tool} ${JSON.stringify(args)}`,
    executor: gadgetExecutor(slug),
  };
  const review: ApprovalResult = described.readOnly
    ? { decision: 'allow', hits: [] }
    : {
      decision: 'gate',
      hits: [{
        decision: 'gate',
        rule: GADGET_MCP_ACTION_RULE,
        explanation: `${binding.server}/${tool} has side effects and gadget "${slug}" is calling it`,
      }],
    };
  return { ok: true, review: { subject, review } };
}
