// A report's trials as Markdown for a reviewer that reads files line by line. Every multi-line
// string, which is where the agent's code lives, becomes a fenced block, and a line is cut into
// pieces before a reader's line limit would drop its tail.
import { basename } from 'node:path';
import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import { redact } from './redact';
import { parseResults, trials, type Assertion, type HarnessRun, type StepUsage, type TranscriptEntry } from './results';

const LINE_LIMIT = 1_900;

function chunked(text: string): string {
  return text.split('\n').map((line) => {
    if (line.length <= LINE_LIMIT) return line;
    const pieces: string[] = [];

    for (let at = 0; at < line.length; at += LINE_LIMIT) {
      pieces.push(line.slice(at, at + LINE_LIMIT) + (at + LINE_LIMIT < line.length ? ' \u23CE' : ''));
    }

    return pieces.join('\n');
  }).join('\n');
}

function fence(text: string): string {
  // A fence longer than any run of backticks inside the text cannot be closed by the text.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = '`'.repeat(longest + 1);

  return `${marks}\n${chunked(text.replace(/\n$/, ''))}\n${marks}`;
}

/** Inline for a short scalar, fenced for anything that would otherwise be one long line. */
function value(json: JsonValue | undefined): string {
  if (json === undefined) return '_none_';
  const text = redact(v.is(v.string(), json) ? json : JSON.stringify(json, null, 2));

  return text.includes('\n') || text.length > 120 || text.includes('`') ? `\n${fence(text)}` : `\`${text}\``;
}

function entry(event: TranscriptEntry): string {
  switch (event.type) {
    case 'message':
      // Fenced rather than inlined: an agent's Markdown would otherwise add headings to this document.
      return `**${event.role}** ${value(event.content)}`;
    case 'tool_call':
      return [`\u2192 \`${event.name}\` \`${event.id}\``,
        ...Object.entries(event.arguments ?? {}).map(([key, argument]) => `- ${key}: ${value(argument)}`)].join('\n');
    case 'tool_result':
      return event.error !== undefined
        ? `\u2190 \`${event.name ?? 'tool'}\` failed: ${value(event.error.message)}`
        : `\u2190 \`${event.name ?? 'tool'}\`: ${value(event.content)}`;
  }
}

function count(tokens: number | null | undefined): string {
  return tokens === null || tokens === undefined ? '—' : String(tokens);
}

function stepTokens(step: StepUsage): string {
  const uncached = step.inputTokens === null || step.cacheReadTokens === null || step.cacheWriteTokens === null
    ? null : step.inputTokens - step.cacheReadTokens - step.cacheWriteTokens;

  return `- ${value(step.actor)}, run ${value(step.runId)}, step ${String(step.stepIndex)}: ${count(step.inputTokens)} input · `
    + `${count(uncached)} uncached · ${count(step.cacheReadTokens)} cache read · ${count(step.cacheWriteTokens)} cache write · ${count(step.outputTokens)} output`;
}

/** One trial's section: its checks turn by turn, its errors, and its whole transcript. */
export function renderTrial(run: HarnessRun, verdict: { status: 'passed' | 'failed'; durationMs: number }): string {
  const { taskId, arm } = run.session.metadata;
  const cost = run.usage.metadata.costUsd;

  const lines = [
    `## ${taskId} \u00b7 ${run.usage.model} \u00b7 ${arm} \u00b7 trial ${String(run.session.metadata.trial)} \u2014 ${verdict.status} `
      + `(${(verdict.durationMs / 60_000).toFixed(1)} min)`,
    '',
    `Model steps ${String(run.output.metrics.modelTurns)} \u00b7 tool calls ${String(run.output.metrics.toolCalls)} \u00b7 `
      + `tool errors ${String(run.output.metrics.toolErrors)} · trial cost ${cost === undefined ? '—' : `$${cost.toFixed(4)}`} `
      + `· wall time ${(verdict.durationMs / 1000).toFixed(1)} s`,
    `Prompt tokens ${count(run.usage.inputTokens)} · cache read ${count(run.usage.metadata.cacheReadTokens)} `
      + `· cache write ${count(run.usage.metadata.cacheWriteTokens)} · output ${count(run.usage.outputTokens)}`,
  ];

  for (const { part, turn, outcome, checks } of run.output.turns) {
    lines.push('', `Turn ${String(turn)} (${part}): ${outcome.status}${outcome.message === undefined ? '' : ` \u2014 ${value(outcome.message)}`}`);

    for (const check of checks) {
      lines.push(`- ${check.pass ? 'pass' : 'FAIL'} \`${check.id}\`${check.pass || check.evidence === undefined ? '' : `: ${value(check.evidence)}`}`);
    }
  }

  if (run.errors.length > 0) {
    lines.push('', 'Errors:', ...run.errors.map((error) => `- ${error.name}: ${value(error.message)}`));
  }

  if (run.usage.metadata.steps.length > 0) {
    lines.push('', '### Prompt tokens by model step', '', ...run.usage.metadata.steps.map(stepTokens));
  }

  lines.push('', '### Transcript', '', run.session.events.map(entry).join('\n\n'));

  return lines.join('\n');
}

/** One Markdown document for a whole report: a section per trial, in report order; `only` keeps the failed ones. */
export function renderTrajectories(text: string, only: 'all' | 'failed' = 'all'): string {
  const files = parseResults('results', text);

  const sections = files.flatMap((file) => file.assertionResults.length === 0
    ? [`## ${basename(file.name)} ran no trials\n\n${value(file.message ?? 'no message')}`]
    : []);

  sections.push(...trials(files).filter((assertion) => only === 'all' || assertion.status === 'failed').map(trialSection));

  return `# Eval trajectories\n\n${sections.join('\n\n---\n\n')}\n`;
}

function trialSection(assertion: Assertion): string {
  return renderTrial(assertion.meta.harness.run, { status: assertion.status, durationMs: assertion.duration });
}

/** One leg's trials of one task, passing and failing, as the change review reads them beside the other leg's. */
export function renderLeg(title: string, assertions: readonly Assertion[]): string {
  return `# ${title}\n\n${assertions.map(trialSection).join('\n\n---\n\n')}\n`;
}
