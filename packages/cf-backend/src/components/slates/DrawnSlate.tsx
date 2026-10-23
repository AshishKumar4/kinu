/**
 * An answer's page the chat draws itself (1023-ac): while its answer streams, the markup written so far; once its block
 * is closed, the page opened as written. No fetch of its own: each frame is a `srcdoc` document on an opaque origin
 * (`DRAWN_SANDBOX`), which reaches nothing of the app's and nothing outside (`drawnPageDocument`). What it calls through
 * `kinu:slate` reaches its workspace over a port this page carries, made as the page itself (`drawnSlateCall`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import * as v from "valibot";
import {
  drawnPageDocument, drawnStreamDocument, DRAWN_SANDBOX, isSlateFrameMessage, SLATE_BRIDGE_MESSAGE, SLATE_DRAW_MESSAGE,
  SLATE_INLINE_HEIGHT_LIMIT, SLATE_PAGE_MODULES_PATH, SlateFrameMessageSchema, type DrawnPageLook, type JsonValue,
  type SlateCallResult,
} from "@kinu.run/core";
import { useTheme } from "@/hooks/use-theme";
import { onSlatePush } from "@/lib/slate-pushes";
import { Effect } from "effect";
import { detach, diagnostics, KinuError, renderThrownChain, settle } from "@kinu.run/core/obs";
import { knownHeight, readThemeTokens, rememberHeight, SlateCard } from "./InlineSlate";

/** An opaque origin, as a sandboxed `srcdoc` frame's messages name theirs. */
const OPAQUE_ORIGIN = "null";

/** The page's look, read off this page: a new theme draws the page again in it. */
function useDrawnLook(): DrawnPageLook {
  const theme = useTheme();

  return useMemo(() => {
    const appOrigin = "location" in globalThis ? location.origin : "";

    return {
      theme: theme.mode,
      variables: "document" in globalThis ? readThemeTokens() : {},
      appOrigin,
      // Written in by the app's build; a render outside it (the landing's prerender) draws no page.
      modules: { base: `${appOrigin}${SLATE_PAGE_MODULES_PATH}`, files: typeof __KINU_SLATE_PAGE_MODULES__ === "undefined" ? {} : __KINU_SLATE_PAGE_MODULES__ },
    };
  }, [theme.mode, theme.name]);
}

/** What the page's `$workspace(path, args)` reaches: its workspace, as the page itself. */
export type DrawnCall = (id: string, request: JsonValue) => Promise<SlateCallResult>;

/** A refused call, thrown in the page as the runner throws one: its reason and its words. */
class SlateRefusal extends Error {
  readonly reason: string;

  constructor(result: { readonly reason: string; readonly error: string }) {
    super(`${result.reason}: ${result.error}`);
    this.name = "SlateRefusal";
    this.reason = result.reason;
  }
}

/** What a page's call answered, or the refusal thrown in the page. */
function answeredIn(result: SlateCallResult): JsonValue {
  if (!result.ok) throw new SlateRefusal({ reason: result.reason, error: result.error });

  return result.value;
}

/** The page's end of its session: `$workspace`, and `$method`, a method of its block's own server (`slate.load()`). */
class DrawnPageTarget extends RpcTarget {
  /** `answering`: the call once the page's answer is stored and its workspace can read the page back. */
  constructor(private readonly id: string, private readonly answering: () => Promise<DrawnCall>) { super(); }

  async $workspace(path: readonly string[], args: readonly JsonValue[]): Promise<JsonValue> {
    return answeredIn(await (await this.answering())(this.id, { path: [...path], args: [...args], invocation: null }));
  }

  async $method(method: string, args: readonly JsonValue[]): Promise<JsonValue> {
    return answeredIn(await (await this.answering())(this.id, { method, args: [...args] }));
  }
}

/** What answers a port this chat does not take: from a document its frame was sent to after the one it wrote, or a
 *  second from the written one. Each call is refused at once, rather than left with no answer. */
class RefusedPage extends RpcTarget {
  $workspace(): Promise<never> {
    return settle(Effect.fail(notTheDrawnPage()));
  }

