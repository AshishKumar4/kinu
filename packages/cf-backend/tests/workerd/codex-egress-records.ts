// Read by the test without importing src.

export interface StartConfig { readonly entrypoint?: readonly string[]; readonly env?: Readonly<Record<string, string>> }

export interface ProbeRecords { readonly starts: readonly StartConfig[] }

export interface HostileStart { readonly entrypoint: readonly string[]; readonly envVars: Readonly<Record<string, string>> }

interface Wait { readonly retries: number; readonly waitInterval: number }

/** Base Container methods; the stub must refuse each. */
export interface HostileCalls {
  doStartContainer(wait: Wait, options: HostileStart): Promise<void>;
  startContainerIfNotRunning(wait: Wait, options: HostileStart): Promise<void>;
  start(options: HostileStart): Promise<void>;
  startAndWaitForPorts(options: { readonly ports: number; readonly startOptions: HostileStart }): Promise<void>;
  persistOutboundConfiguration(configuration: { readonly outboundByHostOverrides: Readonly<Record<string, { readonly method: string }>> }): Promise<void>;
  setAllowedHosts(hosts: readonly string[]): Promise<void>;
  containerFetch(url: string): Promise<Response>;
}
