export interface NamedNamespace {
  idFromName(name: string): { toString(): string };
}

export interface BenchArmBindings<TNamespace extends NamedNamespace = NamedNamespace> {
  BENCH_SELECTED_ARMS?: string;
  SnapshotChainBox?: TNamespace;
}

/** A generated fixture selects its arm explicitly, so a config that declares
 * the class without naming it is not dispatched. A hand-run config without
 * that var is still safe because an absent namespace is never dispatched. */
export function strategyIsDeployed<TNamespace extends NamedNamespace>(
  env: BenchArmBindings<TNamespace>,
  strategy: string,
): boolean {
  const configured = env.BENCH_SELECTED_ARMS;

  return (configured === undefined || configured.split(',').includes(strategy))
    && env.SnapshotChainBox !== undefined;
}

/** This box's own payload prefix. Derived in ONE place, so a mount and a
 * metadata read can never resolve to two different box ids. */
export function storePrefixOf<TNamespace extends NamedNamespace>(
  env: BenchArmBindings<TNamespace>,
  strategy: string,
  name: string,
): string {
  const binding = env.SnapshotChainBox;

  if (binding === undefined) throw new Error(`no durable-object binding for ${strategy}`);

  return `boxes/${binding.idFromName(`${strategy}:${name}`).toString()}/`;
}
