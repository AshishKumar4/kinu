import { registerAgent } from "@/lib/user-api";

export async function createAgentFromMission(mission: string): Promise<{ name: string; mission: string }> {
  const trimmed = mission.trim();
  if (!trimmed) throw new Error("Mission required.");
  const agent = await registerAgent(undefined, trimmed);
  return { name: agent.name, mission: trimmed };
}
