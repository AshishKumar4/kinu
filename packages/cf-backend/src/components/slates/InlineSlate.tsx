import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { ArrowSquareOutIcon, CaretRightIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import type { Rpc, SlateCallResult } from "@kinu.run/core";
import {
  buildSlateHostContext, isPreviewUrl, isSlateFrameMessage, PREVIEW_SANDBOX, slateFrameSrc,
  slateInlineHeight, SLATE_HOST_CONTEXT_MESSAGE, SLATE_THEME_TOKENS,
  SlateFrameMessageSchema,
} from "@kinu.run/core";
import { useElementSize } from "@/hooks/use-element-size";
import { useTheme } from "@/hooks/use-theme";
import { PreviewChrome } from "@/components/PreviewFrame";
import { SlateInlineContext, SlatePreviews } from "./context";
import { showRejection } from "@/hooks/use-async-resource";


const SlatePreviewSchema = v.strictObject({
  url: v.string(),
  port: v.number(),
  inline: v.strictObject({ height: v.number() }),
});

type SlatePreview = v.InferOutput<typeof SlatePreviewSchema>;

/** Read inside effects only: `document` does not exist under the static renderer. */
function readThemeTokens() {
  const styles = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};

  for (const name of SLATE_THEME_TOKENS) {
    const value = styles.getPropertyValue(name).trim();

    if (value !== '') variables[name] = value;
  }

  return variables;
}

const browserOrigin = (): string =>
  'window' in globalThis && window.location !== undefined ? window.location.origin : '';

/** In the chat, a preview folds behind a later one of its slate, and while the panel shows it. */
export function ChatSlates({ shownInPanel, children }: { shownInPanel: string | null; children: ReactNode }) {
  const inline = useContext(SlateInlineContext);
  const [previews] = useState(() => new SlatePreviews());
  const value = useMemo(() => (inline === null ? null : { ...inline, chat: { previews, shownInPanel } }), [inline, previews, shownInPanel]);

  return <SlateInlineContext.Provider value={value}>{children}</SlateInlineContext.Provider>;
}

const UNLISTED = (): (() => void) => () => {};

/** False until the card's first frame is on screen: a card that mounts folded must not fold in view. */
function usePainted(): boolean {
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setPainted(true)); });

    return () => cancelAnimationFrame(frame);
  }, []);

  return painted;
}

function SlateCard({ id, measure, children }: { id: string; measure: Ref<HTMLSpanElement>; children: ReactNode }) {
  const inline = useContext(SlateInlineContext);
  const previews = inline?.chat?.previews;
  const [card, setCard] = useState<HTMLSpanElement | null>(null);
  const body = useId();
  const painted = usePainted();

  const register = useCallback((element: HTMLSpanElement | null) => {
    setCard(element);
    const remove = element === null ? undefined : previews?.add(id, element);

    return () => remove?.();
  }, [previews, id]);

  const superseded = useSyncExternalStore(previews?.subscribe ?? UNLISTED, () => previews?.superseded(id, card) ?? false, () => false);
  const inPanel = inline?.chat?.shownInPanel === id;
  const auto = superseded || inPanel;
  // A fold set by hand holds until the reason for the automatic one clears.
  const [hand, setHand] = useState<boolean | null>(null);
  const [reason, setReason] = useState(auto);

  if (reason !== auto) {
    setReason(auto);

    if (!auto) setHand(null);
  }

  const folded = hand ?? auto;
  const openSlate = inline?.openSlate;
  let why: string | null = null;

  if (folded && auto) why = superseded ? "Updated below" : "Shown in the work surface";

  // Spans only: the card renders inside a markdown <p>, where a <div> trips React's dev validator.
  return (
    <span ref={measure} data-slate-inline={id} data-fold-still={painted ? undefined : ""} className="block my-2 overflow-hidden rounded-lg border p-border p-fill">
      <span ref={register} className="flex items-center gap-1 py-1 pl-1.5 pr-1">
        <button type="button" onClick={() => setHand(!folded)} aria-expanded={!folded} aria-controls={body}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--c-elevated)]">
          <CaretRightIcon size={10} weight="bold" className={`shrink-0 p-text-4 p-fold-turn ${folded ? "" : "rotate-90"}`} />
          <code className="p-annotation p-text-3 truncate">{id}</code>
          {why !== null && <span className="ml-auto shrink-0 pl-2 p-meta p-text-4">{why}</span>}
        </button>
        {openSlate !== undefined && (
          <button type="button" onClick={() => openSlate(id)} aria-label={`Open ${id} in the work surface`} title="Open in the work surface"
            className="p-text-3 hover:p-text p-1 shrink-0 inline-flex rounded-md transition-colors hover:bg-[var(--c-elevated)]">
            <ArrowSquareOutIcon size={11} />
          </button>
        )}
      </span>
      <span id={body} className="p-fold" data-folded={folded ? "" : undefined} inert={folded}>
        <span><span className="block border-t p-border">{children}</span></span>
      </span>
    </span>
  );
}

