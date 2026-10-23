/**
 * The scripted model the product tiers run on: background memory, the durability canary's calls, the group-reset
 * workload's, the flows',
 * the first-run cases', the Minecraft benchmark's control, then the fallback answer.
 * One model for every tier and every origin, a local server in a suite and the deployed Worker alike, so a row answers
 * the same wherever it runs. Each script owns only the words its rows send, so none answers another's.
 */
import { firstRunScript } from '../tests/first-run/scripted';
import { sleepTimeScript } from './sleep-time-script';
import { canaryScript } from './canary-script';
import { faultScript } from './fault-script';
import { flowsScript } from './flows-script';
import { minecraftControlScript } from './minecraft-control-script';
import { FALLBACK_ANSWER, type ScriptedModel } from './scripted-protocol';

export const tierModel: ScriptedModel = (request) => sleepTimeScript(request) ?? canaryScript(request) ?? faultScript(request) ?? flowsScript(request) ?? firstRunScript(request)
  ?? minecraftControlScript(request) ?? { text: FALLBACK_ANSWER };
