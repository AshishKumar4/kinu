import * as v from 'valibot';
import type { JsonValue } from '@kinu.run/core';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { matchesReference, type EvalVerifier, type Script, type SlateClient } from '../src/verifier';
import { Seeded } from './seeded';

// A small exchange: a limit order book with price-time priority, built from a precise spec. The
// checker places a day of seeded orders and compares every fill with its own matching engine
// below, then adds self-trade prevention and post-only orders, then asks for a number the trades
// imply. Exact rules and many edge cases make this the hardest task.

const MISSION = "Kestrel Markets' workspace. We run a small internal exchange where employees trade company shares.";

const SYMBOLS = ['ACME', 'BOLT'];

// ── The contract ─────────────────────────────────────────────────────

const METHODS = ['place', 'cancel', 'book', 'trades'] as const;

type Method = (typeof METHODS)[number];

const Refused = v.object({ ok: v.literal(false), error: v.string() });

/** Prices are compared in whole cents, so 101.1 and 101.10 are one price. */
const Price = v.pipe(v.number(), v.transform((price) => Math.round(price * 100) / 100));

const FillSchema = v.object({ buyId: v.string(), sellId: v.string(), price: Price, qty: v.number() });

const LevelSchema = v.object({ price: Price, qty: v.number() });

const ANSWERS: Record<Method, v.GenericSchema<JsonValue>> = {
  place: v.variant('ok', [v.object({ ok: v.literal(true), fills: v.array(FillSchema), restingQty: v.number() }), Refused]),
  cancel: v.variant('ok', [v.object({ ok: v.literal(true), canceledQty: v.number() }), Refused]),
  book: v.object({ bids: v.array(LevelSchema), asks: v.array(LevelSchema) }),
  trades: v.object({ trades: v.array(FillSchema) }),
};

function normalize(method: Method, answer: JsonValue): JsonValue {
  const parsed = v.safeParse(ANSWERS[method], answer);

  return parsed.success ? parsed.output : answer;
}

// ── The checker's own matching engine ────────────────────────────────

type Order = { id: string; trader: string; symbol: string; side: string; type: string; price?: number; qty: number; postOnly?: boolean };

const OrderInput = v.object({
  id: v.string(), trader: v.string(), symbol: v.string(), side: v.string(), type: v.string(),
  price: v.optional(v.number()), qty: v.number(), postOnly: v.optional(v.boolean()),
});

const SymbolInput = v.object({ symbol: v.string() });

type Resting = { id: string; trader: string; side: 'buy' | 'sell'; cents: number; qty: number; seq: number };

type Book = { bids: { price: number; qty: number }[]; asks: { price: number; qty: number }[] };

type Fill = { buyId: string; sellId: string; price: number; qty: number };

/** Turn 2's two features, off until the prompt adds them. */
type Features = { selfTradePrevention: boolean; postOnly: boolean };

const FIRST_FEATURES: Features = { selfTradePrevention: false, postOnly: false };

const TURN_2_FEATURES: Features = { selfTradePrevention: true, postOnly: true };

function isCents(price: number): boolean {
  return Math.abs(price * 100 - Math.round(price * 100)) < 1e-6;
}

class ReferenceExchange {
  features = FIRST_FEATURES;
  readonly #ids = new Set<string>();
  readonly #resting = new Map<string, Resting[]>(SYMBOLS.map((symbol) => [symbol, []]));
  readonly #trades = new Map<string, Fill[]>(SYMBOLS.map((symbol) => [symbol, []]));
  #seq = 0;

  /** The first rule an order breaks, in the order the prompt lists them. */
  #invalid(order: Order): string | null {
    if (this.#ids.has(order.id)) return 'DUPLICATE_ID';

    if (!SYMBOLS.includes(order.symbol)) return 'UNKNOWN_SYMBOL';

    if (order.side !== 'buy' && order.side !== 'sell') return 'BAD_SIDE';

    if (!Number.isInteger(order.qty) || order.qty <= 0) return 'BAD_QTY';

    if (order.type === 'market') return order.price === undefined ? null : 'BAD_PRICE';

    if (order.type !== 'limit' || order.price === undefined || order.price <= 0 || !isCents(order.price)) return 'BAD_PRICE';

    return null;
  }

