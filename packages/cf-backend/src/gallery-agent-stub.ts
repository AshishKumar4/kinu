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
		return () => window.removeEventListener("gallery-reconnect", reconnect);
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
