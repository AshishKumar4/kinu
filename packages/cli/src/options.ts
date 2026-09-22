import type { CloudWebhookTriggerInput } from './cloud-api';
import type { JsonObject, JsonValue } from '@kinu.run/core';
import { JsonObjectSchema, nonEmptyString } from '@kinu.run/core';
import * as v from 'valibot';

export const MODEL_OPTION_FLAG = '--model';

export function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);

  return parsed;
}

export function parsePositiveNumber(value: string, label: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);

  return parsed;
}

export function parseTime(value: string, label: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label}: ${value}`);

  return parsed;
}

export function normalizeWebhookAuthMode(value: string | undefined): CloudWebhookTriggerInput['auth_mode'] {
  const raw = (value ?? 'hmac').toLowerCase();

  if (raw === 'hmac' || raw === 'bearer' || raw === 'mtls') return raw;
  throw new Error('--auth-mode must be hmac, bearer, or mtls');
}

/** Non-objects are kept under `key` so the payload survives. */
export function asRecord(input: { value: JsonValue }, key: string): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, input.value);

  if (parsed.success) return parsed.output;

  return { [key]: input.value };
}

/** Blank reads as absent. */
export function stringField(record: JsonObject, key: string): string | undefined {
  return nonEmptyString({ value: record[key] });
}

/** Numeric strings read as numbers. */
export function numberField(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  const number = v.safeParse(v.pipe(v.number(), v.finite()), value);

  if (number.success) return number.output;
  const string = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value);

  if (!string.success) return undefined;
  const parsed = Number(string.output);

  if (Number.isFinite(parsed)) return parsed;

  return undefined;
}
