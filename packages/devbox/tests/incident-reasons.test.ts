import { describe, expect, test } from 'bun:test';
import { INCIDENT_REASON_MAX_CHARS } from '../src/incidents';
import { chainBox } from './support/chain-box';

describe('devboxIncidentReasons reports filed failures oldest first', () => {
  test('an empty ledger reads empty', async () => {
    const { box } = chainBox();
    expect(await box.devboxIncidentReasons()).toEqual([]);
  });

  test('two refused attaches come back with stages and reasons', async () => {
    const { box, container } = chainBox();
    container.containerUnavailable = new Error('capacity exhausted (probe A)');
    await expect(box.attachNow()).rejects.toThrow();
    container.containerUnavailable = new Error('capacity exhausted (probe B)');
    await expect(box.attachNow()).rejects.toThrow();
    const reasons = await box.devboxIncidentReasons();
    expect(reasons).toHaveLength(2);
    expect(reasons[0]?.stage).toBe('attach');
    expect(reasons[0]?.reason).toContain('probe A');
    expect(reasons[0]?.attempts).toBe(0);
    expect(reasons[0]?.delivered).toBe(false);
    expect(reasons[1]?.stage).toBe('attach');
    expect(reasons[1]?.reason).toContain('probe B');
    const atA = reasons[0]?.at;
    const atB = reasons[1]?.at;

    if (atA === undefined || atB === undefined) throw new Error('incident rows carry timestamps');
    expect(atA).toBeLessThanOrEqual(atB);
  });

  test('a refusal longer than the host accepts is filed at the bound the host validates', async () => {
    const { box, container } = chainBox();
    container.containerUnavailable = new Error(`capacity exhausted: ${'the platform said more '.repeat(200)}`);
    await expect(box.attachNow()).rejects.toThrow();

    const [filed] = await box.devboxIncidentReasons();
    expect(filed?.reason).toContain('capacity exhausted: the platform said more');
    expect(filed?.reason).toHaveLength(INCIDENT_REASON_MAX_CHARS);
  });
});
