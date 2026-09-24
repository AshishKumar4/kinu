/** The letter-on-a-wash picture a workspace, slate or share gets before it has one of its own. */
import type { CSSProperties } from "react";

export function hueOf(name: string): number {
  let hash = 0;

  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;

  return hash % 360;
}

export function coverWash(hue: number): CSSProperties {
  return { background: `linear-gradient(180deg, oklch(62% 0.13 ${String(hue)} / 0.28), oklch(62% 0.13 ${String(hue)} / 0.08))` };
}

export function coverBadge(hue: number): CSSProperties {
  return { background: `oklch(62% 0.14 ${String(hue)} / 0.35)`, color: `oklch(78% 0.12 ${String(hue)})` };
}

export function coverLetter(title: string): string {
  return title.trim().charAt(0).toUpperCase() || "·";
}

export function tileWash(hue: number): CSSProperties {
  const tone = `oklch(62% 0.13 ${String(hue)}`;

  return { backgroundImage: `linear-gradient(180deg, ${tone} / 0.13), ${tone} / 0.02))` };
}

export function tileBadge(hue: number): CSSProperties {
  const tone = `oklch(62% 0.13 ${String(hue)}`;

  return { background: `${tone} / 0.2)`, color: `color-mix(in oklch, ${tone}) 55%, var(--c-text))` };
}
