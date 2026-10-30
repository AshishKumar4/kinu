import { createContext, useCallback, useContext, useState, useSyncExternalStore } from "react";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

/**
 * The chat's previews, each listed under what it shows (a slate's id, a site's origin), so each sees a later one of the
 * same: an answer's slate and a tool's preview of a site fold alike.
 */
export class ChatPreviews {
  private readonly cards = new Map<string, Set<Element>>();
  private readonly latest = new Map<string, Element>();
  private readonly listeners = new Set<() => void>();

  /** Lists a preview; the returned function takes it off. */
  add(target: string, card: Element): () => void {
    const cards = this.cards.get(target) ?? new Set<Element>();

    cards.add(card);
    this.cards.set(target, cards);
    this.settle(target);

    return () => {
      cards.delete(card);
      this.settle(target);
    };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  };

  /** Whether a preview later in the document shows the same target. */
  superseded(target: string, card: Element | null): boolean {
    const latest = this.latest.get(target);

    return card !== null && latest !== undefined && latest !== card;
  }

  private settle(target: string): void {
    let latest: Element | undefined;

    for (const card of this.cards.get(target) ?? []) {
      if (latest === undefined || (latest.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) latest = card;
    }

    if (latest === this.latest.get(target)) return;

    if (latest === undefined) this.latest.delete(target);
    else this.latest.set(target, latest);

    for (const listener of this.listeners) listener();
  }
}

/** Null where a surface cannot host a frame; `slate://` links then render as code. `chat` is set only around the
 *  chat, whose previews fold. */
export const SlateInlineContext = createContext<{
  rpc: WorkspaceRpc;
  openSlate?: (id: string) => void;
  /** The slate an answer's page was saved as, by the workspace's slate list; none until it is saved. */
  savedAs?: (page: string) => { readonly id: string; readonly title: string } | null;
  chat?: { readonly previews: ChatPreviews; readonly shownInPanel: string | null };
} | null>(null);

const UNLISTED = (): (() => void) => () => {};

/** A chat preview's fold: why it folds by itself, if it does, whether it is folded, and the reader's toggle. */
export interface PreviewFold {
  /** Its element, listed with the chat's previews while it is mounted. */
  readonly register: (element: Element | null) => () => void;
  /** "Updated below" once a later preview shows the same target, else `elsewhere`'s words; null when neither holds. */
  readonly reason: string | null;
  readonly folded: boolean;
  readonly toggle: () => void;
}

/**
 * Folds a preview behind a later one of its target, or while `elsewhere` names another place that shows it. A fold the
 * reader set by hand holds until the reason for the automatic one clears. Outside the chat nothing folds by itself.
 */
export function usePreviewFold(target: string, elsewhere: string | null): PreviewFold {
  const previews = useContext(SlateInlineContext)?.chat?.previews;
  const [card, setCard] = useState<Element | null>(null);

  const register = useCallback((element: Element | null) => {
    setCard(element);
    const remove = element === null ? undefined : previews?.add(target, element);

    return () => remove?.();
  }, [previews, target]);

  const superseded = useSyncExternalStore(previews?.subscribe ?? UNLISTED, () => previews?.superseded(target, card) ?? false, () => false);
  const reason = superseded ? "Updated below" : elsewhere;
  const auto = reason !== null;
  const [hand, setHand] = useState<boolean | null>(null);
  const [was, setWas] = useState(auto);

  if (was !== auto) {
    setWas(auto);

    if (!auto) setHand(null);
  }

  const folded = hand ?? auto;

  return { register, reason, folded, toggle: () => { setHand(!folded); } };
}
