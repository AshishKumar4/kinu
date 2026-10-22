import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Local peer transport: agent-to-agent mail among root agents sharing one `{ cwd, workspaceId }` pair.
 * Membership is exact pair equality; subagents never hold this transport.
 */

import {
  PeerHub,
  type PeerMessage,
  type ReceiveResult,
} from '../events/ingress/peer';
import { Effect } from 'effect';
import type { EventLog } from '../events/hub/log';
import { attempt, KinuError, settle } from '../obs/index';
import type { ReplyChannelStore } from '../events/hub/reply-channel';
import type { ReplyChannelRow } from '../events/hub/types';
import type { JsonValue } from '../utils/json';
import type { PeerSpawnOutcome, PeersToolDeps } from '../types/peers';
import type { SqlExec } from '../types/primitives';

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

/**
 * The `peers` an agent's tools reach, over its hub: one shape on every host. A host supplies who it may reach and how it
 * checks a name, as its owner it acts for, and what creating a peer means where it runs.
 */
export function peersToolDeps(hub: Pick<PeerHub, 'ask' | 'send' | 'reply'>, ports: {
  /** This agent's own name: never its own peer. */
  readonly self: string;
  /** The peers it may reach, itself excluded. */
  peers(): Promise<ReadonlyArray<{ readonly name: string; readonly displayName?: string }>>;
  /** Whether it may reach `agent`: checked before a row is queued, so a typo is a tool error, not a dead letter. */
  known(agent: string): Promise<boolean>;
  /** The owner it acts for, asked at each call: a tool set outlives the turn it was built in. */
  userId(): string;
  readonly spawnWorkspace: PeersToolDeps['spawnWorkspace'];
}): PeersToolDeps {
  const requirePeer = (agent: string): Effect.Effect<string, KinuError> => {
    if (agent === ports.self) return Effect.fail(new KinuError('bad_input', 'that is this agent: pick another peer (op:"list")'));

    return attempt({ doing: `checking the peer ${agent}`, otherwise: 'unavailable' }, () => ports.known(agent)).pipe(Effect.flatMap((known) => (known
      ? Effect.sync(() => ports.userId())
      : Effect.fail(new KinuError('missing', `unknown peer "${agent}": list the ones you can reach with op:"list"`)))));
  };

  return {
    listPeers: async () => (await ports.peers()).map((peer) => (peer.displayName === undefined ? { name: peer.name } : { name: peer.name, displayName: peer.displayName })),
    ask: ({ agent, topic, message, mode, signal }) => settle(requirePeer(agent).pipe(Effect.flatMap((userId) => Effect.promise(() => hub.ask({
      agent, userId, topic, message, mode, ...(signal !== undefined && { signal }),
    }))))),
    send: ({ agent, topic, message, mode }) => settle(requirePeer(agent).pipe(Effect.flatMap((userId) => Effect.promise(() => hub.send({ agent, userId, topic, message, mode }))))),
    reply: async ({ eventId, message }) => hub.reply({ eventId, message }),
    spawnWorkspace: ports.spawnWorkspace,
  };
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
    // Cross-group mail is refused: the group is the workspace identity.
    isSameOwner: async (senderGroupId) => senderGroupId === groupId,
    scheduleDispatch: async (at) => deps.scheduleDispatch(at),
    onAdmitted: () => deps.onAdmitted(),
    // No `now`: time enters only through `dispatch(now)`, keeping one injectable clock.
  };

  const hub = new PeerHub(hubOptions);

  const reachable = (): HostedAgentRef[] => deps.roster().filter((ref) =>
    ref.name !== deps.self.name && samePeerGroup(ref, deps.self));

  return {
    receive: (msg) => hub.receive(msg),
    peerBack: (channel, payload) => hub.dispatchPeerBack(channel, payload),
    dispatch: async (now) => {
      await hub.dispatchOutbox(now);

      return hub.nextRetryAt();
    },
    deps: peersToolDeps(hub, {
      self: deps.self.name,
      peers: async () => reachable(),
      known: async (agent) => reachable().some((ref) => ref.name === agent),
      userId: () => groupId,
      // Creating a peer is the user's act; the host only binds refs it is handed.
      spawnWorkspace: async ({ name }): Promise<PeerSpawnOutcome> => ({
        agent: name ?? '',
        created: false,
        status: 'rejected',
        reason: 'creating a peer agent locally is a user action: run'
          + ` \`kinu create ${name ?? '<name>'}\` in ${deps.self.cwd}, then message it by name.`,
      }),
    }),
  };
}
