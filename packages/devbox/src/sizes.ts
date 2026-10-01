import * as v from 'valibot';
import type { CheckpointOutcome } from './storage';

/** Smallest first; a box stores the key (D50). */
export const BOX_SIZES = {
  small: { label: 'Small', vcpu: 1, memoryMib: 4_096, diskMb: 20_000 },
  medium: { label: 'Medium', vcpu: 2, memoryMib: 8_192, diskMb: 20_000 },
  large: { label: 'Large', vcpu: 4, memoryMib: 12_288, diskMb: 20_000 },
} as const;

export type BoxSize = keyof typeof BOX_SIZES;

export const DEFAULT_BOX_SIZE: BoxSize = 'medium';

function isBoxSize(key: string): key is BoxSize {
  return Object.hasOwn(BOX_SIZES, key);
}

export const BOX_SIZE_ORDER: readonly BoxSize[] = Object.keys(BOX_SIZES).filter(isBoxSize);

export const BoxSizeSchema = v.picklist(BOX_SIZE_ORDER);

export function instanceOf(size: BoxSize): ContainerStartResources {
  const { vcpu, memoryMib, diskMb } = BOX_SIZES[size];

  return { vcpu, memoryMib, diskMb };
}

export type ResizeOutcome =
  | { readonly kind: 'recorded'; readonly size: BoxSize; readonly previous: undefined }
  | { readonly kind: 'unchanged'; readonly size: BoxSize; readonly previous: BoxSize }
  | { readonly kind: 'restarted'; readonly size: BoxSize; readonly previous: BoxSize | undefined; readonly endedCommands: number; readonly checkpoint: CheckpointOutcome }
  | { readonly kind: 'failed'; readonly size: BoxSize; readonly previous: BoxSize | undefined; readonly reason: string };
