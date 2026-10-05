import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useCallback, useRef, type RefObject } from 'react';
import type { CliRenderer, TextareaRenderable } from '@opentui/core';
import { Cause, Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';

interface DraftSnapshot { text: string; cursor: number }

export function useDraftEditing(input: RefObject<TextareaRenderable | null>, renderer: CliRenderer) {
  const current = useRef<DraftSnapshot>({ text: '', cursor: 0 });
  const snapshots = useRef<DraftSnapshot[]>([]);
  const burst = useRef({ direction: 0, at: 0 });

  const record = useCallback((text: string, cursor: number, separate = false) => {
    if (text === current.current.text) return;
    const now = Date.now();
    const direction = Math.sign(text.length - current.current.text.length);

    if (separate || direction === 0 || direction !== burst.current.direction || now - burst.current.at > 400) {
      snapshots.current.push(current.current);

      if (snapshots.current.length > 64) snapshots.current.shift();
    }

    current.current = { text, cursor };
    burst.current = { direction: separate ? 0 : direction, at: now };
  }, []);

  const replace = useCallback((text: string) => {
    record(text, 0, true);
    input.current?.setText(text);
  }, [input, record]);

  const changed = useCallback(() => {
    const editor = input.current;

    if (editor) record(editor.plainText, editor.cursorOffset);
  }, [input, record]);

  const cursorMoved = useCallback(() => {
    const editor = input.current;

    if (editor?.plainText === current.current.text && editor.cursorOffset !== current.current.cursor) {
      current.current = { text: editor.plainText, cursor: editor.cursorOffset };
      burst.current.direction = 0;
    }
  }, [input]);

  const reset = useCallback(() => {
    snapshots.current = [];
    current.current = { text: input.current?.plainText ?? '', cursor: input.current?.cursorOffset ?? 0 };
    burst.current = { direction: 0, at: 0 };
  }, [input]);

  const undo = useCallback(() => {
    const previous = snapshots.current.pop();
    const editor = input.current;

    if (!previous || !editor) return;
    current.current = previous;
    burst.current = { direction: 0, at: 0 };
    editor.setText(previous.text);
    editor.cursorOffset = previous.cursor;
  }, [input]);

  const external = useCallback((text: string): Promise<string> => settle(Effect.gen(function* () {
    const visual = process.env.VISUAL?.trim();
    const command = visual === undefined || visual === '' ? process.env.EDITOR?.trim() : visual;

    if (!command) return yield* Effect.die(new Error('Set VISUAL or EDITOR to open an external editor.'));
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'kinu-draft-')));
    const path = join(directory, 'prompt.txt');
    yield* Effect.promise(() => writeFile(path, text, { mode: 0o600 }));
    renderer.suspend();

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      const child = Bun.spawn(['/bin/sh', '-c', `${command} "$1"`, 'kinu-editor', path], {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
      });

      const exitCode = yield* Effect.promise(() => child.exited);

      if (exitCode !== 0) return yield* Effect.die(new Error(`Editor exited ${exitCode}. Draft retained at ${path}`));
      const edited = yield* Effect.promise(() => readFile(path, 'utf8'));
      yield* Effect.promise(() => rm(directory, { recursive: true }));

      return edited;
    }), (failed) => Effect.die(new Error(`External editor did not finish. Draft retained at ${path}`, { cause: Cause.squash(failed) }))), Effect.sync(() => {
      renderer.resume();
    }));
  })), [renderer]);

  return { replace, changed, cursorMoved, reset, undo, external };
}
