/**
 * The parked-command queue's decision half: a bulk decide must not reset the selection to null (null means everything)
 * and must re-read the queue. `ParkedDecisionFlow` is a plain object, so this drives it without a browser.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ParkedCommands, ParkedDecisionFlow, type ParkedDecision, type ParkedDecisionDeps } from '../src/components/surfaces/WorkTab';
import type { Rpc } from '@kinu.run/core';
import type { PendingAction } from '@kinu.run/core';

/** One fixed queue timestamp, so "queued X ago" is stable across renders. */
const AT = Date.UTC(2026, 8, 3, 12, 0, 0);

/** The flow under test is injected, so the seam stays silent. */
const SILENT_RPC: Rpc = () => Promise.withResolvers<never>().promise;

function parked(id: string, detail = `run \`deploy --${id}\` on device`): PendingAction {
  return { id, kind: 'deferred_action', title: `device · ${id}`, detail, at: AT };
}

const ACTIONS = [parked('a'), parked('b'), parked('c')];

const ALL = ACTIONS.map((a) => a.id);

/** `decideDeferredApprovals` answers with the ids it accepted; the recorder narrows the promise to that. */
interface RecordingDeps extends ParkedDecisionDeps {
  readonly decisions: Array<{ ids: string[]; decision: ParkedDecision }>;
  refreshes: number;
  /** Fail the next decide call with this message. */
  failNextWith: string | null;
}

function recorder(): RecordingDeps {
  const decisions: Array<{ ids: string[]; decision: ParkedDecision }> = [];

  const rec: RecordingDeps = {
    decisions,
    refreshes: 0,
    failNextWith: null,
    decide: async (ids, decision) => {
      if (rec.failNextWith !== null) {
        const message = rec.failNextWith;
        rec.failNextWith = null;
        throw new Error(message);
      }

      rec.decisions.push({ ids, decision });

      return { decided: ids };
    },
    onDecided: () => { rec.refreshes += 1; },
  };

  return rec;
}


describe('the parked queue, as the owner decides it', () => {
  test('untouched, everything is chosen — an overnight pile is one click', () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    expect([...flow.chosen(ALL)].sort()).toEqual(['a', 'b', 'c']);
  });

  test('a recorded decision goes out with exactly the chosen ids', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    flow.toggle('c', ALL);
    await flow.decide('approved', [...flow.chosen(ALL)]);
    expect(rec.decisions).toEqual([{ ids: ['a', 'b'], decision: 'approved' }]);
  });

  test('after a decision nothing is selected — decided rows do not re-tick', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    await flow.decide('approved', [...flow.chosen(ALL)]);
    expect(flow.snapshot().selected).toEqual(new Set());
    expect(flow.chosen(ALL).size).toBe(0);
  });

  test('a recorded decision re-reads the queue exactly once', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    await flow.decide('denied', [...flow.chosen(ALL)]);
    expect(rec.refreshes).toBe(1);
    expect(flow.snapshot().decided).toBe('denied');
  });

  test('a failed decision keeps the selection and names the failure', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    flow.toggle('b', ALL);
    rec.failNextWith = 'connection lost';
    await flow.decide('approved', [...flow.chosen(ALL)]);
    expect([...flow.chosen(ALL)].sort()).toEqual(['a', 'c']);
    expect(flow.snapshot().error).toContain('Could not record the decision');
    expect(rec.refreshes).toBe(0);
  });

  test('a decision with nothing chosen and a second decide while busy record nothing', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    await flow.decide('approved', []);
    expect(rec.decisions).toHaveLength(0);
    expect(rec.refreshes).toBe(0);
  });

  test('toggling from the post-decision empty set re-selects one row only', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    await flow.decide('approved', [...flow.chosen(ALL)]);
    flow.toggle('b', ALL);
    expect([...flow.chosen(ALL)]).toEqual(['b']);
  });

  test('a newly parked row arriving after a decision is NOT auto-selected', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    await flow.decide('approved', [...flow.chosen(ALL)]);
    expect(flow.chosen([...ALL, 'd']).has('d')).toBe(false);
  });
});

describe('the queue card, as the reader sees it', () => {
  test('fresh, every box is ticked', () => {
    const html = renderToStaticMarkup(createElement(ParkedCommands, {
      actions: ACTIONS,
      rpc: SILENT_RPC,
    }));

    expect(html.match(/checked/g)?.length).toBe(3);
    expect(html).toContain('Approve all');
  });

  test('one untick names the one', () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    flow.toggle('c', ALL);

    const html = renderToStaticMarkup(createElement(ParkedCommands, {
      actions: ACTIONS,
      rpc: SILENT_RPC,
      flow,
    }));

    expect(html.match(/checked/g)?.length).toBe(2);
    expect(html).toContain('Approve 2');
  });

  test('after the decision the card shows, everything is unticked', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    await flow.decide('approved', [...flow.chosen(ALL)]);

    const html = renderToStaticMarkup(createElement(ParkedCommands, {
      actions: ACTIONS,
      rpc: SILENT_RPC,
      flow,
    }));

    expect(html).not.toContain('checked');
    expect(html).toContain('Approved. It runs when the agent picks the decision up.');
  });

  test('a failed decision says what broke and keeps the ticks', async () => {
    const rec = recorder();
    const flow = new ParkedDecisionFlow(rec);
    rec.failNextWith = 'connection lost';
    await flow.decide('denied', [...flow.chosen(ALL)]);

    const html = renderToStaticMarkup(createElement(ParkedCommands, {
      actions: ACTIONS,
      rpc: SILENT_RPC,
      flow,
    }));

    expect(html).toContain('Could not record the decision');
    expect(html.match(/checked/g)?.length).toBe(3);
  });
});
