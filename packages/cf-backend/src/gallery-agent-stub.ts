/**
 * The Agents SDK client, stood in for by the design gallery.
 *
 * `gallery.vite.config.ts` aliases `agents/react` and `@cloudflare/ai-chat/react`
 * here. Page fixtures own their connection through `useKinu`, so this is the
 * one transport seam gallery controls; surface fixtures receive RPC props and
 * need none of it.
 */

import { useEffect, useMemo, useRef } from "react";

interface GalleryConnectionError {
	readonly code: number;
	readonly reason: string;
	readonly message: string;
}

/** A terminal close fixture is SDK-shaped input, not a copied WorkspacePage
 * policy. `useKinu` consumes this same connectionError state in production. */
const terminalClose: GalleryConnectionError | null =
	new URLSearchParams(location.search).get("terminal") === "denied"
		? {
			code: 1008,
			reason: "workspace access denied by fixture",
			message: "workspace access denied by fixture",
		}
		: null;

/** The one method surface `useKinu` uses off the agent connection. */
export interface GalleryAgent {
	readonly readyState: number;
	readonly connectionError: GalleryConnectionError | null;
	call<T>(method: string, args?: unknown[]): Promise<T>;
	send(data: string): void;
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
	close(): void;
	reopen(): void;
	/** A frame the SERVER started. Every other message on this connection
	 *  answers a call the client made, so a broadcast — the only shape a push
	 *  notification has — has no other way in. A fixture that handed `useKinu`
	 *  the parsed value instead would be testing itself: the hook's own schema
	 *  parse, its root-only gate and its de-duplication all live on this edge. */
	deliver(raw: string): void;
}

interface AgentHandlers {
	onOpen?: (event: Event) => void;
	onClose?: (event: CloseEvent) => void;
	onError?: (event: Event) => void;
	onMessage?: (event: MessageEvent) => void;
}

type GalleryRpc = <T>(method: string, args?: unknown[]) => Promise<T>;

/** Installed by `gallery.tsx` before a page frame mounts. Registered rather than
 * imported to avoid the gallery -> page -> hook -> gallery module cycle. */
let served: GalleryRpc | null = null;

export function serveGalleryRpc(rpc: GalleryRpc): void {
	served = rpc;
}

/** Every gallery connection currently open. A push has no client call to
 *  answer, so it cannot be served through `served`: it has to reach the
 *  connections themselves. */
const live = new Set<GalleryAgent>();

/**
 * Make the SERVER speak: deliver one raw frame to every open connection.
 *
 * The fixture stand-in for a frame the server started, which is the only shape
 * a push notification can take — every other message on this transport answers
 * a call the client made. Raw, because handing `useKinu` a parsed value would
 * be the fixture testing itself: the hook's own schema parse, its root-only
 * gate and its de-duplication all live on this edge, and a gate that pushes a
 * frame exercises all three rather than fabricating their result.
 *
 * This edge therefore parses NOTHING. A socket carries bytes, and a fixture
 * that vetted them here could not push the malformed frame the hook's parse
 * exists to reject. The caller is where the shape is established: the gallery
 * builds its announcement through `WorkspacePlanUpdatedFrameSchema`, the same
 * schema the hook parses it back with.
 */
export function galleryServerPush(raw: string): void {
	for (const agent of live) agent.deliver(raw);
}

/**
 * An open connection whose calls resolve out of the frame fixture.
 *
 * Terminal mode deliberately never opens. The SDK error plus the CloseEvent are
 * the real `useKinu` inputs; WorkspacePage remains the terminal-state renderer
 * oracle rather than a gallery copy.
 */
export function useAgent(options: AgentHandlers): GalleryAgent {
	const handlers = useRef(options);
	handlers.current = options;
	const agent = useMemo<GalleryAgent>(() => {
		const listeners = new Map<string, Set<EventListener>>();
		return {
			readyState: 1,
			connectionError: terminalClose,
			call: <T,>(method: string, args: unknown[] = []): Promise<T> => (
				served === null
					? Promise.reject(new Error(`gallery: no fixture serves ${method}`))
					: served<T>(method, args)
			),
			send: () => {},
			addEventListener: (type, listener) => {
				const set = listeners.get(type) ?? new Set<EventListener>();
				set.add(listener);
				listeners.set(type, set);
			},
			removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener); },
			close: () => { listeners.clear(); },
			reopen: () => {
				handlers.current.onClose?.(new CloseEvent("close", { code: 1006 }));
				handlers.current.onOpen?.(new Event("open"));
				for (const listener of listeners.get("open") ?? []) listener(new Event("open"));
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
		// Only an OPEN connection is reachable by a push: the terminal fixture
		// returned above never opens, so it never joins the registry.
		live.add(agent);
		return () => {
			live.delete(agent);
			window.removeEventListener("gallery-reconnect", reconnect);
		};
	}, [agent]);
	return agent;
}

/**
 * `useAgentChat`'s gallery surface. The held-send DOM values are transport
 * controls only: real `useKinu` decides whether same-task presses enter it.
 */
export function useAgentChat(_options: { agent: GalleryAgent }): {
	messages: never[];
	sendMessage: () => Promise<void>;
	regenerate: () => Promise<void>;
	clearHistory: () => void;
	stop: () => void;
	isStreaming: false;
	status: "ready";
	error: undefined;
	connectionError: GalleryConnectionError | null;
} {
	return useMemo(() => ({
		messages: [],
		sendMessage: () => {
			const root = document.documentElement;
			root.dataset.galleryChatSends = String(Number(root.dataset.galleryChatSends ?? "0") + 1);
			if (root.dataset.galleryChatHold !== "1") return Promise.resolve();
			return new Promise<void>(() => {});
		},
		regenerate: () => Promise.resolve(),
		clearHistory: () => {},
		stop: () => {},
		isStreaming: false,
		status: "ready" as const,
		error: undefined,
		connectionError: terminalClose,
	}), []);
}
