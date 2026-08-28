import type { DevboxStrategyName } from '../src/index';

export interface NamedNamespace {
  idFromName(name: string): { toString(): string };
}

export interface BenchArmBindings<TNamespace extends NamedNamespace = NamedNamespace> {
  BENCH_SELECTED_ARMS?: string;
  SnapshotChainBox?: TNamespace;
  R2fsBox?: TNamespace;
  OverlayCasBox?: TNamespace;
  BoundedLayersBox?: TNamespace;
  MerklePackBox?: TNamespace;
}

/** The namespace-valued keys; `BENCH_SELECTED_ARMS` never names a binding. */
type ArmBindingKey = Exclude<keyof BenchArmBindings, 'BENCH_SELECTED_ARMS'>;

const BINDING_NAME = {
  'snapshot-chain': 'SnapshotChainBox',
  r2fs: 'R2fsBox',
  'overlay-cas': 'OverlayCasBox',
  'bounded-layers': 'BoundedLayersBox',
  'merkle-pack': 'MerklePackBox',
} as const satisfies Readonly<Record<DevboxStrategyName, ArmBindingKey>>;

export function bindingFor<TNamespace extends NamedNamespace>(
  env: BenchArmBindings<TNamespace>,
  strategy: DevboxStrategyName,
): TNamespace | undefined {
  return env[BINDING_NAME[strategy]];
}

/** A generated fixture selects its arms explicitly. A hand-run config without
 * that var is still safe because an absent namespace is never dispatched. */
export function strategyIsDeployed<TNamespace extends NamedNamespace>(
  env: BenchArmBindings<TNamespace>,
  strategy: DevboxStrategyName,
): boolean {
  const configured = env.BENCH_SELECTED_ARMS;
  return (configured === undefined || configured.split(',').includes(strategy))
    && bindingFor(env, strategy) !== undefined;
}

/** This arm's own prefix. Candidate metadata cannot inspect another arm's files. */
export function storePrefixOf<TNamespace extends NamedNamespace>(
  env: BenchArmBindings<TNamespace>,
  strategy: DevboxStrategyName,
  name: string,
): string {
  const binding = bindingFor(env, strategy);
  if (binding === undefined) throw new Error(`no durable-object binding for ${strategy}`);
  const prefix = `boxes/${binding.idFromName(`${strategy}:${name}`).toString()}/`;
  if (strategy === 'bounded-layers') return `${prefix}candidate/bounded-layers/`;
  if (strategy === 'merkle-pack') return `${prefix}candidate/merkle-pack/`;
  return prefix;
}
