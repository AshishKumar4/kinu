import { createContext } from "react";
import type { Rpc } from "@kinu.run/core";

/** The chat's inline previews, so each sees a later one of its slate. */
export class SlatePreviews {
  private readonly cards = new Map<string, Set<Element>>();
  private readonly listeners = new Set<() => void>();

  /** Lists a preview; the returned function takes it off. */
  add(slate: string, card: Element): () => void {
    const cards = this.cards.get(slate) ?? new Set<Element>();

    cards.add(card);
    this.cards.set(slate, cards);
    this.changed();

    return () => {
      cards.delete(card);
      this.changed();
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  };

  /** Whether a preview later in the document shows the same slate. */
  superseded(slate: string, card: Element | null): boolean {
    if (card === null) return false;

    for (const other of this.cards.get(slate) ?? []) {
      if (other !== card && (card.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return true;
    }

    return false;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Null where a surface cannot host a frame; `slate://` links then render as code. `chat` is set only around the
 *  chat, whose previews fold. */
export const SlateInlineContext = createContext<{
  rpc: Rpc;
  openSlate?: (id: string) => void;
  chat?: { readonly previews: SlatePreviews; readonly shownInPanel: string | null };
} | null>(null);
