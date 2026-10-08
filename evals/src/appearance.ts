/**
 * How a slate's page looks against the workspace that holds it: its background beside the workspace's, how much of
 * its text a person can read against what lies under it, and whether it is wider than its window.
 */

/** A colour as the screen shows it: red, green and blue from 0 to 255. */
type Rgb = readonly [number, number, number];

/** Lights are WCAG relative luminance, 0 for black to 1 for white. */
export type Appearance = {
  /** The page's own background, or the workspace's where the page draws none, and its light. */
  readonly background: Rgb;
  readonly light: number;
  /** The workspace's background (`--c-bg`) and its light, or null when it names none. */
  readonly host: Rgb | null;
  readonly hostLight: number | null;
  /** Visible letters, and the share of them drawn at a contrast of 3:1 or more against what lies under them. */
  readonly letters: number;
  readonly readable: number;
  /** How far the page reaches past its window's right side, in CSS pixels. */
  readonly overflow: number;
};

/**
 * Runs in the page, so it is whole: nothing it uses is defined outside it. A colour is read by painting it, so every
 * colour syntax a page may use comes back as one: a canvas pixel. A layer more than half transparent shows what is
 * under it, so the background of a text is that of its nearest ancestor that paints one, else the page's, else the
 * workspace's `host`.
 */
export function appearance(host: string | null): Appearance {
  const LETTERS = 4000;
  const canvas = document.createElement('canvas');

  canvas.width = 1;
  canvas.height = 1;
  const pen = canvas.getContext('2d', { willReadFrequently: true });

  if (pen === null) throw new Error('the page has no 2d canvas to read colours with');

  const paint = (color: string): readonly [number, number, number, number] => {
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = 'rgba(0, 0, 0, 0)';
    pen.fillStyle = color;
    pen.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = pen.getImageData(0, 0, 1, 1).data;

    return [red, green, blue, alpha / 255];
  };

  const light = ([red, green, blue]: Rgb): number => {
    const linear = (channel: number): number => {
      const value = channel / 255;

      return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  };

  const hostColor = host === null ? null : paint(host);
  const fallback: Rgb = hostColor === null || hostColor[3] < 0.5 ? [255, 255, 255] : [hostColor[0], hostColor[1], hostColor[2]];

  const backgroundOf = (element: Element | null): Rgb => {
    for (let node = element; node !== null; node = node.parentElement) {
      const [red, green, blue, alpha] = paint(getComputedStyle(node).backgroundColor);

      if (alpha >= 0.5) return [red, green, blue];
    }

    return fallback;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let letters = 0, readable = 0;

  for (let node = walker.nextNode(); node !== null && letters < LETTERS; node = walker.nextNode()) {
    const text = (node.textContent ?? '').replace(/\s+/gu, '');
    const parent = node.parentElement;

    if (text === '' || parent === null || !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const range = document.createRange();

    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();

    if (box.width <= 0 || box.height <= 0) continue;
    const [red, green, blue] = paint(getComputedStyle(parent).color);
    const [lighter, darker] = [light([red, green, blue]), light(backgroundOf(parent))].sort((left, right) => right - left);

    letters += text.length;

    if (((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05) >= 3) readable += text.length;
  }

  const background = backgroundOf(document.body);
  const hostRgb: Rgb | null = hostColor === null || hostColor[3] < 0.5 ? null : [hostColor[0], hostColor[1], hostColor[2]];

  return {
    background, light: light(background), host: hostRgb, hostLight: hostRgb === null ? null : light(hostRgb),
    letters,
    readable: letters === 0 ? 0 : readable / letters,
    overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
}
