/**
 * The seam, driven end to end on the LOCAL target — credential-free.
 *
 * WHY THIS EXISTS RATHER THAN LEAVING THE SEAM TO THE LIVE ARMS. Every wiring
 * defect the eval tier has ever shipped was silent: a runtime with no executors
 * built `execute_tools` with an empty provider surface and every `workspace.*`
 * call failed as an ordinary tool result (two graded runs reported 0.817 and
 * 0.903 over it); a runtime with no profile resolver killed eleven tests across
 * three suites; a degraded birth runtime produced `craft_reuse eligible 0` and
 * three flash runs blamed the corpus. Each of those is a property of the TARGET,
 * not of the model — so each is checkable with a scripted model, for free, in a
 * tier that reproduces anywhere.
 *
 * That is what this does. It asserts the local target is really wired, using
 * exactly the members a live suite reads, so a live arm's zero can no longer be
 * explained by the harness. The live arms then measure the agent, which is the
 * only thing they should have to be about.
 *
 * IT IS ALSO THE SHAPE THE CLOUD ARM TAKES. Every assertion below is about the
 * seam rather than about `bun:sqlite`, so the same expectations are the ones the
 * cloud target has to satisfy — and a difference between the two arms is then a
 * difference in the agent rather than in what the suite knew how to ask.
 *
 * WHY THE SPEND METER IS RESET IN TEARDOWN. `bun test ./tests/` is ONE process
 * over every file, so the module-level meter is shared. A scripted suite that
 * left its fake tokens in it would hand them to whichever live suite reported
 * next, and a cost report is the last place a fabricated number belongs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import type { LanguageModel } from 'ai';

import {
  ledgerTotalsFromEvents, resetLiveModelSpend, scriptedTurnModel, stepBoundEvidence,
  UNCONFIGURED_LLM, type AgentEvalTarget, type EvalTargetProbe, type ScriptedTurnResult,
} from '@kinu.run/test-utils';
import { provisionLocalTarget } from './target-local';

/** What the scripted agent writes, and reads back. A round trip rather than a
 *  bare write: a write that "succeeded" into a filesystem nothing can read is
 *  the degraded-runtime shape this suite exists to catch. */
const NOTE_PATH = 'seam-note.txt';
const NOTE_BODY = 'the seam wrote this';

/**
 * Three steps: write, read, answer.
 *
 * `file` is the tool because its input shape is stable and its effect is
 * observable through the seam's own `workspaceFiles()`. The third step finishes
 * with `stop`, so `stepBoundEvidence` has a NATURAL finish to report — which is
 * the value the capped-loop probe has to be able to tell apart from a cut.
 */
