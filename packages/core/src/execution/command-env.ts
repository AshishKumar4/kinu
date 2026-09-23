type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export function unsandboxedCommandEnvironment(source: EnvironmentSource, withheld: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(source).flatMap(([name, value]) => (
    value === undefined || withheld.has(name) ? [] : [[name, value] as const])));
}
