import { expect, test } from 'bun:test';
import {
  isSlateFrameMessage, slateFrameSrc, slateInlineHeight, slateLinkId,
  SLATE_HOST_CONTEXT_MESSAGE, SLATE_INLINE_HEIGHT, SLATE_QUERY_PARAM, SLATE_SIZE_CHANGED_MESSAGE,
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

test('slateInlineHeight clamps to the schema band and the schema reads the same bounds', () => {
  expect(slateInlineHeight(900)).toBe(SLATE_INLINE_HEIGHT.max);
  expect(slateInlineHeight(10)).toBe(SLATE_INLINE_HEIGHT.min);
  expect(slateInlineHeight(240)).toBe(240);

  expect(parseSlateProject({ main: 'server.js', slate: { inline: { height: 240 } } }).slate.inline.height).toBe(240);
  expect(() => parseSlateProject({ main: 'server.js', slate: { inline: { height: 900 } } })).toThrow('height');
  expect(() => parseSlateProject({ main: 'server.js', slate: { inline: { height: 10 } } })).toThrow('height');
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

  // Built as JSON so the runtime schema check is what fails.
  expect(() => slateFrameSrc('https://f.example.test/', JSON.parse(JSON.stringify({ ...context, theme: 'solarized' })))).toThrow();
  expect(() => slateFrameSrc('https://f.example.test/', JSON.parse(JSON.stringify({ ...context, extra: true })))).toThrow();
});
