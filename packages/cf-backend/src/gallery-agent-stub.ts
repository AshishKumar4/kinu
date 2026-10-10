/** Gallery stand-in for `agents/react` and `@cloudflare/ai-chat/react` (aliased in `gallery.vite.config.ts`). */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import * as v from "valibot";
import { openingListOf, WORK_TAB_JOBS } from "@kinu.run/core";

interface GalleryConnectionError {
	readonly code: number;
	readonly reason: string;
	readonly message: string;
}

const terminalClose: GalleryConnectionError | null =
	new URLSearchParams(location.search).get("terminal") === "denied"
		? {
			code: 1008,
			reason: "workspace access denied by fixture",
			message: "workspace access denied by fixture",
		}
		: null;

export interface GalleryAgent {
	readonly readyState: number;
	readonly connectionError: GalleryConnectionError | null;
	call<T>(method: string, args?: unknown[]): Promise<T>;
	send(data: string): void;
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
	close(): void;
	reopen(): void;
	/** A forced redial: a fresh socket, so the calls a dead one would have failed are served again. */
	reconnect(): void;
	/** A server-initiated frame, delivered raw so `useKinu`'s own parse and gates run. */
	deliver(raw: string): void;
	readonly path: string;
}

interface AgentHandlers {
	path?: string;
	onOpen?: (event: Event) => void;
	onClose?: (event: CloseEvent) => void;
	onError?: (event: Event) => void;
	onMessage?: (event: MessageEvent) => void;
}

type GalleryRpc = <T>(method: string, args?: unknown[]) => Promise<T>;

/** Registered by `gallery.tsx`, not imported, to avoid a gallery -> page -> hook -> gallery cycle. */
let served: GalleryRpc | null = null;

export function serveGalleryRpc(rpc: GalleryRpc): void {
	served = rpc;
}

/** The server's opening read (`getWorkspaceOpening`) from the frame's own reads, so every fixture mode applies to it;
 *  serialized, as the wire carries it. `data-gallery-openings` counts the openings asked. */
async function galleryOpening(rpc: GalleryRpc): Promise<string> {
	const list = (method: string) => openingListOf(`answering ${method}`, () => rpc<unknown>(method, []));

	const [snapshot, pendingActions, backgroundJobs, inspectedWork, subordinates, pendingConsents, workspaceAgents] = await Promise.all([
		rpc<unknown>("getWorkspaceSnapshot", []),
		rpc<unknown>("listPendingActions", []),
		rpc<unknown>("listBackgroundJobs", [WORK_TAB_JOBS]),
		rpc<unknown>("inspectWork", []),
		list("listSubordinates"), list("listPendingConsents"), list("listWorkspaceAgents"),
	]);

	// `&opening=bad-plan`: an opening whose plan this page cannot read, as a newer or broken server might send.
	const badPlan = new URLSearchParams(location.search).get("opening") === "bad-plan" ? { activePlan: { id: 3 } } : {};

	return JSON.stringify({
		...v.parse(v.looseObject({}), snapshot),
		pendingActions, backgroundJobs, inspectedWork, subordinates, pendingConsents, workspaceAgents, ...badPlan,
	});
}

/** Each chat's transcript by socket path ("" the workspace's), sent on connect as the chat room does. */
const seededChats = new Map<string, readonly UIMessage[]>();

export function seedGalleryChat(messages: readonly UIMessage[], path = ""): void {
	seededChats.set(path, messages);
}

export function seededGalleryChatRows(): number {
	return seededChats.get("")?.length ?? 0;
}

/** Only ids are read: a walk-back redraw names rows the client already holds and adds none; a clear empties them. */
const TranscriptFrameSchema = v.variant("type", [
	v.object({ type: v.literal("cf_agent_chat_messages"), messages: v.array(v.looseObject({ id: v.string() })) }),
	v.object({ type: v.literal("cf_agent_chat_clear") }),
]);

const live = new Set<GalleryAgent>();

/** Deliver one raw server frame to every open connection; parses nothing, so malformed frames can be pushed. */
export function galleryServerPush(raw: string): void {
	for (const agent of live) agent.deliver(raw);
}

