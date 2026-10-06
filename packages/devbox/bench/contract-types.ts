export const CONTAINER_CONTRACTS = ['tools', 'exec', 'processes', 'kill', 'trust'] as const;

export type ContainerContract = typeof CONTAINER_CONTRACTS[number];

export const DISK_CONTRACTS = ['blocks', 'compact', 'baseline', 'streaming', 'parallel-mounts', 'low-disk', 'lost-inventory', 'quiesce-tick'] as const;

export type DiskContract = typeof DISK_CONTRACTS[number];
