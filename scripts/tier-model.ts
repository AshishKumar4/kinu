/**
 * The scripted model the product tiers run on: the durability canary's calls, the flows', then the first-run cases',
 * then the fallback answer.
 * One model for every tier and every origin, a local server in a suite and the deployed Worker alike, so a row answers
 * the same wherever it runs. Each script owns only the words its rows send, so none answers another's.
 */
import { firstRunScript } from '../tests/first-run/scripted';
import { canaryScript } from './canary-script';
import { flowsScript } from './flows-script';
import { FALLBACK_ANSWER, type ScriptedModel } from './scripted-protocol';

export const tierModel: ScriptedModel = (request) => canaryScript(request) ?? flowsScript(request) ?? firstRunScript(request) ?? { text: FALLBACK_ANSWER };
