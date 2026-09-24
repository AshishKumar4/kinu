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

const CONTINUATION_MASK = 0xC0;

const CONTINUATION_BITS = 0x80;

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
    const head = concatBytes(this.head);
    const headEnd = completeUtf8End(head);
    const tailStart = firstUtf8Start(tail);
    const omitted = this.total - headEnd - (tail.length - tailStart);
    const decoder = new TextDecoder();
    const kept = `${decoder.decode(head.subarray(0, headEnd))}\n[… ${String(omitted)} bytes omitted …]\n${decoder.decode(tail.subarray(tailStart))}`;
    const saved = this.spill?.close();
    let where = `the full ${stream} was not kept`;

    if (saved !== undefined) where = 'path' in saved ? `the full ${stream} is at ${saved.path}` : `the full ${stream} was not saved: ${saved.failure}`;

    return `${kept}\n[${stream}: ${String(this.total)} bytes, ${String(omitted)} omitted from the middle; ${where}]\n`;
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

function completeUtf8End(bytes: Uint8Array): number {
  for (let lead = bytes.length - 1; lead >= Math.max(0, bytes.length - 4); lead--) {
    const byte = bytes[lead] ?? 0;

    if ((byte & CONTINUATION_MASK) === CONTINUATION_BITS) continue;

    return lead + utf8SequenceLength(byte) > bytes.length ? lead : bytes.length;
  }

  return bytes.length;
}

function firstUtf8Start(bytes: Uint8Array): number {
  let start = 0;

  while (start < Math.min(3, bytes.length) && ((bytes[start] ?? 0) & CONTINUATION_MASK) === CONTINUATION_BITS) start++;

  return start;
}

function utf8SequenceLength(lead: number): number {
  if (lead >= 0xF0) return 4;

  if (lead >= 0xE0) return 3;

  return lead >= 0xC0 ? 2 : 1;
}
