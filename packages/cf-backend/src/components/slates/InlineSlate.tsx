import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import type { Rpc, SlateCallResult } from "@kinu.run/core";
import {
  buildSlateHostContext, isPreviewUrl, isSlateFrameMessage, PREVIEW_SANDBOX, slateFrameSrc,
  slateInlineHeight, SLATE_HOST_CONTEXT_MESSAGE, SLATE_THEME_TOKENS,
  SlateFrameMessageSchema,
} from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";
import { useElementSize } from "@/hooks/use-element-size";
import { useTheme } from "@/hooks/use-theme";
import { PreviewChrome } from "@/components/PreviewFrame";
import { SlateInlineContext } from "./context";


const SlatePreviewSchema = v.strictObject({
  url: v.string(),
  port: v.number(),
  inline: v.strictObject({ height: v.number() }),
});

type SlatePreview = v.InferOutput<typeof SlatePreviewSchema>;

/** The theme tokens the host page resolves, mirrored into the slate. Read
 *  inside effects only: `document` does not exist under the static renderer. */
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

/**
 * One slate preview, both surfaces. `display="pane"` is the work surface's
 * full-height frame with the URL chrome; `display="inline"` is the chat card —
 * a slim header and a height the slate itself reports over postMessage.
 */
export function InlineSlate({ id, rpc, display, reloadKey = 0, onReady }: {
  id: string;
  rpc: Rpc;
  display: 'inline' | 'pane';
  /** Bumped when the slate changes, so its preview URL is re-read. */
  reloadKey?: number;
  onReady?: () => void;
}) {
  const openSlate = useContext(SlateInlineContext)?.openSlate;
  const theme = useTheme();
  const { attach, size } = useElementSize();
  const [preview, setPreview] = useState<SlatePreview | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);

  // What the host page knows, rebuilt when anything it holds changes. The
  // iframe src snapshots this object once through `contextRef` (below); from
  // then on the same values go to the frame as postMessages.
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

    const previewUnreachable = <Thrown,>(thrown: Thrown): void => {
      if (live) setRefusal(renderThrownChain({ cause: thrown }));
    };

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
    }).catch(previewUnreachable);

    return () => { live = false; };
  }, [id, rpc, display, reloadKey, onReady]);

  const previewOrigin = useMemo(() => (preview === null ? null : new URL(preview.url).origin), [preview]);
  // The src is a point-in-time snapshot of the context — recomputing it on a
  // theme flip would reload the slate, which is exactly what postMessage is
  // for. It is derived the moment a preview exists and stays until the
  // preview itself changes.

  const src = useMemo(
    () => (preview === null ? null : slateFrameSrc(preview.url, contextRef.current)),
    [preview],
  );

  // Push later context — a theme flip, a width change — into the live frame.
  // The frame's own `load` marks its window navigated to the preview origin;
  // posting before then targets about:blank and the browser throws.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => setLoaded(false), [src]);

  useEffect(() => {
    const window_ = frame.current?.contentWindow;

    if (previewOrigin === null || window_ == null || !loaded) return;
    window_.postMessage({ kinu: SLATE_HOST_CONTEXT_MESSAGE, context }, previewOrigin);
  }, [context, previewOrigin, loaded]);

  // The slate reports its own content height; the inline card follows it
  // inside the schema's band, the pane ignores it entirely.
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

  const content = src === null ? null : !isPreviewUrl(previewUrl ?? '') ? (
    // The only gate on what this frame renders, same as PreviewFrame's.
    <div className="flex-1 flex items-center justify-center p-4 text-center">
      <span className="p-annotation p-text-3 break-all">
        Refused to preview a URL that is not a Kinu preview: {previewUrl}
      </span>
    </div>
  ) : (
    <iframe
      ref={frame}
      src={src}
      title={id}
      onLoad={() => setLoaded(true)}
      className={pane ? 'p-bg flex-1 min-h-0 w-full border-0' : 'p-bg w-full border-0'}
      style={pane ? undefined : { height: height ?? 320, transition: 'height 160ms ease-out' }}
      sandbox={PREVIEW_SANDBOX}
    />
  );

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

  // Every element here is a span (block/flex by class): the card renders inside
  // the markdown paragraph, and a <div> under <p> trips React's dev validator.
  return (
    <span ref={attach} data-slate-inline={id} className="block my-2 overflow-hidden rounded-lg border p-border p-fill">
      <span className="flex items-center gap-1.5 px-3 py-1.5 border-b p-border">
        <code className="p-annotation p-text-3 truncate flex-1">{id}</code>
        {openSlate !== undefined && (
          <button type="button" onClick={() => openSlate(id)}
            className="p-text-3 hover:p-text p-1 shrink-0 inline-flex" title="Open in the work surface">
            <ArrowSquareOutIcon size={11} />
          </button>
        )}
      </span>
      {refusal !== null && (
        <span className="block p-notice-danger px-3 py-2 text-xs">
          <span className="block break-words m-0">{refusal}</span>
        </span>
      )}
      {content === null && refusal === null && (
        <span className="flex justify-center py-8"><Loader /></span>
      )}
      {content}
    </span>
  );
}
