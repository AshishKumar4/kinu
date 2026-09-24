import { describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { Nimbus } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type {
  SqlDatabase,
  SqlValue,
} from '@nimbus-sh/core/runtime/os-contracts.js';
import { mockAgentsSdk } from './helpers/agents-sdk';

// `agents` reaches `cloudflare:email`: mock first, then the harness.
mockAgentsSdk();

const { orchestratorHarness } = await import('./helpers/actor-harness');

type NativeSqlValue = string | number | bigint | null | Uint8Array;

type NativeSqlRow = Record<string, NativeSqlValue>;

function nativeBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return value;
}

function workspaceSql(database: Database): SqlDatabase {
  return {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<NativeSqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(nativeBinding);

      if (statement.columnNames.length > 0) return statement.all(...bound);
      statement.run(...bound);

      return [];
    },
  };
}

describe('installed Nimbus dependency integrity', () => {
  test('the SDK preserves runtime policy enforcement', async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({
        _rpcReady: async () => ({ ok: true as const, preinstalled: [] }),
      }),
    };

    const box = Nimbus.fromEnv(
      { NIMBUS_SESSION: namespace },
      { sandboxes: { default: { runtimes: { allow: ['node'], onDemand: true } } } },
    ).sandbox('patched-sdk');

    await expect(box.runtimes.install('python')).rejects.toThrow(
      "Nimbus runtime 'python' is not allowed",
    );
  });

  test('xargs null mode preserves leading whitespace in the first argument', async () => {
    const db = new Database(':memory:');

    const workspace = await NimbusWorkspace.create({
      sql: workspaceSql(db),
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => db.transaction(fn)() } },
      generation: 1,
      cwd: '/home/main',
    });

    const result = await workspace.exec('xargs -0 -n 1 echo', { stdin: ' leading\0second\0' });

    expect(result).toMatchObject({ exitCode: 0, stdout: ' leading\nsecond\n' });
    db.close();
  });

  // `writeWorkspaceSoul` rests on the installed filesystem: a sticky 1777 root owned by the kernel, SOUL.md kernel-owned 444.
  test('the agent cannot remove, rename or rewrite the SOUL.md its owner wrote', async () => {
    const { agent } = orchestratorHarness();
    const soul = '# Checkout\n\n## Mission\n\nAudit the checkout flow.';

    await agent.setSoul(soul);

    const attempts = await Promise.all([
      'rm -f /home/main/SOUL.md',
      'mv /home/main/SOUL.md /home/main/renamed.md',
      'echo rewritten > /home/main/SOUL.md',
    ].map(async (command) => {
      const ran = await agent.execWorkspaceCommand(`${command}; echo "exit=$?"`);

      return ran.ok ? ran.value.stdout.trim() : ran.error.message;
    }));

    expect(attempts).toEqual(['exit=1', 'exit=1', 'exit=1']);
    expect((await agent.deleteWorkspaceFile('SOUL.md')).ok).toBe(false);
    expect((await agent.writeWorkspaceFile({ kind: 'file', path: 'SOUL.md', data: 'rewritten' })).ok).toBe(false);

    const kept = await agent.execWorkspaceCommand('cat /home/main/SOUL.md');

    expect(kept.ok ? kept.value.stdout : kept.error.message).toBe(soul);
  });
});
