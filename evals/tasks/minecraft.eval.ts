import { defineTaskEval } from '../src/eval';
import { defineEvalTask } from '../src/task';
import { MINECRAFT_MISSION, minecraftTower } from './minecraft';

// Computer use as a person plays: Minecraft Classic on the agent's own desktop, by hand (minecraft.ts).
await defineTaskEval(defineEvalTask({ id: 'minecraft', mission: MINECRAFT_MISSION, parts: [minecraftTower] }));
