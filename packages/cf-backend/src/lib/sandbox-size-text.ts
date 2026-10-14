import { BOX_SIZES, BOX_SIZE_ORDER, DEFAULT_BOX_SIZE, type BoxSize } from '@kinu.run/devbox/sizes';
import type { SandboxSizeState } from '../sandbox-size';

/** `2 vCPU · 8 GiB`: what a size gives. Every size has the same disk, so a choice between them does not name it. */
export function sizeSpecs(size: BoxSize): string {
  const { vcpu, memoryMib } = BOX_SIZES[size];

  return `${String(vcpu)} vCPU · ${String(Math.round(memoryMib / 102.4) / 10)} GiB`;
}

/** `Medium · 2 vCPU · 8 GiB`. */
export function sandboxSizeText(size: BoxSize): string {
  return `${BOX_SIZES[size].label} · ${sizeSpecs(size)}`;
}

export const ACCOUNT_DEFAULT = 'account';

export function workspaceSizeOptions(account: BoxSize | null): Array<{ value: BoxSize | typeof ACCOUNT_DEFAULT; label: string }> {
  return [
    { value: ACCOUNT_DEFAULT, label: `Your default · ${sandboxSizeText(account ?? DEFAULT_BOX_SIZE)}` },
    ...BOX_SIZE_ORDER.map((size) => ({ value: size, label: sandboxSizeText(size) })),
  ];
}

export function startRefusedNote(reason: string): string {
  return `The computer did not start: ${reason}. It stays stopped until you start it again or choose another size.`;
}

export function workspaceSizeNote(state: SandboxSizeState, pending: boolean): string | null {
  if (pending) return state.running === null ? 'Saving…' : 'Restarting at the new size…';

  if (state.running !== null && state.running !== state.size) {
    return `Runs at ${BOX_SIZES[state.running].label} until it next starts, then at ${BOX_SIZES[state.size].label}.`;
  }

  return null;
}
