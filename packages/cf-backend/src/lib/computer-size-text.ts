import { BOX_SIZES, BOX_SIZE_ORDER, DEFAULT_BOX_SIZE, type BoxSize } from '@kinu.run/devbox/sizes';
import type { ComputerSizeState } from '../computer-size';

/** `2 vCPU · 8 GiB`: what a size gives. Every size has the same disk, so a choice between them does not name it. */
export function sizeSpecs(size: BoxSize): string {
  const { vcpu, memoryMib } = BOX_SIZES[size];

  return `${String(vcpu)} vCPU · ${String(Math.round(memoryMib / 102.4) / 10)} GiB`;
}

/** `Medium · 2 vCPU · 8 GiB`. */
export function computerSizeText(size: BoxSize): string {
  return `${BOX_SIZES[size].label} · ${sizeSpecs(size)}`;
}

export const ACCOUNT_DEFAULT = 'account';

export function workspaceSizeOptions(account: BoxSize | null): Array<{ value: BoxSize | typeof ACCOUNT_DEFAULT; label: string }> {
  return [
    { value: ACCOUNT_DEFAULT, label: `Your default · ${computerSizeText(account ?? DEFAULT_BOX_SIZE)}` },
    ...BOX_SIZE_ORDER.map((size) => ({ value: size, label: computerSizeText(size) })),
  ];
}

export function startRefusedNote(reason: string): string {
  return `The computer did not start: ${reason}. It stays stopped until you start it again or choose another size.`;
}

/** The computer's last stop, waiting on a disk that stopped answering: what Stop beside it does. */
export function stalledNote(stalled: string): string {
  return `${stalled.charAt(0).toUpperCase()}${stalled.slice(1)}. Stop restarts the computer: files stay as last saved, and what was running starts fresh.`;
}

/** A free account's computer, set larger than its cap, runs at the cap: said where its size is chosen. Null otherwise. */
export function cappedSizeNote(size: BoxSize, cap: BoxSize | null): string | null {
  if (cap === null || BOX_SIZE_ORDER.indexOf(size) <= BOX_SIZE_ORDER.indexOf(cap)) return null;

  return `A free account's computer runs at ${BOX_SIZES[cap].label}, whatever size is set. ${BOX_SIZES[size].label} stays set, for when the account has no limits.`;
}

/** What the workspace's size line says: a resize under way, a free account's cap, or a size waiting for the next start. */
export function workspaceSizeNote(state: ComputerSizeState, pending: boolean, cap: BoxSize | null): string | null {
  if (pending) return state.running === null ? 'Saving…' : 'Restarting at the new size…';
  const capped = cappedSizeNote(state.size, cap);

  if (capped !== null) return capped;

  if (state.running !== null && state.running !== state.size) {
    return `Runs at ${BOX_SIZES[state.running].label} until it next starts, then at ${BOX_SIZES[state.size].label}.`;
  }

  return null;
}
