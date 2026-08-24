/**
 * The local peer transport — agent-to-agent mail inside ONE virtual workspace.
 *
 * A virtual workspace is metadata, not a place. It is the pair
 * `{ cwd, workspaceId }` recorded on a local agent ref, and every ROOT agent
 * carrying the same pair is an equal peer of the others: same physical
 * directory, same shell, its own SQLite identity, conversation, role, scaffold,
 * search and memory. None of them is the workspace and none of them is above
 * another, so mail between them is peer mail rather than a report up a tree.
 *
 * The transport is core's `PeerHub`, unchanged — the durable `outbox_peer` row,
 * per-receiver ordering, the exponential backoff, the dead letter, the
 * peer-back reply channel and the ask waiter are all the same code the hosted
 * backend runs. The one part a host owns is `deliver`, the hop that reaches the
 * receiver; on the cloud that hop is a cross-DO RPC and here it is a direct
 * call into the sibling's own endpoint inside this process.
 *
 * The boundary is exact equality of the pair, enforced twice for two different
 * jobs: the roster makes an off-group name a legible refusal before anything is
 * queued, and the host's `deliver` resolves names only within the group, so a
 * row naming an outsider dead-letters instead of arriving. Subordinates never
 * hold this transport at all, so a subordinate cannot reach a peer, its
 * parent's peers, or another workspace.
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
import type { PeerSpawnOutcome, PeersToolDeps } from './agents-tool';
import type { SqlExec, VFS } from '../types/primitives';

/**
 * One local agent the host may bind.
 *
 * `cwd` is the canonical physical project directory — realpath'd by whoever
 * recorded the ref — and it is what the agent's file plane, shell and
 * AGENTS.md discovery are rooted in. `workspaceId` groups the agent with its
 * peers inside that directory. The pair travels together because neither half
 * identifies a group on its own: two workspaces can share a directory, and the
 * same workspace id in another directory is a different group.
 */
export interface HostedAgentRef {
  name: string;
  cwd: string;
  workspaceId: string;
  /** Human label for the roster, when the ref recorded one. */
  displayName?: string;
}

/** Peer membership: exact equality of the pair. Nothing else. */
export function samePeerGroup(
  a: { cwd: string; workspaceId: string },
  b: { cwd: string; workspaceId: string },
): boolean {
  return a.cwd === b.cwd && a.workspaceId === b.workspaceId;
}

/**
 * The transport-level owner of a local peer group.
 *
 * `PeerHub` puts a `sender_user_id` on the wire, checks it with `isSameOwner`,
 * and orders its outbox per `(receiver_user_id, receiver)`. A local machine has
 * one human, so the useful identity at that seam is not the human — it is the
 * virtual workspace. Making the group the owner means the hub's own same-owner
 * check IS the membership check and its ordering key is genuinely per-peer.
 * `workspaceId` is name-validated and cannot contain `:`, so the split point
 * stays unambiguous however the directory is spelled.
 */
function peerGroupId(ref: { cwd: string; workspaceId: string }): string {
  return `local:${ref.workspaceId}:${ref.cwd}`;
}

/** What one endpoint needs from the host that owns it. */
export interface LocalPeerEndpointDeps {
  /** The agent this endpoint speaks for. */
  self: HostedAgentRef;
  /** Every local agent the host knows, re-read per call so a ref recorded
   *  after this process started is reachable without restarting it. */
  roster(): readonly HostedAgentRef[];
  /** The agent's own storage — `outbox_peer` lives beside `agent_log`. */
  sql: SqlExec;
  log: EventLog;
  /** Must carry a `peer_back` dispatcher routed to {@link LocalPeerEndpoint
   *  .peerBack}, or an answer to an ask has nowhere to go. The cycle is real
   *  and the cloud backend has the same one: bind the dispatcher through a
   *  getter that reads the endpoint after it is built. */
  replyChannels: ReplyChannelStore;
  /** Dereferenced per received message — the file plane is built lazily. */
  vfs(): VFS;
  /** The hop to a peer. The host resolves the name inside this agent's group
   *  and calls the sibling's {@link LocalPeerEndpoint.receive}; a name it
   *  cannot resolve is a refusal that dead-letters the row, and a sibling it
   *  cannot open is a thrown hop the outbox backs off on. */
  deliver(peer: string, msg: PeerMessage): Promise<ReceiveResult>;
  /** Run another host pass no later than `at` — the outbox's retry schedule. */
  scheduleDispatch(at: number): void;
  /** A peer message was admitted: wake this agent's loop. */
  onAdmitted(): void;
}

/** One agent's peer endpoint: its tool deps, its inbox, its outbox pump. */
export interface LocalPeerEndpoint {
  /** The `agents` tool's peers group — list, ask, send, reply. */
  deps: PeersToolDeps;
  /** The receiving half, invoked by the sending peer's hop. */
  receive(msg: PeerMessage): Promise<ReceiveResult>;
  /** Route an answer back to the asker over the same durable outbox. Wired as
   *  the `peer_back` reply dispatcher on {@link LocalPeerEndpointDeps
   *  .replyChannels}. */
  peerBack(channel: ReplyChannelRow, payload: JsonValue): Promise<{ delivered: boolean; detail?: string }>;
  /** Drain due outbox rows, then report the soonest pending retry so the
   *  host's driver can fold it into its next delay. */
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
    // Cross-group mail has no grant path at all. A local group is not a
    // sharing boundary a user widens; it is the identity of the workspace.
    // Reaching another one is running `kinu` there, not a grant here.
    hasGrant: async () => false,
    scheduleDispatch: async (at) => deps.scheduleDispatch(at),
    onAdmitted: () => deps.onAdmitted(),
    // No `now`: `PeerHub` already defaults to `Date.now()`, and time enters this
    // endpoint explicitly through `dispatch(now)`. A second, uninjectable clock
    // beside the controllable one would stamp rows with real time while the
    // pump ran on fabricated time.
  };
  const hub = new PeerHub(hubOptions);

  /** The peers this agent may address: same pair, self excluded. */
  const reachable = (): HostedAgentRef[] => deps.roster().filter((ref) =>
    ref.name !== deps.self.name && samePeerGroup(ref, deps.self));

  /** Throws the way the cloud backend's `requirePeer` does — the agents
   *  dispatcher renders it as the tool's error, so a typo says what to do next
   *  instead of queueing a row that can only dead-letter. */
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
      // Creating a peer is the person at the keyboard's act, not the host's.
      // The ref that makes an agent addressable lives in the user's config and
      // the host is HANDED the refs it may bind. Refused with the command that
      // does it rather than half-done here: an agent.db with no ref is exactly
      // the db-existence inference this cutover removes.
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
