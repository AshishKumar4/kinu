/**
 * Client-side agent registry — tracks known agent IDs in localStorage.
 *
 * Each Proteus agent is a separate DO instance. There's no central server-side
 * registry (DOs are isolated). The client tracks which agents it has created
 * so the homepage can show them.
 */

const REGISTRY_KEY = "proteus-agents";

export interface AgentEntry {
  id: string;
  name: string;
  purpose: string;
  createdAt: number;
  lastVisited: number;
}

function load(): AgentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(entries: AgentEntry[]): void {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(entries));
}

export function getKnownAgents(): AgentEntry[] {
  return load().sort((a, b) => b.lastVisited - a.lastVisited);
}

export function registerAgent(id: string, name?: string, purpose?: string): void {
  const entries = load();
  const existing = entries.find(e => e.id === id);
  if (existing) {
    existing.lastVisited = Date.now();
    if (name) existing.name = name;
    if (purpose) existing.purpose = purpose;
  } else {
    entries.push({
      id,
      name: name ?? id,
      purpose: purpose ?? "",
      createdAt: Date.now(),
      lastVisited: Date.now(),
    });
  }
  save(entries);
}

export function removeAgent(id: string): void {
  save(load().filter(e => e.id !== id));
}
