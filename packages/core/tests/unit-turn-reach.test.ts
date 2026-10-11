/** What a turn reaches by whom it answers (design v2 §1.6), decided once for every host. */
import { describe, expect, test } from 'bun:test';
import { OWNER_ANSWER_SIGNAL, turnLane, turnReach } from '../src/index';

describe('turnLane', () => {
  test("a hire's hirer-written turn is its hirer's lane; every other turn is its owner's", () => {
    expect(turnLane({ hirer: 'hirer-id' }, 'hirer')).toBe('hirer');
    expect(turnLane({ hirer: 'hirer-id' }, 'owner')).toBe('owner');
    // With no hirer, a programmatic turn has no one else to answer.
    expect(turnLane({ hirer: null }, 'hirer')).toBe('owner');
  });
});

describe('turnReach', () => {
  const owner = { lane: 'owner', mode: 'build', driving: { kinuEvent: OWNER_ANSWER_SIGNAL }, ownerSurface: true, awaitsReply: false } as const;

  test("the hirer's lane reports and reaches nothing of the owner's", () => {
    expect(turnReach({ ...owner, lane: 'hirer', awaitsReply: true })).toEqual({ report: true, askOwner: false, submitPlan: false, replyToComment: false });
  });

  test("the owner's lane reaches the owner where the host shows the owner the agent", () => {
    expect(turnReach({ ...owner, awaitsReply: true })).toEqual({ report: false, askOwner: true, submitPlan: true, replyToComment: true });
    expect(turnReach({ ...owner, ownerSurface: false, awaitsReply: true })).toEqual({ report: false, askOwner: false, submitPlan: false, replyToComment: false });
  });

  test("Build offers a plan only on the owner's conversation; Plan on any owner's-lane turn", () => {
    // A harness turn, as a job's wake is: the owner's lane of an agent with no hirer, and not the owner's conversation.
    const wake = { kinuEvent: 'job_wake' };

    expect(turnReach({ ...owner, driving: wake }).submitPlan).toBe(false);
    expect(turnReach({ ...owner, driving: wake, mode: 'plan' }).submitPlan).toBe(true);
  });
});
