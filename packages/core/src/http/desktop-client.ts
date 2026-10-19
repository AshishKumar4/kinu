/** KasmVNC's own client (D70), vendored under cf-backend's `public/kasmvnc`. */
export const DESKTOP_CLIENT_ROOT = '/kasmvnc/';

/** The client, opening its socket on the gated desktop route of the page's origin: the computer's screen, or
 *  `device`'s, a PC this workspace holds. The query outranks any setting the client has stored. Its bell is off: a ring
 *  on the desktop plays nothing in the owner's tab, where Kinu's own alerts are the only sounds (use-owner-alerts.ts). */
export function desktopClientUrl(at: Pick<URL, 'protocol' | 'hostname' | 'port'>, workspace: string, device: string | null): string {
  const secure = at.protocol === 'https:';

  const query = new URLSearchParams({
    host: at.hostname,
    port: at.port || (secure ? '443' : '80'),
    encrypt: secure ? '1' : '0',
    path: `api/workspaces/${encodeURIComponent(workspace)}/${device === null ? '' : `devices/${encodeURIComponent(device)}/`}desktop`,
    autoconnect: '1',
    resize: 'scale',
    enable_webrtc: '0',
    bell: 'off',
  });

  return `${DESKTOP_CLIENT_ROOT}vnc.html?${query.toString()}`;
}
