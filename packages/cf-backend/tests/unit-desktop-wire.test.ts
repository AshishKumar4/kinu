/**
 * Devbox D89: core reads each desktop member's input and plans it into the box's actions; the box admits an action by
 * its own schema, declared apart because the box imports nothing of core (scripts/bench-devbox-independence.test.ts).
 * The two meet here as they do in the Worker: every action core sends, at the limits of its members' own inputs, is one
 * the box admits.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { DESKTOP_SIZE, WATCH_SHEET } from '@kinu.run/devbox/desktop';
import { createSandboxExecutor, executorNamespace, projectJsonValue, type JsonValue, type SandboxHandle } from '@kinu.run/core';
import { DESKTOP_INPUTS } from '../../core/src/execution/desktop';
import { sandboxHandleLifecycle } from '../../core/tests/helpers/sandbox-handle-lifecycle';
import { DesktopRequestSchema } from '../../devbox/src/desktop-input';

const PNG = 'iVBORw0KGgo=';

const Pipe = v.array(v.looseObject({ type: v.string(), requirement: v.optional(v.unknown()) }));

/** A field's schema as far as its bounds: its pipe, or its pipe inside the `optional` it may be. */
const FieldSchema = v.looseObject({ pipe: v.optional(Pipe), wrapped: v.optional(v.looseObject({ pipe: Pipe })) });

/** A bound a field's schema states, read from it rather than restated here. */
function bound(schema: v.GenericSchema, type: 'min_value' | 'max_value' | 'max_length'): number {
  const field = v.parse(FieldSchema, schema);
  const requirement = (field.wrapped?.pipe ?? field.pipe ?? []).find((action) => action.type === type)?.requirement;

  return v.parse(v.number(), requirement);
}

test("every action core sends at the limits of its members' inputs is one the box admits", async () => {
  const refused: Array<{ readonly kind: string; readonly issues: readonly string[] }> = [];
  const asked = new Set<string>();

  const unreachable = async (): Promise<never> => {
    throw new Error('a desktop call must not touch the computer any other way');
  };

  const box: SandboxHandle = {
    exec: unreachable, readFile: unreachable, writeFile: unreachable, listFiles: unreachable, deleteFile: unreachable,
    exposePort: unreachable, unexposePort: unreachable, getExposedPorts: unreachable,
    ...sandboxHandleLifecycle,
    desktop: async (request) => {
      const admitted = v.safeParse(DesktopRequestSchema, request);

      asked.add(request.action.kind);

      if (!admitted.success) refused.push({ kind: request.action.kind, issues: admitted.issues.map((issue) => issue.message) });

      return request.action.kind === 'screenshot' || request.action.kind === 'watch'
        ? { kind: 'screen', png: PNG, ...DESKTOP_SIZE }
        : { kind: 'done' };
    },
  };

  const computer = executorNamespace(createSandboxExecutor(box, { desktop: { driver: 'main', screen: { ...DESKTOP_SIZE, sheet: WATCH_SHEET } } }));

  /** A program's call: its value, or the refusal it branches on, which core answers without asking the box. */
  const call = async (member: string, ...args: JsonValue[]): Promise<JsonValue> => {
    const tool = computer.tools[member];

    if (tool === undefined) throw new Error(`computer has no ${member}`);

    return projectJsonValue({ value: await tool.execute(...args) });
  };

  const corner: JsonValue = [DESKTOP_SIZE.width - 1, DESKTOP_SIZE.height - 1];
  const longest = bound(DESKTOP_INPUTS.type.text, 'max_length');
  // Every kind of character typing plans differently: runs of ASCII, line breaks, tabs, and keys past ASCII.
  const mixed = 'Typed run, then\r\na line\tand a tab: Grüße 😀 '.repeat(longest).slice(0, longest);

  const answers = [
    await call('screenshot'),
    await call('watch', bound(DESKTOP_INPUTS.watch.seconds, 'max_value'), { fps: bound(DESKTOP_INPUTS.watch.fps, 'max_value') }),
    await call('watch', bound(DESKTOP_INPUTS.watch.seconds, 'min_value'), { fps: bound(DESKTOP_INPUTS.watch.fps, 'min_value') }),
    await call('click', corner, { button: 'middle', count: bound(DESKTOP_INPUTS.click.count, 'max_value'), keys: ['ctrl', 'shift', 'alt', 'super'] }),
    await call('type', 'a'.repeat(longest)),
    await call('type', mixed),
    await call('key', ['ctrl', 'shift', 'F12'], { hold: bound(DESKTOP_INPUTS.key.hold, 'max_value') }),
    await call('key', ['super'], { hold: bound(DESKTOP_INPUTS.key.hold, 'min_value') }),
    // Keys pressed together, as a game reads forward and jump at once.
    await call('key', ['w', 'space'], { hold: bound(DESKTOP_INPUTS.key.hold, 'min_value') }),
    await call('scroll', corner, bound(DESKTOP_INPUTS.scroll.dy, 'min_value'), { dx: bound(DESKTOP_INPUTS.scroll.dx, 'max_value') }),
    await call('move', corner),
    await call('drag', [0, 0], corner),
  ];

  const shown = `data:image/png;base64,${PNG}`;

  // Every call was core's to send, not refused before the box: the looks answer the screen, the rest nothing.
  expect({ answers, refused, asked: [...asked].sort() }).toEqual({
    answers: [shown, shown, shown, ...answers.slice(3).map(() => null)],
    refused: [],
    asked: ['click', 'drag', 'key', 'move', 'screenshot', 'scroll', 'type', 'watch'],
  });
});
