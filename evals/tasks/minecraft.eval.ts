import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { MINECRAFT_MISSION, minecraftTower } from './minecraft';

// Computer use as a person plays: Minecraft Classic on the agent's own desktop, by hand (minecraft.ts).
await defineTaskEval(defineEvalTask({
  id: 'minecraft',
  modelCallPeak: {
    calls: 1,
    source: 'Staging trial eval-mc-dev3 (2026-10-16, build 66938aa25), its ledger kept at '
      + '/mnt/local/kinu/artifacts/evals-minecraft/staging-eval-mc-dev3-ledger.json: one run of 105 sequential steps, each one '
      + 'eval call, and no other run. That build records no model_operation rows, so the peak is the lead\'s own.',
  },
  mission: MINECRAFT_MISSION,
  parts: [minecraftTower],
}));
