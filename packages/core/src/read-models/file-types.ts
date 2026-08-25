/** Inline-previewable file types. One registry serves HTTP response policy and
 * browser preview chrome, so clients cannot disagree with the response MIME. */
const INLINE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
} as const satisfies Record<string, string>;

function isInlineExtension(value: string): value is keyof typeof INLINE_TYPES {
  return Object.hasOwn(INLINE_TYPES, value);
}

export function inlineFileType(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return isInlineExtension(ext) ? INLINE_TYPES[ext] : undefined;
}
