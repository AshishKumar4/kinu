/**
 * Browser-side screenshot capture for the feedback dialog.
 *
 * `modern-screenshot` (MIT, no runtime dependencies) rasterises a CLONE of the
 * page into an SVG `foreignObject`, so the browser draws the real CSS rather
 * than a reimplementation of it. It is loaded through a dynamic `import()` and
 * nowhere else, so the 186 KB it unpacks to is a separate chunk that a session
 * which never opens the dialog never fetches.
 *
 * WHY THE CLONE MATTERS, from its source rather than its README: `cloneNode`
 * copies computed styles inline and — at dist/index.mjs:821 — copies a live
 * input's `value` into the clone as an ATTRIBUTE. A password field therefore
 * arrives in the clone with its secret spelled out. `onCloneNode`, awaited at
 * dist/index.mjs:1509 after cloning and before font embedding and
 * rasterisation, is the one place that can be undone, and undoing it there is
 * what keeps the live DOM untouched: the reporter never sees their own page
 * flicker, and a capture that throws half-way leaves nothing to restore.
 *
 * EVERY CAPTURE IS RE-ENCODED through a canvas on the way out, annotated or
 * not. The canvas holds decoded pixels and nothing else, so the PNG it emits
 * cannot carry a text chunk, an EXIF block or a timestamp — the strip is a
 * property of the pipeline rather than a step that could be skipped.
 */

import {
  FEEDBACK_MAX_SCREENSHOT_BYTES,
  FEEDBACK_OMIT_ATTR,
  FEEDBACK_REDACT_ATTR,
  FEEDBACK_SCREENSHOT_TYPE,
} from './contract';

/** Opaque near-black, so a blocked-out field reads as deliberately removed in
 *  both themes rather than as a rendering failure. */
const REDACTION_FILL = '#111111';

/** Marks what the redaction actually replaced, so a test can assert on the
 *  clone instead of inferring privacy from pixels. */
export const REDACTED_MARKER = 'data-feedback-redacted';

/**
 * Total pixels a capture is scaled to fit. Device pixel ratio is honoured up to
 * this bound: past it a retina full-page shot of a long transcript spends
 * seconds in the PNG encoder and lands over the upload limit anyway, and a
 * report nobody can send is worth less than a slightly softer one.
 */
const MAX_CAPTURE_PIXELS = 12_000_000;

export interface Capture {
  /** PNG bytes, re-encoded through a canvas. */
  blob: Blob;
  width: number;
  height: number;
  /** How many nodes were blocked out — surfaced to the reporter so redaction
   *  is visible rather than merely promised. */
  redacted: number;
}

/**
 * Blank every secret-bearing node in a cloned tree, and drop the feedback UI's
 * own nodes. Returns how many were blanked.
 *
 * Password inputs are included WITHOUT being annotated. An opt-in list is only
 * as good as the last person who remembered it, and the failure is silent and
 * permanent — the secret is already in the image by the time anyone looks.
 *
 * Exported because it is the security property of this feature, and a property
 * that cannot be tested on its own is a property nobody can hold us to.
 */
export function redactClone(root: Element): number {
  for (const omit of root.querySelectorAll(`[${FEEDBACK_OMIT_ATTR}]`)) omit.remove();

  const targets = root.querySelectorAll<HTMLElement>(
    `[${FEEDBACK_REDACT_ATTR}], [${FEEDBACK_REDACT_ATTR}] *, input[type="password"]`,
  );
  for (const node of targets) {
    // The confirmed leak: dist/index.mjs:821 wrote the live value here.
    node.removeAttribute('value');
    node.removeAttribute('placeholder');
    node.removeAttribute('title');
    node.removeAttribute('aria-label');
    // Text children, and any <img> inside a marked region, go with them.
    node.textContent = '';
    // Pseudo-element `content` is hoisted into a generated stylesheet keyed by
    // a class on the clone, so it survives an emptied element. Dropping the
    // classes drops that too; the geometry is already inline by this point.
    node.removeAttribute('class');
    // `background` shorthand rather than `background-color`: it resets the
    // image and gradient layers a copied style may have put underneath. Border,
    // outline and shadow go with it, so what lands is a SOLID BLOCK rather than
    // an empty-looking field — which matters twice over: a bordered blank reads
    // as "nothing was there", and any surviving edge is a pixel the block did
    // not cover. `box-sizing: border-box` is global here, so dropping the
    // border does not move the box.
    node.style.background = REDACTION_FILL;
    node.style.border = '0';
    node.style.outline = 'none';
    node.style.boxShadow = 'none';
    node.style.color = 'transparent';
    node.setAttribute(REDACTED_MARKER, '1');
  }
  return root.querySelectorAll(`[${REDACTED_MARKER}]`).length;
}

/** Honour the display's pixel ratio, but never past the pixel bound. */
function captureScale(width: number, height: number): number {
  const area = Math.max(1, width * height);
  return Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CAPTURE_PIXELS / area));
}

/** A canvas is the re-encode: it holds decoded pixels, so what comes out
 *  carries no chunk that was not drawn. */
async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  const encoded = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, FEEDBACK_SCREENSHOT_TYPE);
  });
  if (encoded === null) throw new Error('the browser could not encode the screenshot as PNG');
  return encoded;
}

/**
 * Photograph `document.documentElement` — the whole page, at whatever size the
 * document lays out to, which is the viewport for this app's fixed shell and
 * the full scroll height for a page that scrolls.
 *
 * Throws on failure rather than returning a degraded capture: the caller offers
 * a note-only report, and a blank or half-drawn image would be worse than none.
 */
export async function capturePage(): Promise<Capture> {
  // DYNAMIC ON PURPOSE, and a static import cannot express it: this is the one
  // reference to the rasteriser in the app, so `import()` is what puts its
  // 186 KB in a chunk of its own. A static import would bundle it into the
  // authenticated app's entry and charge every session that never sends
  // feedback for it.
  const { domToCanvas } = await import('modern-screenshot');
  const root = document.documentElement;
  const width = root.clientWidth;
  const height = Math.max(root.clientHeight, root.scrollHeight);
  let redacted = 0;

  const source = await domToCanvas(root, {
    width,
    height,
    scale: captureScale(width, height),
    // The page's own ground, so a capture of a dark theme is not matted onto
    // white where the document background does not paint.
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    onCloneNode: (cloned) => {
      if (cloned instanceof Element) redacted = redactClone(cloned);
    },
  });

  return { blob: await encode(source), width: source.width, height: source.height, redacted };
}

/** A drawn annotation, in image pixel coordinates so it survives any zoom the
 *  editor renders at. */
export interface Annotation {
  kind: 'box' | 'hide';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Accent used to point at something. Read off the app's own token so the
 *  annotation belongs to this product rather than to a screenshot tool. */
function accent(): string {
  const token = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim();
  return token.length > 0 ? token : '#E0A458';
}

/**
 * Draw `annotations` over `image` and re-encode. `hide` paints an opaque block,
 * which is how a reporter removes something the automatic redaction could not
 * know about; `box` outlines without covering.
 */
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

/** Re-encode a capture with its annotations burned in. Called on send, so the
 *  bytes that leave are the bytes the reporter approved. */
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

/** Whether these bytes can be sent at all. The client refuses the same number
 *  the server refuses, so an over-limit capture is reported here rather than
 *  after an 8 MiB upload. */
export function tooLarge(bytes: number): boolean {
  return bytes > FEEDBACK_MAX_SCREENSHOT_BYTES;
}
