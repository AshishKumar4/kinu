/**
 * Browser-side screenshot capture for the feedback dialog, via `modern-screenshot` loaded only by
 * dynamic `import()`. Its clone copies a live input's `value` as an attribute (dist/index.mjs:821), so
 * redaction runs in `onCloneNode` (dist/index.mjs:1509), leaving the live DOM untouched. Every capture
 * is re-encoded through a canvas, so no text chunk, EXIF or timestamp can survive.
 */

import {
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_OMIT_ATTR,
  FEEDBACK_REDACT_ATTR,
  FEEDBACK_SCREENSHOT_TYPE,
} from '@kinu.run/core';

/** Opaque, so a blocked-out field reads as deliberately removed in both themes. */
const REDACTION_FILL = '#111111';

const REDACTED_MARKER = 'data-feedback-redacted';

/** Device pixel ratio is honoured up to this bound; past it, encoding is slow and exceeds the upload limit. */
const MAX_CAPTURE_PIXELS = 12_000_000;

export interface Capture {
  blob: Blob;
  width: number;
  height: number;
  /** Shown to the reporter so redaction is visible rather than merely promised. */
  redacted: number;
}

/**
 * Blanks secret-bearing nodes and drops the feedback UI's own; returns the count. Password inputs are
 * included without annotation because a forgotten opt-in leaks silently. Covered by `scripts/feedback-ux.test.ts`.
 */
function redactClone(root: Element): number {
  for (const omit of root.querySelectorAll(`[${FEEDBACK_OMIT_ATTR}]`)) omit.remove();

  const targets = root.querySelectorAll<HTMLElement>(
    `[${FEEDBACK_REDACT_ATTR}], [${FEEDBACK_REDACT_ATTR}] *, input[type="password"]`,
  );

  for (const node of targets) {
    // dist/index.mjs:821 writes the live value here.
    node.removeAttribute('value');
    node.removeAttribute('placeholder');
    node.removeAttribute('title');
    node.removeAttribute('aria-label');
    node.textContent = '';
    // Pseudo-element `content` is keyed by a class on the clone; dropping classes drops it.
    node.removeAttribute('class');
    // The shorthand resets image/gradient layers; border, outline and shadow go too so no edge survives
    // (`box-sizing: border-box` is global, so the box does not move).
    node.style.background = REDACTION_FILL;
    node.style.border = '0';
    node.style.outline = 'none';
    node.style.boxShadow = 'none';
    node.style.color = 'transparent';
    node.setAttribute(REDACTED_MARKER, '1');
  }

  return root.querySelectorAll(`[${REDACTED_MARKER}]`).length;
}

function captureScale(width: number, height: number): number {
  const area = Math.max(1, width * height);

  return Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CAPTURE_PIXELS / area));
}

/** The rasteriser translates `documentElement` by its scroll offset, cropping a whole-document capture;
 *  this cancels only the document's share. */
function unscrollDocument(root: Element): { transform: string } | undefined {
  const { scrollLeft, scrollTop } = root;

  if (scrollLeft === 0 && scrollTop === 0) return undefined;

  return { transform: `translate(${String(scrollLeft)}px, ${String(scrollTop)}px)` };
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const encoded = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, FEEDBACK_SCREENSHOT_TYPE);
  });

  if (encoded === null) throw new Error('the browser could not encode the screenshot as PNG');

  return encoded;
}

/** The whole document. Throws rather than degrading: the caller offers a note-only report instead. */
export async function capturePage(): Promise<Capture> {
  // Dynamic on purpose: the only reference, so the rasteriser stays out of the entry chunk.
  const { domToCanvas } = await import('modern-screenshot');
  const root = document.documentElement;
  const width = root.clientWidth;
  const height = Math.max(root.clientHeight, root.scrollHeight);
  let redacted = 0;

  const source = await domToCanvas(root, {
    width,
    height,
    scale: captureScale(width, height),
    // Dark themes must not be matted onto white where the document background does not paint.
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    // Off by default in the rasteriser; a bug report must show panes where the reader scrolled them.
    features: { restoreScrollPosition: true },
    style: unscrollDocument(root),
    onCloneNode: (cloned) => {
      if (cloned instanceof Element) redacted = redactClone(cloned);
    },
  });

  return { blob: await encode(source), width: source.width, height: source.height, redacted };
}

/** In image pixel coordinates, so it survives any editor zoom. */
export interface Annotation {
  kind: 'box' | 'hide';
  x: number;
  y: number;
  w: number;
  h: number;
}

function accent(): string {
  const token = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim();

  return token.length > 0 ? token : '#E0A458';
}

/** `hide` paints an opaque block (manual redaction); `box` outlines without covering. */
export function paint(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  annotations: readonly Annotation[],
  size: { width: number; height: number },
): void {
  context.clearRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);
  const stroke = Math.max(2, Math.round(Math.min(size.width, size.height) / 320));

  for (const mark of annotations) {
    if (mark.kind === 'hide') {
      context.fillStyle = REDACTION_FILL;
      context.fillRect(mark.x, mark.y, mark.w, mark.h);
      continue;
    }

    context.strokeStyle = accent();
    context.lineWidth = stroke;
    context.strokeRect(mark.x + stroke / 2, mark.y + stroke / 2, mark.w - stroke, mark.h - stroke);
  }
}

/** Called on send, so the bytes that leave are the bytes the reporter approved. */
export async function flatten(capture: Capture, annotations: readonly Annotation[]): Promise<Blob> {
  if (annotations.length === 0) return capture.blob;
  const bitmap = await createImageBitmap(capture.blob);

  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');

    if (context === null) throw new Error('the browser gave no 2D canvas for the annotation');
    paint(context, bitmap, annotations, { width: bitmap.width, height: bitmap.height });

    return await encode(canvas);
  } finally {
    bitmap.close();
  }
}

/** Mirrors the server's limit, so an over-limit capture is refused before upload. */
export function tooLarge(bytes: number): boolean {
  return bytes > FEEDBACK_MAX_SCREENSHOT_BYTES;
}
