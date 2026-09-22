/**
 * Local peer transport: agent-to-agent mail among root agents sharing one `{ cwd, workspaceId }` pair.
 * Membership is exact pair equality; subordinates never hold this transport.
 */

import {
  PeerHub,
  type PeerMessage,
  type ReceiveResult,
} from '../events/ingress/peer';
import type { EventLog } from '../events/hub/log';
import type { ReplyChannelStore } from '../events/hub/reply-channel';
import type { ReplyChannelRow } from '../events/hub/types';
import type { JsonValue } from '../utils/json';
import type { PeerSpawnOutcome, PeersToolDeps } from '../types/peers';
import type { SqlExec, VFS } from '../types/primitives';

/** One local agent the host may bind. `cwd` is realpath'd; only the pair identifies a group. */
export interface HostedAgentRef {
  name: string;
  cwd: string;
  workspaceId: string;
  displayName?: string;
}

export function samePeerGroup(
  a: { cwd: string; workspaceId: string },
  b: { cwd: string; workspaceId: string },
): boolean {
  return a.cwd === b.cwd && a.workspaceId === b.workspaceId;
}

/** Group id used as the PeerHub owner, so the hub's same-owner check is the membership check.
 *  `workspaceId` cannot contain `:`, so the split stays unambiguous. */
function peerGroupId(ref: { cwd: string; workspaceId: string }): string {
  return `local:${ref.workspaceId}:${ref.cwd}`;
}

export interface LocalPeerEndpointDeps {
  self: HostedAgentRef;
  /** Re-read per call so refs recorded after startup are reachable. */
  roster(): readonly HostedAgentRef[];
  sql: SqlExec;
  log: EventLog;
  /** Must carry a `peer_back` dispatcher routed to `peerBack`, bound through a getter (the cycle is real). */
  replyChannels: ReplyChannelStore;
  /** Dereferenced per received message; the file plane is built lazily. */
  vfs(): VFS;
  /** Unresolvable name is a refusal that dead-letters; a throw is retried with backoff. */
  deliver(peer: string, msg: PeerMessage): Promise<ReceiveResult>;
  /** Run another host pass no later than `at`. */
  scheduleDispatch(at: number): void;
  onAdmitted(): void;
}

export interface LocalPeerEndpoint {
  deps: PeersToolDeps;
  receive(msg: PeerMessage): Promise<ReceiveResult>;
  /** Wired as the `peer_back` reply dispatcher. */
  peerBack(channel: ReplyChannelRow, payload: JsonValue): Promise<{ delivered: boolean; detail?: string }>;
  /** Drains due rows; returns the soonest pending retry. */
  dispatch(now: number): Promise<number | null>;
}

export function createLocalPeerEndpoint(deps: LocalPeerEndpointDeps): LocalPeerEndpoint {
  const groupId = peerGroupId(deps.self);

  const hubOptions: ConstructorParameters<typeof PeerHub>[0] = {
    sql: deps.sql,
    log: deps.log,
    replyChannels: deps.replyChannels,
    vfs: () => deps.vfs(),
    selfAgentName: () => deps.self.name,
    selfUserId: () => groupId,
    deliver: (peer, msg) => deps.deliver(peer, msg),
    isSameOwner: async (senderGroupId) => senderGroupId === groupId,
    // Cross-group mail has no grant path: the group is the workspace identity.
    hasGrant: async () => false,
    scheduleDispatch: async (at) => deps.scheduleDispatch(at),
    onAdmitted: () => deps.onAdmitted(),
    // No `now`: time enters only through `dispatch(now)`, keeping one injectable clock.
  };

  const hub = new PeerHub(hubOptions);

  const reachable = (): HostedAgentRef[] => deps.roster().filter((ref) =>
    ref.name !== deps.self.name && samePeerGroup(ref, deps.self));

  /** Throws so a typo renders as a tool error instead of queueing a row that can only dead-letter. */
  const requirePeer = (name: string): void => {
    if (name === deps.self.name) {
      throw new Error('that is this agent — pick another peer (action:"list")');
    }

    if (!reachable().some((ref) => ref.name === name)) {
      throw new Error(`unknown peer "${name}" in workspace "${deps.self.workspaceId}"`
        + ' — list the ones you can reach with action:"list"');
    }
  };

  return {
    receive: (msg) => hub.receive(msg),
    peerBack: (channel, payload) => hub.dispatchPeerBack(channel, payload),
    dispatch: async (now) => {
      await hub.dispatchOutbox(now);

      return hub.nextRetryAt();
    },
    deps: {
      listPeers: async () => reachable().map((ref) => (ref.displayName === undefined
        ? { name: ref.name }
        : { name: ref.name, displayName: ref.displayName })),
      ask: async ({ agent, topic, message, mode, signal }) => {
        requirePeer(agent);

        const request: Parameters<PeerHub['ask']>[0] = {
          agent, userId: groupId, topic, message, mode,
        };

        if (signal) Object.assign(request, { signal });

        return hub.ask(request);
      },
      send: async ({ agent, topic, message, mode }) => {
        requirePeer(agent);

        return hub.send({ agent, userId: groupId, topic, message, mode });
      },
      reply: async ({ eventId, message }) => hub.reply({ eventId, message }),
      // Creating a peer is the user's act; the host only binds refs it is handed.
      spawnWorkspace: async ({ name }): Promise<PeerSpawnOutcome> => ({
        agent: name ?? '',
        created: false,
        status: 'rejected',
        reason: 'creating a peer agent locally is a user action — run'
          + ` \`kinu create ${name ?? '<name>'}\` in ${deps.self.cwd}, then message it by name.`,
      }),
    },
  };
}
