import { WORKSPACE_TITLE_SYSTEM_PROMPT } from '../../../core/src/identity/naming';
import { sleepTimeScript } from '../../../../scripts/sleep-time-script';
import { readScriptedRequest, scriptedBody, type ScriptedAnswer, type ScriptedRequest } from '../../../../scripts/scripted-protocol';

export const PROBE_TITLE = 'Long Probe';

const titleScript = (request: ScriptedRequest): ScriptedAnswer | null => {
  if (request.streamed || request.available.length !== 0 || !request.system.startsWith(WORKSPACE_TITLE_SYSTEM_PROMPT)) return null;

  return { text: JSON.stringify({ title: PROBE_TITLE }) };
};

const logoScript = (request: ScriptedRequest): ScriptedAnswer | null => {
  if (request.available.length !== 0 || !request.userTexts.some(text => text.startsWith('Design the logo of a Kinu workspace:'))) return null;

  return { text: '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="#6b86ff"/></svg>' };
};

export interface ScriptedHttpAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * The probes' auxiliary lanes use the same request/response protocol as the deploy tier model. A nonstream request
 * always gets one completion; streamed turns remain the streaming probes' own. The shared memory script still runs.
 */
export function scriptedProbeAnswer(raw: string): ScriptedHttpAnswer | null {
  const read = readScriptedRequest(raw);

  if ('refusal' in read) return { status: read.refusal.status, contentType: 'application/json', body: read.refusal.body };
  const request = read.request;
  const scripted = sleepTimeScript(request) ?? titleScript(request) ?? logoScript(request);

  if (scripted === null && request.streamed) return null;
  const answer = scripted ?? { text: `echo:${request.userTexts.filter(text => !text.startsWith('<')).at(-1) ?? ''}` };

  return { status: 200, ...scriptedBody(answer, request) };
}