  $method(): Promise<never> {
    return settle(Effect.fail(notTheDrawnPage()));
  }
}

const notTheDrawnPage = (): KinuError => new KinuError("forbidden", "this frame no longer holds the page the chat drew");

/**
 * Where the page's calls go, as soon as there is one: a page drawn while its answer is still written calls before the
 * workspace holds it, so each call waits for the answer to be stored rather than being dropped (its session's one port
 * is offered once). The latest call answers.
 */
function useAnswering(call: DrawnCall | undefined): () => Promise<DrawnCall> {
  const latest = useRef(call);
  const ready = useRef(Promise.withResolvers<DrawnCall>());

  useEffect(() => {
    latest.current = call;

    if (call !== undefined) ready.current.resolve(call);
  }, [call]);

  return useCallback(async () => latest.current ?? ready.current.promise, []);
}

/** The page's end of its session, as the page offers it: what its server pushes is handed to it. */
type PageEnd = { push(data: JsonValue): Promise<void> } & Disposable;

/** The chat's end of one page document's session, and what it hears for that page. */
interface BridgeEnd {
  readonly port: MessagePort;
  readonly page: PageEnd;
  readonly unheard: () => void;
}

/** The session on `port`, answering as the page `id`, which hears what its server pushes. */
function openEnd(port: MessagePort, id: string, answering: () => Promise<DrawnCall>): BridgeEnd {
  const page = newMessagePortRpcSession<PageEnd>(port, new DrawnPageTarget(id, answering));

  // A page that has closed its end hears no more; nothing waits on what it did with the last.
  const handed = (data: JsonValue): void => detach(Effect.tryPromise({ try: () => page.push(data), catch: (cause) => cause }).pipe(
    Effect.catch((cause) => Effect.sync(() => { diagnostics.event("slate.push_unheard", { page: id, error: renderThrownChain({ cause }) }); })),
  ));

  return { port, page, unheard: onSlatePush(id, handed) };
}

function closeEnd(end: BridgeEnd | null): void {
  if (end === null) return;
  end.unheard();
  end.page[Symbol.dispose]();
  end.port.close();
}

/** A page document this chat wrote, and the nonce it names itself to the chat by. */
interface WrittenPage {
  readonly html: string;
  readonly nonce: string;
}

/**
 * The page's `kinu:slate` session, bound to the document this chat wrote, never to its frame: a frame can be navigated
 * to another document that keeps its window and its opaque origin. The written document's head sends its port with
 * the document's nonce before any of the page's scripts run (`drawnPageDocument`); the first such port is taken, and
 * any other after it is answered by {@link RefusedPage}. The frame's first load is that document; at any later one the
 * frame has gone elsewhere, and the session closes. Calls are made only on the port: no message to this window is ever
 * a call. Answers the frame's load.
 */
function useBridge(frame: RefObject<HTMLIFrameElement | null>, id: string, answering: () => Promise<DrawnCall>, written: WrittenPage | null): () => void {
  const end = useRef<BridgeEnd | null>(null);
  const loads = useRef(0);

  // Listening before the frame's document is parsed: its head speaks first, and a message nobody hears is lost.
  useLayoutEffect(() => {
    if (written === null) return;
    const PortOffer = v.object({ kinu: v.literal(SLATE_BRIDGE_MESSAGE), nonce: v.string() });
    const refused: Disposable[] = [];
    let taken = false;

    loads.current = 0;

    const onMessage = (event: MessageEvent): void => {
      const port = event.ports[0];

      if (event.source !== frame.current?.contentWindow || event.origin !== OPAQUE_ORIGIN || port === undefined || !v.is(PortOffer, event.data)) return;

      if (taken || event.data.nonce !== written.nonce) {
        refused.push(newMessagePortRpcSession<Disposable>(port, new RefusedPage()));

        return;
      }

      taken = true;
      end.current = openEnd(port, id, answering);
    };

    window.addEventListener("message", onMessage);

    return () => {
      window.removeEventListener("message", onMessage);
      closeEnd(end.current);
      end.current = null;

      for (const session of refused) session[Symbol.dispose]();
    };
  }, [frame, id, answering, written]);

  return useCallback(() => {
    loads.current += 1;

    if (loads.current === 1) return;
    closeEnd(end.current);
    end.current = null;
  }, []);
}