function threeStepAgent(): LanguageModel {
  let step = 0;
  // The V3 usage shape, spelled once. Every step reports the same cost, because
  // what these numbers have to prove is that the usage CHANNEL is live end to
  // end — provider to ledger to spend read model — not that any particular
  // figure is right.
  const usage: ScriptedTurnResult['usage'] = {
    inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 20, text: 20, reasoning: undefined },
  };
  const fileCall = (id: string, input: Record<string, string>): ScriptedTurnResult => ({
    content: [{ type: 'tool-call', toolCallId: id, toolName: 'file', input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage,
    warnings: [],
  });
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'seam-probe',
    doGenerate: (): ScriptedTurnResult => {
      step += 1;
      if (step === 1) {
        return fileCall('call-1', { action: 'write', path: NOTE_PATH, content: NOTE_BODY });
      }
      if (step === 2) return fileCall('call-2', { action: 'read', path: NOTE_PATH });
      return {
        content: [{ type: 'text', text: `I wrote and read ${NOTE_PATH}.` }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

describe('AgentEvalTarget — the local target is really wired', () => {
  const dir = join(tmpdir(), `kinu-seam-${String(Date.now())}`);
  let target: AgentEvalTarget;
  let probe: EvalTargetProbe;

  beforeAll(async () => {
    target = await provisionLocalTarget({
      dir,
      workspace: 'seam-local',
      purpose: 'A workspace that proves the eval target seam is wired.',
      llm: UNCONFIGURED_LLM,
      model: threeStepAgent(),
      evolution: false,
    });
    // BEFORE the turn, exactly as a live suite does it: a runtime that cannot
    // execute is not a measurement of an agent that can, and discovering it
    // afterwards costs a paid episode.
    probe = await target.probe();
    await target.sendTurn('Write a note and read it back.');
  }, 300_000);

  afterAll(async () => {
    await target?.teardown();
    // The scripted tokens do not leave this file. See the header.
    resetLiveModelSpend();
  });

  test('provisioning survives the checks a live suite makes before it spends', () => {
    // `provisionLocalTarget` throws on a runtime with no executors or one that
    // can reach the developer's machine, so reaching here IS those two facts.
    // Asserted anyway, because "it did not throw" is invisible in a report.
    expect(probe.executors.length).toBeGreaterThan(0);
    // Every plane must be one whose filesystem is not the developer's. A live
    // run once left `scratch-add/{add.js,add.test.js}` in a worktree root.
    expect(probe.executors.map((executor) => executor.kind)).toEqual(
      probe.executors.map(() => 'workspace'),
    );
  });

  test('the target reports whether the verifier can RUN, not whether a shell exists', () => {
    // The distinction is the whole point of `VerifierProbe`: production had a
    // shell that existed and could not run the only registered verifier kind.
    // This asserts the probe ANSWERED — either verdict is information — and that
    // an `unavailable` verdict carries a reason somebody can act on. A probe
    // that returned `unavailable` with an empty reason would be the old
    // existence check wearing a new name.
    expect(['runs', 'unavailable']).toContain(probe.verifier.kind);
    if (probe.verifier.kind === 'unavailable') {
      expect(probe.verifier.reason.length).toBeGreaterThan(20);
      console.warn(`[seam] the local workspace shell cannot run an exec-ratio harness: `
        + `${probe.verifier.reason}`);
      return;
    }
    expect(probe.verifier.evidence.length).toBeGreaterThan(0);
  });

  test('a turn writes a ledger the target can read back', async () => {
    const events = await target.runEvents();
    // Non-empty is the floor. A target whose `runEvents` returns nothing after a
    // settled turn is the zero-denominator defect at its source, and every
    // scorer downstream would report a clean zero over it.
    expect(events.length).toBeGreaterThan(0);
    const totals = ledgerTotalsFromEvents(events);
    expect(totals.turns).toBeGreaterThan(0);
    // Two `file` calls, because the script made two. This is the assertion that
    // proves the tool surface was really reachable: a runtime with an empty
    // provider surface answers `is not a function` and records zero.
    expect(totals.toolCalls).toBe(2);
    expect(totals.toolNames).toEqual(['file', 'file']);
    expect(totals.steps).toBeGreaterThanOrEqual(3);
    expect(totals.failures).toEqual([]);
    // The provider's own numbers reached the ledger. `?? 0` upstream makes an
    // unreported turn and a zero-token turn indistinguishable, so a non-zero
    // here is what says the usage channel is live at all.
    expect(totals.tokensIn).toBeGreaterThan(0);
  });

  test('the step-bound probe counts this episode\'s steps and its run bracket', async () => {
    const evidence = stepBoundEvidence(await target.runEvents());
    // THE STEP COUNT is the half that catches the cap, and it is what this
    // asserts: three scripted steps, three counted. On the cloud arm the same
    // read is what shows a turn stopping at exactly ten with the model still
    // calling tools — the defect no suite in this tree could reach.
    expect(evidence.steps).toBeGreaterThanOrEqual(3);
    // The run closed, so the bracket is readable. `run_end` with no reason reads
    // as `unstated` rather than being dropped, so this is non-empty either way.
    expect(evidence.runEndReasons.length).toBeGreaterThan(0);

    // `lastStepReason` is DELIBERATELY NOT asserted here, and the reason is a
    // limit of this fixture rather than a fact about the product. `step_finish`
    // carries the finish reason the turn accumulator reads off the SDK's own
    // `ctx.finishReason`, which at the `ai` facade is a plain string union
    // (`ai/dist/index.d.ts:108`). A scripted model supplies the PROVIDER-level
    // shape instead, so what reaches the accumulator here is the fixture's, not
    // a provider's — measured null on this run. A test cannot tell "the product
    // does not record it" from "my fake did not produce it", and a suite that
    // asserted either way would be reporting on its own scaffolding.
    //
    // So the reason half is asserted on the LIVE arms, where the provider is
    // real: that is where `truncated` beside a `completed` run_end means
    // something, and it is the pair the production incident turned on.
    console.warn(`[seam] scripted lastStepReason=${String(evidence.lastStepReason)} — not `
      + 'assertable under a fake provider; the reason half of the probe is a live-arm assertion');
  });

  test('the workspace filesystem the agent wrote is the one the seam reads', async () => {
    // The seam's `workspaceFiles()` and the agent's `file` tool must address one
    // set of bytes. Seeding a task through a filesystem the agent cannot see is
    // how a corpus produces unearned zeros, and it is not hypothetical: the
    // harness seeds through `rt.storage.vfs` for exactly this reason.
    const files = target.workspaceFiles();
    expect(await files.vfs.exists(NOTE_PATH)).toBe(true);
    expect(await files.vfs.readFile(NOTE_PATH, { encoding: 'utf8' })).toContain(NOTE_BODY);
  });

  test('the shell the verifier would use can run a command', async () => {
    // `verifyHardTask` grades through this channel, so a target whose `exec`
    // cannot answer would score every attempt zero for a reason that is not
    // about the agent.
    const run = await target.workspaceFiles().exec('echo seam-exec-ok');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('seam-exec-ok');
  });

  test('the search ledger and roster answer rather than throwing', async () => {
    // This turn ran no search and hired nobody, so every count is zero — and
    // that is the point. These five reads are what `agent://SwarmNoopRootCause`
    // used to rule out "the swarm started and died silently", so they have to be
    // REACHABLE on an ordinary turn. A read that throws on an empty table is a
    // read no suite can use as evidence of absence.
    expect(await target.searchLedger()).toEqual({
      searchRuns: 0, forkRuns: 0, canvasNodes: 0, recordObjectives: 0, backgroundJobs: 0,
    });
    expect(await target.roster()).toEqual([]);
  });

  test('the episode reports its spend through the shared read model', async () => {
    const spend = await target.spend();
    // The scripted provider reported usage, so the workspace must be able to
    // account for it. A zero here with a non-zero `tokensIn` in the ledger would
    // mean the two channels disagree — which is precisely the gap that made the
    // behavioural tier print `0 model call(s)` over an episode that spent
    // hundreds of thousands of neurons.
    expect(spend.total.calls).toBeGreaterThan(0);
    expect(spend.coverage.calls).toBeGreaterThan(0);
  });

  test('teardown removes what provisioning made', async () => {
    // Asserted last, and it really tears down: the local target owns a scratch
    // directory and a cloud target owns a workspace on a shared account, so
    // `teardown` is the member that keeps a failed run from leaving debris. The
    // account this tier ran against once held 23 unattributable test rows.
    expect(existsSync(dir)).toBe(true);
    await target.teardown();
    expect(existsSync(dir)).toBe(false);
  });
});
