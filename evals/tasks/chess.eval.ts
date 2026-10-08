import { Chess, DEFAULT_POSITION, type Move as OracleMove, validateFen } from 'chess.js';
import * as v from 'valibot';
import { Seeded } from './seeded';
import { defineTaskEval } from '../src/eval';
import { defineEvalTask, type EvalPart } from '../src/task';
import type { Evidence, EvalVerifier, SlateClient } from '../src/verifier';
import { ElementHandle } from 'puppeteer';
import type { SlateView } from '../src/browser';
import { builtItself, buildsClean, slateQuality, type DrawnSlate } from './slate-quality';

// The workshop-evals chess task: a complete engine authored without a chess package, extended
// twice. chess.js stays in the checker, comparing legal moves, positions and status on curated
// edge cases, standard perft positions and seeded random games.

const MoveSchema = v.object({
  from: v.string(),
  to: v.string(),
  promotion: v.optional(v.string()),
});

type Move = v.InferOutput<typeof MoveSchema>;

const FenSchema = v.object({ fen: v.string() });

const MovesSchema = v.object({ moves: v.array(MoveSchema) });

const RefusedSchema = v.object({ ok: v.literal(false), error: v.pipe(v.string(), v.minLength(1)) });

const LoadSchema = v.variant('ok', [v.object({ ok: v.literal(true) }), RefusedSchema]);

const MoveResultSchema = v.variant('ok', [
  v.object({ ok: v.literal(true), fen: v.string() }),
  RefusedSchema,
]);

const PgnSchema = v.object({ pgn: v.string() });

const StatusSchema = v.object({
  turn: v.picklist(['w', 'b']),
  inCheck: v.boolean(),
  checkmate: v.boolean(),
  stalemate: v.boolean(),
  gameOver: v.boolean(),
  threefoldRepetition: v.optional(v.boolean()),
  fiftyMoveRule: v.optional(v.boolean()),
  insufficientMaterial: v.optional(v.boolean()),
  draw: v.optional(v.boolean()),
});

type Status = v.InferOutput<typeof StatusSchema>;

const METHODS = ['newGame', 'loadFen', 'fen', 'legalMoves', 'move', 'status', 'loadPgn', 'pgn'] as const;

type ChessClient = SlateClient<(typeof METHODS)[number]>;

const SLATE_ID = 'chess';

const TITLE = 'Chess';

/** The board drawn: its page says whose move it is. */
const DRAWN: DrawnSlate = { id: SLATE_ID, names: [], done: (sight) => /\b(?:white|black)\b/iu.test(sight.text) };

/** The placement field of the start position after 1. e4. */
const PAWN_TO_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR';

/** The board as a person's screen reader hears it: each square's button, by the square its name starts with. */
async function squares(view: SlateView): Promise<Record<string, string>> {
  return v.parse(v.record(v.string(), v.string()), await view.frame.evaluate(() => {
    const named: Record<string, string> = {};

    for (const control of document.querySelectorAll('button, [role="button"], [role="gridcell"]')) {
      const name = (control.getAttribute('aria-label') ?? control.getAttribute('title') ?? control.textContent ?? '').trim();
      const square = /^([a-h][1-8])\b/iu.exec(name)?.[1]?.toLowerCase();

      if (square !== undefined) named[square] = name;
    }

    return named;
  }));
}

/** Press the square whose accessible name starts with `square`, as a person's pointer does. */
async function pressSquare(view: SlateView, square: string): Promise<boolean> {
  const control = await view.frame.evaluateHandle((wanted) => [...document.querySelectorAll('button, [role="button"], [role="gridcell"]')]
    .find((element) => (element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent ?? '').trim().toLowerCase()
      .startsWith(wanted)) ?? null, square);

  if (!(control instanceof ElementHandle)) return false;
  await control.click();
  await control.dispose();

  return true;
}

const MISSION = 'A shared chess workspace where a friend and I play, import games and share our own.';

const SHARED_OPENING = ['e4', 'c5', 'Nf3'];

function moveKey(move: Move): string {
  return `${move.from}${move.to}${move.promotion?.toLowerCase() ?? ""}`.toLowerCase();
}

function coordinateMove(move: Move): Move {
  const coordinates: Move = { from: move.from, to: move.to };

  if (move.promotion !== undefined) coordinates.promotion = move.promotion;

  return coordinates;
}


function oracleMoves(oracle: Chess): string[] {
  return oracle.moves({ verbose: true }).map(move => moveKey(move)).sort();
}

