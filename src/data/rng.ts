/**
 * Deterministic PRNG. Same seed -> same sequence, on every machine and run.
 * This is what makes the seeded dataset and the fault/latency injection
 * reproducible, which the brief requires. Hand-rolled to avoid a dependency.
 *
 * mulberry32: small, fast, good enough distribution for test data. Not for
 * anything cryptographic.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience helpers over a raw number stream. */
export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** [0, 1) */
  float(): number {
    return this.next();
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}
