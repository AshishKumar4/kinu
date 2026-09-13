import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { useCallback, useEffect, useMemo, type RefObject } from 'react';
import { decodePasteBytes, type CliRenderer, type PasteEvent, type TextareaRenderable } from '@opentui/core';
import { AGENT_HOME } from '../config';
import { renderThrownChain } from '@kinu.run/core/obs';
import { ClipboardPaste } from './clipboard-paste';

export function useComposerPaste(options: {
  renderer: CliRenderer;
  input: RefObject<TextareaRenderable | null>;
  enabled: RefObject<boolean>;
  limitBytes: number;
  note(message: string): void;
}) {
  const pastes = useMemo(() => new Map<string, string>(), []);
  const sequence = useMemo(() => ({ text: 0, image: 0 }), []);
  const { renderer, input, enabled, limitBytes, note } = options;

  useEffect(() => {
    const insert = (text: string, kind: 'text' | 'image') => {
      const editor = input.current;

      if (!editor || !enabled.current) return;
      let marker: string;

      do {
        sequence[kind] += 1;
        marker = `[${kind === 'text' ? 'paste' : 'Image'} #${sequence[kind]}]`;
      } while (editor.plainText.includes(marker));

      pastes.set(marker, text);
      editor.insertText(marker);
    };

    const paste = (bytes: Uint8Array, mime = 'text/plain') => {
      if (!enabled.current) return;

      if (mime === 'image/png' || mime === 'image/jpeg') {
        if (bytes.length > limitBytes) {
          note('Clipboard image exceeds the attachment limit. Paste a file path instead.');

          return;
        }

        try {
          const directory = join(AGENT_HOME, 'clipboard');
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, `${crypto.randomUUID()}.${mime === 'image/png' ? 'png' : 'jpg'}`);
          writeFileSync(path, bytes, { mode: 0o600 });
          insert(`@"${path}"`, 'image');
        } catch (cause) {
          note(`Could not save clipboard image: ${renderThrownChain({ cause })}`);
        }

        return;
      }

      if (mime !== 'text/plain') {
        note(`Unsupported clipboard type: ${mime}`);

        return;
      }

      const text = decodePasteBytes(bytes).replace(/\r\n?/g, '\n');
      const trimmed = text.trim();
      const path = trimmed.replace(/^@/, '').replace(/^(['"])(.*)\1$/, '$2').replace(/\\ /g, ' ');

      if (!text.includes('\n') && /\.(png|jpe?g)$/i.test(path) && !path.includes('"')) {
        insert(`@"${path}"`, 'image');
      } else if (text.split('\n').length > 10) insert(text, 'text');
      else input.current?.insertText(text);
    };

    const clipboard = new ClipboardPaste({ renderer, enabled: () => enabled.current,
      limitBytes, write: (data) => { writeSync(1, data); }, paste, error: note });

    const onPaste = (event: PasteEvent) => {
      event.preventDefault();
      paste(event.bytes, event.metadata?.mimeType);
    };

    renderer.keyInput.on('paste', onPaste);

    writeSync(1, '\x1b[?5522h');

    return () => {
      renderer.keyInput.off('paste', onPaste);
      clipboard.dispose();
      writeSync(1, '\x1b[?5522l');
    };
  }, [renderer, input, enabled, limitBytes, note, pastes, sequence]);

  return useCallback((text: string) => text.replace(/\[(?:paste|Image) #\d+\]/g, (marker) => pastes.get(marker) ?? marker), [pastes]);
}