async function slateMoves(api: ChessClient): Promise<string[]> {
  return v.parse(MovesSchema, await api('legalMoves')).moves.map(moveKey).sort();
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * FEN as the oracle would write the same position. Two conventions exist for the en passant
 * field (after every double push, or only when a capture is actually possible) and the oracle
 * uses the second; comparing through it accepts both. An unparseable FEN stays as written.
 */
function canonical(fen: string): string {
  return validateFen(fen).ok ? new Chess(fen).fen() : fen;
}

function sameFen(left: string, right: string): boolean {
  return canonical(left) === canonical(right);
}

/**
 * The oracle's status as the turn under test defines it. Until turn 3 adds draw detection,
 * `gameOver` means checkmate or stalemate only: a position drawn by material after, say, a
 * promotion to a knight is not over yet in turns 1 and 2.
 */
function oracleStatus(oracle: Chess, fields: readonly (keyof Status)[]): Status {
  const drawsCount = fields.includes("draw");

  return {
    turn: oracle.turn(),
    inCheck: oracle.isCheck(),
    checkmate: oracle.isCheckmate(),
    stalemate: oracle.isStalemate(),
    gameOver: drawsCount ? oracle.isGameOver() : oracle.isCheckmate() || oracle.isStalemate(),
    threefoldRepetition: oracle.isThreefoldRepetition(),
    fiftyMoveRule: oracle.isDrawByFiftyMoves(),
    insufficientMaterial: oracle.isInsufficientMaterial(),
    draw: oracle.isDraw(),
  };
}

const BASE_STATUS = ["turn", "inCheck", "checkmate", "stalemate", "gameOver"] as const;

const DRAW_STATUS = [...BASE_STATUS, "threefoldRepetition", "fiftyMoveRule",
  "insufficientMaterial", "draw"] as const;

function statusMismatch(
    actual: Status, expected: Status, fields: readonly (keyof Status)[]): string[] {
  return fields.filter(field => actual[field] !== expected[field]);
}

type Divergence = { at: string; what: string; slate: Evidence; oracle: Evidence };

/**
 * Compare the stored position, legal moves and status with the oracle at the slate's current
 * position. A drawn game can still have movable pieces, and engines differ on whether to list
 * them once play is over; either answer is accepted there. Until turn 3 defines draws, only a
 * dead position (insufficient material) ends play by itself, as it does over the board.
 */
async function compareHere(
    api: ChessClient, oracle: Chess, fields: readonly (keyof Status)[]): Promise<Divergence | null> {
  const fen = oracle.fen();
  const stored = v.parse(FenSchema, await api('fen')).fen;

  if (!sameFen(stored, fen)) return { at: fen, what: "fen", slate: stored, oracle: fen };

  const [moves, status] = [await slateMoves(api), v.parse(StatusSchema, await api('status'))];
  const expectedMoves = oracleMoves(oracle);

  const drawnWithMovesLeft = fields.includes("draw")
    ? oracle.isGameOver() && !oracle.isCheckmate() && !oracle.isStalemate()
    : oracle.isInsufficientMaterial();

  if (!sameList(moves, expectedMoves) && !(drawnWithMovesLeft && moves.length === 0)) {
    return { at: fen, what: "legalMoves", slate: moves, oracle: expectedMoves };
  }

  const expected = oracleStatus(oracle, fields);
  const mismatch = statusMismatch(status, expected, fields);

  if (mismatch.length > 0) {
    return { at: fen, what: `status.${mismatch.join(",")}`, slate: status, oracle: expected };
  }

  return null;
}

/**
 * The slate's own record of the game, without tag pairs: the prompt asks for movetext, and a
 * slate that also writes a Date or clock tag must not fail "changes nothing" on that.
 */
async function movetext(api: ChessClient): Promise<string> {
  return v.parse(PgnSchema, await api('pgn')).pgn.replace(/^\[[^\]]*\]\s*$/gm, "").trim();
}

/** Every malformed FEN is refused with INVALID_FEN and leaves the stored position as it was. */
async function refusesInvalidFens(api: ChessClient, position: string) {
  const refusals = [];

  for (const fen of INVALID_FENS) {
    const refused = v.parse(LoadSchema, await api('loadFen', { fen }));
    const after = v.parse(FenSchema, await api('fen')).fen;
    refusals.push({ fen, refused, unchanged: sameFen(after, position) });
  }

  const ok = refusals.every(({ refused, unchanged }) =>
    !refused.ok && refused.error === "INVALID_FEN" && unchanged);

  return { ok, refusals };
}

type GameOptions = {
  plies: number;
  fields: readonly (keyof Status)[];
  /** Once turn 2 adds PGN, a refused move must leave the game's own record unchanged too. */
  pgn: boolean;
};

/**
 * Play a seeded random game on both engines, comparing legal moves, status, and the position after
 * every move. Every few plies, also try moves the oracle says are illegal and require that they are
 * refused without changing the position, or the recorded game once there is one.
 */
