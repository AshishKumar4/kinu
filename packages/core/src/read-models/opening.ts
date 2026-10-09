import { Effect } from 'effect';
import { attempt, settle } from '../obs/effect';
import { KinuError, renderCauseChain } from '../obs/error';

/**
 * A list the workspace's opening read carries whose failure is its own: the tab reports it on that list's surface, as
 * the list's own read did, and the rest of the opening still lands (`getWorkspaceOpening`).
 */
export type OpeningList<T> = { readonly value: T } | { readonly error: string };

/** `read`'s answer as a list on the opening: its value, or its own failure. */
export function openingList<T>(doing: string, read: () => PromiseLike<T>): Effect.Effect<OpeningList<T>> {
  return Effect.match(attempt({ doing, otherwise: 'io' }, read), {
    onSuccess: (value): OpeningList<T> => ({ value }),
    onFailure: (failure): OpeningList<T> => ({ error: renderCauseChain(failure) }),
  });
}

/** {@link openingList}, run: for a caller outside Effect, such as the gallery's stand-in for the server. */
export function openingListOf<T>(doing: string, read: () => PromiseLike<T>): Promise<OpeningList<T>> {
  return settle(openingList(doing, read));
}

/** A list off the opening, as the list's own read would have answered it: its value, or its failure. */
export function listedOn<T>(list: OpeningList<T>): Promise<T> {
  return settle('error' in list ? Effect.fail(new KinuError('io', list.error)) : Effect.succeed(list.value));
}
