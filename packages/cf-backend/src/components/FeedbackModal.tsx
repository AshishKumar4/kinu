/** Wrapped in `data-feedback-omit` so the capture omits this dialog. A failed send keeps the capture; nothing retries automatically. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ArrowCounterClockwiseIcon, CameraIcon, MegaphoneIcon, RectangleIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "./ui/FilledButton";
import { Modal } from "./ui/Modal";
import { inputCls } from "./ui/form";
import { diagnostics, renderThrownChain, toKinuError, tolerateAsync } from "@kinu.run/core/obs";
import * as v from "valibot";
import {
  capturePage,
  flatten,
  paint,
  tooLarge,
  type Annotation,
  type Capture,
} from "@/feedback/capture";
import {
  FEEDBACK_ENDPOINT,
  FEEDBACK_FIELDS,
  FEEDBACK_MAX_NOTE_CHARS,
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_OMIT_ATTR,
  FEEDBACK_SCREENSHOT_TYPE,
} from "@kinu.run/core";

const FeedbackReplySchema = v.object({
  id: v.optional(v.string()),
  error: v.optional(v.string()),
});

const WORKSPACE_ROUTES: Readonly<Record<string, true>> = Object.freeze({
  workspace: true, mcts: true, settings: true, triggers: true,
});

function workspaceOf(pathname: string): string {
  const [head, name] = pathname.replace(/^\/+/, "").split("/");

  return head !== undefined && WORKSPACE_ROUTES[head] === true && name !== undefined ? name : "";
}

type ShotState =
  | { phase: "off" }
  | { phase: "capturing" }
  | { phase: "ready"; capture: Capture }
  | { phase: "failed"; reason: string };

type SendState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; id: string }
  | { phase: "failed"; reason: string };

function sendLabel(phase: SendState["phase"]): string {
  if (phase === "sending") return "Sending…";

  if (phase === "failed") return "Retry";

  return "Send";
}

export function FeedbackModal({ onClose }: { onClose: () => void }) {
  const location = useLocation();
  const [note, setNote] = useState("");
  const [wanted, setWanted] = useState(true);
  const [shot, setShot] = useState<ShotState>({ phase: "capturing" });
  const [send, setSend] = useState<SendState>({ phase: "idle" });
  const [tool, setTool] = useState<Annotation["kind"]>("box");
  const [marks, setMarks] = useState<Annotation[]>([]);

  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const captureGeneration = useRef(0);

  const take = useCallback(() => {
    const generation = ++captureGeneration.current;
    setShot({ phase: "capturing" });
    setMarks([]);

    const captureFailed = (...rejection: [unknown]): void => {
      const [thrown] = rejection;

      diagnostics.failure("feedback.capture_failed", toKinuError({
        doing: "capture the page for a feedback report", cause: thrown, otherwise: "unsupported",
      }));

      if (generation === captureGeneration.current) {
        setShot({ phase: "failed", reason: renderThrownChain({ cause: thrown }) });
      }
    };

    // Wait one frame so the dialog paints before the clone; otherwise the page is captured mid-reflow.
    requestAnimationFrame(() => {
      if (generation !== captureGeneration.current) return;
      void capturePage().then(
        (capture) => {
          if (generation !== captureGeneration.current) return;
          setShot(tooLarge(capture.blob.size)
            ? {
              phase: "failed",
              reason: `it came to ${String(Math.ceil(capture.blob.size / (1024 * 1024)))} MiB, over the ${String(FEEDBACK_MAX_SCREENSHOT_BYTES >> 20)} MiB limit. Narrow the window and retake it`,
            }
            : { phase: "ready", capture });
        },
        captureFailed,
      );
    });
  }, []);

  useEffect(() => {
    if (wanted) take();
    else setShot({ phase: "off" });

    return () => { captureGeneration.current += 1; };
  }, [wanted, take]);

  // Decode once per capture; re-decoding per mark delays the repaint.
  useEffect(() => {
    if (shot.phase !== "ready") {
      setBitmap((current) => {
        current?.close();

        return null;
      });

      return;
    }

    let live = true;

    const decodeFailed = (...rejection: [unknown]): void => {
      const [thrown] = rejection;

      diagnostics.failure("feedback.decode_failed", toKinuError({
        doing: "decode the captured screenshot for preview", cause: thrown, otherwise: "bad_input",
      }));

      if (live) setShot({ phase: "failed", reason: renderThrownChain({ cause: thrown }) });
    };

    void createImageBitmap(shot.capture.blob).then((decoded) => {
      if (!live) {
        decoded.close();

        return;
      }

      setBitmap((current) => {
        current?.close();

        return decoded;
      });
    }, decodeFailed);

    return () => { live = false; };
  }, [shot]);

  // The canvas is sized to the image and CSS-scaled, so mark coordinates are image coordinates.
  useEffect(() => {
    const canvas = canvasRef.current;

    if (bitmap === null || canvas === null) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");

    if (context === null) return;
    paint(context, bitmap, marks, { width: bitmap.width, height: bitmap.height });
    // Signals the paint so readers (browser gates) can tell drawn from merely mounted.
    canvas.dataset.feedbackPainted = String(marks.length);
  }, [bitmap, marks]);

  const at = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const box = canvas.getBoundingClientRect();

    return {
      x: Math.round((event.clientX - box.left) * (canvas.width / box.width)),
      y: Math.round((event.clientY - box.top) * (canvas.height / box.height)),
    };
  }, []);

  const onDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = at(event);
  }, [at]);

  const onUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const from = dragRef.current;
    dragRef.current = null;

    if (from === null) return;
    const to = at(event);

    const mark: Annotation = {
      kind: tool,
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      w: Math.abs(to.x - from.x),
      h: Math.abs(to.y - from.y),
    };

    if (mark.w < 6 || mark.h < 6) return;
    setMarks((current) => [...current, mark]);
  }, [at, tool]);

  const onMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const from = dragRef.current;
    const canvas = canvasRef.current;

    if (from === null || bitmap === null || canvas === null) return;
    const context = canvas.getContext("2d");

    if (context === null) return;
    const to = at(event);
    paint(context, bitmap, [...marks, {
      kind: tool,
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      w: Math.abs(to.x - from.x),
      h: Math.abs(to.y - from.y),
    }], { width: canvas.width, height: canvas.height });
  }, [at, bitmap, marks, tool]);

  const trimmed = note.trim();
  const ready = shot.phase === "ready";
  const sending = send.phase === "sending";
  const sendable = (trimmed.length > 0 || ready) && !sending && shot.phase !== "capturing";

  // Under StrictMode this cleanup runs once at mount with nothing in flight.
  useEffect(() => () => { inFlight.current?.abort(); }, []);

  const submit = useCallback(() => {
    setSend({ phase: "sending" });
    // A fresh handle per attempt so a replaced request cannot answer for Retry.
    const attempt = new AbortController();
    inFlight.current = attempt;

    const sendFailed = (...rejection: [unknown]): void => {
      const [thrown] = rejection;

      // An abort is user-initiated, not a failure to record.
      if (attempt.signal.aborted) return;
      diagnostics.failure("feedback.send_failed", toKinuError({
        doing: "send a feedback report", cause: thrown, otherwise: "io",
      }));
      setSend({ phase: "failed", reason: renderThrownChain({ cause: thrown }) });
    };

    const form = new FormData();
    form.set(FEEDBACK_FIELDS.note, trimmed);
    form.set(FEEDBACK_FIELDS.route, location.pathname);
    form.set(FEEDBACK_FIELDS.workspace, workspaceOf(location.pathname));
    form.set(FEEDBACK_FIELDS.annotated, marks.length > 0 ? "1" : "0");

    const attach = shot.phase === "ready"
      ? flatten(shot.capture, marks).then((blob) => {
        if (tooLarge(blob.size)) {
          throw new Error(`the annotated screenshot is ${String(Math.ceil(blob.size / (1024 * 1024)))} MiB, over the ${String(FEEDBACK_MAX_SCREENSHOT_BYTES >> 20)} MiB limit`);
        }

        form.set(FEEDBACK_FIELDS.screenshot, new File([blob], "feedback.png", { type: FEEDBACK_SCREENSHOT_TYPE }));
      })
      : Promise.resolve();

    void attach
      .then(() => fetch(FEEDBACK_ENDPOINT, { method: "POST", body: form, signal: attempt.signal }))
      .then(async (response) => {
        // A non-endpoint body (e.g. proxy HTML) parses to {}; the status then carries the failure.
        const parsed = v.safeParse(
          FeedbackReplySchema,
          await tolerateAsync(() => response.json(), 'malformed-input'),
        );

        const reply = parsed.success ? parsed.output : {};

        if (!response.ok) {
          throw new Error(reply.error ?? `the server answered ${String(response.status)}`);
        }

        setSend({ phase: "sent", id: reply.id ?? "" });
      })
      .catch(sendFailed);
  }, [location.pathname, marks, shot, trimmed]);

  const stop = useCallback(() => {
    inFlight.current?.abort();
    setSend({ phase: "failed", reason: "you stopped it" });
  }, []);

  if (send.phase === "sent") {
    return (
      <div {...{ [FEEDBACK_OMIT_ATTR]: "1" }}>
        <Modal title="Feedback sent" onClose={onClose} icon={<MegaphoneIcon size={16} className="p-accent" />}
          footer={<FilledButton onClick={onClose} data-feedback-done>Done</FilledButton>}>
          <p className="text-sm p-text-2" data-feedback-sent={send.id}>
            Thank you. Your report is with us{send.id.length > 0 ? ` as ${send.id.slice(0, 8)}` : ""}.
          </p>
        </Modal>
      </div>
    );
  }

  return (
    <div {...{ [FEEDBACK_OMIT_ATTR]: "1" }}>
      <Modal
        title="Send feedback"
        onClose={onClose}
        busy={sending}
        maxWidthClass="max-w-2xl"
        icon={<MegaphoneIcon size={16} className="p-accent" />}
        footer={
          <>
            {/* Never disabled: aborts the POST in flight, otherwise closes the dialog. */}
            <Button type="button" variant="ghost" size="sm"
              onClick={sending ? stop : onClose} data-feedback-cancel={sending ? "stop" : "close"}>
              {sending ? "Stop" : "Cancel"}
            </Button>
            <FilledButton onClick={submit} disabled={!sendable} data-feedback-send>
              {sendLabel(send.phase)}
            </FilledButton>
          </>
        }
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium p-text-2">What happened?</span>
          <textarea
            autoFocus
            rows={4}
            value={note}
            maxLength={FEEDBACK_MAX_NOTE_CHARS}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What you expected, and what happened instead."
            className={`${inputCls} resize-y`}
            data-feedback-note
          />
        </label>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm p-text-2">
            <input
              type="checkbox"
              checked={wanted}
              onChange={(event) => setWanted(event.target.checked)}
              data-feedback-include-shot
            />
            <CameraIcon size={15} />
            <span>Include a screenshot of this page</span>
          </label>

          {shot.phase === "capturing" && (
            <p className="text-xs p-text-3" data-feedback-shot="capturing">Taking the screenshot…</p>
          )}

          {shot.phase === "failed" && (
            <p className="text-xs p-warn" data-feedback-shot="failed">
              No screenshot: {shot.reason}. Your note can still be sent on its own.
            </p>
          )}

          {ready && (
            <div className="space-y-2" data-feedback-shot="ready">
              <div className="flex flex-wrap items-center gap-1.5">
                <Button type="button" size="sm" variant={tool === "box" ? "secondary" : "ghost"}
                  onClick={() => setTool("box")} data-feedback-tool="box">
                  <RectangleIcon size={14} /> Box
                </Button>
                <Button type="button" size="sm" variant={tool === "hide" ? "secondary" : "ghost"}
                  onClick={() => setTool("hide")} data-feedback-tool="hide">
                  <EyeSlashIcon size={14} /> Hide
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={marks.length === 0}
                  onClick={() => setMarks((current) => current.slice(0, -1))} data-feedback-undo>
                  Undo
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={take} data-feedback-retake>
                  <ArrowCounterClockwiseIcon size={14} /> Retake
                </Button>
                <span className="ml-auto p-meta p-text-3" data-feedback-shot-meta={String(shot.capture.redacted)}>
                  {shot.capture.width}×{shot.capture.height}
                  {shot.capture.redacted > 0
                    ? ` · ${String(shot.capture.redacted)} field${shot.capture.redacted === 1 ? "" : "s"} hidden`
                    : ""}
                </span>
              </div>
              <canvas
                ref={canvasRef}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                className="block w-full cursor-crosshair rounded-md border p-border touch-none"
                data-feedback-canvas
              />
              <p className="p-meta p-text-3">
                Drag on the image to {tool === "hide" ? "cover something" : "draw a box"}.
              </p>
            </div>
          )}
        </div>

        {send.phase === "failed" && (
          <p className="text-xs p-warn" data-feedback-error>
            Not sent: {send.reason}. Your note and screenshot are still here, so you can retry.
          </p>
        )}

        <p className="p-meta p-text-3" data-feedback-consent>
          Sending shares your note, the page address, your account email, and the screenshot if you
          include one. Password fields are blacked out before upload. Use{" "}
          <span className="p-text-2">Hide</span> for anything else.
        </p>
      </Modal>
    </div>
  );
}
