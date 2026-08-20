/**
 * The Agents SDK client, stood in for by the design gallery.
 *
 * `gallery.vite.config.ts` aliases `agents/react` and `@cloudflare/ai-chat/react`
 * here, the same way it aliases `node:crypto` to `gallery-node-stubs.ts`. It sits
 * inside `src` rather than beside that file because the gallery IMPORTS
 * `serveGalleryRpc` from it by path, and `gate:capability-parity` reads a local
 * import that resolves outside the tracked source set as a module with no
 * dependencies at all — which would report the gallery as movable when it is not. Frames that mount a SURFACE are
 * handed an `Rpc` as a prop and need none of this; frames that mount a PAGE are
 * not — a page owns its own connection through `useProteus`, so without a stand-in
 * for the socket there is no seam a fixture can reach at all.
 *
 * That is not hypothetical. `?frame=forkfull`, `?frame=forkbig` and
 * `?frame=forkswarmfull` all mount `MCTSExplorer`, all opened a real WebSocket to
 * a vite dev server that is not a Worker, and all rendered a blank body — while
 * `scripts/computed-style.ts` listed `forkfull` among the frames it audits and
 * reported clean over the empty document.
 *
 * A stand-in for the transport, and nothing more. It answers RPC out of the same
 * fixture stores the surface frames read, reports one open connection, and holds
 * no chat: what the pages under test draw is trees and panels, and a socket that
 * pushed fabricated broadcasts would photograph a product nobody shipped.
 */

import { useEffect, useMemo, useRef } from "react";

/** The one method surface `useProteus` uses off the agent connection. */
export interface GalleryAgent {
	readonly readyState: number;
	call<T>(method: string, args?: unknown[]): Promise<T>;
	send(data: string): void;
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
	close(): void;
}

interface AgentHandlers {
	onOpen?: (event: Event) => void;
	onClose?: (event: CloseEvent) => void;
	onError?: (event: Event) => void;
	onMessage?: (event: MessageEvent) => void;
}

type GalleryRpc = <T>(method: string, args?: unknown[]) => Promise<T>;

/**
 * The fixture the stub answers from, installed by `src/gallery.tsx` before it
 * mounts anything.
 *
 * Registered rather than imported: the stub stands in for a module the app
 * imports, so importing the gallery back would close the cycle
 * `gallery -> page -> use-proteus -> agents/react -> gallery`, and
 * `import/no-cycle` is an error at zero across this repo.
 */
let served: GalleryRpc | null = null;

export function serveGalleryRpc(rpc: GalleryRpc): void {
	served = rpc;
}

/**
 * An open connection whose calls resolve out of the fixture.
 *
 * A call made before a fixture is installed REJECTS with the reason. Answering
 * it with `[]` or leaving it pending are the two shapes that made the blank
 * frames unreadable — one renders a lie, the other an eternal spinner — and this
 * file exists because both of them survived in a green gate.
 */
export function useAgent(options: AgentHandlers): GalleryAgent {
	const handlers = useRef(options);
	handlers.current = options;
	const agent = useMemo<GalleryAgent>(() => {
		const listeners = new Map<string, Set<EventListener>>();
		return {
			readyState: 1,
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
		};
	}, []);
	// One open, on mount. `useProteus` gates its whole snapshot fetch on the
	// connected status, so a stub that never opens is a stub that never loads.
	useEffect(() => { handlers.current.onOpen?.(new Event("open")); }, []);
	return agent;
}

/** `useAgentChat`'s surface, with no conversation behind it. The pages this
 *  file exists for draw trees and panels; the chat frames use the real
 *  component with fixture messages passed in. */
export function useAgentChat(_options: { agent: GalleryAgent }): {
	messages: never[];
	sendMessage: () => Promise<void>;
	regenerate: () => Promise<void>;
	clearHistory: () => void;
	stop: () => void;
	isStreaming: false;
	error: undefined;
} {
	return useMemo(() => ({
		messages: [],
		sendMessage: () => Promise.resolve(),
		regenerate: () => Promise.resolve(),
		clearHistory: () => {},
		stop: () => {},
		isStreaming: false,
		error: undefined,
	}), []);
}
