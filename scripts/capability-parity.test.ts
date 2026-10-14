import { describe, expect, test } from 'bun:test';
import { findAsymmetries, findMovable, keyOf } from './capability-parity';

const contracts = `
export interface WorkspaceAuthority { workspaceId: string; ownerUserId: string }
export interface ForkDestination {
  workspaceId: string; ownerUserId: string; destination: string;
  transaction?: (write: () => void) => void;
  writeSoulFile?: (text: string) => void;
}
`;

function survey(cli: string) {
  return findAsymmetries(new Map([
    ['packages/core/src/contracts.ts', contracts],
    ['packages/cf-backend/src/adapter.ts', `const target = { workspaceId: 'workspace', ownerUserId: 'owner', destination: 'fork', transaction: (write) => write(), writeSoulFile: (text) => persist(text) };`],
    ['packages/cli-backend/src/adapter.ts', cli],
  ])).asymmetries.map(keyOf);
}

describe('capability contract attribution', () => {
  test('a required-only authority is not a fork with missing optional effects', () => {
    expect(survey(`const authority = { workspaceId: 'workspace', ownerUserId: 'owner' };`)).toEqual([]);
  });

  test('a real fork omission stays red beside the narrower authority', () => {
    expect(survey(`
      const authority = { workspaceId: 'workspace', ownerUserId: 'owner' };
      const target = { workspaceId: 'workspace', ownerUserId: 'owner', destination: 'fork' };
    `)).toEqual([
      'asymmetry ForkDestination.transaction#absent-in-cli',
      'asymmetry ForkDestination.writeSoulFile#absent-in-cli',
    ]);
  });

  test('a field core supplies is supplied for both backends', () => {
    const omitting = `const target = { workspaceId: 'workspace', ownerUserId: 'owner', destination: 'fork' };`;
    const coreSupplies = `const destination = { workspaceId: w, ownerUserId: o, destination: d, transaction: (write) => write(), writeSoulFile: persist };`;

    expect(findAsymmetries(new Map([
      ['packages/core/src/contracts.ts', `${contracts}\n${coreSupplies}`],
      ['packages/cf-backend/src/adapter.ts', `const target = { workspaceId: 'workspace', ownerUserId: 'owner', destination: 'fork', transaction: (write) => write(), writeSoulFile: (text) => persist(text) };`],
      ['packages/cli-backend/src/adapter.ts', omitting],
    ])).asymmetries.map(keyOf)).toEqual([]);
  });
});

/** Core's real turn contract in miniature: four members a literal cannot omit,
 *  and behaviour switches that can differ between backends. `signal` and `cache`
 *  are optional DATA — the names the CLI's version probe happens to share. */
const turnContracts = `
export interface ExtensionHost { register(): void }
export interface ChatOptions {
  model: string;
  system: string;
  history: string[];
  tools: string[];
  signal?: AbortSignal;
  cache?: { sessionKey: string };
  extensions?: ExtensionHost;
}
`;

const WIRED = `{ model: m, system: s, history: h, tools: t, extensions: host }`;

const BARE = `{ model: m, system: s, history: h, tools: t }`;

function surveyTurn(cf: string, cli: string) {
  return findAsymmetries(new Map([
    ['packages/core/src/turn.ts', turnContracts],
    ['packages/cf-backend/src/agent.ts', cf],
    ['packages/cli/src/session.ts', cli],
  ]));
}