async function differentialGame(
    api: ChessClient, seed: number, { plies, fields, pgn }: GameOptions): Promise<Divergence | null> {
  const random = new Seeded(seed);
  const oracle = new Chess();
  const record = async () => pgn ? await movetext(api) : null;
  await api('newGame');

  for (let ply = 0; ply < plies && !oracle.isGameOver(); ply++) {
    const divergence = await compareHere(api, oracle, fields);

    if (divergence !== null) return divergence;

    const legal = oracle.moves({ verbose: true });

    if (ply % 5 === 0) {
      const legalKeys = new Set(legal.map(move => moveKey(move)));

      for (let attempt = 0; attempt < 3; attempt++) {
        const from = random.pick(legal).from;
        const to = `${"abcdefgh"[random.int(0, 7)]}${random.int(1, 8)}`;

        if (legalKeys.has(`${from}${to}`) || legalKeys.has(`${from}${to}q`)) continue;

        const before = await record();
        const refused = v.parse(MoveResultSchema, await api('move', { from, to }));
        const after = v.parse(FenSchema, await api('fen')).fen;
        const afterRecord = await record();

        if (refused.ok || refused.error !== "ILLEGAL_MOVE" || !sameFen(after, oracle.fen()) ||
            afterRecord !== before) {
          return { at: oracle.fen(), what: `illegal ${from}${to}`,
            slate: { refused, after, pgn: { before, after: afterRecord } }, oracle: "ILLEGAL_MOVE" };
        }
      }
    }

    const chosen = random.pick(legal);
    const played = v.parse(MoveResultSchema, await api('move', coordinateMove(chosen)));
    oracle.move(chosen);

    if (!played.ok || !sameFen(played.fen, oracle.fen())) {
      return { at: oracle.fen(), what: `after ${chosen.san}`, slate: played, oracle: oracle.fen() };
    }
  }

  return await compareHere(api, oracle, fields);
}

// Special moves for both colours: an engine that only castles or captures en passant as White
// would otherwise pass every position here.
const CURATED = {
  bothCastles: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1",
  blackBothCastles: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1",
  castleThroughCheck: "4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1",
  castleRightsPartlyLost: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w Kq - 0 1",
  enPassantAvailable: "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
  blackEnPassant: "rnbqkbnr/pppp1ppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 3",
  enPassantExposesKing: "8/8/8/8/k2pP2R/8/8/4K3 b - e3 0 1",
  promotion: "8/P7/8/8/8/8/8/k6K w - - 0 1",
  promotionByCapture: "1n6/P7/8/8/8/8/8/k6K w - - 0 1",
  blackPromotion: "k6K/8/8/8/8/8/p7/8 b - - 0 1",
  // Taking the rook on h1 also takes White's right to castle there.
  blackPromotionByCapture: "4k3/8/8/8/8/8/6p1/4K2R b K - 0 1",
  pinnedBishop: "4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1",
  inCheck: "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
  checkmate: "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4",
  stalemate: "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
  middlegame: "r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N2N2/PP2BPPP/R2QKB1R w KQ - 0 9",
} satisfies Record<string, string>;

// Six-field FENs that a parser must inspect, not just count, to refuse.
const INVALID_FENS = [
  "not a position",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1",
  "rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - -1 1",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e9 0 1",
];

async function checkCurated(
    verifier: EvalVerifier, id: string, fields: readonly (keyof Status)[],
    positions: Record<string, string>): Promise<void> {
  await verifier.check(id, async () => {
    const api = verifier.slate(SLATE_ID, METHODS);
    const failures: Record<string, Evidence> = {};

    for (const [name, fen] of Object.entries(positions)) {
      const loaded = v.parse(LoadSchema, await api('loadFen', { fen }));

      if (!loaded.ok) {
        failures[name] = { what: "loadFen", slate: loaded };
        continue;
      }

      const roundTrip = v.parse(FenSchema, await api('fen')).fen;

      if (!sameFen(roundTrip, fen)) {
        failures[name] = { what: "fen round trip", slate: roundTrip, oracle: fen };
        continue;
      }

      const divergence = await compareHere(api, new Chess(fen), fields);

      if (divergence !== null) {
        failures[name] = divergence;
        continue;
      }

      const played = await playSpecialMoves(api, fen, fields);

      if (played !== null) failures[name] = played;
    }

    return { pass: Object.keys(failures).length === 0, evidence: failures };
  });
}

/**
 * Listing a castle, en passant capture or promotion correctly is not applying it correctly: play
 * each one the position offers and compare the resulting position with the oracle's.
 */
async function playSpecialMoves(
    api: ChessClient, fen: string, fields: readonly (keyof Status)[]): Promise<Divergence | null> {
  const oracle = new Chess(fen);

  const special = oracle.moves({ verbose: true }).filter(move =>
    move.isKingsideCastle() || move.isQueensideCastle() || move.isEnPassant() || move.isPromotion());

  for (const move of special) {
    await api('loadFen', { fen });
    const played = v.parse(MoveResultSchema, await api('move', coordinateMove(move)));
    const expected = new Chess(fen);
    expected.move(move);

    if (!played.ok || !sameFen(played.fen, expected.fen())) {
      return { at: fen, what: `after ${move.san}`, slate: played, oracle: expected.fen() };
    }

    const divergence = await compareHere(api, expected, fields);

    if (divergence !== null) return { ...divergence, what: `${divergence.what} after ${move.san}` };
  }

  return null;
}

