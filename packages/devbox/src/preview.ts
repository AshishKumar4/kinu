/** Preview hosts: `<port>-<box name>-<token>.<zone>`, routed by name and served by the box itself (D60, D86). */
import { env } from 'cloudflare:workers';
import * as v from 'valibot';

/** The port is the first field and the token the last, so a box name may hold hyphens. */
const PREVIEW_LABEL = /^(\d{1,5})-([a-z0-9-]+)-([a-z0-9]+)$/;

/** A DNS label holds 63 characters (RFC 1035 §2.3.4). */
export const LABEL_LIMIT = 63;

/** What a box name may hold to come back as itself: a host is lowercased on the way in, and a label holds nothing else. */
export const LABEL_NAME = /^[a-z0-9-]+$/;

/** `DEVBOX_PREVIEW_HOST` in a Worker's env: the zone preview hosts are served under. */
export const ZoneSchema = v.object({ DEVBOX_PREVIEW_HOST: v.pipe(v.string(), v.minLength(1)) });

export interface PreviewAddress {
  readonly port: number;
  readonly name: string;
  readonly token: string;
}

/** The port, box name and token a host under `zone` carries; null for every other host. */
export function previewAddress(hostname: string, zone: string | undefined): PreviewAddress | null {
  if (zone === undefined || zone.length === 0) return null;
  const suffix = `.${zone.toLowerCase()}`;

  if (!hostname.endsWith(suffix)) return null;
  const label = PREVIEW_LABEL.exec(hostname.slice(0, -suffix.length));
  const port = Number(label?.[1]);

  if (label === null || port < 1 || port > 65_535) return null;

  return { port, name: label[2], token: label[3] };
}

/** The box a preview host under `DEVBOX_PREVIEW_HOST` names, or null for every other host. Only the shape is read
 *  here: the box serves the request after checking that the name is its own, the token the port's and the port
 *  exposed. A host whose boxes override `previewHost` routes its own zone. */
export function previewBox<Box extends Rpc.DurableObjectBranded | undefined>(
  request: Request,
  boxes: DurableObjectNamespace<Box>,
): DurableObjectStub<Box> | null {
  const zone = v.safeParse(ZoneSchema, env);
  const address = previewAddress(new URL(request.url).hostname, zone.success ? zone.output.DEVBOX_PREVIEW_HOST : undefined);

  return address === null ? null : boxes.getByName(address.name);
}
