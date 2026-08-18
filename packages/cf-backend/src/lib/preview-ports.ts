import { isPreviewUrl } from './preview-origin';

export interface PinnedPreviewPort {
  executor: string;
  port: number;
  url: string;
  name?: string;
}

export interface ExposedPortList {
  ports: Array<{ port: number; url: string; name?: string }>;
  error?: string;
}

export interface ExecutorPortRefresh {
  executor: string;
  result: ExposedPortList;
}

export interface PreviewPortState {
  ports: PinnedPreviewPort[];
  error: string | null;
}

/**
 * Apply authoritative per-executor port results without discarding the last
 * known working preview when that executor could not be read. A successful
 * empty result is authoritative and removes its prior ports.
 */
export function reconcilePreviewPorts(
  previous: readonly PinnedPreviewPort[],
  refreshes: readonly ExecutorPortRefresh[],
  acceptsUrl: (url: string) => boolean = isPreviewUrl,
): PreviewPortState {
  const replacements = new Map<string, PinnedPreviewPort[]>();
  const failures: string[] = [];

  for (const { executor, result } of refreshes) {
    if (result.error) {
      failures.push(`${executor}: ${result.error}`);
      continue;
    }

    const ports: PinnedPreviewPort[] = [];
    const identities = new Set<number>();
    let invalidPort: number | null = null;
    for (const candidate of result.ports) {
      if (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65_535
        || !acceptsUrl(candidate.url)
        || identities.has(candidate.port)) {
        invalidPort = candidate.port;
        break;
      }
      identities.add(candidate.port);
      const port: PinnedPreviewPort = {
        executor,
        port: candidate.port,
        url: candidate.url,
      };
      if (candidate.name) port.name = candidate.name;
      ports.push(port);
    }

    if (invalidPort !== null) {
      failures.push(`${executor}: invalid preview registration for port ${invalidPort}`);
      continue;
    }
    replacements.set(executor, ports);
  }

  return {
    ports: [
      ...previous.filter((port) => !replacements.has(port.executor)),
      ...[...replacements.values()].flat(),
    ],
    error: failures.length > 0 ? failures.join(' · ') : null,
  };
}
