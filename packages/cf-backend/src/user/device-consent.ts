export const DEVICE_CONSENT_SCOPE = 'all_local_actions';

export type DeviceConsentScope = typeof DEVICE_CONSENT_SCOPE;

export interface DeviceActionSummary {
  method: string;
  command: string;
}

export function summarizeDeviceAction(method: string, params: unknown[]): DeviceActionSummary {
  if (method === 'exec') return { method, command: String(params[0] ?? '') };
  return {
    method,
    command: `${method}(${params.map((p) => summarizeParam(p)).join(', ')})`,
  };
}

function summarizeParam(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? String(value)).slice(0, 120);
}