// Standard perft positions (chessprogramming.org/Perft_Results) with their published node
// counts. At depth 2 every root move is played and the reply list compared, so a missing move
// cannot hide behind a spurious one elsewhere.
const PERFT = {
  kiwipete: { fen: "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    depth: 2, nodes: 2039 },
  position3: { fen: "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", depth: 1, nodes: 14 },
  position4: { fen: "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    depth: 2, nodes: 264 },
  position5: { fen: "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", depth: 1, nodes: 44 },
  position6: { fen: "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    depth: 1, nodes: 46 },
} satisfies Record<string, { fen: string; depth: 1 | 2; nodes: number }>;

async function perftDivergence(
    api: ChessClient, fen: string, depth: 1 | 2): Promise<Divergence | null> {
  await api('loadFen', { fen });
  const root = await compareHere(api, new Chess(fen), BASE_STATUS);

  if (root !== null || depth === 1) return root;

  for (const move of new Chess(fen).moves({ verbose: true })) {
    await api('loadFen', { fen });
    const played = v.parse(MoveResultSchema, await api('move', coordinateMove(move)));
    const child = new Chess(fen);
    child.move(move);

    if (!played.ok || !sameFen(played.fen, child.fen())) {
      return { at: fen, what: `after ${move.san}`, slate: played, oracle: child.fen() };
    }

    const [moves, expected] = [await slateMoves(api), oracleMoves(child)];

    if (!sameList(moves, expected)) {
      return { at: child.fen(), what: `legalMoves after ${move.san}`, slate: moves, oracle: expected };
    }
  }

  return null;
}

// Lines that bring the same placement back three times. The first loses White's castling right
// and the second a legal en passant capture, so only their last checkpoint repeats with the same
// rights. The third pushes a pawn nothing can take en passant, so it repeats the third time the
// placement comes back.
const REPETITION_LINES = {
  castlingRight: {
    fen: "4k3/8/8/8/8/8/8/4K2R w K - 0 1",
    moves: ["h1h2", "e8f8", "h2h1", "f8e8", "h1h2", "e8f8", "h2h1", "f8e8", "h1h2"],
    checkpoints: [4, 8, 9],
  },
  enPassantRight: {
    fen: "4k1n1/3p4/8/4P3/8/8/8/4K1N1 b - - 0 1",
    moves: ["d7d5", "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8", "g1f3"],
    checkpoints: [1, 5, 9, 10],
  },
  noEnPassantRight: {
    fen: "4k1n1/3p4/8/8/8/8/8/4K1N1 b - - 0 1",
    moves: ["d7d5", "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"],
    checkpoints: [5, 9],
  },
} satisfies Record<string, { fen: string; moves: string[]; checkpoints: number[] }>;

// Two occurrences of the position after 4. Ng1 are in the imported history; 4... Ng8 then
// brings back the start position a third time.
const REPEATING_PGN = "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1";

async function checkGames(
    verifier: EvalVerifier, id: string, seeds: readonly number[],
    options: GameOptions): Promise<void> {
  await verifier.check(id, async () => {
    const api = verifier.slate(SLATE_ID, METHODS);

    for (const seed of seeds) {
      const divergence = await differentialGame(api, seed, options);

      if (divergence !== null) {
        return { pass: false, evidence: { seed, ...divergence } };
      }
    }

    return { pass: true, evidence: { seeds, ...options } };
  });
}

/** A seeded random game as PGN, so import covers whatever castling, captures and checks it has. */
function randomPgn(seed: number, plies: number): string {
  const random = new Seeded(seed);
  const oracle = new Chess();

  for (let ply = 0; ply < plies && !oracle.isGameOver(); ply++) {
    oracle.move(random.pick(oracle.moves({ verbose: true })));
  }

  return oracle.pgn();
}

const PGN_GAMES = {
  foolsMate: "1. f3 e5 2. g4 Qh4#",
  blackWins: "1. f3 e5 2. g4 Qh4# 0-1",
  // Sam Loyd's ten-move stalemate.
  stalemate: "1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. h4 Rah6 5. Qxc7 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 " +
    "8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6 1/2-1/2",
  scholarsMate: "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
  legalTrap: "1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7 7. Nd5#",
  operaGame: `[Event "Paris"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`,
  randomA: randomPgn(7, 60),
  randomB: randomPgn(11, 80),
} satisfies Record<string, string>;

const INVALID_PGNS = [
  "1. e4 e5 2. Ke2 Ke7 3. Ke1 Kxe1",
  "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O-O",
  "this is not a game",
];

const game: EvalPart = {
  id: 'game',
  objectives: [
    'Build a shared chess slate that follows every rule, answers its FEN, legal-move and status methods as the oracle does, and keeps the game across connections.',
    'Add PGN import and export that refuse an invalid game without changing the board.',
    'Detect threefold repetition, the fifty-move rule and insufficient material.',
  ],
  turns: [{
    prompt: `Build a slate with id "${SLATE_ID}" named exactly "${TITLE}": a two-player chess game a friend
and I can both open on our phones and play in real time. Full rules of play: castling (including that
you cannot castle out of, through, or into check), en passant, promotion, check, checkmate and stalemate.
Implement the rules yourself, without third-party packages. Keep the game in the slate's own storage.

Squares are algebraic ("e2"); promotion pieces are "q", "r", "b" or "n"; FEN is the full six-field
form, including castling rights, en passant square, halfmove clock and move number. For the en
passant field, recording the square after every double pawn push or only when a capture is
actually possible are both fine.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- newGame() -> { fen }   the standard starting position
- loadFen({ fen }) -> { ok: true } | { ok: false, error: "INVALID_FEN" }   replaces the position
- fen() -> { fen }
- legalMoves() -> { moves: Array<{ from, to, promotion? }> }   every legal move and nothing else
- move({ from, to, promotion? }) -> { ok: true, fen } | { ok: false, error: "ILLEGAL_MOVE" }
  A refused move changes nothing.
- status() -> { turn: "w" | "b", inCheck, checkmate, stalemate, gameOver }

Its page shows the game as it stands and says whose move it is. Every square on the board is a button
whose accessible name says the square and what stands on it, like "e1 white king" or "e4 empty", and
pressing a piece and then a square plays that move.`,
    verify: async verifier => {
      await verifier.check("starts-from-the-standard-position", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const started = v.parse(FenSchema, await api('newGame')).fen;
        const read = v.parse(FenSchema, await api('fen')).fen;
        const status = v.parse(StatusSchema, await api('status'));
        const moves = await slateMoves(api);
        const refusals = await refusesInvalidFens(api, DEFAULT_POSITION);

        return {
          pass: started === DEFAULT_POSITION && read === DEFAULT_POSITION &&
            statusMismatch(status, oracleStatus(new Chess(), BASE_STATUS), BASE_STATUS).length === 0 &&
            sameList(moves, oracleMoves(new Chess())) && refusals.ok,
          evidence: { started, status, moveCount: moves.length, refusals: refusals.refusals },
        };
      });
      await verifier.check('the-board-shows-the-game', () => verifier.browse(async (browser) => {
        const board = await squares(await browser.workSurface(SLATE_ID));
        const said = (square: string) => board[square] ?? '';

        return {
          pass: Object.keys(board).length === 64 && /white/iu.test(said('e1')) && /king/iu.test(said('e1'))
            && /black/iu.test(said('d8')) && /queen/iu.test(said('d8')) && /empty/iu.test(said('e4')),
          evidence: { squares: Object.keys(board).length, e1: said('e1'), d8: said('d8'), e4: said('e4') },
        };
      }));
      await verifier.check('a-pressed-move-is-played', async () => {
        const pressed = await verifier.browse(async (browser) => {
          const view = await browser.workSurface(SLATE_ID);

          return { from: await pressSquare(view, 'e2'), to: await pressSquare(view, 'e4') };
        });

        const { fen } = v.parse(FenSchema, await verifier.slate(SLATE_ID, METHODS)('fen'));

        return { pass: pressed.from && pressed.to && fen.split(' ')[0] === PAWN_TO_E4, evidence: { pressed, fen } };
      });
      await checkCurated(verifier, "agrees-with-the-oracle-on-the-hard-positions", BASE_STATUS, CURATED);
      await verifier.check("agrees-with-the-oracle-on-perft-positions", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const failures: Record<string, Evidence> = {};

        for (const [name, { fen, depth }] of Object.entries(PERFT)) {
          const divergence = await perftDivergence(api, fen, depth);

          if (divergence !== null) failures[name] = divergence;
        }

        return { pass: Object.keys(failures).length === 0, evidence: failures };
      });
      await checkGames(verifier, "agrees-with-the-oracle-through-random-games", [1, 2],
          { plies: 60, fields: BASE_STATUS, pgn: false });

      // SlateClient does not open a socket; the harness reconnects before verifyAfterEviction.
      await verifier.check('records-the-shared-game', async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const oracle = new Chess();
        await api('newGame');

        for (const san of SHARED_OPENING) {
          const move = oracle.move(san);
          const played = v.parse(MoveResultSchema, await api('move', { from: move.from, to: move.to }));

          if (!played.ok || !sameFen(played.fen, oracle.fen())) {
            return { pass: false, evidence: { san, played, expected: oracle.fen() } };
          }
        }

        const divergence = await compareHere(api, oracle, BASE_STATUS);

        return { pass: divergence === null, evidence: { divergence, expected: oracle.fen() } };
      });
      await slateQuality(verifier, DRAWN);
    },
    verifyAfterEviction: async (verifier) => {
      await verifier.check('the-game-is-shared-across-connections', async () => {
        const oracle = new Chess();

        for (const san of SHARED_OPENING) oracle.move(san);

        const divergence = await compareHere(verifier.slate(SLATE_ID, METHODS), oracle, BASE_STATUS);

        return { pass: divergence === null, evidence: { divergence, expected: oracle.fen() } };
      });
    },
  }, {
    prompt: `Add PGN so we can load games from Lichess and share ours.

- loadPgn({ pgn }) -> { ok: true, fen } | { ok: false, error: "INVALID_PGN" }
  Plays the game from the standard start. Movetext in standard algebraic notation with move
  numbers; tag pairs before it and a result at the end are both optional. A PGN with an illegal
  move is refused and changes nothing.
- pgn() -> { pgn }   the moves of the current game in standard algebraic notation with move
  numbers, and the result at the end once the game is over.

Everything that already worked keeps working.`,
    verify: async verifier => {
      await builtItself(verifier);
      await buildsClean(verifier, DRAWN);
      await verifier.check("imports-known-games-to-the-right-positions", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const failures: Record<string, Evidence> = {};

        for (const [name, pgn] of Object.entries(PGN_GAMES)) {
          const oracle = new Chess();
          oracle.loadPgn(pgn);
          const loaded = v.parse(MoveResultSchema, await api('loadPgn', { pgn }));
          const fen = v.parse(FenSchema, await api('fen')).fen;

          if (!loaded.ok || !sameFen(loaded.fen, oracle.fen()) || !sameFen(fen, oracle.fen())) {
            failures[name] = { loaded, fen, oracle: oracle.fen() };
            continue;
          }

          const divergence = await compareHere(api, oracle, BASE_STATUS);

          if (divergence !== null) failures[name] = divergence;
        }

        return { pass: Object.keys(failures).length === 0, evidence: failures };
      });

      await verifier.check("refuses-invalid-pgn-without-changing-the-game", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const before = v.parse(MoveResultSchema, await api('loadPgn', { pgn: PGN_GAMES.legalTrap }));
        const beforePgn = await movetext(api);
        const results = [];

        for (const pgn of INVALID_PGNS) {
          const refused = v.parse(MoveResultSchema, await api('loadPgn', { pgn }));
          const after = v.parse(FenSchema, await api('fen')).fen;
          const afterPgn = await movetext(api);
          results.push({ refused, unchanged: before.ok && sameFen(after, before.fen) && afterPgn === beforePgn });
        }

        return {
          pass: before.ok && results.every(result =>
            !result.refused.ok && result.refused.error === "INVALID_PGN" && result.unchanged),
          evidence: { before, results },
        };
      });

      await verifier.check("exports-pgn-the-oracle-replays-to-the-same-position", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const failures: Record<string, Evidence> = {};

        // An imported game, and a game played move by move, both exported.
        const cases = {
          imported: async () => {
            const oracle = new Chess();
            oracle.loadPgn(PGN_GAMES.operaGame);
            await api('loadPgn', { pgn: PGN_GAMES.operaGame });

            return oracle;
          },
          played: async () => {
            const random = new Seeded(23);
            const oracle = new Chess();
            await api('newGame');

            for (let ply = 0; ply < 40 && !oracle.isGameOver(); ply++) {
              const chosen = random.pick(oracle.moves({ verbose: true }));
              await api('move', coordinateMove(chosen));
              oracle.move(chosen);
            }

            return oracle;
          },
        } satisfies Record<string, () => Promise<Chess>>;

        for (const [name, setUp] of Object.entries(cases)) {
          const oracle = await setUp();
          const exported = v.parse(PgnSchema, await api('pgn')).pgn;
          const replay = new Chess();

          try {
            replay.loadPgn(exported);
          } catch (error) {
            failures[name] = { exported, error: error instanceof Error ? error.message : String(error) };
            continue;
          }

          // The replay's own canonical SAN of what it parsed, against the game actually played.
          if (!sameList(replay.history(), oracle.history())) {
            failures[name] = { exported, replayed: replay.history(), played: oracle.history() };
          } else if (!sameFen(replay.fen(), oracle.fen())) {
            failures[name] = { exported, replayedTo: replay.fen(), playedTo: oracle.fen() };
          } else if (oracle.isGameOver() && !/(1-0|0-1|1\/2-1\/2)\s*$/.test(exported.trim())) {
            failures[name] = { exported, what: "missing result" };
          }
        }

        return { pass: Object.keys(failures).length === 0, evidence: failures };
      });

      await checkGames(verifier, "rules-still-agree-with-the-oracle", [3],
          { plies: 50, fields: BASE_STATUS, pgn: true });
    },
  }, {
    prompt: `Add draw detection to status(): threefoldRepetition, fiftyMoveRule and
insufficientMaterial as booleans, plus draw, which is true for any of those or for stalemate.
gameOver is true for checkmate or draw. A position repeats only with the same side to move, the
same pieces on the same squares, the same castling rights and the same en passant capture
available. The moves of a game loaded with loadPgn count; loadFen and newGame start afresh.
Everything that already worked keeps working.`,
    verify: async verifier => {
      await builtItself(verifier);
      await buildsClean(verifier, DRAWN);
      await verifier.check("detects-threefold-repetition-and-the-fifty-move-rule", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const oracle = new Chess();
        await api('newGame');
        const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8"];
        const seen: Status[] = [];
        const played: v.InferOutput<typeof MoveResultSchema>[] = [];

        for (let repeat = 0; repeat < 2; repeat++) {
          for (const key of shuffle) {
            const move = { from: key.slice(0, 2), to: key.slice(2) };
            played.push(v.parse(MoveResultSchema, await api('move', move)));
            oracle.move(move);
          }

          seen.push(v.parse(StatusSchema, await api('status')));
        }

        const afterTwo = seen[0];
        const afterThree = seen[1];
        // The start position has now occurred three times; loading it again begins a new game.
        const reloaded = v.parse(LoadSchema, await api('loadFen', { fen: new Chess().fen() }));
        const afterReload = v.parse(StatusSchema, await api('status'));
        const fiftyFen = "8/8/8/8/8/4k3/8/R3K3 w - - 99 80";
        const fiftyOracle = new Chess(fiftyFen);
        const loadedFifty = v.parse(LoadSchema, await api('loadFen', { fen: fiftyFen }));
        const beforeFifty = v.parse(StatusSchema, await api('status'));
        const expectedBeforeFifty = oracleStatus(fiftyOracle, DRAW_STATUS);
        played.push(v.parse(MoveResultSchema, await api('move', { from: "a1", to: "a2" })));
        fiftyOracle.move({ from: "a1", to: "a2" });
        const afterFifty = v.parse(StatusSchema, await api('status'));
        const expectedThree = oracleStatus(oracle, DRAW_STATUS);

        return {
          pass: afterTwo !== undefined && afterThree !== undefined && reloaded.ok && loadedFifty.ok &&
            afterReload.threefoldRepetition === false && afterReload.draw === false &&
            played.every(result => result.ok) &&
            afterTwo.threefoldRepetition === false && afterTwo.draw === false &&
            statusMismatch(afterThree, expectedThree, DRAW_STATUS).length === 0 &&
            expectedThree.threefoldRepetition === true &&
            statusMismatch(beforeFifty, expectedBeforeFifty, DRAW_STATUS).length === 0 &&
            statusMismatch(afterFifty, oracleStatus(fiftyOracle, DRAW_STATUS), DRAW_STATUS).length === 0 &&
            afterFifty.fiftyMoveRule === true && afterFifty.gameOver === true,
          evidence: { played, afterTwo, afterThree, expectedThree, afterReload, loadedFifty,
            beforeFifty, afterFifty },
        };
      });

      await verifier.check("repeats-a-position-only-with-the-same-rights", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const failures: Record<string, Evidence> = {};

        for (const [name, { fen, moves, checkpoints }] of Object.entries(REPETITION_LINES)) {
          const oracle = new Chess(fen);
          const loaded = v.parse(LoadSchema, await api('loadFen', { fen }));

          if (!loaded.ok) {
            failures[name] = { what: "loadFen", slate: loaded };
            continue;
          }

          for (const [index, key] of moves.entries()) {
            const move = { from: key.slice(0, 2), to: key.slice(2) };
            const played = v.parse(MoveResultSchema, await api('move', move));
            oracle.move(move);
            let divergence: Divergence | null = null;

            if (!played.ok || !sameFen(played.fen, oracle.fen())) {
              divergence = { at: oracle.fen(), what: `after ${key}`, slate: played, oracle: oracle.fen() };
            } else if (checkpoints.includes(index + 1)) {
              divergence = await compareHere(api, oracle, DRAW_STATUS);
            }

            if (divergence !== null) {
              failures[name] = { ply: index + 1, ...divergence };
              break;
            }
          }
        }

        return { pass: Object.keys(failures).length === 0, evidence: failures };
      });

      await verifier.check("counts-repetitions-from-an-imported-game", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const oracle = new Chess();
        oracle.loadPgn(REPEATING_PGN);
        const loaded = v.parse(MoveResultSchema, await api('loadPgn', { pgn: REPEATING_PGN }));

        const afterLoad = loaded.ok && sameFen(loaded.fen, oracle.fen())
          ? await compareHere(api, oracle, DRAW_STATUS)
          : { at: oracle.fen(), what: "loadPgn", slate: loaded, oracle: oracle.fen() };

        const played = v.parse(MoveResultSchema, await api('move', { from: "f6", to: "g8" }));
        oracle.move({ from: "f6", to: "g8" });

        const afterRepeat = played.ok && sameFen(played.fen, oracle.fen())
          ? await compareHere(api, oracle, DRAW_STATUS)
          : { at: oracle.fen(), what: "after Ng8", slate: played, oracle: oracle.fen() };

        return {
          pass: afterLoad === null && afterRepeat === null,
          evidence: { afterLoad, afterRepeat },
        };
      });

      await verifier.check("still-refuses-invalid-fen", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        await api('newGame');
        const refusals = await refusesInvalidFens(api, DEFAULT_POSITION);

        return { pass: refusals.ok, evidence: { refusals: refusals.refusals } };
      });

      // Reached by play rather than loaded: the capture leaves king and knight against king.
      await verifier.check("detects-insufficient-material-after-a-capture", async () => {
        const api = verifier.slate(SLATE_ID, METHODS);
        const start = "4k3/8/8/8/8/8/3p4/4K2N w - - 0 1";
        const oracle = new Chess(start);
        const loaded = v.parse(LoadSchema, await api('loadFen', { fen: start }));
        const played = v.parse(MoveResultSchema, await api('move', { from: "e1", to: "d2" }));
        oracle.move({ from: "e1", to: "d2" });
        const divergence = await compareHere(api, oracle, DRAW_STATUS);

        return {
          pass: loaded.ok && played.ok && divergence === null,
          evidence: { loaded, played, divergence },
        };
      });

      await checkCurated(verifier, "judges-material-and-terminal-positions-like-the-oracle", DRAW_STATUS, {
        knightVersusKing: "8/8/8/8/8/4k3/8/4K2N w - - 0 1",
        bishopVersusKing: "8/8/8/8/8/4k3/8/4K2B w - - 0 1",
        rookVersusKing: "8/8/8/8/8/4k3/8/4K2R w - - 0 1",
        sameColourBishops: "8/8/8/8/8/3bk3/8/4K2B w - - 0 1",
        kingsOnly: "8/8/8/8/8/4k3/8/4K3 w - - 0 1",
        checkmate: CURATED.checkmate,
        stalemate: CURATED.stalemate,
        middlegame: CURATED.middlegame,
      });

      await checkGames(verifier, "rules-still-agree-with-the-oracle-after-draws", [4],
          { plies: 50, fields: DRAW_STATUS, pgn: true });
    },
  }],
  evidence: async (call) => {
    await call(SLATE_ID, 'fen');
    await call(SLATE_ID, 'legalMoves');
    await call(SLATE_ID, 'status');
    await call(SLATE_ID, 'pgn');
  },
};

