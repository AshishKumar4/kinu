/** The sandbox's size (D50): the owner's default is a config key; a workspace's choice lives in its box. */
import * as v from 'valibot';
import { BoxSizeSchema, type BoxSize } from '@kinu.run/devbox/sizes';

export const SANDBOX_SIZE_CONFIG_KEY = 'sandbox_size';

/** A value that names no size is no choice. */
export function accountSandboxSize(value: string | null): BoxSize | null {
  const parsed = v.safeParse(BoxSizeSchema, value);

  return parsed.success ? parsed.output : null;
}

/** `size` is what the next start uses. */
export interface SandboxSizeState {
  readonly account: BoxSize | null;
  readonly chosen: BoxSize | null;
  readonly size: BoxSize;
  readonly running: BoxSize | null;
}
