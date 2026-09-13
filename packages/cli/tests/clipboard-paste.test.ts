import { expect, test } from 'bun:test';
import { ClipboardPaste } from '../src/tui/clipboard-paste';

const packet = (header: string, payload = '') => `\x1b]5522;type=read:${header};${payload}\x1b\\`;

const encoded = (text: string) => Buffer.from(text).toString('base64');

function oscSource() {
  let listener: ((sequence: string) => void) | null = null;

  return {
    subscribeOsc(handler: (sequence: string) => void) {
      listener = handler;

      return () => { listener = null; };
    },
    receive(sequence: string) { listener?.(sequence); },
  };
}

test('Kitty dot listings select image over text, preserve primary authorization and join chunks', () => {
  const writes: string[] = [];
  const pasted: Array<{ bytes: Uint8Array; mime: string }> = [];
  const errors: string[] = [];
  const source = oscSource();

  const clipboard = new ClipboardPaste({ renderer: source, enabled: () => true, limitBytes: 1024, write: (data) => { writes.push(data); },
    paste: (bytes, mime) => { pasted.push({ bytes, mime }); }, error: (message) => { errors.push(message); } });

  source.receive(packet('status=OK:pw=password:loc=primary'));
  source.receive(packet(`status=DATA:mime=${encoded('.')}`, encoded('text/plain image/jpeg')));
  source.receive(packet('status=DONE'));
  expect(writes).toEqual([`\x1b]5522;type=read:loc=primary:pw=password:name=${encoded('Paste event')};${encoded('image/jpeg')}\x07`]);
  source.receive(packet('status=OK'));
  source.receive(packet(`status=DATA:mime=${encoded('image/jpeg')}`, encoded('first')));
  source.receive(packet(`status=DATA:mime=${encoded('image/jpeg')}`, encoded('second')));
  expect(pasted).toEqual([]);
  source.receive(packet('status=DONE'));
  expect(pasted).toEqual([{ bytes: Buffer.from('firstsecond'), mime: 'image/jpeg' }]);
  expect(errors).toEqual([]);
  clipboard.dispose();
});

test('an oversized or failed transfer cannot deliver partial data', () => {
  const pasted: Uint8Array[] = [];
  const errors: string[] = [];
  const source = oscSource();

  const clipboard = new ClipboardPaste({ renderer: source, enabled: () => true, limitBytes: 2, write: () => {},
    paste: (bytes) => { pasted.push(bytes); }, error: (message) => { errors.push(message); } });

  for (const status of ['DATA', 'DENIED']) {
    source.receive(packet('status=OK'));
    source.receive(packet(`status=DATA:mime=${encoded('image/png')}`));
    source.receive(packet('status=DONE'));
    source.receive(packet(`status=${status}:mime=${encoded('image/png')}`, encoded('too big')));
    source.receive(packet('status=DONE'));
  }

  expect(pasted).toEqual([]);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain('exceeds');
  expect(errors[1]).toContain('DENIED');
  clipboard.dispose();
});