export function InlineSlate({ id, rpc, display, reloadKey = 0, onReady }: {
  id: string;
  rpc: Rpc;
  display: 'inline' | 'pane';
  reloadKey?: number;
  onReady?: () => void;
}) {
  const theme = useTheme();
  const { attach, size } = useElementSize();
  const [preview, setPreview] = useState<SlatePreview | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  // The iframe src snapshots this once via `contextRef`; later values go over postMessage.
  const context = useMemo(() => buildSlateHostContext({
    theme: theme.mode,
    variables: 'document' in globalThis ? readThemeTokens() : {},
    width: size.w,
    display,
    origin: browserOrigin(),
  }), [theme.mode, size.w, display]);

  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    let live = true;
    setPreview(null);
    setRefusal(null);
    setHeight(null);

    void rpc<SlateCallResult>("previewSlate", [id]).then((result) => {
      if (!live) return;

      if (!result.ok) {
        setRefusal(`${result.reason}: ${result.error}`);

        return;
      }

      const parsed = v.safeParse(SlatePreviewSchema, result.value);

      if (!parsed.success) {
        setRefusal(`The Slate "${id}" answered an invalid preview URL.`);

        return;
      }

      setPreview(parsed.output);

      if (display === 'inline') setHeight(slateInlineHeight(parsed.output.inline.height));

      onReady?.();
    }).catch(showRejection(setRefusal, () => live));

    return () => { live = false; };
  }, [id, rpc, display, reloadKey, onReady]);

  const previewOrigin = useMemo(() => (preview === null ? null : new URL(preview.url).origin), [preview]);
  // The src is a snapshot; recomputing it on a theme flip would reload the slate.

  const src = useMemo(
    () => (preview === null ? null : slateFrameSrc(preview.url, contextRef.current)),
    [preview],
  );

  // Post only after the frame's `load`: before it the target is about:blank and the browser throws.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => setLoaded(false), [src]);

  useEffect(() => {
    const window_ = frame.current?.contentWindow;

    if (previewOrigin === null || window_ == null || !loaded) return;
    window_.postMessage({ kinu: SLATE_HOST_CONTEXT_MESSAGE, context }, previewOrigin);
  }, [context, previewOrigin, loaded]);

  useEffect(() => {
    if (display !== 'inline' || previewOrigin === null) return;

    const onMessage = (event: MessageEvent): void => {
      if (!isSlateFrameMessage(event, frame.current?.contentWindow ?? null, previewOrigin)) return;
      const message = v.parse(SlateFrameMessageSchema, event.data);
      setHeight(slateInlineHeight(message.height));
    };

    window.addEventListener('message', onMessage);

    return () => window.removeEventListener('message', onMessage);
  }, [display, previewOrigin]);

  const pane = display === 'pane';
  const previewUrl = preview?.url;

  let content: ReactNode = null;

  if (src !== null) {
    // The only gate on what this frame renders, same as PreviewFrame's.
    content = isPreviewUrl(previewUrl ?? '') ? (
      <iframe
        ref={frame}
        src={src}
        title={id}
        onLoad={() => setLoaded(true)}
        className={pane ? 'p-bg flex-1 min-h-0 w-full border-0' : 'p-bg w-full border-0 p-fold-frame'}
        style={pane ? undefined : { height: height ?? 320 }}
        sandbox={PREVIEW_SANDBOX}
      />
    ) : (
      <div className="flex-1 flex items-center justify-center p-4 text-center">
        <span className="p-annotation p-text-3 break-all">
          Refused to preview a URL that is not a Kinu preview: {previewUrl}
        </span>
      </div>
    );
  }

  if (pane) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {refusal !== null && (
          <div className="p-notice-danger rounded-lg px-3 py-2 text-xs">
            <p className="break-words m-0">{refusal}</p>
          </div>
        )}
        {content === null && refusal === null && (
          <div className="flex justify-center py-16"><Loader /></div>
        )}
        {content !== null && src !== null && (
          <div key={reloadKey} className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <PreviewChrome url={previewUrl ?? src} />
            {content}
          </div>
        )}
      </div>
    );
  }

  return (
    <SlateCard id={id} measure={attach}>
      {refusal !== null && (
        <span className="block p-notice-danger px-3 py-2 text-xs">
          <span className="block break-words m-0">{refusal}</span>
        </span>
      )}
      {content === null && refusal === null && (
        <span className="flex justify-center py-8"><Loader /></span>
      )}
      {content}
    </SlateCard>
  );
}