  /** Resting orders of `side`, best first: highest bid, lowest ask, then earliest. */
  #queue(symbol: string, side: 'buy' | 'sell'): Resting[] {
    return (this.#resting.get(symbol) ?? []).filter((order) => order.side === side)
      .sort((left, right) => (side === 'buy' ? right.cents - left.cents : left.cents - right.cents) || left.seq - right.seq);
  }

  #crosses(order: Order, resting: Resting): boolean {
    if (order.type === 'market') return true;
    const cents = Math.round((order.price ?? 0) * 100);

    return order.side === 'buy' ? resting.cents <= cents : resting.cents >= cents;
  }

  #remove(symbol: string, id: string): void {
    this.#resting.set(symbol, (this.#resting.get(symbol) ?? []).filter((order) => order.id !== id));
  }

  place(order: Order): JsonValue {
    const error = this.#invalid(order);

    if (error !== null) return { ok: false, error };
    const side = order.side === 'buy' ? 'buy' : 'sell';
    const opposite = this.#queue(order.symbol, side === 'buy' ? 'sell' : 'buy');
    const takes = opposite.filter((resting) => this.#crosses(order, resting));

    if (this.features.postOnly && order.postOnly === true && takes.length > 0) return { ok: false, error: 'WOULD_CROSS' };

    this.#ids.add(order.id);
    const fills: Fill[] = [];
    let remaining = order.qty;

    for (const resting of takes) {
      if (remaining === 0) break;

      if (this.features.selfTradePrevention && resting.trader === order.trader) {
        this.#remove(order.symbol, resting.id);
        continue;
      }

      const qty = Math.min(remaining, resting.qty);

      const fill = side === 'buy'
        ? { buyId: order.id, sellId: resting.id, price: resting.cents / 100, qty }
        : { buyId: resting.id, sellId: order.id, price: resting.cents / 100, qty };

      fills.push(fill);
      this.#trades.get(order.symbol)?.push(fill);
      remaining -= qty;
      resting.qty -= qty;

      if (resting.qty === 0) this.#remove(order.symbol, resting.id);
    }

    const restingQty = order.type === 'limit' ? remaining : 0;

    if (restingQty > 0) {
      this.#seq += 1;
      this.#resting.get(order.symbol)?.push({ id: order.id, trader: order.trader, side, cents: Math.round((order.price ?? 0) * 100), qty: restingQty, seq: this.#seq });
    }

    return { ok: true, fills, restingQty };
  }

  cancel(id: string): JsonValue {
    for (const [symbol, orders] of this.#resting) {
      const order = orders.find((resting) => resting.id === id);

      if (order !== undefined) {
        this.#remove(symbol, id);

        return { ok: true, canceledQty: order.qty };
      }
    }

    return { ok: false, error: 'UNKNOWN_ORDER' };
  }

  book(symbol: string): Book {
    const levels = (side: 'buy' | 'sell') => {
      const summed = new Map<number, number>();

      for (const order of this.#queue(symbol, side)) summed.set(order.cents, (summed.get(order.cents) ?? 0) + order.qty);

      return [...summed].map(([cents, qty]) => ({ price: cents / 100, qty }));
    };

    return { bids: levels('buy'), asks: levels('sell') };
  }

  trades(symbol: string): Fill[] {
    return [...this.#trades.get(symbol) ?? []];
  }

  /** The contract's methods over this engine, called the way the checker calls the slate. */
  client(): SlateClient<Method> {
    return (method, input) => {
      switch (method) {
        case 'place': return Promise.resolve(this.place(v.parse(OrderInput, input)));
        case 'cancel': return Promise.resolve(this.cancel(v.parse(v.object({ id: v.string() }), input).id));
        case 'book': return Promise.resolve(this.book(v.parse(SymbolInput, input).symbol));
        case 'trades': return Promise.resolve({ trades: this.trades(v.parse(SymbolInput, input).symbol) });
      }
    };
  }
}

// ── The checker's orders ─────────────────────────────────────────────

const lookBoth: Script<Method> = async (exchange) => {
  for (const symbol of SYMBOLS) {
    await exchange('book', { symbol });
    await exchange('trades', { symbol });
  }
};

// Each order breaks exactly one rule; then a good one, and its id again.
const badOrders: Script<Method> = async (exchange) => {
  const base = { trader: 't1', symbol: 'ACME', side: 'buy', type: 'limit', price: 100, qty: 10 };
  await exchange('place', { ...base, id: 'bad-1', symbol: 'ZETA' });
  await exchange('place', { ...base, id: 'bad-2', side: 'hold' });
  await exchange('place', { ...base, id: 'bad-3', qty: 0 });
  await exchange('place', { ...base, id: 'bad-4', qty: 2.5 });
  await exchange('place', { id: 'bad-5', trader: 't1', symbol: 'ACME', side: 'buy', type: 'limit', qty: 10 });
  await exchange('place', { ...base, id: 'bad-6', price: 100.005 });
  await exchange('place', { ...base, id: 'bad-7', type: 'market' });
  await exchange('place', { ...base, id: 'a-1', price: 99.5 });
  await exchange('place', { ...base, id: 'a-1', price: 99.25, qty: 5 });
  await lookBoth(exchange);
};

// By hand: time priority at one price, price priority across prices, a sweep through two levels at
// the resting prices, a sell filled above its limit, market orders whose remainder is dropped, and
// cancels of a resting, a filled and an unknown order.
const handOrders: Script<Method> = async (exchange) => {
  // [id, trader, side, price, qty]; no price is a market order.
  const orders: readonly (readonly [string, string, string, number | null, number])[] = [
    ['a-2', 't2', 'sell', 100.5, 30], ['a-3', 't3', 'sell', 100.25, 20], ['a-4', 't4', 'sell', 100.25, 25],
    ['a-5', 't5', 'buy', 100.25, 30], ['a-6', 't6', 'buy', 101, 60], ['a-7', 't7', 'sell', 99, 50],
    ['a-8', 't8', 'buy', null, 100], ['a-9', 't2', 'sell', null, 10], ['a-10', 't5', 'buy', 98, 40],
  ];

  for (const [id, trader, side, price, qty] of orders) {
    await exchange('place', price === null
      ? { id, trader, symbol: 'ACME', side, type: 'market', qty }
      : { id, trader, symbol: 'ACME', side, type: 'limit', price, qty });
  }

  await exchange('cancel', { id: 'a-10' });
  await exchange('cancel', { id: 'a-6' });
  await exchange('cancel', { id: 'nope' });
  await lookBoth(exchange);
};

type Operation = { kind: 'place'; order: Order } | { kind: 'cancel'; id: string };

/** A day of orders around a mid price: a tenth are market orders, one in nine is a cancel. */
function day(seed: number, prefix: string, count: number, options: { postOnly: boolean; traders: number }): Operation[] {
  const random = new Seeded(seed);
  const operations: Operation[] = [];

  for (let index = 1; index <= count; index += 1) {
    if (index > 5 && random.next() < 1 / 9) {
      operations.push({ kind: 'cancel', id: `${prefix}-${String(random.int(1, index - 1))}` });
      continue;
    }

    const symbol = random.pick(SYMBOLS);
    const side = random.pick(['buy', 'sell']);
    const [mid, tick] = symbol === 'ACME' ? [10_000, 5] : [2_000, 1];
    const cents = mid + (side === 'buy' ? -1 : 1) * random.int(-8, 20) * tick;
    const trader = `t${String(random.int(1, options.traders))}`;
    const qty = random.int(1, 30) * 10;
    const id = `${prefix}-${String(index)}`;

    if (random.next() < 0.1) {
      operations.push({ kind: 'place', order: { id, trader, symbol, side, type: 'market', qty } });
    } else {
      const order: Order = { id, trader, symbol, side, type: 'limit', price: cents / 100, qty };

      if (options.postOnly && random.next() < 0.2) order.postOnly = true;
      operations.push({ kind: 'place', order });
    }
  }

  return operations;
}

const FIRST_DAY = day(20270917, 'd1', 170, { postOnly: false, traders: 12 });

// Four traders on the second day, so an order often meets its own trader's resting orders.
const SECOND_DAY = day(20270918, 'd2', 150, { postOnly: true, traders: 4 });

function replay(operations: readonly Operation[]): Script<Method> {
  return async (exchange) => {
    for (const operation of operations) {
      if (operation.kind === 'place') await exchange('place', operation.order);
      else await exchange('cancel', { id: operation.id });
    }

    await lookBoth(exchange);
  };
}

const TURN_1: readonly Script<Method>[] = [badOrders, handOrders, replay(FIRST_DAY)];

// t3 rests two asks and then buys through the book: its own resting orders it reaches are cancelled,
// wherever they sit, and everyone else's trade.
const selfTrades: Script<Method> = async (exchange) => {
  // [id, trader, side, price, qty]
  const orders: readonly (readonly [string, string, string, number, number])[] = [
    ['s-1', 't3', 'sell', 25.01, 40], ['s-2', 't9', 'sell', 25.01, 30], ['s-3', 't3', 'sell', 25.02, 20],
    ['s-4', 't9', 'sell', 25.03, 50], ['s-5', 't3', 'buy', 25.03, 100],
  ];

  for (const [id, trader, side, price, qty] of orders) await exchange('place', { id, trader, symbol: 'BOLT', side, type: 'limit', price, qty });

  await exchange('place', { id: 's-6', trader: 't9', symbol: 'BOLT', side: 'buy', type: 'market', qty: 10 });
  await lookBoth(exchange);
};

// A post-only order that would trade is refused and changes nothing; one that would not, rests.
// The last reuses an id, which is the first rule it breaks.
const postOnlyOrders: Script<Method> = async (exchange) => {
  const order = (id: string, trader: string, side: string, price: number) => exchange('place', 
    { id, trader, symbol: 'BOLT', side, type: 'limit', price, qty: 15, postOnly: true });

  await order('p-1', 't10', 'buy', 30);
  await order('p-2', 't10', 'buy', 12.5);
  await order('p-3', 't11', 'sell', 1);
  await order('p-2', 't10', 'sell', 40);
  await lookBoth(exchange);
};

/** Turn 1's requests, or turn 2's features switched on between them. */
type Step = readonly Script<Method>[] | Features;

async function exchangeAfter(history: readonly Step[]): Promise<ReferenceExchange> {
  const exchange = new ReferenceExchange();

  for (const step of history) {
    if ('postOnly' in step) exchange.features = step;
    else for (const script of step) await script(exchange.client());
  }

  return exchange;
}

async function sameAsReference(verifier: EvalVerifier, id: string, history: readonly Step[], script: Script<Method>): Promise<void> {
  await verifier.check(id, async () => matchesReference({
    slate: verifier.slate('exchange', METHODS), reference: (await exchangeAfter(history)).client(), script, normalize,
  }));
}

const TURN_2: readonly Script<Method>[] = [selfTrades, postOnlyOrders, replay(SECOND_DAY)];

const AFTER_TURN_2: readonly Step[] = [TURN_1, TURN_2_FEATURES, TURN_2];

const QUESTION_SYMBOL = 'ACME';

// ── The task ─────────────────────────────────────────────────────────

const task = defineEvalTask({
  id: 'order-book',
  mission: MISSION,
  turns: [{
    prompt: `Build a slate with id "exchange": a limit order book for our two shares, ACME and BOLT, keeping
everything in the slate's own storage. Prices are dollars with at most two decimals, like 101.25;
quantities are whole shares.

Orders are matched by price, then time. An incoming buy trades with the resting sells at the lowest
price first, and among equal prices the earliest placed first, for as long as their price is at or
below its limit; an incoming sell does the same against the resting buys, highest price first. Each
trade is for the smaller of the two remaining quantities, at the resting order's price. Whatever a
limit order does not fill rests in the book. A market order has no price, trades at any price, and
never rests: whatever it does not fill is dropped.

Reject an order, changing nothing, with the first rule it breaks:
- "DUPLICATE_ID" when its id belongs to an order accepted before;
- "UNKNOWN_SYMBOL" for any symbol but ACME and BOLT;
- "BAD_SIDE" when side is not "buy" or "sell";
- "BAD_QTY" when qty is not a positive whole number;
- "BAD_PRICE" when a limit order has no price, or a price that is not positive and a whole number of
  cents, or when a market order has a price.

Its server methods take and return plain data, so I can check it:
- place({ id, trader, symbol, side, type: "limit" | "market", price?, qty })
  -> { ok: true, fills: Array<{ buyId, sellId, price, qty }>, restingQty } | { ok: false, error }
  fills are this order's trades in the order they happened; buyId and sellId are the ids of the two
  orders; restingQty is what is left of this order in the book (0 for a market order).
- cancel({ id }) -> { ok: true, canceledQty } | { ok: false, error: "UNKNOWN_ORDER" }
  Only an order resting in the book can be cancelled.
- book({ symbol }) -> { bids: Array<{ price, qty }>, asks: Array<{ price, qty }> }
  Resting quantity summed per price: bids highest first, asks lowest first.
- trades({ symbol }) -> { trades: Array<{ buyId, sellId, price, qty }> }
  Every trade in that share, in the order it happened.

Leave the book empty when you are done: I will place the orders myself.`,
    verify: async (verifier) => {
      await sameAsReference(verifier, 'rejects-bad-orders-without-changing-anything', [], badOrders);
      await sameAsReference(verifier, 'matches-by-price-then-time', [[badOrders]], handOrders);
      await sameAsReference(verifier, 'matches-a-day-of-orders', [[badOrders, handOrders]], replay(FIRST_DAY));
    },
  }, {
    prompt: `Two features. Self-trade prevention: an incoming order never trades with a resting order from the
same trader; when it would, that resting order is cancelled instead and matching goes on. And a limit
order may carry postOnly: true. A post-only order whose price reaches any resting order on the other
side, whoever placed it, is rejected with "WOULD_CROSS" and changes nothing; otherwise it rests as
usual. "WOULD_CROSS" comes after the other rules. Orders already in the book stay as they are.`,
    verify: async (verifier) => {
      await sameAsReference(verifier, 'resting-orders-survive-the-change', [TURN_1], lookBoth);
      await sameAsReference(verifier, 'self-trades-cancel-the-resting-order', [TURN_1, TURN_2_FEATURES], selfTrades);
      await sameAsReference(verifier, 'post-only-orders-never-take', [TURN_1, TURN_2_FEATURES, [selfTrades]], postOnlyOrders);
      await sameAsReference(verifier, 'matches-a-second-day', [TURN_1, TURN_2_FEATURES, [selfTrades, postOnlyOrders]], replay(SECOND_DAY));
    },
    verifyAfterEviction: async (verifier) => {
      await sameAsReference(verifier, 'the-book-survives-an-eviction', AFTER_TURN_2, lookBoth);
    },
  }, {
    prompt: `What is the volume-weighted average price of every ${QUESTION_SYMBOL} trade so far? Reply with just the number, rounded to 2 decimals.`,
    verify: async (verifier) => {
      await verifier.check('answers-with-the-vwap-of-the-trades', async () => {
        const trades = (await exchangeAfter(AFTER_TURN_2)).trades(QUESTION_SYMBOL);
        const vwap = trades.reduce((sum, trade) => sum + trade.price * trade.qty, 0) / trades.reduce((sum, trade) => sum + trade.qty, 0);
        const answer = verifier.bareAnswer(/^\$?(\d+(?:\.\d+)?)$/);

        return {
          pass: answer !== null && Math.abs(Number(answer) - vwap) <= 0.0051,
          evidence: { answer, expected: Number(vwap.toFixed(2)), replies: verifier.recentReplies() },
        };
      });

      await sameAsReference(verifier, 'asking-changes-nothing', AFTER_TURN_2, lookBoth);
    },
  }],
});

defineTaskEval(task);
