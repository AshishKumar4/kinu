/** Altitude tabs name views; the live pill is two indicators (socket, task), each dot plus words, never hue alone. */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { workspaceDisplayTitle } from '@kinu.run/core';
import { WorkspaceBar, type Altitude, type WorkspaceBarProps } from '../src/components/WorkspaceBar';
import type { ConnectionStatus } from '../src/hooks/use-kinu';

function markupForTitle(title: string): string {
  return renderToStaticMarkup(createElement(WorkspaceBar, {
    title,
    onRename: async (name: string) => name,
    connectionStatus: 'connected',
    working: false,
    altitude: 'run',
    onAltitude: () => {},
  }));
}

function markupFor(options: {
  connectionStatus?: ConnectionStatus;
  working?: boolean;
  waitingOnYou?: boolean;
  altitude?: Altitude;
}): string {
  const props: WorkspaceBarProps = {
    title: 'Checkout coupon bug',
    onRename: async (name: string) => name,
    connectionStatus: options.connectionStatus ?? 'connected',
    working: options.working ?? false,
    altitude: options.altitude ?? 'run',
    onAltitude: () => {},
  };

  if (options.waitingOnYou !== undefined) props.waitingOnYou = options.waitingOnYou;

  return renderToStaticMarkup(createElement(WorkspaceBar, props));
}

describe('the connection indicator', () => {
  test('each socket state renders its word beside the dot', () => {
    expect(markupFor({ connectionStatus: 'connected' })).toContain('Connected');
    expect(markupFor({ connectionStatus: 'connecting' })).toContain('Connecting');
    expect(markupFor({ connectionStatus: 'disconnected' })).toContain('Offline');
    expect(markupFor({ connectionStatus: 'error' })).toContain('Offline');
  });
});

describe('the task indicator', () => {
  test('a running turn reads working', () => {
    const html = markupFor({ working: true });
    expect(html).toContain('working');
  });

  test('waiting on you wins over working', () => {
    const html = markupFor({ working: true, waitingOnYou: true });
    expect(html).toContain('waiting on you');
    expect(html).not.toContain('working');
  });
});

describe('the altitude tabs', () => {
  test('the tabs read Work and Supervise, with what each view holds', () => {
    const html = markupFor({});
    expect(html).toContain('>Work<');
    expect(html).toContain('>Supervise<');
    expect(html).toContain('title="Work: the current task and its record"');
    expect(html).toContain('title="Supervise: what the agent learned and what needs you"');
  });
});

describe('the workspace title at both moments', () => {
  test('a stored title renders from the first paint, never the slug', () => {
    const html = markupForTitle(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: 'Fix the kiln' }));

    expect(html).toContain('Fix the kiln');
    expect(html).not.toContain('ashen-kiln-386c2ec1');
  });

  test('an unknown title renders the placeholder state, never the slug or id', () => {
    for (const stored of [undefined, null, '   ', 'ashen-kiln-386c2ec1']) {
      const shown = workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: stored });
      const html = markupForTitle(shown);

      expect(shown.length).toBeGreaterThan(0);
      expect(html).toContain(shown);
      expect(html).not.toContain('ashen-kiln-386c2ec1');
    }

    const states = [undefined, null, '   ', 'ashen-kiln-386c2ec1'].map((stored) =>
      markupForTitle(workspaceDisplayTitle({ name: 'ashen-kiln-386c2ec1', displayName: stored })));

    expect(new Set(states).size).toBe(1);
  });
});
