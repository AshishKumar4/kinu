export const NIMBUS_ROUTE_PREFIX = "/_nimbus";

const COMPONENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function nimbusIdComponent(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return normalized || fallback;
}

export function nimbusTenantForUser(userId: string | null | undefined): string {
  return nimbusIdComponent(userId, "unclaimed");
}

export function nimbusSubjectForAgent(agentName: string): string {
  return nimbusIdComponent(agentName, "agent");
}

export function nimbusSandboxIdForAgent(agentName: string): string {
  return nimbusIdComponent(`agent-${agentName}`, "agent");
}

export function nimbusPreviewBaseUrl(origin: string, tenant: string, subject: string): string {
  return `${origin}${NIMBUS_ROUTE_PREFIX}/${tenant}/${subject}/{sessionId}`;
}

export function nimbusSandboxConfig(origin: string, tenant: string, subject: string) {
  return {
    endpoint: origin,
    sandboxes: {
      default: {
        root: "/home/user",
        runtimes: {
          onDemand: true,
          allow: ["node", "bun", "npm", "git", "python", "ruby", "clang", "shell"],
        },
        tools: { namespace: "nimbus", kind: "nimbus" },
        preview: {
          baseUrl: nimbusPreviewBaseUrl(origin, tenant, subject),
          pathStyle: true,
        },
      },
    },
  };
}

export async function handleNimbusPreviewRequest(
  request: Request,
  env: Env,
  identityUserId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${NIMBUS_ROUTE_PREFIX}/`)) return null;

  const rest = url.pathname.slice(NIMBUS_ROUTE_PREFIX.length + 1);
  const parts = rest.split("/");
  const [tenant, subject, sessionId, ...innerParts] = parts;
  if (!tenant || !subject || !sessionId || !COMPONENT_RE.test(tenant) || !COMPONENT_RE.test(subject) || !COMPONENT_RE.test(sessionId)) {
    return new Response("Invalid Nimbus route", { status: 400, headers: { "cache-control": "no-store" } });
  }

  if (tenant !== nimbusTenantForUser(identityUserId)) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }

  const innerPath = `/${innerParts.join("/") || ""}`;
  const targetUrl = new URL(innerPath + url.search + url.hash, url.origin);
  const headers = new Headers(request.headers);
  const basePath = `${NIMBUS_ROUTE_PREFIX}/${tenant}/${subject}/${sessionId}`;
  headers.set("X-Nimbus-Base", basePath);
  headers.set("X-Nimbus-Tenant", `${tenant}:${subject}`);

  const stub = env.NIMBUS_SESSION.get(env.NIMBUS_SESSION.idFromName(`${tenant}:${subject}:${sessionId}`));
  return stub.fetch(new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  }));
}