const windows = new Map<string, Set<(messages: readonly UIMessage[]) => void>>();

/** As the server's `cf_agent_chat_messages` frame lands: every window on the chat at `path` now shows `messages`. */
export function galleryChatWindow(path: string, messages: readonly UIMessage[]): void {
	for (const show of windows.get(path) ?? []) show(messages);
}

/** As the server answers a clear: the chat at `path` is emptied, then every window on it is told to empty. */
export function galleryClearChat(path: string): void {
	seededChats.delete(path);

	for (const agent of live) if (agent.path === path) agent.deliver(JSON.stringify({ type: "cf_agent_chat_clear" }));
}

/**
 * `data-gallery-socket`: `dead`, every workspace-socket call times out with the SDK's own rejection until a redial, as
 * an open socket whose peer is gone does; `refusing`, every call is refused at once, as a live origin does.
 * `data-gallery-failed-calls` counts the calls failed either way.
 */
function socketFailure(method: string): Error | null {
	const root = document.documentElement.dataset;
	const mode = root.gallerySocket;

	if (mode !== "dead" && mode !== "refusing") return null;
	root.galleryFailedCalls = String(Number(root.galleryFailedCalls ?? "0") + 1);

	return mode === "dead" ? new Error(`RPC call to ${method} timed out after 30000ms`) : new Error("the origin refused the call");
}

/** A connection whose calls resolve from the frame fixture; terminal mode never opens. */
export function useAgent(options: AgentHandlers): GalleryAgent {
	const handlers = useRef(options);
	handlers.current = options;

	useEffect(() => {
		const root = document.documentElement;
		root.dataset.galleryAgentsOpen = String(Number(root.dataset.galleryAgentsOpen ?? "0") + 1);

		return () => { root.dataset.galleryAgentsOpen = String(Number(root.dataset.galleryAgentsOpen ?? "1") - 1); };
	}, []);

	const agent = useMemo<GalleryAgent>(() => {
		const listeners = new Map<string, Set<EventListener>>();

		const reopen = () => {
			handlers.current.onClose?.(new CloseEvent("close", { code: 1006 }));
			handlers.current.onOpen?.(new Event("open"));

			for (const listener of listeners.get("open") ?? []) listener(new Event("open"));
		};

		return {
			path: options.path ?? "",
			readyState: 1,
			connectionError: terminalClose,
			call: <T,>(method: string, args: unknown[] = []): Promise<T> => {
				const failure = options.path === undefined || options.path === "" ? socketFailure(method) : null;

				if (failure === null && served !== null && method === "getWorkspaceOpening") {
					const root = document.documentElement.dataset;

					root.galleryOpenings = String(Number(root.galleryOpenings ?? "0") + 1);

					return galleryOpening(served).then((opening) => new Response(opening).json<T>());
				}

				if (failure === null && served !== null) return served<T>(method, args);

				return Promise.reject(failure ?? new Error(`gallery: no fixture serves ${method}`));
			},
			send: () => {},
			addEventListener: (type, listener) => {
				const set = listeners.get(type) ?? new Set<EventListener>();
				set.add(listener);
				listeners.set(type, set);
			},
			removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener); },
			close: () => { listeners.clear(); },
			reopen,
			reconnect: () => {
				const root = document.documentElement.dataset;

				root.galleryRedials = String(Number(root.galleryRedials ?? "0") + 1);

				// A fresh socket reaches the peer a dead one lost.
				if (root.gallerySocket === "dead") delete root.gallerySocket;
				reopen();
			},
			deliver: (raw) => {
				const message = new MessageEvent("message", { data: raw });
				handlers.current.onMessage?.(message);

				for (const listener of listeners.get("message") ?? []) listener(message);
			},
		};
	}, []);

	useEffect(() => {
		if (terminalClose !== null) {
			handlers.current.onClose?.(new CloseEvent("close", {
				code: terminalClose.code,
				reason: terminalClose.reason,
			}));

			return;
		}

		handlers.current.onOpen?.(new Event("open"));
		const reconnect = () => { agent.reopen(); };

		window.addEventListener("gallery-reconnect", reconnect);
		live.add(agent);
		queueMicrotask(() => {
			agent.deliver(JSON.stringify({ type: "cf_agent_chat_messages", messages: seededChats.get(agent.path) ?? [] }));
		});

		return () => {
			live.delete(agent);
			window.removeEventListener("gallery-reconnect", reconnect);
		};
	}, [agent]);

	return agent;
}

