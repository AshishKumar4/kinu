// Kinu's workspace blueprints, and how an install turns one into a soul and a seed: the owner's name in the soul, and
// each daily schedule in the owner's own zone, as the cron and zone the trigger hub reads.
import { describe, expect, test } from 'bun:test';
import { present } from '@kinu.run/test-utils';
import { blueprintSeed, kinuBlueprint, kinuListings, nextCronFire, PERSONAL_ASSISTANT_ID, type WorkspaceBlueprint } from '../src/index';

/** Every blueprint Kinu keeps, as Explore lists them. */
const KINU_BLUEPRINTS: WorkspaceBlueprint[] = kinuListings().map(({ id }) => {
  const blueprint = kinuBlueprint(id);

  if (blueprint === undefined) throw new Error(`Explore lists ${id}, which Kinu does not keep`);

  return blueprint;
});

const assistant = () => {
  const found = kinuBlueprint(PERSONAL_ASSISTANT_ID);

  if (found === undefined) throw new Error('Kinu keeps the Personal assistant');

  return found;
};

describe("Kinu's workspace blueprints", () => {
  test('each has a distinct id, a mission its soul names, and schedules the trigger hub can arm', () => {
    expect(new Set(KINU_BLUEPRINTS.map((blueprint) => blueprint.id)).size).toBe(KINU_BLUEPRINTS.length);

    for (const blueprint of KINU_BLUEPRINTS) {
      const { soul, seed } = blueprintSeed(blueprint, { owner: 'Ashish', timeZone: 'UTC' });

      expect(soul).toContain('## Mission');
      expect(soul).not.toContain('{{');

      for (const schedule of seed.schedules) expect(nextCronFire(schedule.cron, Date.UTC(2026, 9, 20), schedule.timeZone)).not.toBeNull();
    }
  });

  test('the assistant creates and steers workspaces without asking, and asks first only before what leaves Kinu', () => {
    const { soul } = blueprintSeed(assistant(), { owner: 'Ashish', timeZone: 'UTC' });

    expect(soul).toContain('agent.createWorkspace');
    expect(soul).toContain('never ask before it');
    expect(soul).toContain("Ask Ashish first, in one line, before anything that leaves Ashish's own Kinu");
  });
});

describe('the brief in the owner\'s own time', () => {
  const schedulesOf = (brief: string, timeZone: string) => blueprintSeed(assistant(), { owner: 'A', brief, timeZone }).seed.schedules;

  // The rc27 review: an offset taken on the day of install moved the brief an hour at the next daylight-saving change.
  test("the brief is the owner's wall clock in their zone, and stays there across a daylight-saving change", () => {
    const brief = present(schedulesOf('08:30', 'America/New_York').find((schedule) => schedule.label === 'Daily brief'), 'the brief');

    expect(brief).toMatchObject({ cron: '30 8 * * *', timeZone: 'America/New_York' });
    // 08:30 EDT on 31 Oct 2026 is 12:30 UTC; 08:30 EST on 2 Nov is 13:30 UTC.
    expect(new Date(present(nextCronFire(brief.cron, Date.UTC(2026, 9, 31), brief.timeZone), 'October')).toISOString()).toBe('2026-10-31T12:30:00.000Z');
    expect(new Date(present(nextCronFire(brief.cron, Date.UTC(2026, 10, 2), brief.timeZone), 'November')).toISOString()).toBe('2026-11-02T13:30:00.000Z');
  });

  test('a check every few minutes is the same in every zone, so it names none', () => {
    expect(schedulesOf('08:00', 'Asia/Kolkata').filter((schedule) => schedule.label !== 'Daily brief').map(({ cron, timeZone }) => ({ cron, timeZone })))
      .toEqual([{ cron: '*/15 * * * *', timeZone: undefined }, { cron: '*/15 * * * *', timeZone: undefined }]);
  });

  test('a name chosen at install replaces the blueprint\'s in the soul and the seed; a blank one keeps it', () => {
    const named = blueprintSeed(assistant(), { owner: 'Ashish', agent: 'Jarvis', timeZone: 'UTC' });
    const blank = blueprintSeed(assistant(), { owner: 'Ashish', agent: '  ', timeZone: 'UTC' });

    expect(named.soul).toStartWith('# Jarvis');
    expect(named.seed.agent).toBe('Jarvis');
    expect(blank.seed.agent).toBe('Kinu');
  });
});
