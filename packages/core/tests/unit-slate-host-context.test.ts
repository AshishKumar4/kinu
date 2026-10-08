import { expect, test } from 'bun:test';
import {
  isSlateFrameMessage, slateFrameSrc, slateLinkId,
  SLATE_HOST_CONTEXT_MESSAGE, SLATE_QUERY_PARAM, SLATE_SIZE_CHANGED_MESSAGE,
} from '../src/slates/host-context';
import { SLATE_CLIENT_MODULE } from '../src/slates/runtime-modules';
import { parseSlateProject } from '../src/slates/project';

test('slateLinkId accepts a well-formed slate link and refuses every other href', () => {
  expect(slateLinkId('slate://deploy-choice')).toBe('deploy-choice');
  expect(slateLinkId('slate://../x')).toBeNull();
  expect(slateLinkId('slate://a/b')).toBeNull();
  expect(slateLinkId('slate://')).toBeNull();
  expect(slateLinkId('https://x')).toBeNull();
  expect(slateLinkId('slate:x')).toBeNull();
  expect(slateLinkId('')).toBeNull();
});

test('the generated client module and the host vocabulary share one spelling', () => {
  expect(SLATE_CLIENT_MODULE).toContain(`"${SLATE_QUERY_PARAM}"`);
  expect(SLATE_CLIENT_MODULE).toContain(`"${SLATE_HOST_CONTEXT_MESSAGE}"`);
  expect(SLATE_CLIENT_MODULE).toContain(`"${SLATE_SIZE_CHANGED_MESSAGE}"`);
});

test('a slate is sized by what it holds: package.json declares no inline height', () => {
  expect(() => parseSlateProject({ main: 'server.js', slate: { inline: { height: 240 } } })).toThrow('slate.inline');
});

test('isSlateFrameMessage checks the frame, the origin and the envelope', () => {
  const channel = new MessageChannel();
  const data = { kinu: SLATE_SIZE_CHANGED_MESSAGE, height: 200 };

  const event = (fields: { source?: unknown; origin?: string; data?: unknown }) =>
    ({ source: fields.source ?? null, origin: fields.origin ?? '', data: fields.data });

  expect(isSlateFrameMessage(event({ source: channel.port1, origin: 'https://p.example.test', data }), channel.port1, 'https://p.example.test')).toBe(true);
  expect(isSlateFrameMessage(event({ source: channel.port2, origin: 'https://p.example.test', data }), channel.port1, 'https://p.example.test')).toBe(false);
  expect(isSlateFrameMessage(event({ source: channel.port1, origin: 'https://evil.example.test', data }), channel.port1, 'https://p.example.test')).toBe(false);
  expect(isSlateFrameMessage(event({ source: channel.port1, origin: 'https://p.example.test', data: { kinu: 'other', height: 1 } }), channel.port1, 'https://p.example.test')).toBe(false);
});

test('slateFrameSrc embeds a schema-checked context and refuses a malformed one', () => {
  const context = {
    theme: 'dark',
    styles: { variables: { '--c-bg': '#000' } },
    containerDimensions: { width: 640 },
    display: 'inline',
    origin: 'https://kinu.run',
  } as const;

  const back = JSON.parse(new URL(slateFrameSrc('https://f.example.test/', context)).searchParams.get(SLATE_QUERY_PARAM) ?? 'null');
  expect(back).toEqual(context);
});
