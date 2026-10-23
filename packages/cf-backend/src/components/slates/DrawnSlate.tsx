/**
 * An answer's page the chat draws itself (1023-ac): while its answer streams, the markup written so far; once its block
 * is closed, the page opened as written. No process and no fetch: each frame is a `srcdoc` document on an opaque origin
 * (`DRAWN_SANDBOX`), which reaches nothing of the app's and nothing outside (`drawnPageDocument`).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import * as v from "valibot";
import {
  drawnPageDocument, drawnStreamDocument, DRAWN_SANDBOX, isSlateFrameMessage, SLATE_DRAW_MESSAGE, SLATE_INLINE_HEIGHT_LIMIT,
  SlateFrameMessageSchema, type DrawnPageLook, type SlateCallResult,
} from "@kinu.run/core";
import { useTheme } from "@/hooks/use-theme";
import { knownHeight, readThemeTokens, rememberHeight, SlateCard } from "./InlineSlate";

/** An opaque origin, as a sandboxed `srcdoc` frame's messages name theirs. */
const OPAQUE_ORIGIN = "null";

/** The page's look, read off this page: a new theme draws the page again in it. */
function useDrawnLook(): DrawnPageLook {
  const theme = useTheme();

  return useMemo(() => ({
    theme: theme.mode,
    variables: "document" in globalThis ? readThemeTokens() : {},
    appOrigin: "location" in globalThis ? location.origin : "",
  }), [theme.mode, theme.name]);
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
export function DrawnSlate({ id, block, html, closed, save }: {
  id: string;
  block: string;
  html: string;
  closed: boolean;
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
