/** Brand hexes do not theme: marks sit on white unless their hex is unreadable there, then on ink. */
import { CloudflareLogo } from "@cloudflare/kumo";
import {
  siAnthropic, siCloudflare, siDeepmind, siDeepseek, siGithub, siGoogle,
  siGooglecloud, siHuggingface, siKimi, siMetaai, siMinimax, siMistralai,
  siMoonshotai, siNvidia, siOllama, siOpenrouter, siPerplexity, siQwen,
  siVercel, siLinear, siNotion,
} from "simple-icons";

interface BrandIcon {
  readonly title: string;
  readonly path: string;
  readonly hex: string;
  readonly viewBox?: string;
}

/** Marks simple-icons lacks, from models.dev/logos (anomalyco/models.dev, MIT), monochrome by design. */
const siOpenai: BrandIcon = {
  title: "OpenAI",
  hex: "000000",
  viewBox: "0 0 40 40",
  path: "M32.8377 17.282C33.2127 16.25 33.3072 15.218 33.2127 14.1875C33.1197 13.1571 32.7447 12.1251 32.2752 11.1876C31.4322 9.78209 30.2127 8.6571 28.8072 8.0001C27.3072 7.34461 25.7127 7.15711 24.1197 7.53211C23.3698 6.78212 22.5253 6.12512 21.5878 5.65713C20.6503 5.18913 19.5253 5.00013 18.4948 5.00013C16.8851 4.99074 15.3125 5.48246 13.9948 6.40712C12.6824 7.34311 11.7449 8.6571 11.2754 10.1571C10.1504 10.4376 9.21289 10.9071 8.27539 11.4696C7.4324 12.1251 6.77541 12.9696 6.21291 13.8126C5.36992 15.2195 5.08792 16.8125 5.27542 18.407C5.46399 19.9968 6.11605 21.496 7.1504 22.718C6.79608 23.7086 6.66795 24.7659 6.77541 25.8124C6.86991 26.8444 7.2449 27.8749 7.7129 28.8124C8.55739 30.2194 9.77538 31.3444 11.1824 31.9999C12.6824 32.6569 14.2753 32.8444 15.8698 32.4694C16.6198 33.2194 17.4628 33.8749 18.4003 34.3444C19.3378 34.8139 20.4628 34.9999 21.4948 34.9999C23.1043 35.0097 24.6769 34.5185 25.9947 33.5944C27.3072 32.6569 28.2447 31.3444 28.7127 29.8444C29.7719 29.6432 30.7682 29.1934 31.6197 28.5319C32.4627 27.8749 33.2127 27.1249 33.6822 26.1874C34.5251 24.7819 34.8071 23.1875 34.6196 21.5945C34.4322 20 33.8697 18.5015 32.8377 17.282ZM21.5878 33.0304C20.0878 33.0304 18.9628 32.5609 17.9323 31.7179C17.9323 31.7179 18.0253 31.6234 18.1198 31.6234L24.1197 28.1554C24.2862 28.0803 24.4196 27.9469 24.4947 27.7804C24.5698 27.636 24.6021 27.4731 24.5877 27.3109V18.875L27.1197 20.375V27.3124C27.1455 28.0547 27.0215 28.7945 26.755 29.4878C26.4885 30.181 26.085 30.8134 25.5687 31.3473C25.0523 31.8811 24.4337 32.3054 23.7497 32.5949C23.0658 32.8843 22.3305 33.0314 21.5878 33.0304ZM9.49488 27.8749C8.83789 26.7499 8.55739 25.4374 8.83789 24.125C8.83789 24.125 8.93239 24.2195 9.02539 24.2195L15.0253 27.6874C15.1693 27.7638 15.3325 27.7966 15.4948 27.7819C15.6823 27.7819 15.8698 27.7819 15.9628 27.6874L23.2753 23.4695V26.3749L17.1823 29.9374C16.5506 30.3042 15.8527 30.5427 15.1287 30.6393C14.4046 30.7358 13.6686 30.6884 12.9629 30.4999C11.4629 30.1249 10.2449 29.1874 9.49488 27.8749ZM7.9004 14.8445C8.56239 13.7234 9.58826 12.8627 10.8074 12.4056V19.532C10.8074 19.718 10.8074 19.907 10.9004 20C10.9755 20.1665 11.1089 20.2998 11.2754 20.375L18.5878 24.5944L16.0573 26.0944L10.0574 22.625C9.41842 22.2639 8.85742 21.7797 8.40684 21.2004C7.95627 20.6211 7.62506 19.9582 7.4324 19.25C7.05741 17.8445 7.1504 16.157 7.9004 14.8445ZM28.6197 19.625L21.3073 15.407L23.8377 13.9071L29.8377 17.375C30.7752 17.9375 31.5252 18.6875 31.9947 19.625C32.4642 20.5625 32.7447 21.5945 32.6502 22.7195C32.5603 23.7755 32.1699 24.7837 31.5252 25.6249C30.8697 26.4694 30.0252 27.1249 28.9947 27.4999V20.375C28.9947 20.1875 28.9947 20 28.9002 19.907C28.9002 19.907 28.8072 19.718 28.6197 19.625ZM31.1502 15.875C31.1502 15.875 31.0572 15.782 30.9627 15.782L24.9627 12.3126C24.7752 12.2196 24.6822 12.2196 24.4947 12.2196C24.3072 12.2196 24.1197 12.2196 24.0252 12.3126L16.7128 16.532V13.6251L22.8073 10.0626C23.7448 9.50009 24.7752 9.31259 25.9002 9.31259C26.9322 9.31259 27.9627 9.68759 28.9002 10.3446C29.7447 11.0001 30.4947 11.8446 30.8697 12.7821C31.2447 13.7196 31.3377 14.8445 31.1502 15.875ZM15.4003 21.125L12.8699 19.625V12.5946C12.8699 11.5626 13.1503 10.4376 13.7128 9.59459C14.2753 8.6571 15.1198 8.0001 16.0573 7.53211C17.0127 7.05249 18.0956 6.88812 19.1503 7.06261C20.1823 7.15711 21.2128 7.62511 22.0573 8.2821C22.0573 8.2821 21.9628 8.3751 21.8698 8.3751L15.8698 11.8446C15.7033 11.9197 15.57 12.0531 15.4948 12.2196C15.4003 12.4071 15.4003 12.5001 15.4003 12.6876V21.125ZM16.7128 18.125L19.9948 16.25L23.2753 18.125V21.875L19.9948 23.75L16.7128 21.875V18.125Z",
};

