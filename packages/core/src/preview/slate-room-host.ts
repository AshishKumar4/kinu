/**
 * A slate room's own host, `<handle>-<token>-<workspace>.<suffix>`: its token, an HMAC of the workspace and handle, is
 * checked before the room is woken (docs/SLATE-SHARING-SECURITY.md §2.7). Who may use the host is the room's to say.
 */
import { labelSigner, type LabelSignerEnv } from '../utils/label-signer';
import { workspaceAddressRefusal } from '../identity/naming';
import { buildSlateShareHost } from './slate-share-host';
import { previewHostSuffix, previewPortSuffix, type PreviewPortEnv, type PreviewSuffixEnv } from './preview-origin';

const hostSigner = labelSigner('kinu.slate-room-host.salt', 'kinu.slate-room-host.v1');

function hostMessage(workspace: string, handle: string): string {
  return `kinu:slate-room-host:v1:${workspace}:${handle}`;
}

export async function hostTokenHolds(env: LabelSignerEnv, workspace: string, handle: string, token: string): Promise<boolean> {
  return await hostSigner.verify(env, hostMessage(workspace, handle), token);
}

/** `https://<handle>-<token>-<workspace>.<suffix>`, or null where no host suffix or secret is configured. */
export async function slateHostOrigin(env: LabelSignerEnv & PreviewSuffixEnv & PreviewPortEnv, workspace: string, handle: string): Promise<string | null> {
  const suffix = previewHostSuffix(env);
  const secret = hostSigner.secret(env);

  if (suffix === null || secret === undefined || workspaceAddressRefusal(workspace) !== null) return null;
  const token = await hostSigner.token(secret, hostMessage(workspace, handle));
  const host = buildSlateShareHost({ handle, token, workspace, suffix });

  return host === null ? null : `https://${host}${previewPortSuffix(env)}`;
}
