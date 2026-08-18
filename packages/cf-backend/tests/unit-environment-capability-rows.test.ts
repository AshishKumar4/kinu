/**
 * What the Environment surface's capability row SAYS about a machine.
 *
 * Asserted through the reading a user gets — "Not here: Runs Python" is a claim
 * about their laptop — rather than through the arrays behind it. The bug this
 * pins is that the row had two buckets and needed three: a capability absent
 * from an executor's declared set is either measured absent or never measured,
 * and only the first belongs under a heading that means "this machine lacks it".
 */
import { describe, expect, test } from 'bun:test';
import {
  capabilityLabel, partitionCapabilities, type ExecutorInfo,
} from '../src/lib/executors';

/** The tunnel's own structural row: what the tunnel's existence establishes,
 *  before anyone asks the machine what it runs. */
const TUNNEL_STRUCTURAL = [
  'native_binary', 'shell', 'fs_owned', 'net_outbound', 'process_spawn',
];

/** Everything a PATH probe cannot settle either way. */
const UNPROBEABLE = ['docker', 'gpu'];

/** Everything a PATH probe CAN settle. */
const PROBEABLE = ['javascript', 'typescript', 'python', 'npm', 'git'];

const laptop = (over: Partial<ExecutorInfo> = {}): ExecutorInfo => ({
  name: 'laptop', kind: 'device', capabilities: [...TUNNEL_STRUCTURAL], available: true, ...over,
});

/** A reachable environment that HAS everything, so every absence has somewhere
 *  to point and none is filtered out for being unactionable. */
const workspace: ExecutorInfo = {
  name: 'workspace', kind: 'nimbus', available: true,
  capabilities: [...PROBEABLE, ...UNPROBEABLE, 'fs_shared', 'net_inbound', 'process_long', 'process_signal'],
};

/** The words under each heading, which is what a user actually reads. */
function reading(selected: ExecutorInfo, all: readonly ExecutorInfo[]) {
  const { has, missing, unknown } = partitionCapabilities(selected, all);
  return {
    can: has.map(capabilityLabel),
    notHere: missing.map((row) => capabilityLabel(row.capability)),
    notMeasured: unknown.map(capabilityLabel),
  };
}

describe('Environment capability row', () => {
  test('an unprobed machine is not said to lack Python', () => {
    // Never probed: the row declares nothing about the toolchain, and the whole
    // probeable set plus the unprobeable set is unmeasured.
    const row = reading(laptop({ unmeasuredCapabilities: [...PROBEABLE, ...UNPROBEABLE] }), [
      laptop({ unmeasuredCapabilities: [...PROBEABLE, ...UNPROBEABLE] }), workspace,
    ]);
    expect(row.notHere).not.toContain('Runs Python');
    expect(row.notMeasured).toContain('Runs Python');
    // And it is not claimed either — an unmeasured capability is in neither of
    // the two buckets that assert something.
    expect(row.can).not.toContain('Runs Python');
  });

  test('a probed machine states what it found and what it did not', () => {
    // Answered: node and python3 resolved, npm and git did not. `npm`/`git` were
    // LOOKED FOR, so their absence is a measurement and reads as one.
    const probed = laptop({
      capabilities: ['javascript', 'python', ...TUNNEL_STRUCTURAL],
      unmeasuredCapabilities: [...UNPROBEABLE],
    });
    const row = reading(probed, [probed, workspace]);
    expect(row.can).toContain('Runs JavaScript');
    expect(row.can).toContain('Runs Python');
    expect(row.notHere).toContain('Installs npm packages');
    expect(row.notHere).toContain('git');
    expect(row.notHere).not.toContain('Runs Python');
    expect(row.notMeasured).toEqual(['Docker', 'GPU']);
  });

  test('GPU is never reported absent, because nothing here can establish it', () => {
    // The costliest omission: a user may have attached the tunnel FOR the GPU,
    // and no PATH lookup can confirm or deny hardware. It must never appear as
    // an absence in either state of the probe.
    for (const unmeasuredCapabilities of [[...PROBEABLE, ...UNPROBEABLE], [...UNPROBEABLE]]) {
      const row = reading(laptop({ unmeasuredCapabilities }), [laptop({ unmeasuredCapabilities }), workspace]);
      expect(row.notHere).not.toContain('GPU');
      expect(row.notMeasured).toContain('GPU');
    }
  });

  test('the three buckets are disjoint, so nothing is claimed and denied at once', () => {
    const probed = laptop({
      capabilities: ['javascript', ...TUNNEL_STRUCTURAL],
      unmeasuredCapabilities: [...UNPROBEABLE],
    });
    const { has, missing, unknown } = partitionCapabilities(probed, [probed, workspace]);
    const all = [...has, ...missing.map((row) => row.capability), ...unknown];
    expect(new Set(all).size).toBe(all.length);
  });

  test('an environment that answers for everything shows no unmeasured line', () => {
    // The common case pays nothing for the third bucket: a workspace measures
    // its whole row, so the heading never renders.
    expect(reading(workspace, [workspace, laptop()]).notMeasured).toEqual([]);
  });

  test('filesystem topology is not an absence in either direction', () => {
    // `fs_owned`/`fs_shared` say WHICH filesystem an environment has, not
    // whether it can do something, so neither is ever a gap to switch away for.
    expect(reading(laptop(), [laptop(), workspace]).notHere).not.toContain('Files shared with the agent');
    expect(reading(workspace, [workspace, laptop()]).notHere).not.toContain('Its own private files');
  });
});
