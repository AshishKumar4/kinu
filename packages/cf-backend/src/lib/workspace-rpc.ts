/**
 * A workspace socket's calls, typed from the agent's own class through the Agents SDK's stub: each method's arguments
 * and answer are the server's. The SDK's typed `call` cannot be wrapped or answered for any method without an assertion
 * (a generic method picks none of its overloads), so the socket's untyped call is asked for the stub's answer instead.
 * The SDK refuses a method that is not `@callable()` at run time; the type admits any public one.
 */
import type { useAgent } from "agents/react";
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