/** A send the transport holds: Stop leaves it unsettled, as an abort that lands late; `gallery:settle-send` settles it. */
interface HeldSend {
	readonly settle: ReturnType<typeof Promise.withResolvers<void>>;
	stopped: boolean;
	settled: boolean;
}

const SettleSendSchema = v.object({ at: v.number(), failed: v.optional(v.boolean()) });

/** The held-send DOM values are transport controls only; `useKinu` decides whether presses reach it. */
export function useAgentChat(options: { agent: GalleryAgent }) {
	const [messages, setMessages] = useState<readonly UIMessage[]>(seededChats.get(options.agent.path) ?? []);
	const agent = options.agent;
	const held = useRef<HeldSend[]>([]);
	// An external store, as the SDK's status is: a Stop inside a transition shows at once, not when the transition ends.
	const watchers = useRef(new Set<() => void>());
	const submitted = () => held.current.some((send) => !send.stopped && !send.settled);
	const resync = () => { for (const watcher of watchers.current) watcher(); };

	const status = useSyncExternalStore((watcher) => {
		watchers.current.add(watcher);

		return () => { watchers.current.delete(watcher); };
	}, () => (submitted() ? "submitted" as const : "ready" as const));

	useEffect(() => {
		const settle = (event: Event) => {
			const asked = v.parse(SettleSendSchema, event instanceof CustomEvent ? event.detail : null);
			const send = held.current[asked.at];

			if (send === undefined) return;

			if (asked.failed === true) send.settle.reject(new Error("the gallery transport failed this send"));
			else send.settle.resolve();
		};

		window.addEventListener("gallery:settle-send", settle);

		return () => { window.removeEventListener("gallery:settle-send", settle); };
	}, []);

	useEffect(() => {
		const shown = windows.get(agent.path) ?? new Set();

		windows.set(agent.path, shown.add(setMessages));

		return () => { shown.delete(setMessages); };
	}, [agent.path]);

	useEffect(() => {
		const onMessage = (event: Event) => {
			const frame = v.safeParse(TranscriptFrameSchema, event instanceof MessageEvent
				? v.parse(v.unknown(), JSON.parse(String(event.data)))
				: null);

			if (!frame.success) return;

			if (frame.output.type === "cf_agent_chat_clear") {
				setMessages([]);

				return;
			}

			const named = new Set(frame.output.messages.map((message) => message.id));
			setMessages((current) => current.filter((message) => named.has(message.id)));
		};

		agent.addEventListener("message", onMessage);

		return () => { agent.removeEventListener("message", onMessage); };
	}, [agent]);

	const controls = useMemo(() => ({
		sendMessage: (message: { readonly parts?: readonly { readonly type: string; readonly filename?: string; readonly text?: string }[] }) => {
			const root = document.documentElement;
			root.dataset.galleryChatSends = String(Number(root.dataset.galleryChatSends ?? "0") + 1);
			// What the transport was handed, part by part.
			root.dataset.galleryChatSent = JSON.stringify((message.parts ?? []).map((part) => (part.type === "file" ? `file:${part.filename ?? ""}` : `${part.type}:${part.text ?? ""}`)));

			if (root.dataset.galleryChatHold !== "1") return Promise.resolve();
			const send: HeldSend = { settle: Promise.withResolvers<void>(), stopped: false, settled: false };

			held.current.push(send);
			resync();

			return send.settle.promise.finally(() => {
				send.settled = true;
				resync();
			});
		},
		regenerate: () => Promise.resolve(),
		stop: () => {
			for (const send of held.current) send.stopped = true;
			resync();
		},
		isStreaming: false as const,
		error: undefined,
		connectionError: terminalClose,
	}), []);

	return { ...controls, messages, status };
}
