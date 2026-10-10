/**
 * Boundary crossings into one isolate while a meter runs: each call another isolate or object makes into a method of a
 * receiving class here is one crossing, counted under `<prefix>.<method>`. Each isolate counts what it receives, so a
 * call between two of them is counted once, where it lands. A class is counted whole, its inherited methods too, and an
 * RPC target one of its methods answers with is counted as it leaves, whatever its class: a Nimbus session, a memory, a
 * context tree. Only a call's entry is a crossing: what the receiver calls on itself while it answers is a helper of
 * that call (Nimbus's session reads through its own `client()` and `cred()`), and a target's instances that never left
 * this isolate are this isolate's own. The count splits into phases at a marker call, each step's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DurableObject, RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';

/** A class whose calls are counted, by its constructor: its methods live on its prototype. */
export interface CountedClass {
  readonly prototype: object;
  readonly name: string;
}

/** One method as the prototype holds it: a function, called with the instance as `this` (`Function.prototype.apply`). */
export interface CountedMethod {
  apply(receiver: CountedMethods, args: readonly CallArgument[]): CallAnswer;
}

/** A class's methods as its prototype holds them. */
export type CountedMethods = Record<string, CountedMethod>;

/** An argument a counted call passes through untouched. */
export type CallArgument = string | number | boolean | null | undefined | CountedMethods;

/** What a counted call answers, passed back untouched. */
export type CallAnswer = Promise<CallArgument> | CallArgument;

/** A metered window's crossings: in all, and split at each phase marker, the first phase before the first marker. */
export interface PhasedCrossings {
  readonly total: Readonly<Record<string, number>>;
  readonly phases: ReadonlyArray<Readonly<Record<string, number>>>;
}

/** What a call that crossed is answering, as everything it awaits sees it. */
interface Answering {
  /** The receivers of the calls that crossed and are answering here: a call one of them makes on itself is no crossing. */
  readonly receivers: ReadonlySet<object>;
  /** The measurement's own calls, never the turn's. */
  readonly aside: boolean;
}

/** One counted method: the entry it counts under, the method it wraps, and whether only instances handed across count. */
interface CountedEntry {
  readonly entry: string;
  readonly original: CountedMethod;
  readonly handedOnly: boolean;
}

/** The prototypes a class's own surface stops at: the runtime's, which no counted method lives on. */
const RUNTIME_BASES: readonly object[] = [Object.prototype, RpcTarget.prototype, WorkerEntrypoint.prototype, DurableObject.prototype];

export class Crossings {
  #phases: Array<Map<string, number>> | null = null;

  readonly #answering = new AsyncLocalStorage<Answering>();

  readonly #counted = new WeakSet<object>();

  /** The instances of a returned target's class that a counted call handed across: the rest never left this isolate. */
  readonly #handed = new WeakSet<object>();

  /** `marker` is the call each phase after the first starts with. */
  constructor(private readonly marker: string) {}

  begin(): void {
    this.#phases = [new Map()];
  }

