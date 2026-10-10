/**
 * Boundary crossings into one isolate while a meter runs: each call another isolate or object makes into a method named
 * here is one crossing, counted under `<prefix>.<method>`. Each isolate counts what it receives, so a call between two
 * of them is counted once, where it lands.
 */

/** A class whose calls are counted, by its constructor: its methods live on its prototype. */
export interface CountedClass {
  readonly prototype: object;
  readonly name: string;
}

/** A class's methods as its prototype holds them. */
export type CountedMethods = Record<string, CountedMethod>;

/** One method as the prototype holds it: a function, called with the instance as `this` (`Function.prototype.apply`). */
export interface CountedMethod {
  apply(receiver: CountedMethods, args: readonly CallArgument[]): CallAnswer;
}

/** An argument a counted call passes through untouched. */
export type CallArgument = string | number | boolean | null | undefined | CountedMethods;

/** What a counted call answers, passed back untouched. */
export type CallAnswer = Promise<CallArgument> | CallArgument;

export class Crossings {
  #counts: Map<string, number> | null = null;

  begin(): void {
    this.#counts = new Map();
  }

  /** What landed since `begin`, by entry; the count stops. */
  end(): Record<string, number> {
    const counts = this.#counts ?? new Map<string, number>();

    this.#counts = null;

    return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  }

  crossed(entry: string): void {
    if (this.#aside === 0) this.#counts?.set(entry, (this.#counts.get(entry) ?? 0) + 1);
  }

  #aside = 0;

  /** `run` and the calls it makes are the measurement's own, never the turn's. */
  async aside<A>(run: () => Promise<A>): Promise<A> {
    this.#aside += 1;

    try {
      return await run();
    } finally {
      this.#aside -= 1;
    }
  }

  /** Every call to `names` on `owner`'s instances counts as a crossing into this isolate. */
  count(owner: CountedClass, prefix: string, names: readonly string[]): void {
    const crossed = (entry: string): void => { this.crossed(entry); };

    for (const name of names) {
      // A method of the prototype's own, as JavaScript holds it: a function, applied to the instance below.
      const original: CountedMethod | undefined = Object.getOwnPropertyDescriptor(owner.prototype, name)?.value;

      if (original === undefined) continue;
      Object.defineProperty(owner.prototype, name, {
        configurable: true, writable: true,
        value: function counted(this: CountedMethods, ...args: readonly CallArgument[]): CallAnswer {
          crossed(`${prefix}.${name}`);

          return original.apply(this, args);
        },
      });
    }
  }
}

/** Crossings summed over every entry. */
export function crossingTotal(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
