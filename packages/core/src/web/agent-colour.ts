/**
 * An agent's colour, as a hue that no other rank of its workspace takes: golden-angle steps round the wheel from a point
 * the workspace's name picks, drawn in OKLCH at fixed lightness and chroma so every hue reads alike. A palette of twelve
 * gave the thirteenth agent the first one's colour (production, 2026-10-08).
 */

/** The golden angle: each step lands on a hue no earlier step took, and as far from its neighbours as any step can. */
const GOLDEN_ANGLE = 137.50776405003785;

/** A tile's gradient stops, lightest first: lightness and chroma fixed, so only the hue tells two agents apart. */
const STOPS = [{ l: 0.88, c: 0.075 }, { l: 0.7, c: 0.14 }, { l: 0.54, c: 0.13 }] as const;

/** The hue in degrees an agent of birth rank `rank` wears, from a start its workspace picks (`start`, any integer). */
export function rankHue(start: number, rank: number): number {
  return ((start % 360) + rank * GOLDEN_ANGLE) % 360;
}

type Rgb = readonly [number, number, number];

/** Linear sRGB at OKLCH (l, c, h°): Björn Ottosson's matrices. */
function linearRgb(l: number, c: number, hue: number): Rgb {
  const radians = hue * Math.PI / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

const inGamut = (rgb: Rgb): boolean => rgb.every((channel) => channel >= 0 && channel <= 1);

/** The colour at (l, c, h) as sRGB hex; a chroma past the screen's gamut is drawn at the most this hue allows. */
function hexAt(l: number, c: number, hue: number): string {
  let chroma = c;

  while (chroma > 0 && !inGamut(linearRgb(l, chroma, hue))) chroma -= 0.002;

  const encode = (linear: number): string => {
    const clamped = Math.min(1, Math.max(0, linear));
    const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;

    return Math.round(gamma * 255).toString(16).padStart(2, '0');
  };

  return `#${linearRgb(l, Math.max(0, chroma), hue).map(encode).join('')}`.toUpperCase();
}

/** A tile's three gradient stops at `hue`, lightest first. */
export function hueStops(hue: number): readonly [string, string, string] {
  const [light, mid, dark] = STOPS.map(({ l, c }) => hexAt(l, c, hue));

  return [light ?? '', mid ?? '', dark ?? ''];
}