const task = defineEvalTask({ id: SLATE_ID, mission: MISSION, parts: [game] });

// The oracle must accept every PGN the task calls valid and refuse every one it calls invalid.
for (const [name, pgn] of Object.entries(PGN_GAMES)) {
  try {
    new Chess().loadPgn(pgn);
  } catch (error) {
    throw new Error(`PGN_GAMES.${name} is not a valid game`, { cause: error });
  }
}

for (const pgn of INVALID_PGNS) {
  let accepted = true;

  try {
    new Chess().loadPgn(pgn);
  } catch (error) {
    if (!(error instanceof Error) || (error.name !== 'SyntaxError' && !error.message.startsWith('Invalid move in PGN:'))) {
      throw new Error(`The oracle failed to parse an invalid PGN: ${pgn}`, { cause: error });
    }

    accepted = false;
  }

  if (accepted) throw new Error(`INVALID_PGNS entry is accepted by the oracle: ${pgn}`);
}

for (const [name, fen] of Object.entries(CURATED)) {
  if (!validateFen(fen).ok) throw new Error(`CURATED.${name} is not a valid FEN`);
}

for (const fen of INVALID_FENS) {
  if (validateFen(fen).ok) throw new Error(`INVALID_FENS entry is accepted by the oracle: ${fen}`);
}

