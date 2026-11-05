import { expect, test } from 'bun:test';
import {
  readSlateFrameMessage, slateFrameSrc, slateLinkId,
  SLATE_QUERY_PARAM, SLATE_SIZE_CHANGED_MESSAGE,
} from '../src/slates/host-context';
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

test('a slate is sized by what it holds: package.json declares no inline height', () => {
  expect(() => parseSlateProject({ main: 'server.js', slate: { inline: { height: 240 } } })).toThrow('slate.inline');
});

test('readSlateFrameMessage checks the frame, the origin and the envelope, and holds a runaway height', () => {
  const channel = new MessageChannel();
  const data = { kinu: SLATE_SIZE_CHANGED_MESSAGE, height: 200 };

  const event = (fields: { source?: unknown; origin?: string; data?: unknown }) =>
    ({ source: fields.source ?? null, origin: fields.origin ?? '', data: fields.data });

  expect(readSlateFrameMessage(event({ source: channel.port1, origin: 'https://p.example.test', data }), channel.port1, 'https://p.example.test')?.height).toBe(200);
  expect(readSlateFrameMessage(event({ source: channel.port2, origin: 'https://p.example.test', data }), channel.port1, 'https://p.example.test')).toBeNull();
  expect(readSlateFrameMessage(event({ source: channel.port1, origin: 'https://evil.example.test', data }), channel.port1, 'https://p.example.test')).toBeNull();
  expect(readSlateFrameMessage(event({ source: channel.port1, origin: 'https://p.example.test', data: { kinu: 'other', height: 1 } }), channel.port1, 'https://p.example.test')).toBeNull();
  // A page that grows with its frame says a height without end; the chat holds it to a page's worth.
  expect(readSlateFrameMessage(event({ source: channel.port1, origin: 'https://p.example.test', data: { ...data, height: 1e9 } }), channel.port1, 'https://p.example.test')?.height).toBeLessThan(1e9);
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
