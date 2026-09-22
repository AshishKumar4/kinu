/**
 * A retained memory or tool renders from its row. Buttons render only where an RPC exists: `revert`
 * where offered, never Edit/Remove.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChangelogEntry } from '@kinu.run/core';
import { ChangelogEntryCard } from '../src/components/surfaces/changelog-entries';
import {
  withToolDetails, type ChangelogEntryView, type CraftedToolDetail,
} from '../src/components/surfaces/shared';

const AT = Date.UTC(2026, 8, 1, 9, 0, 0);

async function stubRpc<T>(method: string): Promise<T> {
  throw new Error(`unexpected rpc in markup test: ${method}`);
}

function render(entry: ChangelogEntryView): string {
  return renderToStaticMarkup(createElement(ChangelogEntryCard, {
    entry, grouped: false, seenAt: 0, rpc: stubRpc, onReverted: () => {},
  }));
}

function fact(over: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: 'fact:test.command', kind: 'fact', at: AT,
    summary: 'Your test command is bun test',
    evidence: 'test.command = bun test · confidence 90% · via project configuration',
    revert: { type: 'fact_forget', target: 'test.command' },
    ...over,
  };
}

const TOOL_DETAIL: CraftedToolDetail = {
  name: 'bisect_migration', description: 'Walk a migration to find the one that changed a column.',
  qualityScore: 0.82, usageCount: 14,
};

function tool(over: Partial<ChangelogEntryView> = {}): ChangelogEntryView {
  return {
    id: 'tool:bisect_migration:123', kind: 'tool', at: AT,
    summary: 'Created a tool: bisect migration',
    evidence: 'Crafted tool bisect_migration — Walk a migration · EMA 0.82 over 14 uses',
    toolDetail: TOOL_DETAIL,
    ...over,
  };
}

describe('a remembered fact', () => {
  test('renders what was stored, its source, scope, time and status from the row', () => {
    const html = render(fact());

    expect(html).toContain('test.command');
    expect(html).toContain('bun test');
    expect(html).toContain('project configuration');
    expect(html).toContain('this workspace');
    expect(html).toContain('applied');
  });

  test('offers Revert only where the entry carries a revert', () => {
    expect(render(fact())).toContain('Revert:');
    expect(render(fact({ revert: undefined }))).not.toContain('Revert:');
  });

  test('never offers Edit or Remove — no RPC exposes them', () => {
    const html = render(fact());

    expect(html).not.toContain('Edit:');
    expect(html).not.toContain('Remove:');
  });
});

describe('a crafted tool entry', () => {
  test('renders name, purpose and EMA score over N from the row', () => {
    const html = render(tool());

    expect(html).toContain('bisect_migration');
    expect(html).toContain('Walk a migration');
    expect(html).toContain('EMA 0.82 over 14 uses');
    expect(html).toContain('this workspace');
  });

  test('a tool entry carries no revert and no Edit/Remove', () => {
    const html = render(tool());

    expect(html).not.toContain('Revert:');
    expect(html).not.toContain('Edit:');
    expect(html).not.toContain('Remove:');
  });

  test('a tool the workspace no longer lists still shows what its row holds', () => {
    const html = render(tool({ toolDetail: undefined }));

    expect(html).toContain('bisect_migration');
    expect(html).toContain('EMA 0.82 over 14 uses');
  });
});

describe('withToolDetails', () => {
  test('joins a tool entry to the live tool list by name', () => {
    const entries: ChangelogEntry[] = [{
      id: 'tool:bisect_migration:123', kind: 'tool', at: AT, summary: 's', evidence: 'e',
    }];

    const joined = withToolDetails(entries, [TOOL_DETAIL]);

    expect(joined[0]?.toolDetail?.usageCount).toBe(14);
  });

  test('leaves facts and unknown tools unenriched', () => {
    const entries: ChangelogEntry[] = [
      fact(),
      { id: 'tool:retired_thing:9', kind: 'tool', at: AT, summary: 's', evidence: 'e' },
    ];

    const joined = withToolDetails(entries, [TOOL_DETAIL]);

    expect(joined[0]?.toolDetail).toBeUndefined();
    expect(joined[1]?.toolDetail).toBeUndefined();
  });
});
