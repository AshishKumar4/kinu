const origin = (process.env.PROTEUS_SMOKE_ORIGIN ?? 'https://proteus-staging.ashishkmr472.workers.dev').replace(/\/+$/, '');
const agentName = process.env.PROTEUS_SMOKE_AGENT ?? `smoke-workspace-${Date.now().toString(36)}`;
const mission = process.env.PROTEUS_SMOKE_MISSION ?? `Verify workspace websocket and snapshot ${new Date().toISOString()}`;
const keepAgent = process.env.PROTEUS_SMOKE_KEEP_AGENT === '1';

function wsOrigin(httpOrigin: string): string {
  if (httpOrigin.startsWith('https://')) return `wss://${httpOrigin.slice('https://'.length)}`;
  if (httpOrigin.startsWith('http://')) return `ws://${httpOrigin.slice('http://'.length)}`;
  throw new Error(`Unsupported origin: ${httpOrigin}`);
}

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) as T : undefined as T;
}

interface WorkspaceSnapshot {
  status?: {
    name?: string;
    purpose?: string;
  };
  tools?: {
    builtIn?: unknown[];
    crafted?: unknown[];
  };
  executors?: unknown[];
}

async function waitForWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  return new Promise((resolve, reject) => {
    const url = `${wsOrigin(origin)}/agents/orchestrator-agent/${encodeURIComponent(agentName)}`;
    const ws = new WebSocket(url);
    const rpcId = crypto.randomUUID();
    let sentRpc = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(1000, 'smoke done'); } catch { /* noop */ }
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error('Timed out waiting for websocket identity/RPC snapshot')));
    }, 20_000);

    ws.addEventListener('open', () => {
      // Wait for cf_agent_identity before RPC; this matches agents/react ready.
    });
    ws.addEventListener('error', () => {
      finish(() => reject(new Error('Workspace websocket failed')));
    });
    ws.addEventListener('close', (event) => {
      if (!settled) finish(() => reject(new Error(`Workspace websocket closed early: ${event.code} ${event.reason}`)));
    });
    ws.addEventListener('message', (event) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.type === 'cf_agent_identity' && !sentRpc) {
        sentRpc = true;
        ws.send(JSON.stringify({
          type: 'rpc',
          id: rpcId,
          method: 'getWorkspaceSnapshot',
          args: [],
        }));
        return;
      }
      if (msg.type !== 'rpc' || msg.id !== rpcId) return;
      if (msg.success === false) {
        finish(() => reject(new Error(`getWorkspaceSnapshot failed: ${String(msg.error ?? 'unknown')}`)));
        return;
      }
      finish(() => resolve(msg.result as WorkspaceSnapshot));
    });
  });
}

async function cleanupAgent(): Promise<void> {
  if (keepAgent) return;
  try {
    await jsonFetch(`/api/user/agents/${encodeURIComponent(agentName)}`, { method: 'DELETE' });
  } catch (err) {
    console.warn(`[smoke-workspace] cleanup failed for ${agentName}:`, err instanceof Error ? err.message : err);
  }
}

try {
  await jsonFetch('/api/user/agents', {
    method: 'POST',
    body: JSON.stringify({ name: agentName, purpose: mission }),
  });
  const snapshot = await waitForWorkspaceSnapshot();
  if (snapshot.status?.name !== agentName) {
    throw new Error(`Snapshot agent mismatch: expected ${agentName}, got ${snapshot.status?.name ?? '(missing)'}`);
  }
  if (snapshot.status?.purpose !== mission) {
    throw new Error(`Snapshot purpose mismatch: expected "${mission}", got "${snapshot.status?.purpose ?? '(missing)'}"`);
  }
  if (!Array.isArray(snapshot.tools?.builtIn)) {
    throw new Error('Snapshot missing built-in tools array');
  }
  if (!Array.isArray(snapshot.executors)) {
    throw new Error('Snapshot missing executors array');
  }
  console.log(JSON.stringify({
    ok: true,
    origin,
    agentName,
    builtInTools: snapshot.tools.builtIn.length,
    executors: snapshot.executors.length,
  }));
} finally {
  await cleanupAgent();
}
