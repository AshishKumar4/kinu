// A deletion confirmed by a read of what the object still holds (core obs/confirmed-deletion.ts), and the read its own
// end answers: a destroyed Agent aborts with `destroyed` only after its wipe, which local workerd sends the read to.
import { describe, expect, test } from 'bun:test';
import { confirmedDeletion } from '../src/obs/confirmed-deletion';

const destroyed = () => Promise.reject(new Error('destroyed'));

const ended = (failure: Error): boolean => failure.message === 'destroyed';

describe('a confirmed deletion', () => {
  test('a read the dying object answers with its own end holds nothing, so the deletion is done', async () => {
    await expect(confirmedDeletion(() => ({ destroy: async () => {}, remains: destroyed }), 'the workspace w', { ended })).resolves.toBe('read');
  });

  test('without that sentinel named, or with another failure, the read fails the deletion', async () => {
    await expect(confirmedDeletion(() => ({ destroy: async () => {}, remains: destroyed }), 'the workspace w')).rejects.toThrow('the workspace w');
    await expect(confirmedDeletion(() => ({ destroy: async () => {}, remains: () => Promise.reject(new Error('network lost')) }), 'the workspace w', { ended }))
      .rejects.toThrow('the workspace w');
  });

  test('data still held after the deletion answered fails it, sentinel or not', async () => {
    await expect(confirmedDeletion(() => ({ destroy: async () => {}, remains: async () => 2 }), 'the workspace w', { ended })).rejects.toThrow('still holds 2');
  });

  // Production 2026-10-24: the read started the emptied object again, 6.7 s of a 27 s delete.
  test("where the deletion's answer or its object's own end says the storage went, nothing is read", async () => {
    let reads = 0;

    const counted = async () => {
      reads += 1;

      return 1;
    };

    expect(await confirmedDeletion(() => ({ destroy: async () => {}, remains: counted }), 'the workspace w', { ended, answerProves: true })).toBe('answered');
    expect(await confirmedDeletion(() => ({ destroy: destroyed, remains: counted }), 'the workspace w', { ended })).toBe('ended');
    expect(reads).toBe(0);
    // Any other failure says nothing of the storage: the read decides.
    await expect(confirmedDeletion(() => ({ destroy: () => Promise.reject(new Error('Network connection lost.')), remains: counted }), 'the workspace w', { ended, answerProves: true }))
      .rejects.toThrow('the workspace w');
    expect(reads).toBe(1);
  });
});