  /** What landed since `begin`, by entry and by phase; the count stops. */
  end(): PhasedCrossings {
    const phases = (this.#phases ?? [new Map<string, number>()]).map((phase) => sorted(phase));
    const total = new Map<string, number>();

    this.#phases = null;

    for (const phase of phases) for (const [entry, count] of Object.entries(phase)) total.set(entry, (total.get(entry) ?? 0) + count);

    return { total: sorted(total), phases };
  }

  crossed(entry: string): void {
    const phases = this.#phases;

    if (phases === null || this.#answering.getStore()?.aside === true) return;

    if (entry === this.marker) phases.push(new Map());
    const phase = phases.at(-1);

    phase?.set(entry, (phase.get(entry) ?? 0) + 1);
  }

  /** `run` and the calls it makes are the measurement's own, never the turn's. */
  async aside<A>(run: () => Promise<A>): Promise<A> {
    return await this.#answering.run({ receivers: new Set(), aside: true }, run);
  }

  /** `names` on `owner`'s instances, each counted as a crossing; a name that is no method of its fails here. */
  count(owner: CountedClass, prefix: string, names: readonly string[]): void {
    this.#count(owner, prefix, names, false);
  }

  /** Every method of `owner`, inherited ones too, but `internal`: the whole surface another isolate can call. */
  countAll(owner: CountedClass, prefix: string, internal: readonly string[] = []): void {
    this.#countAll(owner, prefix, internal, false);
  }

  #countAll(owner: CountedClass, prefix: string, internal: readonly string[], handedOnly: boolean): void {
    if (this.#counted.has(owner.prototype)) return;
    this.#counted.add(owner.prototype);
    this.#count(owner, prefix, surfaceOf(owner).filter((name) => !internal.includes(name)), handedOnly);
  }

  #count(owner: CountedClass, prefix: string, names: readonly string[], handedOnly: boolean): void {
    for (const name of names) {
      const original = methodOf(owner, name);

      if (original === null) throw new Error(`crossings: ${owner.name}.${name} is no method to count`);
      this.#wrap(owner, name, { entry: `${prefix}.${name}`, original, handedOnly });
    }
  }

  #wrap(owner: CountedClass, name: string, { entry, original, handedOnly }: CountedEntry): void {
    const enter = (receiver: CountedMethods, args: readonly CallArgument[]): CallAnswer => this.#enter(receiver, entry, handedOnly, () => original.apply(receiver, args));

    // On the class's own prototype, inherited or not: its instances and only its instances are counted.
    Object.defineProperty(owner.prototype, name, {
      configurable: true, writable: true,
      value: function counted(this: CountedMethods, ...args: readonly CallArgument[]): CallAnswer {
        return enter(this, args);
      },
    });
  }

  #enter(receiver: CountedMethods, entry: string, handedOnly: boolean, call: () => CallAnswer): CallAnswer {
    const answering = this.#answering.getStore();

    // A helper the receiver calls on itself while it answers, or a target's instance that never crossed: no crossing.
    if (answering?.receivers.has(receiver) === true || (handedOnly && !this.#handed.has(receiver))) return call();
    this.crossed(entry);

    return this.#answering.run({ receivers: new Set([...answering?.receivers ?? [], receiver]), aside: answering?.aside ?? false }, () => {
      const answer = call();

      if (!(answer instanceof Promise)) {
        this.#adopt(answer);

        return answer;
      }

      return answer.then((settled) => {
        this.#adopt(settled);

        return settled;
      });
    });
  }

  /** An RPC target a counted call answers with is a surface of its own, counted whole as it leaves: this instance and
   *  every other its class hands across, never one this isolate keeps. */
  #adopt(answer: CallArgument): void {
    if (typeof answer !== 'object' || answer === null || !(answer instanceof RpcTarget)) return;
    const owner: CountedClass = { prototype: Object.getPrototypeOf(answer), name: answer.constructor.name };

    this.#handed.add(answer);
    this.#countAll(owner, owner.name, [], true);
  }
}

function sorted(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

/** `name` as a method of `owner`'s, its own or inherited, short of the runtime's own. */
function methodOf(owner: CountedClass, name: string): CountedMethod | null {
  for (let at: object | null = owner.prototype; at !== null && !RUNTIME_BASES.includes(at); at = Object.getPrototypeOf(at)) {
    const method: CountedMethod | undefined = Object.getOwnPropertyDescriptor(at, name)?.value;

    if (typeof method === 'function') return method;
  }

  return null;
}

/** Every method name of `owner`'s, its own and inherited, short of the runtime's own. */
function surfaceOf(owner: CountedClass): string[] {
  const names = new Set<string>();

  for (let at: object | null = owner.prototype; at !== null && !RUNTIME_BASES.includes(at); at = Object.getPrototypeOf(at)) {
    for (const name of Object.getOwnPropertyNames(at)) {
      if (name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(at, name)?.value === 'function') names.add(name);
    }
  }

  return [...names];
}

/** Crossings summed over every entry. */
export function crossingTotal(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
