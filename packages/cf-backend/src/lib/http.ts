// Shared HTTP helpers for cf-backend route modules — one home instead of a
// per-route-file clone of json/err/safeJson/escapeHtml.

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function err(status: number, message: string): Response {
  return json({ error: message }, { status });
}

export async function safeJson<T = unknown>(request: Request): Promise<T | null> {
  try { return (await request.json()) as T; } catch { return null; }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