// A Black fixture is only worth its name if the oracle offers the move it exists for.
const BLACK_FIXTURES = {
  blackBothCastles: { fen: CURATED.blackBothCastles, offers: (move: OracleMove) => move.isKingsideCastle() || move.isQueensideCastle() },
  blackEnPassant: { fen: CURATED.blackEnPassant, offers: (move: OracleMove) => move.isEnPassant() },
  blackPromotion: { fen: CURATED.blackPromotion, offers: (move: OracleMove) => move.isPromotion() },
  blackPromotionByCapture: { fen: CURATED.blackPromotionByCapture, offers: (move: OracleMove) => move.isPromotion() && move.isCapture() },
};

for (const [name, { fen, offers }] of Object.entries(BLACK_FIXTURES)) {
  if (!new Chess(fen).moves({ verbose: true }).some(offers)) {
    throw new Error(`CURATED.${name} does not offer the move it is named for`);
  }
}

for (const [name, { fen, depth, nodes }] of Object.entries(PERFT)) {
  if (new Chess(fen).perft(depth) !== nodes) throw new Error(`PERFT.${name} does not count ${nodes}`);
}

// Each line must repeat only at its last checkpoint, and the en passant line must start with a
// capture that is really legal, so that either FEN convention for the field reads the same.
for (const [name, { fen, moves, checkpoints }] of Object.entries(REPETITION_LINES)) {
  const oracle = new Chess(fen);

  const repeats = moves.flatMap((move, index) => {
    oracle.move({ from: move.slice(0, 2), to: move.slice(2) });

    return checkpoints.includes(index + 1) ? [oracle.isThreefoldRepetition()] : [];
  });

  if (repeats.some((repeated, index) => repeated !== (index === repeats.length - 1))) {
    throw new Error(`REPETITION_LINES.${name} does not repeat only at its last checkpoint`);
  }
}

const afterPush = new Chess(REPETITION_LINES.enPassantRight.fen);

afterPush.move("d5");

if (!afterPush.moves({ verbose: true }).some(move => move.isEnPassant())) {
  throw new Error("REPETITION_LINES.enPassantRight does not offer en passant");
}

const imported = new Chess();

imported.loadPgn(REPEATING_PGN);

const importedBefore = imported.isThreefoldRepetition();

imported.move("Ng8");

if (importedBefore || !imported.isThreefoldRepetition()) {
  throw new Error("REPEATING_PGN does not reach threefold repetition on the next move");
}

defineTaskEval(task);
