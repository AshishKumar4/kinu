import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planReviewAwaitingDecision } from '@proteus/core';

const source = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');
const hook = source('src/hooks/use-proteus.ts');
const page = source('src/pages/WorkspacePage.tsx');
const output = source('src/components/surfaces/OutputSurface.tsx');
// The composer is one shared component now; the mode control and the
// Steer-as-Branch gate moved into it out of WorkspacePage.
const composer = source('src/components/Composer.tsx');
const review = source('src/components/surfaces/PlanReviewView.tsx');
const css = source('src/index.css');

describe('Plan mode browser contract', () => {
  test('stamps typed intent, and a retry cannot lose it', () => {
    expect(hook).toContain('metadata: { proteusMode: mode }');
    // Retry no longer COPIES the intent onto a fresh message — it re-runs the
    // turn the intent is already stamped on, so the stamp cannot drift from
    // the turn it governs. Copying was also how a retry appended a duplicate.
    expect(hook).toContain('void regenerate()');
    expect(hook).toContain('parsePlanReview(msg.plan)');
    expect(hook).toContain('"getActivePlanReview"');
    expect(page).toContain('state.sendChat(t, pendingAttachments, effectiveChatMode)');
    expect(page).toContain('planReviewAwaitingDecision(state.activePlan)');
    expect(page).toContain('locked: planAwaitingDecision');
    expect(composer).toContain('aria-label="Turn mode"');
    // Build is unreachable while a plan awaits a decision, and the whole
    // segment is inert mid-turn. Both halves matter: the first is the trust
    // boundary, the second stops a mode swap landing on a running turn.
    expect(composer).toContain('disabled={disabled || (locked && mode === "build")}');
    expect(composer).toContain('disabled={disabled || streaming}');
  });

  test('a streaming Plan turn cannot expose Steer-as-Branch', () => {
    expect(composer).toContain('mode?.value !== "plan"');
    expect(page).toContain('!t || !state.isStreaming || effectiveChatMode === "plan"');
  });

  test('a new plan owns Outputs focus and preview cannot steal it mid-review', () => {
    expect(page).toContain('state.activePlan?.status === "pending"');
    expect(page).toContain('state.activePlan?.status === "changes_requested"');
    expect(page).toContain('if (key && key !== previousPlanRef.current) setSurface("Output")');
    expect(output).toContain('type OutputView = "preview" | "diff" | "plan"');
    expect(output).toContain('lazy(() => import("./PlanReviewView"))');
    expect(output).toContain('if (plan) setView("plan")');
    expect(output).toContain('!planReviewAwaitingDecision(plan)');
    expect(planReviewAwaitingDecision({ status: 'pending', handoffAccepted: false })).toBe(true);
    expect(planReviewAwaitingDecision({ status: 'changes_requested', handoffAccepted: false })).toBe(true);
    expect(planReviewAwaitingDecision({ status: 'approved', handoffAccepted: false })).toBe(true);
    expect(planReviewAwaitingDecision({ status: 'approved', handoffAccepted: true })).toBe(false);
  });

  test('Outputs follows actual work and keeps same-numbered previews distinct', () => {
    expect(output).toContain('pickDefaultExecutor(executors, lastActiveExecutor)');
    expect(output).toContain('key={previewPortId(p)}');
    expect(output).toContain('selectPreviewPort(pinnedPorts, activeId)');
    expect(output).toContain('executorLabel(p.executor)');
  });

  test('reuses the supported Plannotator primitives inside Proteus ownership', () => {
    expect(review).toContain('@plannotator/ui/components/Viewer');
    expect(review).toContain('@plannotator/ui/components/AnnotationPanel');
    expect(review).toContain('exportAnnotations(blocks, annotations');
    expect(review).not.toContain('taterMode');
    expect(review).not.toContain('allowImages');
    expect(review).not.toContain('skillReferences');
    expect(review).not.toContain('vimModeEnabled');
    expect(review).not.toContain('/api/');
    expect(review).not.toContain('ThemeProvider');
  });

  test('turns off Plannotator network defaults and scopes its theme contract', () => {
    expect(review).not.toContain('setDocPreviewFetcher');
    expect(review).not.toContain('setSkillCatalogTransport');
    expect(review).not.toContain('setSkillContentTransport');
    expect(css).toContain('[data-proteus-plan-review]');
    expect(css).toContain('body > [data-comment-popover="true"]');
    expect(css).toContain('body > .annotation-toolbar');
    expect(css).not.toContain('data-quick-label-picker');
    expect(css).not.toContain('data-popover-layer');
    expect(css).toContain('@plannotator/ui/components/Viewer.tsx');
    expect(css).toContain('@plannotator/ui/components/AnnotationPanel.tsx');
    expect(css).not.toContain('@plannotator/ui/components/{');
    expect(css).not.toContain('@plannotator/ui/shortcuts/');
    expect(css).not.toContain('@import "@plannotator/ui/styles.css"');
    expect(css).not.toContain('@import "@plannotator/ui/theme"');
  });

  test('the patched document viewer excludes diagram engines from Proteus', () => {
    const viewer = readFileSync(join(import.meta.dir, '../../../node_modules/@plannotator/ui/components/Viewer.tsx'), 'utf8');
    const patch = readFileSync(join(import.meta.dir, '../../../patches/@plannotator%2Fui@0.30.0.patch'), 'utf8');
    for (const feature of ['Tater', 'Attachments', 'QuickLabel', 'Pinpoint', 'Vim', 'Graphviz', 'Mermaid']) {
      expect(viewer).not.toContain(feature);
    }
    expect(viewer).toContain('applyAnnotations(eligible)');
    expect(viewer).toContain('computeListIndices(blocks)');
    expect(viewer).toContain("split(/(?<!\\\\)\\|/)");
    expect(viewer).toContain('target="_blank" rel="noopener noreferrer"');
    expect(viewer).toContain("!href.startsWith('#')");
    expect(viewer).toContain('!/^https?:\\/\\//i.test(href)');
    const additions = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    expect(additions).not.toContain('@pierre/diffs');
    expect(patch).not.toContain('.bun-tag-');
  });

  test('ships the selected upstream license text with the integration', () => {
    const notice = readFileSync(join(import.meta.dir, '../../../THIRD_PARTY_NOTICES.md'), 'utf8');
    const license = readFileSync(join(import.meta.dir, '../../../third_party/plannotator-LICENSE-MIT'), 'utf8');
    expect(notice).toContain('third_party/plannotator-LICENSE-MIT');
    expect(license).toContain('Copyright (c) 2025 backnotprop');
    expect(license).toContain('Permission is hereby granted');
  });

  test('persists annotations before exactly one decision wake', () => {
    const start = review.indexOf('const decide = useCallback');
    const decide = review.slice(start, review.indexOf('\n\n  if (!plan)', start));
    expect(decide).toContain('await save(annotations)');
    expect(decide.match(/"decidePlanReview"/g)).toHaveLength(1);
    expect(decide).toContain('decision === "request_changes"');
    expect(decide).toContain('exportAnnotations(');
  });

  test('freezes annotation editing across the decision transaction', () => {
    expect(review).toContain('decisionInFlight.current = true');
    expect(review).toContain('if (decisionInFlight.current) return;');
    expect(review).toContain('readOnly={!editable || decisionBusy !== null}');
    expect(review).toContain('decisionInFlight.current = false');
  });
});
