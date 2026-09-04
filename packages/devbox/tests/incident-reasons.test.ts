import { describe, expect, test } from 'bun:test';
import { candidateBox } from './support/candidate-box';

describe('devboxIncidentReasons reports filed failures oldest first', () => {
  test('an empty ledger reads empty', async () => {
    const { box } = candidateBox('bounded-layers');
    expect(await box.devboxIncidentReasons()).toEqual([]);
  });

  test('two refused attaches come back with stages and reasons', async () => {
    const { box, container } = candidateBox('bounded-layers');
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
});
