/** A hirer's task reaches the hired agent's chat as an event naming its hirer, on both backends. */
import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classifyProgrammaticTurn, delegatedTaskMetadata, MAIN_AGENT } from '@kinu.run/core';
import type { UIMessage } from 'ai';

import { MessageView } from '../src/components/MessageView';

function taskRow(from: string): UIMessage {
  return { id: 'asked:t1', role: 'user', metadata: delegatedTaskMetadata(from, 'build'), parts: [{ type: 'text', text: 'Draft the arena rules.' }] };
}

test('a delegated task is an event from its hirer, never the operator speaking', () => {
  expect(classifyProgrammaticTurn({ metadata: taskRow(MAIN_AGENT).metadata })).toEqual({ kind: 'delegated_task', from: MAIN_AGENT });
  expect(classifyProgrammaticTurn({ metadata: taskRow("planner").metadata })).toEqual({ kind: 'delegated_task', from: 'planner' });
});

test('the chat shows the task in an event card that names who sent it', () => {
  const fromMain = renderToStaticMarkup(createElement(MessageView, { message: taskRow(MAIN_AGENT) }));
  const fromPeer = renderToStaticMarkup(createElement(MessageView, { message: taskRow('planner') }));

  expect(fromMain).toContain('from Main');
  expect(fromMain).toContain('Draft the arena rules.');
  expect(fromPeer).toContain('from planner');
});
