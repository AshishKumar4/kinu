/**
 * The workspace bar's two promises: the altitude tabs name VIEWS (Work reads
 * the current task and its record, Supervise reads what the agent learned),
 * and the old live pill is two indicators — the socket state and the task
 * state, each dot plus words, never hue alone.
 *
 * Rendered through `renderToStaticMarkup`: labels, titles, and indicator
 * words are all derived from props, with no effects needed.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceBar, type Altitude, type WorkspaceBarProps } from '../src/components/WorkspaceBar';
import type { ConnectionStatus } from '../src/hooks/use-kinu';

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
