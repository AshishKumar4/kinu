import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useCallback, useRef, type RefObject } from 'react';
import type { CliRenderer, TextareaRenderable } from '@opentui/core';

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

  const external = useCallback(async (text: string): Promise<string> => {
    const command = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();

    if (!command) throw new Error('Set VISUAL or EDITOR to open an external editor.');
    const directory = await mkdtemp(join(tmpdir(), 'kinu-draft-'));
    const path = join(directory, 'prompt.txt');
    await writeFile(path, text, { mode: 0o600 });
    renderer.suspend();

    try {
      const process = Bun.spawn(['/bin/sh', '-c', `${command} "$1"`, 'kinu-editor', path], {
        stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
      });

      const exitCode = await process.exited;

      if (exitCode !== 0) throw new Error(`Editor exited ${exitCode}. Draft retained at ${path}`);
      const edited = await readFile(path, 'utf8');
      await rm(directory, { recursive: true });

      return edited;
    } catch (cause) {
      throw new Error(`External editor did not finish. Draft retained at ${path}`, { cause });
    } finally {
      renderer.resume();
    }
  }, [renderer]);

  return { replace, changed, cursorMoved, reset, undo, external };
}
