/**
 * An answer's page the chat draws itself (1023-ac): while its answer streams, the markup written so far; once its block
 * is closed, the page opened as written. No fetch of its own: each frame is a `srcdoc` document on an opaque origin
 * (`DRAWN_SANDBOX`), which reaches nothing of the app's and nothing outside (`drawnPageDocument`). What it calls through
 * `kinu:slate` reaches its workspace over a port this page carries, made as the page itself (`drawnSlateCall`).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
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
import { detach, diagnostics, renderThrownChain } from "@kinu.run/core/obs";
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
  constructor(private readonly id: string, private readonly call: DrawnCall) { super(); }

  async $workspace(path: readonly string[], args: readonly JsonValue[]): Promise<JsonValue> {
    return answeredIn(await this.call(this.id, { path: [...path], args: [...args], invocation: null }));
  }

  async $method(method: string, args: readonly JsonValue[]): Promise<JsonValue> {
    return answeredIn(await this.call(this.id, { method, args: [...args] }));
  }
}

/** The page's end of its session, as the page offers it: what its server pushes is handed to it. */
type PageEnd = { push(data: JsonValue): Promise<void> } & Disposable;

/** The page's `kinu:slate` session, carried on the port the page frame alone sends, for as long as that frame stands;
 *  what its server pushes reaches it on the same session. */
function useBridge(frame: RefObject<HTMLIFrameElement | null>, id: string, call: DrawnCall | undefined, document: string | null): void {
  useEffect(() => {
    if (call === undefined || document === null) return;
    const ends: { readonly port: MessagePort; readonly page: PageEnd; readonly unheard: () => void }[] = [];

    const onMessage = (event: MessageEvent): void => {
      const port = event.ports[0];

      if (event.source !== frame.current?.contentWindow || event.origin !== OPAQUE_ORIGIN || port === undefined) return;

      if (!v.is(v.object({ kinu: v.literal(SLATE_BRIDGE_MESSAGE) }), event.data)) return;
      const page = newMessagePortRpcSession<PageEnd>(port, new DrawnPageTarget(id, call));

      // A page that has closed its end hears no more; nothing waits on what it did with the last.
      const handed = (data: JsonValue): void => detach(Effect.tryPromise({ try: () => page.push(data), catch: (cause) => cause }).pipe(
        Effect.catch((cause) => Effect.sync(() => { diagnostics.event("slate.push_unheard", { page: id, error: renderThrownChain({ cause }) }); })),
      ));

      ends.push({ port, page, unheard: onSlatePush(id, handed) });
    };

    window.addEventListener("message", onMessage);

    return () => {
      window.removeEventListener("message", onMessage);

      for (const end of ends) {
        end.unheard();
        end.page[Symbol.dispose]();
        end.port.close();
      }
    };
  }, [frame, id, call, document]);
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
  const pageDocument = useMemo(() => (closed ? drawnPageDocument(html, look) : null), [closed, html, look]);
  const streaming = !closed || (streamed && pageHeight === null);

  useBridge(page, id, call, pageDocument);

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
        {pageDocument !== null && (
          <iframe ref={page} srcDoc={pageDocument} title={id} sandbox={DRAWN_SANDBOX}
            className="p-slate-frame" style={pageHeight === null ? hidden : { height: pageHeight }} data-slate-drawn="page" />
        )}
      </span>
    </SlateCard>
  );
}
