import type { ModelMessage } from 'ai';
import { freezeTree } from '../utils/freeze';

/** The same change to the same frozen message is the same frozen copy every step, which the request store names by
 *  identity. A mutable message could change under a kept copy, so it gets a fresh one. */
export class StableCopies {
  private readonly copies = new WeakMap<ModelMessage, { readonly change: string; readonly copy: ModelMessage }>();

  of(message: ModelMessage, change: string, copy: () => ModelMessage): ModelMessage {
    if (!Object.isFrozen(message)) return copy();
    const known = this.copies.get(message);

    if (known?.change === change) return known.copy;
    const fresh = copy();
    freezeTree({ value: fresh });
    this.copies.set(message, { change, copy: fresh });

    return fresh;
  }
}