/** Composio's mark, the glyph of its logo (ComposioHQ/composio, docs/public/Composio Logo.svg). */
const siComposio: BrandIcon = {
  title: "Composio",
  hex: "000000",
  viewBox: "-8.2 0 120 120",
  path: "M49.4884 8.87123C49.4886 2.51319 55.9876 -1.73892 61.8072 0.695182L62.0842 0.816015L62.0903 0.819543L98.2952 17.5403C101.472 18.9726 103.464 22.1461 103.465 25.592V39.7567C103.465 44.9242 99.0638 49.0053 93.9221 48.6075L52.9185 45.5471V74.344L93.9158 71.2834L94.3962 71.2588C99.3203 71.1388 103.463 75.1151 103.434 80.1051V94.2698C103.434 97.7424 101.39 100.869 98.2708 102.32L98.2654 102.321L62.0912 119.012L62.0921 119.013C56.1931 121.743 49.4884 117.443 49.4884 110.962V97.4634C49.2226 97.5681 48.9381 97.6377 48.6391 97.6594L28.6303 99.0999C26.9584 99.22 25.5356 97.8951 25.5353 96.2188V81.3638C25.5354 80.7879 25.7074 80.2477 26.0028 79.7929L9.54222 81.0225H9.53608C4.40851 81.386 1.332e-05 77.3177 0 72.1708V47.7202C0.000369179 42.5512 4.40493 38.4682 9.54846 38.8695H9.54755L25.6439 40.0708C25.5742 39.8222 25.5354 39.5609 25.5353 39.2911V23.6428C25.5353 21.3581 27.5792 19.6154 29.8351 19.9764L48.8878 23.0246C49.0973 23.0581 49.2977 23.1153 49.4884 23.1903V8.87123ZM94.1831 74.7039H94.1768L52.9185 77.7837V95.6878L100.005 85.8461V80.0928L99.9994 79.8018C99.8586 76.8093 97.2358 74.4657 94.1831 74.7039ZM24.8739 43.4532C25.1616 43.9033 25.3289 44.4367 25.329 45.0063V75.413C25.329 75.7655 25.2629 76.1031 25.1464 76.4166L49.4884 74.5998V45.2904L24.8739 43.4532ZM52.9185 42.1073L94.1768 45.1872L94.1831 45.1881L94.4757 45.2031C97.4932 45.2766 100.035 42.8343 100.035 39.7567V33.8024L52.9185 23.9533V42.1073Z",
};

