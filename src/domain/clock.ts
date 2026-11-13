/** "Now" is injected everywhere, so tests can freeze and advance time deterministically. */
export interface Clock {
  now(): Date;
}

/** Returns a number in [0, 1). Injected so that jitter is deterministic in tests. */
export type RandomSource = () => number;
