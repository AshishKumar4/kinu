// Kinu's workspace blueprints, and how an install turns one into a soul and a seed: the owner's name in the soul, and
// each schedule in the owner's own time as the UTC cron the trigger hub reads.
import { describe, expect, test } from 'bun:test';
import { blueprintSeed, KINU_BLUEPRINTS, kinuBlueprint, nextCronFire, PERSONAL_ASSISTANT_ID } from '../src/index';

const assistant = () => {
  const found = kinuBlueprint(PERSONAL_ASSISTANT_ID);

  if (found === undefined) throw new Error('Kinu keeps the Personal assistant');

  return found;
};

describe("Kinu's workspace blueprints", () => {
  test('each has a distinct id, a mission its soul names, and schedules the trigger hub can arm', () => {
    expect(new Set(KINU_BLUEPRINTS.map((blueprint) => blueprint.id)).size).toBe(KINU_BLUEPRINTS.length);

    for (const blueprint of KINU_BLUEPRINTS) {
      const { soul, seed } = blueprintSeed(blueprint, { owner: 'Ashish', utcOffsetMinutes: 0 });

      expect(soul).toContain('## Mission');
      expect(soul).not.toContain('{{');

      for (const schedule of seed.schedules) expect(nextCronFire(schedule.cron, Date.UTC(2026, 9, 20))).not.toBeNull();
    }
  });

  test('the assistant creates and steers workspaces without asking, and asks first only before what leaves Kinu', () => {
    const { soul } = blueprintSeed(assistant(), { owner: 'Ashish', utcOffsetMinutes: 0 });

    expect(soul).toContain('agent.createWorkspace');
    expect(soul).toContain('never ask before it');
    expect(soul).toContain("Ask Ashish first, in one line, before anything that leaves Ashish's own Kinu");
  });
});

describe('the brief in the owner\'s own time', () => {
  const briefCron = (brief: string, utcOffsetMinutes: number) => blueprintSeed(assistant(), { owner: 'A', brief, utcOffsetMinutes })
    .seed.schedules.find((schedule) => schedule.label === 'Daily brief')?.cron;

  test('east and west of UTC, and across midnight', () => {
    expect(briefCron('08:00', 0)).toBe('0 8 * * *');
    expect(briefCron('08:30', 120)).toBe('30 6 * * *');
    expect(briefCron('08:00', -420)).toBe('0 15 * * *');
    expect(briefCron('00:30', 60)).toBe('30 23 * * *');
    expect(briefCron('23:45', -330)).toBe('15 5 * * *');
  });

  test('a name chosen at install replaces the blueprint\'s in the soul and the seed; a blank one keeps it', () => {
    const named = blueprintSeed(assistant(), { owner: 'Ashish', agent: 'Jarvis', utcOffsetMinutes: 0 });
    const blank = blueprintSeed(assistant(), { owner: 'Ashish', agent: '  ', utcOffsetMinutes: 0 });

    expect(named.soul).toStartWith('# Jarvis');
    expect(named.seed.agent).toBe('Jarvis');
    expect(blank.seed.agent).toBe('Kinu');
  });
});
