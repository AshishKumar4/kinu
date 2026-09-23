type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/** Unsandboxed commands (host and facet shells, raw device tier): the parent's env less the harness's credentials. */
export function unsandboxedCommandEnvironment(source: EnvironmentSource, withheld: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(source).flatMap(([name, value]) => (
    value === undefined || withheld.has(name) ? [] : [[name, value] as const])));
}
