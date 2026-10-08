// A workspace the agent proposes exists only after the owner approves it, once; the decision wakes the agent with the
// link, the decline, or why the create failed. A durable row, so an activation that never saw the ask still shows it.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { settle } from "../src/obs/effect";
import {
  initWorkspaceProposalsTable, proposedSoul, WorkspaceProposals, WorkspaceProposalStore, type WorkspaceProposalDeps,
} from "../src/safety/workspace-proposals";
import { buildPendingActions } from "../src/read-models/pending-actions";
import type { AgentSignal } from "../src/types/signals";
import { makeExecRaw, makeSql } from "./helpers";

interface Harness {
  readonly proposals: WorkspaceProposals;
  readonly store: WorkspaceProposalStore;
  readonly created: Array<{ displayName: string; purpose: string; soul: string }>;
  readonly woken: AgentSignal[];
  /** The next create's answer: an address, or a refusal. */
  next: { name: string } | Error;
  /** Held until released, as a create still on the wire is. */
  hold: { readonly promise: Promise<void>; resolve(): void } | null;
}

function harness(db = new Database(":memory:")): Harness {
  initWorkspaceProposalsTable(makeExecRaw(db));
  const store = new WorkspaceProposalStore(makeSql(db));
  let ids = 0;

  const state: Omit<Harness, "proposals"> & { proposals?: WorkspaceProposals } = {
    store, created: [], woken: [], next: { name: "blue-river-1a2b" }, hold: null,
  };

  const deps: WorkspaceProposalDeps = {
    store,
    newId: () => `wsp-${String(ids += 1)}`,
    now: () => 1000 + ids,
    create: async (input) => {
      state.created.push(input);
      await state.hold?.promise;

      if (state.next instanceof Error) throw state.next;

      return state.next;
    },
    link: (workspace) => `https://kinu.example/workspace/${workspace}`,
    inbox: {
      send: async (signal) => {
        state.woken.push(signal);

        return "queued";
      },
    },
    announce: () => {},
  };

  const proposals = new WorkspaceProposals(deps);

  return Object.assign(state, { proposals });
}

const ASK = { name: "Market research", brief: "Track three competitors' pricing weekly.", soul: "You are terse and cite sources." };

describe("a proposed workspace", () => {
  test("is only a pending row until the owner decides, and the queue shows the SOUL.md approving writes", async () => {
    const h = harness();
    const receipt = await settle(h.proposals.propose(ASK));

    expect(receipt).toMatchObject({ status: "pending", proposal: "wsp-1" });
    expect(h.created).toEqual([]);

    const [row] = buildPendingActions({
      scaffoldVersions: [], deferredActions: [], curriculum: [], pendingPlans: [],
      unseenChanges: { count: 0, revertable: 0, latestAt: 0 }, workspaceProposals: h.proposals.open(),
    });

    expect(row).toMatchObject({ id: "wsp-1", kind: "workspace_proposal", title: "Create a workspace: Market research", detail: ASK.brief });
    expect(row?.proposal?.soul).toBe(proposedSoul(ASK));
    expect(proposedSoul(ASK)).toBe("# Market research\n\n## Mission\n\nTrack three competitors' pricing weekly.\n\nYou are terse and cite sources.");
  });

  test("approved, it is created once through the creation path, and the agent is woken with its link", async () => {
    const h = harness();
    await settle(h.proposals.propose(ASK));

    const [first, second] = await Promise.all([
      settle(h.proposals.decide("wsp-1", "approve")),
      settle(h.proposals.decide("wsp-1", "approve")),
    ]);

    expect([first?.status, second]).toEqual(["created", null]);
    expect(h.created).toEqual([{ displayName: "Market research", purpose: ASK.brief, soul: proposedSoul(ASK) }]);
    expect(h.woken).toEqual([expect.objectContaining({
      kind: "workspace_proposal",
      text: expect.stringContaining("https://kinu.example/workspace/blue-river-1a2b"),
      metadata: { proposal: "wsp-1", decision: "created", workspace: "blue-river-1a2b", url: "https://kinu.example/workspace/blue-river-1a2b" },
    })]);
    expect(h.proposals.open()).toEqual([]);
    // Decided once: a later answer decides nothing and wakes nobody.
    expect(await settle(h.proposals.decide("wsp-1", "decline"))).toBeNull();
    expect(h.woken).toHaveLength(1);
  });

  test("declined, nothing is created and the agent is told", async () => {
    const h = harness();
    await settle(h.proposals.propose(ASK));

    expect((await settle(h.proposals.decide("wsp-1", "decline")))?.status).toBe("declined");
    expect(h.created).toEqual([]);
    expect(h.woken.map((signal) => signal.metadata)).toEqual([{ proposal: "wsp-1", decision: "declined" }]);
    expect(h.proposals.open()).toEqual([]);
  });

  test("a create that fails settles the row as failed and tells the agent why", async () => {
    const h = harness();
    await settle(h.proposals.propose(ASK));
    h.next = new Error("Cloudflare Workers AI is not connected");

    expect((await settle(h.proposals.decide("wsp-1", "approve")))?.status).toBe("failed");
    expect(h.woken[0]?.text).toContain("Cloudflare Workers AI is not connected");
    expect(h.proposals.open()).toEqual([]);
  });

  test("while its create is in flight it leaves the queue; one an eviction cut short is decidable again", async () => {
    const db = new Database(":memory:");
    const h = harness(db);
    await settle(h.proposals.propose(ASK));
    h.hold = Promise.withResolvers<void>();
    const deciding = settle(h.proposals.decide("wsp-1", "approve"));

    await Promise.resolve();
    expect(h.proposals.open()).toEqual([]);
    // Another activation over the same rows: the create it never started is the owner's to decide again.
    const woken = harness(db);
    expect(woken.proposals.open().map((proposal) => [proposal.id, proposal.status])).toEqual([["wsp-1", "creating"]]);
    h.hold.resolve();
    await deciding;
  });

  test("a name that is not one short line, or an empty brief, is refused before any row exists", async () => {
    const h = harness();
    const refused = async (input: typeof ASK) => settle(Effect.match(h.proposals.propose(input), { onFailure: (error) => error.code, onSuccess: () => "accepted" }));

    expect(await refused({ ...ASK, name: "  " })).toBe("bad_input");
    expect(await refused({ ...ASK, name: "x".repeat(81) })).toBe("bad_input");
    expect(await refused({ ...ASK, brief: " " })).toBe("bad_input");
    expect(h.proposals.open()).toEqual([]);
  });
});