const siOpencode: BrandIcon = {
  title: "OpenCode",
  hex: "000000",
  path: "M8.40005 17.4H19.2001V21H4.80005V13.8H8.40005V17.4ZM15.6001 10.2V13.8H8.40005V10.2H15.6001ZM19.2001 10.2H15.6001V6.6H4.80005V3H19.2001V10.2Z",
};

const BRANDS = {
  anthropic: { icon: siAnthropic, theme: true },
  cloudflare: { icon: siCloudflare },
  composio: { icon: siComposio, theme: true },
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
  linear: { icon: siLinear },
  moonshotai: { icon: siMoonshotai, theme: true },
  openai: { icon: siOpenai, theme: true },
  opencode: { icon: siOpencode, theme: true },
  ollama: { icon: siOllama, theme: true },
  openrouter: { icon: siOpenrouter },
  notion: { icon: siNotion, theme: true },
  nvidia: { icon: siNvidia },
  perplexity: { icon: siPerplexity },
  qwen: { icon: siQwen },
  vercel: { icon: siVercel, theme: true },
} satisfies Record<string, { icon: BrandIcon; ink?: boolean; theme?: boolean }>;

export type BrandName = keyof typeof BRANDS;

/** The brand's own name, as its mark's title spells it ("Linear"). */
export function brandTitle(brand: BrandName): string {
  return BRANDS[brand].icon.title;
}

/** Undefined when no mark is held. */
export function providerBrand(provider: string): BrandName | undefined {
  switch (provider.toLowerCase().replaceAll(' ', '-')) {
    case "anthropic":
    case "claude": return "anthropic";
    case "openai":
    case "chatgpt":
    case "codex": return "openai";
    case "opencode":
    case "opencode-go": return "opencode";
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
  size?: number;
  bare?: boolean;
  className?: string;
}) {
  const { icon, ink, theme }: { icon: BrandIcon; ink?: boolean; theme?: boolean } = BRANDS[brand];

  const mark = (
    <svg viewBox={icon.viewBox ?? "0 0 24 24"} width={size} height={size} aria-hidden="true"
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
      className={`inline-flex shrink-0 items-center justify-center rounded-[var(--r-row)] ${ink ? "bg-[var(--c-brand-tile-ink)]" : "border p-border bg-[var(--c-brand-tile)]"}`}
      style={{ width: tile, height: tile }}
    >
      {mark}
    </span>
  );
}

/** Cloudflare's cloud, in its own colours on its white tile: its guidelines keep the full-colour mark on white and rule
 *  out black on orange, and white alone would vanish on the light amber of the dark theme. */
export function CloudflareTile() {
  return <span aria-hidden className="p-brand-tile"><CloudflareLogo variant="glyph" className="w-4" /></span>;
}
