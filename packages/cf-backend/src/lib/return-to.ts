/** A path on `origin`, never the auth flow. A parser strips tab or newline (`/\t/evil.example` is another host). */
export function sanitizeReturnTo(input: string, origin: string): string {
  const raw = input.trim();

  if (!raw.startsWith('/') || Array.from(raw, (ch) => ch.codePointAt(0) ?? 0).some((code) => code < 0x20 || code === 0x7f || code === 0x5c)) return '/';
  const resolved = new URL(raw, origin);

  if (resolved.origin !== new URL(origin).origin) return '/';
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;

  if (path.startsWith('/auth/') || resolved.pathname === '/login' || resolved.pathname === '/logout') return '/';

  return path;
}
