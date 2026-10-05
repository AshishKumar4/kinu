
import type { Attachment, AttachmentPolicy } from '@better-compact/core';
import * as v from 'valibot';
import {
  attachmentBytes, formatPath, rasterImage, resolvePromptModelProfile, storeAttachment, SPILL_DIRS,
  type PathPlanes, type RasterImage, type Storage,
} from '@kinu.run/core';
import { carriedMedia, withoutMedia, type CarriedMedia } from './codec';

export interface AttachmentDeps {
  readonly files: () => { readonly storage: Pick<Storage, 'vfs' | 'home'>; readonly planes: PathPlanes };
}

const KEEP_RECENT_IMAGES = 2;

export function kinuAttachments(deps: AttachmentDeps, model: () => string): AttachmentPolicy {
  return {
    get key() {
      return `${model()}|recent:${KEEP_RECENT_IMAGES}`;
    },
    keepRecentImages: KEEP_RECENT_IMAGES,
    list: (item) => carriedMedia(item).flatMap((media) => {
      const attachment = attachmentOf(media);

      return attachment === null ? [] : [attachment];
    }),
    estimateTokens: (attachment, item) => {
      const media = carriedMedia(item).find((carried) => carried.id === attachment.id);

      return media === undefined ? undefined : mediaTokens(model(), attachment, media);
    },
    replace: (item, attachment, text) => withoutMedia(item, attachment.id, text),
    store: async (attachment, item) => {
      const media = carriedMedia(item).find((carried) => carried.id === attachment.id);
      const bytes = media === undefined ? null : attachmentBytes(media.data);

      if (bytes === null) return null;
      const { storage, planes } = deps.files();
      const path = await storeAttachment(storage.vfs, `${storage.home}/${SPILL_DIRS.attachments}`, bytes, attachment.mimeType);

      return formatPath(path, planes);
    },
  };
}

const ATTACHMENTS = new WeakMap<object, Attachment | null>();

function attachmentOf(media: CarriedMedia): Attachment | null {
  const known = ATTACHMENTS.get(media.source);

  if (known !== undefined) return known;
  const image = media.kind === 'image' ? rasterHeader(media.data) : null;
  const mimeType = image?.mediaType ?? media.mediaType;

  const attachment: Attachment | null = mimeType === undefined ? null : {
    id: media.id, kind: media.kind, mimeType, ...(image !== null && { width: image.width, height: image.height }),
  };

  ATTACHMENTS.set(media.source, attachment);

  return attachment;
}

const HEADER_CHARS = 128 * 1024;

function rasterHeader(data: CarriedMedia['data']): RasterImage | null {
  const text = v.safeParse(v.string(), data);
  const bytes = attachmentBytes(text.success && !text.output.startsWith('data:') ? text.output.slice(0, HEADER_CHARS) : data);

  return bytes === null ? null : rasterImage(bytes);
}

interface PatchRule {
  readonly patch: number;
  readonly maxEdge: number;
  readonly budget: number | null;
  readonly multiplier: number;
}

interface TileRule {
  readonly base: number;
  readonly tile: number;
}

const CLAUDE_STANDARD: PatchRule = { patch: 28, maxEdge: 1568, budget: 1568, multiplier: 1 };

const CLAUDE_HIGH_RESOLUTION: PatchRule = { patch: 28, maxEdge: 2576, budget: 4784, multiplier: 1 };

const OPENAI_RULES: ReadonlyArray<readonly [RegExp, PatchRule | TileRule]> = [
  [/^gpt-4o-mini/u, { base: 2833, tile: 5667 }],
  [/^(?:chatgpt-)?gpt-4o|^gpt-4\.1(?!-mini|-nano)/u, { base: 85, tile: 170 }],
  [/^gpt-5(?:\.1)?(?![.\d]|-mini|-nano)/u, { base: 70, tile: 140 }],
  [/^o[13](?!-mini)/u, { base: 75, tile: 150 }],
  [/^gpt-6|^gpt-5\.6/u, { patch: 32, maxEdge: 65_535, budget: null, multiplier: 1.2 }],
  [/^gpt-5\.5/u, { patch: 32, maxEdge: 6000, budget: 10_000, multiplier: 1.2 }],
  [/^gpt-5\.2|^gpt-4\.1-mini/u, { patch: 32, maxEdge: 2048, budget: 6144, multiplier: 1.2 }],
  [/^gpt-4\.1-nano/u, { patch: 32, maxEdge: 2048, budget: 1536, multiplier: 2.46 }],
  [/^o4-mini/u, { patch: 32, maxEdge: 2048, budget: 1536, multiplier: 1.72 }],
  [/^gpt-5-nano/u, { patch: 32, maxEdge: 2048, budget: 1536, multiplier: 1.5 }],
  [/^gpt-5-mini/u, { patch: 32, maxEdge: 2048, budget: 1536, multiplier: 1.2 }],
  [/^gpt-/u, { patch: 32, maxEdge: 2048, budget: 2500, multiplier: 1.2 }],
];

