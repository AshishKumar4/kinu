import type { CliRenderer } from '@opentui/core';

/** Kitty OSC 5522's listing/read handshake, including its dot MIME listing.
 * Protocol shapes also exercised by oh-my-pi's enhanced-paste controller. */
/** How many characters end an OSC reply: BEL, ST, or none (still partial). */
function terminatorLength(sequence: string): number {
  if (sequence.endsWith('\x07')) return 1;

  return sequence.endsWith('\x1b\\') ? 2 : 0;
}

export class ClipboardPaste {
  private readonly stop: () => void;
  private state: {
    phase: 'listing' | 'reading';
    mimes: string[];
    mime: string;
    chunks: Buffer[];
    size: number;
    password: string | undefined;
    location: string | undefined;
    dot: boolean;
  } | null = null;

  constructor(private readonly handlers: {
    renderer: Pick<CliRenderer, 'subscribeOsc'>;
    enabled(): boolean;
    limitBytes: number;
    write(sequence: string): void;
    paste(bytes: Uint8Array, mime: string): void;
    error(message: string): void;
  }) {
    this.stop = handlers.renderer.subscribeOsc((sequence) => {
      if (handlers.enabled()) this.receive(sequence);
      else this.state = null;
    });
  }

  dispose(): void {
    this.stop();
    this.state = null;
  }

  private receive(sequence: string): void {
    if (!sequence.startsWith('\x1b]5522;')) return;
    const end = terminatorLength(sequence);

    if (end === 0) return;
    const body = sequence.slice(7, -end);
    const split = body.indexOf(';');
    const header = split < 0 ? body : body.slice(0, split);
    const payload = split < 0 ? '' : body.slice(split + 1);

    const fields = new Map(header.split(':').map((part) => {
      const index = part.indexOf('=');

      return [part.slice(0, index), part.slice(index + 1)];
    }));

    if (fields.get('type') !== 'read') return;
    const status = fields.get('status');

    if (status === 'OK') {
      if (this.state?.phase === 'reading') return;
      this.state = { phase: 'listing', mimes: [], mime: '', chunks: [], size: 0,
        password: fields.get('pw'), location: fields.get('loc'), dot: false };

      return;
    }

    const state = this.state;

    if (!state) return;

    if (status === 'DATA') {
      const mime = Buffer.from(fields.get('mime') ?? '', 'base64').toString('utf8');

      if (state.phase === 'listing') {
        if (mime === '.' && payload) {
          state.dot = true;
          state.mimes.push(...Buffer.from(payload, 'base64').toString('utf8').split(/\s+/));
        } else state.mimes.push(mime);
      } else if (mime === state.mime) {
        const bytes = Buffer.from(payload, 'base64');
        state.size += bytes.length;

        if (state.size > this.handlers.limitBytes) {
          this.state = null;
          this.handlers.error('Clipboard data exceeds the attachment limit. Paste a file path instead.');
        } else state.chunks.push(bytes);
      }

      return;
    }

    if (status === 'DONE') {
      if (state.phase === 'reading') {
        this.state = null;
        this.handlers.paste(Buffer.concat(state.chunks), state.mime);

        return;
      }

      const mime = ['image/png', 'image/jpeg', 'text/plain'].find((candidate) => state.mimes.includes(candidate));

      if (!mime) {
        this.state = null;
        this.handlers.error('Clipboard has no PNG, JPEG, or plain text. Paste a file path instead.');

        return;
      }

      state.phase = 'reading';
      state.mime = mime;
      const encodedMime = Buffer.from(mime).toString('base64');
      const metadata = ['type=read'];

      if (state.location === 'primary') metadata.push('loc=primary');

      if (state.password) metadata.push(`pw=${state.password}`, `name=${Buffer.from('Paste event').toString('base64')}`);

      if (!state.dot) metadata.push(`mime=${encodedMime}`);
      this.handlers.write(`\x1b]5522;${metadata.join(':')}${state.dot ? `;${encodedMime}` : ''}\x07`);

      return;
    }

    this.state = null;
    this.handlers.error(`Clipboard paste failed: ${status ?? 'missing status'}`);
  }
}
