/**
 * An answer a Worker entrypoint got over RPC and hands on as its own. RPC gives every object answer a disposer, and
 * an entrypoint returning that object returns the disposer with it, so the platform keeps the call open until the
 * caller disposes the answer: on staging f62dfcb9 that held AgentWorkspaceRPC calls open a median of 82 s (up to
 * 19 min), and the runtime reported answered calls as hung when it closed them. A list carries the disposer too;
 * the platform let a relay end as it handed one on, and the list leaves as a copy all the same, so no relayed answer
 * carries a received disposer. The measurements are in packages/cf-backend/tests/workerd/relayed-answer.test.ts.
 */
export async function relayedAnswer<T>(received: Promise<T>): Promise<T> {
  const answer = await received;

  if (Array.isArray(answer)) return Object.assign([], answer);

  // A stub, stream or primitive passes as it is.
  return answer !== null && answer !== undefined && Object.getPrototypeOf(answer) === Object.prototype ? { ...answer } : answer;
}
