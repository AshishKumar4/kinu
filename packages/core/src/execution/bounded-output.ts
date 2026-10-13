export interface CommandOutputLimits {
  readonly headBytes: number;
  readonly tailBytes: number;
}

export const COMMAND_OUTPUT_LIMITS: CommandOutputLimits = { headBytes: 256 * 1024, tailBytes: 256 * 1024 };

export type SpillOutcome = { readonly path: string } | { readonly failure: string };

export interface OutputSpill {
  write(chunk: Uint8Array): void;
  close(): SpillOutcome;
}

export class BoundedOutput {
  private readonly head: Uint8Array[] = [];
  private headLength = 0;
  private tail: Uint8Array | null = null;
  private tailEnd = 0;
  private tailLength = 0;
  private total = 0;
  private spill: OutputSpill | null = null;
  private finished = false;

  constructor(
    private readonly limits: CommandOutputLimits,
    private readonly openSpill?: () => OutputSpill,
  ) {}

  write(chunk: Uint8Array): void {
    if (this.finished || chunk.length === 0) return;
    this.total += chunk.length;

    if (this.spill === null && this.openSpill !== undefined && this.total > this.limits.headBytes + this.limits.tailBytes) {
      const spill = this.openSpill();

      for (const part of [...this.head, this.keptTail()]) spill.write(part);
      this.spill = spill;
    }

    this.spill?.write(chunk);
    this.keep(chunk);
  }

  finish(stream: string): string {
    this.finished = true;
    const tail = this.keptTail();
    const whole = this.total === this.headLength + this.tailLength;

    if (whole) return new TextDecoder().decode(concatBytes([...this.head, tail]));
    const saved = this.spill?.close();
    let where = `the full ${stream} was not kept`;

    if (saved !== undefined) where = 'path' in saved ? `the full ${stream} is at ${saved.path}` : `the full ${stream} was not saved: ${saved.failure}`;

    return elidedOutput({ head: concatBytes(this.head), tail, total: this.total, stream, where });
  }

  private keep(chunk: Uint8Array): void {
    let rest = chunk;
    const headRoom = this.limits.headBytes - this.headLength;

    if (headRoom > 0) {
      const taken = new Uint8Array(rest.subarray(0, headRoom));
      this.head.push(taken);
      this.headLength += taken.length;
      rest = rest.subarray(taken.length);
    }

    const size = this.limits.tailBytes;

    if (rest.length === 0 || size === 0) return;
    this.tail ??= new Uint8Array(size);

    if (rest.length >= size) {
      this.tail.set(rest.subarray(rest.length - size));
      this.tailEnd = 0;
      this.tailLength = size;

      return;
    }

    const first = Math.min(rest.length, size - this.tailEnd);
    this.tail.set(rest.subarray(0, first), this.tailEnd);
    this.tail.set(rest.subarray(first), 0);
    this.tailEnd = (this.tailEnd + rest.length) % size;
    this.tailLength = Math.min(size, this.tailLength + rest.length);
  }

  private keptTail(): Uint8Array {
    if (this.tail === null) return new Uint8Array(0);

    if (this.tailLength < this.tail.length) return this.tail.subarray(0, this.tailLength);

    return concatBytes([this.tail.subarray(this.tailEnd), this.tail.subarray(0, this.tailEnd)]);
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/**
 * A stream's text once it outgrew what is kept: its head and tail, each cut at a whole character, the bytes dropped
 * between them counted, and `where` the whole of it went. Self-contained, as the device daemon's command supervisor runs
 * its source (pc-agent/src/index.js), so every executor's output reads alike.
 */
export function elidedOutput(kept: {
  readonly head: Uint8Array; readonly tail: Uint8Array; readonly total: number; readonly stream: string; readonly where: string;
}): string {
  const { head, tail, total, stream, where } = kept;
  const continues = (byte: number | undefined): boolean => ((byte ?? 0) & 0xC0) === 0x80;
  let headEnd = head.length;

  // A character cut at either seam is dropped whole rather than decoded as a replacement.
  for (let lead = head.length - 1; lead >= Math.max(0, head.length - 4); lead--) {
    const byte = head[lead] ?? 0;

    if (continues(byte)) continue;
    let size = 1;

    if (byte >= 0xF0) size = 4;
    else if (byte >= 0xE0) size = 3;
    else if (byte >= 0xC0) size = 2;

    if (lead + size > head.length) headEnd = lead;

    break;
  }

  let tailStart = 0;

  while (tailStart < Math.min(3, tail.length) && continues(tail[tailStart])) tailStart++;
  const omitted = total - headEnd - (tail.length - tailStart);
  const decoder = new TextDecoder();

  return `${decoder.decode(head.subarray(0, headEnd))}\n[... ${String(omitted)} bytes omitted ...]\n${decoder.decode(tail.subarray(tailStart))}`
    + `\n[${stream}: ${String(total)} bytes, ${String(omitted)} omitted from the middle; ${where}]\n`;
}
