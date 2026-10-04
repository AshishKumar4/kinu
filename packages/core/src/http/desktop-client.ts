/** KasmVNC's own client (D70), vendored under cf-backend's `public/kasmvnc`. */
export const DESKTOP_CLIENT_ROOT = '/kasmvnc/';

/** The client, opening its socket on the gated desktop route of the page's origin. The query outranks any
 *  setting the client has stored. */
export function desktopClientUrl(at: Pick<URL, 'protocol' | 'hostname' | 'port'>, workspace: string): string {
  const secure = at.protocol === 'https:';

  const query = new URLSearchParams({
    host: at.hostname,
    port: at.port || (secure ? '443' : '80'),
    encrypt: secure ? '1' : '0',
    path: `api/workspaces/${encodeURIComponent(workspace)}/desktop`,
    autoconnect: '1',
    resize: 'scale',
    enable_webrtc: '0',
  });

  return `${DESKTOP_CLIENT_ROOT}vnc.html?${query.toString()}`;
}
