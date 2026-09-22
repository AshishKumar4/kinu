/**
 * The landing walkthrough's public contract: cue table, end, and the `window` handle. Imports nothing,
 * so scripts typecheck against it without the timeline's DOM types; story logic is in `landing-movie-timeline.ts`.
 */

/** Named beats, in absolute movie milliseconds. Order is the story. */
export const MOVIE_CUES = {
  typeStart: 300,
  sent: 2_600,
  reasoning: 3_000,
  readStart: 3_400,
  readDone: 4_200,
  searchStart: 4_400,
  searchDone: 5_200,
  submitted: 5_600,
  planReady: 6_200,
  approve: 8_600,
  approvedText: 9_200,
  manifestStart: 9_600,
  manifestDone: 10_200,
  serverStart: 10_400,
  serverDone: 11_200,
  clientStart: 11_400,
  clientDone: 12_200,
  previewStart: 12_400,
  previewDone: 13_000,
  slateOpen: 13_400,
  finalText: 13_800,
  end: 15_400,
} as const;

export const MOVIE_END = MOVIE_CUES.end;

/** A beat name from the published table. */
export type MovieCue = keyof typeof MOVIE_CUES;

/** The movie's deterministic drive, installed on `window`; tests drive the same timeline through it. */
export interface LandingMovieHandle {
  readonly duration: number;
  readonly cues: typeof MOVIE_CUES;
  /** Jump the timeline; resolves once the beat's DOM is settled, so callers can assert immediately. */
  seek(at: number): Promise<void>;
  play(): void;
  pause(): void;
  state(): { t: number; playing: boolean; settled: boolean };
}

declare global {
  interface Window {
    __kinuLandingMovie?: LandingMovieHandle;
  }
}
