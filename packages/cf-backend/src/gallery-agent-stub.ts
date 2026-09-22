/** Gallery stand-in for `agents/react` and `@cloudflare/ai-chat/react` (aliased in `gallery.vite.config.ts`). */

import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import * as v from "valibot";

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
	/** A server-initiated frame, delivered raw so `useKinu`'s own parse and gates run. */
	deliver(raw: string): void;
}

interface AgentHandlers {
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

let seededChat: readonly UIMessage[] = [];

export function seedGalleryChat(messages: readonly UIMessage[]): void {
	seededChat = messages;
}

/** Only ids are read: a walk-back redraw names rows the client already holds and adds none. */
const TranscriptFrameSchema = v.object({
	type: v.literal("cf_agent_chat_messages"),
	messages: v.array(v.looseObject({ id: v.string() })),
});

const live = new Set<GalleryAgent>();

/** Deliver one raw server frame to every open connection; parses nothing, so malformed frames can be pushed. */
export function galleryServerPush(raw: string): void {
	for (const agent of live) agent.deliver(raw);
}

/** A connection whose calls resolve from the frame fixture; terminal mode never opens. */
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
		live.add(agent);

		return () => {
			live.delete(agent);
			window.removeEventListener("gallery-reconnect", reconnect);
		};
	}, [agent]);

	return agent;
}

/** The held-send DOM values are transport controls only; `useKinu` decides whether presses reach it. */
export function useAgentChat(options: { agent: GalleryAgent }) {
	const [messages, setMessages] = useState<readonly UIMessage[]>(seededChat);
	const agent = options.agent;

	useEffect(() => {
		const onMessage = (event: Event) => {
			const frame = v.safeParse(TranscriptFrameSchema, event instanceof MessageEvent
				? v.parse(v.unknown(), JSON.parse(String(event.data)))
				: null);

			if (!frame.success) return;
			const named = new Set(frame.output.messages.map((message) => message.id));
			setMessages((current) => current.filter((message) => named.has(message.id)));
		};

		agent.addEventListener("message", onMessage);

		return () => { agent.removeEventListener("message", onMessage); };
	}, [agent]);

	const controls = useMemo(() => ({
		sendMessage: () => {
			const root = document.documentElement;
			root.dataset.galleryChatSends = String(Number(root.dataset.galleryChatSends ?? "0") + 1);

			if (root.dataset.galleryChatHold !== "1") return Promise.resolve();

			return new Promise<void>(() => {});
		},
		regenerate: () => Promise.resolve(),
		clearHistory: () => { setMessages([]); },
		stop: () => {},
		isStreaming: false as const,
		status: "ready" as const,
		error: undefined,
		connectionError: terminalClose,
	}), []);

	return { ...controls, messages };
}
