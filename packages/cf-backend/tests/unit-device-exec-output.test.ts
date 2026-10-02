/**
 * A watched device command's output reaches its workspace while it runs: UserDO hands each output frame the daemon
 * sends to the call's callback, before the answer. An older daemon, which sends none, still answers.
 */
import { describe, expect, test } from 'bun:test';
import { nextDeviceRequestId, type DeviceExecOutput, type JsonValue } from '@kinu.run/core';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { WORKSPACE, daemon, deviceHarness, type DeviceHarness, type DeviceResponder } from './helpers/device-harness';

const BUILT = { stdout: 'building\n', stderr: 'warn\n', exitCode: 0 } satisfies JsonValue;

/** The daemon's name for the frame; unit-pc-agent-exec pins the daemon's frames reaching the hub's tunnel. */
const DEVICE_EXEC_OUTPUT = 'EXEC_OUT';

function chunk(stream: 'stdout' | 'stderr', text: string): DeviceExecOutput['chunks'][number] {
  return { stream, data: Buffer.from(text).toString('base64') };
}

/** As the daemon prints for a hub that asked: a frame per line, the last counting what it dropped, then the answer. */
const printing: DeviceResponder = async (call, say) => {
  if (call.method !== 'exec') return daemon(call);

  if (call.output === true) {
    await say({ type: DEVICE_EXEC_OUTPUT, request: call.id, chunks: [chunk('stdout', 'building\n')], dropped: 0 });
    await say({ type: DEVICE_EXEC_OUTPUT, request: call.id, chunks: [chunk('stderr', 'warn\n')], dropped: 5 });
  }

  return BUILT;
};

async function exec(harness: DeviceHarness, onOutput?: (output: DeviceExecOutput) => void | Promise<void>): Promise<JsonValue> {
  const answer = await harness.userDO.deviceRpc(harness.workspace, 'exec', ['bun run build'], {
    agentName: WORKSPACE, requestId: nextDeviceRequestId(), ...(onOutput !== undefined && { onOutput }),
  });

  return JSON.parse(answer ?? 'null');
}

function askedForOutput(harness: DeviceHarness): boolean | undefined {
  return harness.deviceFrames.find((frame) => frame.method === 'exec')?.output;
}

describe('a watched device command', () => {
  test("its output reaches the workspace's callback while it runs, all of it before the answer", async () => {
    const harness = await deviceHarness('ashish@studio', printing);
    harness.consentDecision = 'always';
    const heard: DeviceExecOutput[] = [];

    const answer = await exec(harness, (output) => { heard.push(output); });

    expect(heard).toEqual([
      { chunks: [chunk('stdout', 'building\n')], dropped: 0 },
      { chunks: [chunk('stderr', 'warn\n')], dropped: 5 },
    ]);
    expect(answer).toEqual(BUILT);
    expect(askedForOutput(harness)).toBe(true);
    await harness.closeDeviceHarness();
  });

  test('an older daemon, which sends no output, still answers', async () => {
    const harness = await deviceHarness('ashish@studio', (call) => (call.method === 'exec' ? BUILT : daemon(call)));
    harness.consentDecision = 'always';
    const heard: DeviceExecOutput[] = [];

    expect(await exec(harness, (output) => { heard.push(output); })).toEqual(BUILT);
    expect(heard).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a call with nowhere to show its output asks for none', async () => {
    const harness = await deviceHarness('ashish@studio', printing);
    harness.consentDecision = 'always';

    expect(await exec(harness)).toEqual(BUILT);
    expect(askedForOutput(harness)).toBeUndefined();
    await harness.closeDeviceHarness();
  });

  test("a workspace that cannot take the output leaves the command's answer intact, and each loss is logged", async () => {
    const harness = await deviceHarness('ashish@studio', printing);
    harness.consentDecision = 'always';
    const recording = createRecordingLogger();
    // After the harness: building a UserDO installs the isolate's own sink.
    const restore = setDiagnosticsSink(recording);

    try {
      const answer = await exec(harness, async () => { throw new Error('the workspace was reset'); });
      await harness.closeDeviceHarness();

      expect(answer).toEqual(BUILT);
      const unsent = recording.emitted.filter((line) => line.event === 'device.output_unsent');
      expect(unsent.map((line) => line.cause?.includes('the workspace was reset'))).toEqual([true, true]);
    } finally {
      restore();
    }
  });
});
