/**
 * One CLI device sign-in, as the terminal and the approving browser both read it (`auth-store.ts`). The terminal polls
 * from its own Cloudflare location and the approval is often made on another device, at another: Workers KV caches a
 * read per location for about 60 s, so a poll there kept reading `pending` after the approval (2026-10-23), while a
 * Durable Object answers every location from its one copy. An object is named `device:<sha256 of the device token>`
 * and holds the request, or `code:<user code>` and holds the device that code names: the code's object is its claim,
 * so two live sign-ins never share a code. Each deletes itself at the end of retention, as the KV records expired.
 */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { diagnostics } from '@kinu.run/core/obs';
import { CliAuthRecordSchema, currentStatus, type CliAuthRecord } from './auth-store';

const RECORD_KEY = 'record';

const DEVICE_KEY = 'device';

export class CliAuthDO extends DurableObject<Env> {
  /** A code's claim for `deviceHash`, kept until `until`; false while another sign-in holds the code. */
  async claimCode(deviceHash: string, until: number): Promise<boolean> {
    if (await this.deviceOf() !== null) return false;
    // The alarm first: an object cut off between the two writes then holds nothing past it.
    await this.ctx.storage.setAlarm(until);
    await this.ctx.storage.put(DEVICE_KEY, deviceHash);

    return true;
  }

  /** The device hash a code names; null for a code nobody holds. */
  async deviceOf(): Promise<string | null> {
    return v.parse(v.optional(v.string()), await this.ctx.storage.get(DEVICE_KEY)) ?? null;
  }

  /** Holds a new request until `until`. */
  async open(record: CliAuthRecord, until: number): Promise<void> {
    await this.ctx.storage.setAlarm(until);
    await this.ctx.storage.put(RECORD_KEY, record);
  }

  async read(): Promise<CliAuthRecord | null> {
    return v.parse(v.optional(CliAuthRecordSchema), await this.ctx.storage.get(RECORD_KEY)) ?? null;
  }

  /** Approves the request as `userId` while it is pending; answers it as it stands after, approved by whoever did. */
  async approve(userId: string, email: string, now: number): Promise<CliAuthRecord | null> {
    const record = await this.read();

    if (record === null || currentStatus(record, now) !== 'pending') return record;
    const approved: CliAuthRecord = { ...record, status: 'approved', userId, userEmail: email, approvedAt: now };
    await this.ctx.storage.put(RECORD_KEY, approved);

    return approved;
  }

  /** The request as this poll finds it; an approved one is consumed in the same step, so one poll alone reads it so. */
  async collect(now: number): Promise<CliAuthRecord | null> {
    const record = await this.read();

    if (record !== null && currentStatus(record, now) === 'approved') await this.ctx.storage.put(RECORD_KEY, { ...record, status: 'consumed' });

    return record;
  }

  /** Armed only for the end of retention, by `claimCode` and `open`. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    diagnostics.event('cli.auth_retired');
  }
}
