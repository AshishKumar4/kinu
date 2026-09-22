// Device-backed checkpoint store. Out-of-reach devices answer as availability, not a throw; the
// unattached case is checked first because `kinu connect` cannot fix a workspace with no owner.
import * as v from 'valibot';
import { isDeviceAmbiguityError, isDeviceNotConnectedError, isWorkspaceUnattachedError, WORKSPACE_HAS_NO_OWNER } from '../execution/device-tunnel';
import { renderThrownChain } from '../obs/index';
import type { UserCaller } from '../safety/workspace-capability';
import { parseJsonValue, type JsonValue } from '../utils/json';
import {
  CheckpointAvailabilitySchema, FileCheckpointEntrySchema, FileRestorePlanSchema, FileRestoreResultSchema,
  type CheckpointAvailability, type FileCheckpointReads,
} from './types';

export interface DeviceRpcHub {
  deviceRpc(caller: UserCaller, method: string, params: JsonValue[]): Promise<string | undefined>;
}

export interface DeviceCheckpointsInput {
  /** Resolved per call: the owner may be claimed after the actor is built. */
  readonly hub: () => Promise<{ stub: DeviceRpcHub; caller: UserCaller }>;
  readonly hasOwner: () => boolean;
  readonly workspace: string;
}

/** Bounds one answer's size only; the store filters by turn before it truncates. */
const DEVICE_LIST_LIMIT_MAX = 500;

const DEVICE_LIST_LIMIT_DEFAULT = 50;

export function deviceFileCheckpoints(input: DeviceCheckpointsInput): FileCheckpointReads {
  const call = async <Schema extends v.GenericSchema>(method: string, params: JsonValue[], schema: Schema): Promise<v.InferOutput<Schema>> => {
    const { stub, caller } = await input.hub();
    const answer = await stub.deviceRpc(caller, method, params);

    return v.parse(schema, answer === undefined ? undefined : parseJsonValue(answer));
  };

  return {
    async status(): Promise<CheckpointAvailability> {
      if (!input.hasOwner()) return { available: false, reason: 'agent has no owner user yet' };

      try {
        return await call('checkpointStatus', [], CheckpointAvailabilitySchema);
      } catch (cause) {
        if (isWorkspaceUnattachedError({ cause })) return { available: false, reason: WORKSPACE_HAS_NO_OWNER };

        if (isDeviceNotConnectedError({ cause })) {
          return { available: false, reason: 'no device connected — connect one with `kinu connect`' };
        }

        // Several live machines: report the hub's message (it names them), never silently pick one.
        if (isDeviceAmbiguityError({ cause })) return { available: false, reason: renderThrownChain({ cause }) };

        throw cause;
      }
    },
    list: (opts) => call(
      'checkpointList',
      [input.workspace, Math.max(1, Math.min(DEVICE_LIST_LIMIT_MAX, opts?.limit ?? DEVICE_LIST_LIMIT_DEFAULT)), opts?.turnId ?? null],
      v.array(FileCheckpointEntrySchema),
    ),
    plan: (dir, id) => call('checkpointPlan', [input.workspace, dir, id], FileRestorePlanSchema),
    restore: (dir, id) => call('checkpointRestore', [input.workspace, dir, id], FileRestoreResultSchema),
  };
}
