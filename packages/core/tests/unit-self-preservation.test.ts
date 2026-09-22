/**
 * The one command a turn may not run: the one that kills the process running
 * it.
 *
 * The approval table cannot close this. `AGENT_OWN_EXECUTORS` ungates every
 * `harm: 'local'` rule on `workspace` and `sandbox` on the argument that a
 * wiped scratch workspace is a re-clone, and `workspace.exec` is exempt from
 * `gateProviderExec` besides — neither statement contemplates the process
 * HOSTING the turn, whose loss is not local damage the agent may spend. So the
 * refusal lives at the seam that knows its own pid, and these drive that seam.
 */
import { describe, test, expect } from 'bun:test';
import { withSelfPreservingShell, selfTargetedCommand } from '../src/execution/self-preservation';
import type { Shell } from '../src/types/primitives';

const HOST = { pid: 4242, names: ['kinu'] } as const;

/** A shell that records what reached it. Anything that gets here RAN. */
function recordingShell() {
  const ran: string[] = [];

  const shell: Shell = {
    exec: async (command: string) => {
      ran.push(command);

      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };

  return { ran, shell };
}

describe('a command that would end the turn by ending its host', () => {
  const refused = [
    ['signalling this process by pid', 'kill -9 4242'],
    ['signalling this process group', 'kill -- -4242'],
    ['a pid inside a longer pipeline', 'ps aux | grep node; kill 4242 && echo done'],
    ['pattern-killing the host by name', 'pkill -f kinu'],
    ['killall by name', 'killall kinu'],
    ['restarting the host service', 'systemctl --user restart kinu'],
    ['stopping the host service', 'sudo service kinu stop'],
    ['a process manager restart', 'pm2 restart kinu'],
    ['killing every process the user owns', 'pkill -u $(whoami)'],
    ['kill -9 -1', 'kill -9 -1'],
    ['rebooting the machine', 'sudo reboot'],
    ['shutting the machine down', 'shutdown -h now'],
    ['systemctl poweroff', 'systemctl poweroff'],
  ] as const;

  for (const [name, command] of refused) {
    test(`refuses ${name}`, async () => {
      const { shell, ran } = recordingShell();
      const result = await withSelfPreservingShell(shell, HOST).exec(command);

      expect(ran).toEqual([]);
      expect(result.exitCode).toBe(1);
      expect(result.refusal?.reason).toBe('denied');
      expect(result.stderr).toContain('turn');
    });
  }

  const allowed = [
    ['another process by pid', 'kill -9 991'],
    ['a pid this one merely contains', 'kill 42421'],
    ['killing something else by name', 'pkill -f vite'],
    ['restarting a different service', 'systemctl restart nginx'],
    ['a word that merely contains the name', 'pkill -f kinugram'],
    ['reading about the host', 'ps aux | grep kinu'],
    ['ordinary work', 'git status'],
    ['a file whose name says reboot', 'cat docs/reboot-notes.md'],
  ] as const;

  for (const [name, command] of allowed) {
    test(`runs ${name}`, async () => {
      const { shell, ran } = recordingShell();
      const result = await withSelfPreservingShell(shell, HOST).exec(command);

      expect(ran).toEqual([command]);
      expect(result.exitCode).toBe(0);
    });
  }

  test('the reason names which form was refused, not just that it was', () => {
    expect(selfTargetedCommand('kill -9 4242', HOST)).toContain('4242');
    expect(selfTargetedCommand('pkill -f kinu', HOST)).toContain('kinu');
    expect(selfTargetedCommand('git status', HOST)).toBeNull();
  });

  test('a host that declares no names still protects its pid', async () => {
    const { shell, ran } = recordingShell();
    const bare = withSelfPreservingShell(shell, { pid: 4242, names: [] });

    expect((await bare.exec('pkill -f kinu')).exitCode).toBe(0);
    expect((await bare.exec('kill 4242')).exitCode).toBe(1);
    expect(ran).toEqual(['pkill -f kinu']);
  });
});
