/**
 * The landing walkthrough's public contract: the cue table, its end, and the
 * handle the plan frame installs on `window`.
 *
 * This module deliberately imports nothing — no fixtures, components, browser
 * code or backend types — and lives in core so every reader shares it: the
 * plan frame under cf-backend, the recorder (scripts/plan-demo-film.ts) and
 * the public-page gate (scripts/public-pages.test.ts), which typecheck
 * against it under the scripts program where reaching into the timeline's
 * component-land imports would drag the product's DOM types under a
 * different lib. Story text, cursor geometry and the discrete-build logic
 * stay in `landing-movie-timeline.ts`, which reads its timing from here.
 */

/** Named beats, in absolute movie milliseconds. Order is the story. Spacing
 *  follows the deleted demo's `DEMO_CUES` calibration (`CURSOR_ENTER_AT` kept). */
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

/** A beat name from the published table — what evidence stamps and test
 *  seeks name instead of an unverified string. */
export type MovieCue = keyof typeof MOVIE_CUES;

/** The movie's deterministic drive, installed on `window` by the plan frame.
 *  The public-page tests drive the SAME timeline through it — never a second
 *  copy of the story. */
export interface LandingMovieHandle {
  readonly duration: number;
  readonly cues: typeof MOVIE_CUES;
  /** Jump the timeline. Resolves once the beat's DOM is settled — the plan
   *  chunk mounted, the approve click decided where the beat expects it — so
   *  a caller can assert immediately. */
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
