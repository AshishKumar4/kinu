// The timer imported under another name is still the timer.
import { setTimeout as pause } from 'node:timers/promises';

export async function later(): Promise<void> {
  await pause(20);
}