/** The height a frame's page last told, from that frame alone. */
function useToldHeight(frame: RefObject<HTMLIFrameElement | null>, id: string): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!isSlateFrameMessage(event, frame.current?.contentWindow ?? null, OPAQUE_ORIGIN)) return;
      const told = Math.min(v.parse(SlateFrameMessageSchema, event.data).height, SLATE_INLINE_HEIGHT_LIMIT);

      rememberHeight(id, told);
      setHeight(told);
    };

    window.addEventListener("message", onMessage);

    return () => window.removeEventListener("message", onMessage);
  }, [frame, id]);

  return height;
}

/** The markup written so far, sent to the streaming frame each time it grows once the frame is ready for it. */
function useStreamed(frame: RefObject<HTMLIFrameElement | null>, html: string, loaded: boolean): void {
  useEffect(() => {
    if (loaded) frame.current?.contentWindow?.postMessage({ kinu: SLATE_DRAW_MESSAGE, html }, "*");
  }, [frame, html, loaded]);
}

const hidden: CSSProperties = { height: 0, visibility: "hidden", position: "absolute" };

/**
 * `closed`: the block's close has been written, so its page is opened as written; until then, its markup so far is
 * drawn. A page opened after a streaming frame stays hidden until it has told its height, so the answer never jumps.
 */
export function DrawnSlate({ id, block, html, closed, call, save }: {
  id: string;
  block: string;
  html: string;
  closed: boolean;
  /** Where the page's calls go; absent where nothing answers them, and every call is refused in the page. */
  call?: DrawnCall;
  /** Once the answer is stored: the page kept as a slate of the workspace. */
  save?: () => Promise<SlateCallResult>;
}) {
  const look = useDrawnLook();
  const stream = useRef<HTMLIFrameElement | null>(null);
  const page = useRef<HTMLIFrameElement | null>(null);
  const [streamed] = useState(!closed);
  const [streamLoaded, setStreamLoaded] = useState(false);
  const streamHeight = useToldHeight(stream, id);
  const pageHeight = useToldHeight(page, id);
  const streamDocument = useMemo(() => drawnStreamDocument(look), [look]);

  const written = useMemo((): WrittenPage | null => {
    if (!closed) return null;
    const nonce = crypto.randomUUID();

    return { nonce, html: drawnPageDocument(html, look, nonce) };
  }, [closed, html, look]);

  const streaming = !closed || (streamed && pageHeight === null);

  const answering = useAnswering(call);
  const pageLoaded = useBridge(page, id, answering, written);

  // A frame opened again (a new theme) takes the markup once more, after its new document has loaded.
  useEffect(() => { setStreamLoaded(false); }, [streamDocument]);
  useStreamed(stream, html, streamLoaded);
  const reserved = streamHeight ?? knownHeight(id);

  return (
    <SlateCard id={id} block={block} save={save}>
      <span className="relative block" style={pageHeight === null && !streaming && reserved !== undefined ? { height: reserved } : undefined}>
        {streaming && (
          <iframe ref={stream} srcDoc={streamDocument} title={id} sandbox={DRAWN_SANDBOX} onLoad={() => setStreamLoaded(true)}
            className="p-slate-frame" style={{ height: streamHeight ?? 0 }} data-slate-drawn="streaming" />
        )}
        {written !== null && (
          // One element per written document, so its first load is that document's.
          <iframe key={written.nonce} ref={page} srcDoc={written.html} title={id} sandbox={DRAWN_SANDBOX} onLoad={pageLoaded}
            className="p-slate-frame" style={pageHeight === null ? hidden : { height: pageHeight }} data-slate-drawn="page" />
        )}
      </span>
    </SlateCard>
  );
}
