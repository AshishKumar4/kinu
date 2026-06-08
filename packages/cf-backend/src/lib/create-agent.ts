import { slugifyName } from "@/lib/agent-naming";
import { registerAgent } from "@/lib/user-api";

export async function createAgentFromMission(mission: string): Promise<{ name: string; mission: string }> {
  const trimmed = mission.trim();
  if (!trimmed) throw new Error("Mission required.");
  const name = `${slugifyName(trimmed) || "agent"}-${crypto.randomUUID().slice(0, 6)}`;
  await registerAgent(name, trimmed);
  return { name, mission: trimmed };
}