describe('a literal missing a required member is not the contract', () => {
  test('a foreign turn config sharing two optional-looking names is not a chat', () => {
    // `const cfg: TurnConfig = { system, model }` — every key IS a ChatOptions
    // member, and history/tools are required and absent, so it is some other
    // type entirely and cannot be the cf closure's evidence of building a chat.
    expect(surveyTurn(
      `const cfg: TurnConfig = { system: s, model: m };`,
      `const options = ${WIRED};`,
    ).asymmetries.map(keyOf)).toEqual([]);
  });

  test('a fetch options bag sharing cache and signal is not a chat', () => {
    expect(surveyTurn(
      `const options = ${WIRED};`,
      `const res = await fetchImpl(url, { cache: 'no-store', signal: controller.signal });`,
    ).asymmetries.map(keyOf)).toEqual([]);
  });

  test('two complete turns still show the behaviour one of them omits', () => {
    expect(surveyTurn(`const options = ${BARE};`, `const options = ${WIRED};`)
      .asymmetries.map(keyOf)).toEqual(['asymmetry ChatOptions.extensions#absent-in-cf']);
  });

  test('the foreign config does not hide a real omission beside it', () => {
    expect(surveyTurn(
      `const cfg: TurnConfig = { system: s, model: m };\nconst options = ${BARE};`,
      `const options = ${WIRED};`,
    ).asymmetries.map(keyOf)).toEqual(['asymmetry ChatOptions.extensions#absent-in-cf']);
  });

  test('a spread is still a lower bound, so the contract is unreadable not absent', () => {
    // The required members may arrive through the spread. Dropping the site
    // instead would leave the contract silently uncompared rather than counted
    // as the coverage gap it is.
    const parity = surveyTurn(
      `const options = { ...base, model: m, extensions: host };`,
      `const options = ${WIRED};`,
    );

    expect(parity.skipped).toEqual(['ChatOptions']);
    expect(parity.asymmetries.map(keyOf)).toEqual([]);
  });
});

/** The required set is inherited exactly as the alphabet is: what a base
 *  demands, a literal of the derived contract cannot leave out either. */
const derivedContracts = `
export interface ExtensionHost { register(): void }
export interface TurnMeter { open(): void }
export interface ChatBase { model: string; system: string; history: string[]; tools: string[] }
export interface DerivedChatOptions extends ChatBase {
  meter?: TurnMeter;
  extensions?: ExtensionHost;
}
`;

function surveyDerived(cf: string) {
  return findAsymmetries(new Map([
    ['packages/core/src/derived.ts', derivedContracts],
    ['packages/cf-backend/src/agent.ts', cf],
    ['packages/cli/src/session.ts', `const options = { model: m, system: s, history: h, tools: t, meter: gauge, extensions: host };`],
  ])).asymmetries.map(keyOf);
}

describe('inherited required members', () => {
  test('an override bag omitting the base requirements is not the derived contract', () => {
    expect(surveyDerived(`const overrides = { model: m, extensions: host };`)).toEqual([]);
  });

  test('a complete derived turn still reports the behaviour it omits', () => {
    expect(surveyDerived(`const options = { model: m, system: s, history: h, tools: t, meter: gauge };`))
      .toEqual(['asymmetry DerivedChatOptions.extensions#absent-in-cf']);
  });
});

/*
 * A component imports nothing a shared package could not, yet compiles to calls into `react/jsx-runtime`: the web
 * app's tsconfig sets `"jsx": "react-jsx"`, and no shared package compiles JSX. Before the scan knew the compiler's
 * import, `Status.tsx` read as movable and was locked as an exemption.
 */
describe('a module that writes JSX depends on the runtime its package compiles it with', () => {
  const movable = (file: string, text: string) => findMovable(new Map([[file, text]])).movable.map((entry) => entry.file);

  test('a component in the web app is pinned there by its JSX alone', () => {
    expect(movable('packages/cf-backend/src/components/ui/Dot.tsx', 'export const Dot = () => <span className="dot" />;\n')).toEqual([]);
  });

  test('so is a fragment', () => {
    expect(movable('packages/cf-backend/src/components/ui/Pair.tsx', 'export const Pair = () => <><b /><i /></>;\n')).toEqual([]);
  });

  test('the same file writing no JSX is still movable', () => {
    expect(movable('packages/cf-backend/src/components/ui/tone.ts', 'export const tone = (ok: boolean): string => (ok ? "success" : "danger");\n'))
      .toEqual(['packages/cf-backend/src/components/ui/tone.ts']);
  });
});
