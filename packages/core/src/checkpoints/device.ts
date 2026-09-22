/**
 * A cloud workspace's checkpoint store: the owner's device, reached over the
 * account object's device RPC. Every answer is parsed against core's own
 * schema, and the three ways a device can be out of reach come back as
 * availability rather than as a throw — with the unattached case first, since
 * its remedy is not the owner's: a workspace with no owner account reached no
 * hub, and advising `kinu connect` there sends a person to re-link a machine
 * that was never the problem.
 */
import * as v from 'valibot';
import { isDeviceAmbiguityError, isDeviceNotConnectedError, isWorkspaceUnattachedError, WORKSPACE_HAS_NO_OWNER } from '../execution/device-tunnel';
import { renderThrownChain } from '../obs/index';
import type { UserCaller } from '../safety/workspace-capability';
import { parseJsonValue, type JsonValue } from '../utils/json';
import {
  CheckpointAvailabilitySchema, FileCheckpointEntrySchema, FileRestorePlanSchema, FileRestoreResultSchema,
  type CheckpointAvailability, type FileCheckpointReads,
} from './types';

/** The device call the account object forwards, as the actor reaches it. */
export interface DeviceRpcHub {
  deviceRpc(caller: UserCaller, method: string, params: JsonValue[]): Promise<string | undefined>;
}

export interface DeviceCheckpointsInput {
  /** The account object and the caller the actor acts as; resolved per call
   *  because the owner may be claimed after the actor is built. */
  readonly hub: () => Promise<{ stub: DeviceRpcHub; caller: UserCaller }>;
  /** Whether an owner account is attached at all; without one there is no hub
   *  to ask and the answer is the unattached reason, not a throw. */
  readonly hasOwner: () => boolean;
  /** The workspace the device's store files checkpoints under. */
  readonly workspace: string;
}

/** The device RPC's own bound on one listing: the store filters by turn before
 *  it truncates, so the bound is about one answer's size only. */
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

        // Several machines are live and the checkpoint plane does not yet name
        // one: an availability answer in the hub's own words (it names the
        // machines), never a silent pick of whichever came first.
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
