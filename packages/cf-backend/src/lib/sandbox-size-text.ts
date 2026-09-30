import { BOX_SIZES, BOX_SIZE_ORDER, DEFAULT_BOX_SIZE, type BoxSize } from '@kinu.run/devbox/sizes';
import type { SandboxSizeState } from '../sandbox-size';

/** `Medium · 2 vCPU · 8 GiB · 20 GB disk`. */
export function sandboxSizeText(size: BoxSize): string {
  const { label, vcpu, memoryMib, diskMb } = BOX_SIZES[size];

  return `${label} · ${String(vcpu)} vCPU · ${String(Math.round(memoryMib / 102.4) / 10)} GiB · ${String(diskMb / 1000)} GB disk`;
}

export const ACCOUNT_DEFAULT = 'account';

export function workspaceSizeOptions(account: BoxSize | null): Array<{ value: BoxSize | typeof ACCOUNT_DEFAULT; label: string }> {
  return [
    { value: ACCOUNT_DEFAULT, label: `Account default: ${sandboxSizeText(account ?? DEFAULT_BOX_SIZE)}` },
    ...BOX_SIZE_ORDER.map((size) => ({ value: size, label: sandboxSizeText(size) })),
  ];
}

export function workspaceSizeNote(state: SandboxSizeState, pending: boolean): string | null {
  if (pending) return state.running === null ? 'Saving…' : 'Restarting at the new size…';

  if (state.running !== null && state.running !== state.size) {
    return `Runs at ${BOX_SIZES[state.running].label} until it next starts, then at ${BOX_SIZES[state.size].label}.`;
  }

  return null;
}
