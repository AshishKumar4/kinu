/**
 * A workspace socket's calls, typed from the agent's own class through the Agents SDK's stub: each method's arguments
 * and answer are the server's. The SDK's typed `call` cannot be wrapped or answered for any method without an assertion
 * (a generic method picks none of its overloads), so the socket's untyped call is asked for the stub's answer instead.
 * The SDK refuses a method that is not `@callable()` at run time; the type admits any public one.
 */
import type { useAgent } from "agents/react";
import * as v from "valibot";
import { JsonValueSchema } from "@kinu.run/core";
import { Effect } from "effect";
import { KinuError, settle } from "@kinu.run/core/obs";
import type { OrchestratorAgent } from "@/orchestrator";

type WorkspaceStub = ReturnType<typeof useAgent<OrchestratorAgent, unknown>>["stub"];

type WorkspaceMethod = keyof WorkspaceStub;

export type WorkspaceAnswer<K extends WorkspaceMethod> = Awaited<ReturnType<WorkspaceStub[K]>>;

export type WorkspaceRpc = <K extends WorkspaceMethod>(method: K, args: Parameters<WorkspaceStub[K]>) => Promise<WorkspaceAnswer<K>>;

/** A socket's untyped call, as the SDK answers any method, or as a fixture does: what a fixture answers is its word. */
export type SocketCall = <T = unknown>(method: string, args?: unknown[]) => Promise<T>;

/** `call`'s answers, read as the server's type for each method. */
export function workspaceRpc(call: SocketCall): WorkspaceRpc {
  return <K extends WorkspaceMethod>(method: K, args: Parameters<WorkspaceStub[K]>) => call<WorkspaceAnswer<K>>(method, args);
}

/**
 * A fixture's answers by method, each typed as the server answers it: what a fixture shows is checked against what the
 * product reads, so a field the product comes to need fails the build, not the page (the landing, 2026-10-20: its
 * catch-all answered `agentMail` with `{ ok: true }`, and the Agent tab crashed in production).
 */
export type WorkspaceAnswers = {
  readonly [K in WorkspaceMethod]?: (...args: Parameters<WorkspaceStub[K]>) => Answered<WorkspaceAnswer<K>>;
};

/** An answer as a fixture writes it: the value, its promise, or an effect that fails as the server's read would. */
type Answered<A> = A | Promise<A> | Effect.Effect<A, KinuError>;

function isAnswerEffect<A>(answer: Answered<A>): answer is Effect.Effect<A, KinuError> {
  return Effect.isEffect(answer);
}

/**
 * A rpc answering from `answers` alone, each answer carried as the socket carries it (as JSON). A method they lack is
 * refused: the surface that asked shows its read failing, never a shape it did not ask for.
 */
export function answeringRpc(answers: WorkspaceAnswers): WorkspaceRpc {
  return <K extends WorkspaceMethod>(method: K, args: Parameters<WorkspaceStub[K]>): Promise<WorkspaceAnswer<K>> => settle(Effect.gen(function* () {
    const answer = answers[method];

    if (answer === undefined) return yield* new KinuError("unsupported", `This fixture answers no ${String(method)}.`);
    // Typed where it is written (`WorkspaceAnswers`); here it is only carried.
    const answering = answer(...args);
    const value = isAnswerEffect(answering) ? yield* answering : yield* Effect.promise(async () => await answering);

    return yield* Effect.promise(() => new Response(JSON.stringify(v.parse(JsonValueSchema, value ?? null))).json<WorkspaceAnswer<K>>());
  }));
}

/** Whether `answers` has an answer for the method a wire named. */
function answered(answers: WorkspaceAnswers, method: string): method is WorkspaceMethod {
  return Object.hasOwn(answers, method);
}

/**
 * `answers` as a socket serves them, for a page whose own client reads them over the wire: the method a frame names,
 * its arguments decoded as the wire decodes them, each answer typed where it is written. A method `answers` lacks is
 * refused.
 */
export function wireOf(answers: WorkspaceAnswers): SocketCall {
  const rpc = answeringRpc(answers);

  return <T,>(method: string, args?: unknown[]): Promise<T> => settle(Effect.gen(function* () {
    if (!answered(answers, method)) return yield* new KinuError("unsupported", `This fixture answers no ${method}.`);
    const decoded = yield* Effect.promise(() => new Response(JSON.stringify(args ?? [])).json<Parameters<WorkspaceStub[typeof method]>>());
    const answer = yield* Effect.promise(() => rpc(method, decoded));

    return yield* Effect.promise(() => new Response(JSON.stringify(v.parse(JsonValueSchema, answer ?? null))).json<T>());
  }));
}

/** `rpc`, `count` told as each call goes (+1) and as it is answered or refused (-1). */
export function countingRpc(rpc: WorkspaceRpc, count: (delta: 1 | -1) => void): WorkspaceRpc {
  return <K extends WorkspaceMethod>(method: K, args: Parameters<WorkspaceStub[K]>): Promise<WorkspaceAnswer<K>> => {
    count(1);

    return rpc(method, args).finally(() => { count(-1); });
  };
}

