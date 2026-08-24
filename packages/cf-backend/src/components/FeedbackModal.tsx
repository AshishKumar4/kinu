/**
 * Send-feedback dialog: a note, an optional annotated screenshot of the page
 * the reporter was looking at, and one POST.
 *
 * The capture runs while this dialog is already on screen, which is why the
 * whole thing sits under `data-feedback-omit`: the clone hook removes those
 * nodes, so the shot shows the page underneath rather than the dialog covering
 * it. That is also what makes Retake work after annotating.
 *
 * A FAILED SEND KEEPS THE CAPTURE. The bytes stay in this component's state and
 * the reporter gets a Retry button — nothing retries on its own. An automatic
 * retry of a request that may already have written a row is how one report
 * becomes three, and a report is not worth losing a reporter's trust over.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ArrowCounterClockwiseIcon, CameraIcon, MegaphoneIcon, RectangleIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "./ui/FilledButton";
import { Modal } from "./ui/Modal";
import { inputCls } from "./ui/form";
import { renderThrownChain, tolerateAsync } from "@kinu.run/core/obs";
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
} from "@/feedback/contract";

/** What `POST /api/feedback` answers with, either way. Both fields optional
 *  because exactly one arrives, and a body from anything other than the
 *  endpoint itself carries neither. */
const FeedbackReplySchema = v.object({
  id: v.optional(v.string()),
  error: v.optional(v.string()),
});

/** Route families that name a workspace in their second segment — App.tsx's
 *  `/workspace/:agentId`, `/mcts/:agentId`, `/settings/:agentId`,
 *  `/triggers/:agentId`. */
const WORKSPACE_ROUTES: Readonly<Record<string, true>> = Object.freeze({
  workspace: true, mcts: true, settings: true, triggers: true,
});

function workspaceOf(pathname: string): string {
  const [head, name] = pathname.replace(/^\/+/, "").split("/");
  return head !== undefined && WORKSPACE_ROUTES[head] === true && name !== undefined ? name : "";
}

/** What the screenshot half is doing. A reporter is told the difference between
 *  "not asked for" and "could not be taken", so the two are separate phases
 *  rather than one absence. */
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

  const take = useCallback(() => {
    setShot({ phase: "capturing" });
    setMarks([]);
    // One frame, so the dialog's own paint lands before the clone is taken —
    // otherwise the omit hook removes nodes the browser has not laid out and
    // the page underneath is captured mid-reflow.
    requestAnimationFrame(() => {
      void capturePage().then(
        (capture) => {
          setShot(tooLarge(capture.blob.size)
            ? {
              phase: "failed",
              reason: `it came to ${String(Math.ceil(capture.blob.size / (1024 * 1024)))} MiB, over the ${String(FEEDBACK_MAX_SCREENSHOT_BYTES >> 20)} MiB limit — narrow the window and take it again, or send the note on its own`,
            }
            : { phase: "ready", capture });
        },
        <Thrown,>(thrown: Thrown) => {
          setShot({ phase: "failed", reason: renderThrownChain({ cause: thrown }) });
        },
      );
    });
  }, []);

  useEffect(() => {
    if (wanted) take();
    else setShot({ phase: "off" });
  }, [wanted, take]);

  // DECODE once per capture. Re-decoding a multi-megabyte PNG on every drawn
  // mark was both wasteful and visibly wrong: the repaint landed a frame or two
  // after the state change, so a mark appeared late and an undo un-drew late.
  useEffect(() => {
    if (shot.phase !== "ready") {
      setBitmap((current) => { current?.close(); return null; });
      return;
    }
    let live = true;
    void createImageBitmap(shot.capture.blob).then((decoded) => {
      if (!live) { decoded.close(); return; }
      setBitmap((current) => { current?.close(); return decoded; });
    }, () => {
      setShot({ phase: "failed", reason: "the captured image could not be decoded for preview" });
    });
    return () => { live = false; };
  }, [shot]);

  // PAINT synchronously whenever the image or the marks change. The canvas is
  // sized to the IMAGE and CSS scales it down to the dialog, so a mark's
  // coordinates are image coordinates and stay correct at any dialog width.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (bitmap === null || canvas === null) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    paint(context, bitmap, marks, { width: bitmap.width, height: bitmap.height });
    // The canvas EXISTS from the moment the ready state renders, but it is only
    // drawn once the decode resolves. Anything reading these pixels — a browser
    // gate above all — needs to tell those two apart, so the paint states that
    // it happened rather than leaving a reader to time it.
    canvas.dataset.feedbackPainted = String(marks.length);
  }, [bitmap, marks]);

  /** Pointer position in IMAGE pixels, from a canvas the browser has scaled. */
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
    // A click is not a zero-size annotation, it is a click.
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
  const sendable = (trimmed.length > 0 || ready) && send.phase !== "sending" && shot.phase !== "capturing";

  const submit = useCallback(() => {
    setSend({ phase: "sending" });
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
      .then(() => fetch(FEEDBACK_ENDPOINT, { method: "POST", body: form }))
      .then(async (response) => {
        // The endpoint's own two shapes, parsed at the boundary: `{ id }` on
        // success and `{ error }` on refusal. A body that is neither — a proxy's
        // HTML error page, say — parses to an empty object, and the status then
        // carries the failure on its own.
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
      .catch(<Thrown,>(thrown: Thrown) => {
        // The capture stays in state, so Retry sends the same bytes.
        setSend({ phase: "failed", reason: renderThrownChain({ cause: thrown }) });
      });
  }, [location.pathname, marks, shot, trimmed]);

  if (send.phase === "sent") {
    return (
      <div {...{ [FEEDBACK_OMIT_ATTR]: "1" }}>
        <Modal title="Feedback sent" onClose={onClose} icon={<MegaphoneIcon size={16} className="p-accent" />}
          footer={<FilledButton onClick={onClose}>Done</FilledButton>}>
          <p className="text-sm p-text-2" data-feedback-sent={send.id}>
            Thank you — the report is with us{send.id.length > 0 ? ` as ${send.id.slice(0, 8)}` : ""}.
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
        busy={send.phase === "sending"}
        maxWidthClass="max-w-2xl"
        icon={<MegaphoneIcon size={16} className="p-accent" />}
        footer={
          <>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={send.phase === "sending"}>
              Cancel
            </Button>
            <FilledButton onClick={submit} disabled={!sendable} data-feedback-send>
              {send.phase === "sending" ? "Sending…" : send.phase === "failed" ? "Retry" : "Send"}
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
                <span className="ml-auto text-[11px] p-text-3" data-feedback-shot-meta={String(shot.capture.redacted)}>
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
              <p className="text-[11px] p-text-3">
                Drag on the image to {tool === "hide" ? "cover something" : "draw a box"}.
              </p>
            </div>
          )}
        </div>

        {send.phase === "failed" && (
          <p className="text-xs p-warn" data-feedback-error>
            Not sent: {send.reason}. The screenshot and note are still here — press Retry.
          </p>
        )}

        <p className="text-[11px] p-text-3" data-feedback-consent>
          Sending shares your note, the page address, and — when you include it — the screenshot above,
          with your account email so we can reply. Password fields are blacked out before the image
          leaves your browser; use <span className="p-text-2">Hide</span> for anything else you would
          rather not send.
        </p>
      </Modal>
    </div>
  );
}