const CLAUDE_PDF_PAGE_TOKENS = 1500;

function mediaTokens(spec: string, attachment: Attachment, media: CarriedMedia): number | undefined {
  const provider = spec.split('/')[0];
  const id = spec.split('/').at(-1)?.toLowerCase() ?? '';
  const { family } = resolvePromptModelProfile({ provider, id });

  if (attachment.kind === 'file') {
    const pages = family === 'claude' && attachment.mimeType === 'application/pdf' ? pdfPages(media) : null;

    return pages === null ? undefined : pages * CLAUDE_PDF_PAGE_TOKENS;
  }

  const { width, height } = attachment;

  if (width === undefined || height === undefined) return undefined;

  if (family === 'gemini') return geminiTokens(width, height);

  if (family === 'gpt') {
    const rule = OPENAI_RULES.find(([pattern]) => pattern.test(id))?.[1] ?? null;

    if (rule !== null && 'tile' in rule) return tileTokens(width, height, rule);

    if (rule !== null) return patchTokens(width, height, rule);
  }

  return patchTokens(width, height, family === 'claude' && claudeVersion(id) >= 4.7 ? CLAUDE_HIGH_RESOLUTION : CLAUDE_STANDARD);
}

function claudeVersion(id: string): number {
  const match = /claude-(?:[a-z]+-)?(\d+)(?:[-.](\d{1,2})(?!\d))?/u.exec(id);

  return match === null ? 0 : Number(match[1]) + Number(match[2] ?? 0) / 10;
}

function patchTokens(width: number, height: number, rule: PatchRule): number {
  const fit = Math.min(1, rule.maxEdge / Math.max(width, height));
  let w = Math.floor(width * fit);
  let h = Math.floor(height * fit);
  const patches = () => Math.ceil(w / rule.patch) * Math.ceil(h / rule.patch);

  if (rule.budget !== null && patches() > rule.budget) {
    let shrink = Math.sqrt((rule.patch ** 2 * rule.budget) / (w * h));
    const [fittedW, fittedH] = [w, h];

    for (;;) {
      w = Math.floor(fittedW * shrink);
      h = Math.floor(fittedH * shrink);

      if (patches() <= rule.budget) break;
      shrink *= 0.995;
    }
  }

  return Math.ceil(patches() * rule.multiplier);
}

function tileTokens(width: number, height: number, rule: TileRule): number {
  const fit = Math.min(1, 2048 / Math.max(width, height));
  let w = width * fit;
  let h = height * fit;
  const short = Math.min(w, h);

  if (short > 768) {
    w = Math.floor((w * 768) / short);
    h = Math.floor((h * 768) / short);
  }

  return rule.base + rule.tile * Math.ceil(w / 512) * Math.ceil(h / 512);
}

function geminiTokens(width: number, height: number): number {
  if (width <= 384 && height <= 384) return 258;
  const crop = Math.max(1, Math.floor(Math.min(width, height) / 1.5));

  return 258 * Math.ceil(width / crop) * Math.ceil(height / crop);
}

const PDF_PAGES = new WeakMap<object, number | null>();

function pdfPages(media: CarriedMedia): number | null {
  const known = PDF_PAGES.get(media.source);

  if (known !== undefined) return known;
  const bytes = attachmentBytes(media.data);
  const count = bytes === null ? 0 : new TextDecoder('latin1').decode(bytes).match(/\/Type\s*\/Page(?![a-z])/gu)?.length ?? 0;
  const pages = count === 0 ? null : count;

  PDF_PAGES.set(media.source, pages);

  return pages;
}
