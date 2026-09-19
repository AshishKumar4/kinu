/**
 * An official brand mark — the path simple-icons publishes for the brand,
 * in the brand's own hex, on a tile that keeps it legible in both themes.
 * Brand hexes do not theme: a black mark on a dark surface needs the tile
 * to be the surface the brand was drawn for, so every mark sits on white
 * unless its hex cannot be read there — those sit on ink instead. `bare`
 * drops the tile for inline seats (a combobox row already has its own well).
 */
import {
  siAnthropic, siCloudflare, siDeepmind, siDeepseek, siGithub, siGoogle,
  siGooglecloud, siHuggingface, siKimi, siMetaai, siMinimax, siMistralai,
  siMoonshotai, siNvidia, siOllama, siOpenrouter, siPerplexity, siQwen,
  siVercel, type SimpleIcon,
} from "simple-icons";

const BRANDS = {
  anthropic: { icon: siAnthropic },
  cloudflare: { icon: siCloudflare },
  deepmind: { icon: siDeepmind },
  deepseek: { icon: siDeepseek },
  github: { icon: siGithub, theme: true },
  google: { icon: siGoogle },
  googlecloud: { icon: siGooglecloud },
  huggingface: { icon: siHuggingface, ink: true },
  metaai: { icon: siMetaai },
  minimax: { icon: siMinimax },
  mistralai: { icon: siMistralai },
  kimi: { icon: siKimi, theme: true },
  moonshotai: { icon: siMoonshotai, theme: true },
  ollama: { icon: siOllama, theme: true },
  openrouter: { icon: siOpenrouter },
  nvidia: { icon: siNvidia },
  perplexity: { icon: siPerplexity },
  qwen: { icon: siQwen },
  vercel: { icon: siVercel, theme: true },
} satisfies Record<string, { icon: SimpleIcon; ink?: boolean; theme?: boolean }>;

export type BrandName = keyof typeof BRANDS;

/** The provider id the model menu groups by, normalised to the brand it
 *  ships under — `workers-ai` is Cloudflare's. A provider with no official
 *  mark in simple-icons answers undefined and keeps whatever fallback the
 *  seat already draws. */
export function providerBrand(provider: string): BrandName | undefined {
  switch (provider) {
    case "anthropic": return "anthropic";
    case "cloudflare":
    case "workers-ai": return "cloudflare";
    case "deepmind": return "deepmind";
    case "deepseek": return "deepseek";
    case "github": return "github";
    case "google": return "google";
    case "google-vertex": return "googlecloud";
    case "huggingface": return "huggingface";
    case "kimi": return "kimi";
    case "meta": return "metaai";
    case "minimax": return "minimax";
    case "mistral": return "mistralai";
    case "moonshotai": return "moonshotai";
    case "nvidia": return "nvidia";
    case "ollama": return "ollama";
    case "openrouter": return "openrouter";
    case "perplexity": return "perplexity";
    case "qwen": return "qwen";
    case "vercel": return "vercel";
    default: return undefined;
  }
}

export function BrandMark({ brand, size = 16, bare = false, className }: {
  brand: BrandName;
  /** The mark's own pixels; the tile grows around it. */
  size?: number;
  /** No tile — the bare path for a seat that already provides one. */
  bare?: boolean;
  className?: string;
}) {
  const { icon, ink, theme }: { icon: SimpleIcon; ink?: boolean; theme?: boolean } = BRANDS[brand];

  const mark = (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
      className={`${theme && bare ? "text-[var(--c-text-2)]" : ""}${className !== undefined ? ` ${className}` : ""}`}>
      <title>{icon.title}</title>
      <path d={icon.path} fill={theme && bare ? "currentColor" : `#${icon.hex}`} />
    </svg>
  );

  if (bare) return mark;

  const tile = Math.round(size * 1.8);

  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg ${ink ? "bg-[#111318]" : "bg-white border p-border"}`}
      style={{ width: tile, height: tile }}
    >
      {mark}
    </span>
  );
}
