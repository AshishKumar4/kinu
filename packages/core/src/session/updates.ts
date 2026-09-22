import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '../utils/json';
import { KinuError } from '../obs/error';
import type { SessionPayload, SessionPayloads } from './payload';

export type MessageUpdateInput =
  | { readonly operation: 'envelope-metadata'; readonly part: null; readonly value: JsonObject }
  | { readonly operation: 'metadata' | 'open'; readonly part: number; readonly value: JsonObject }
  | { readonly operation: 'append'; readonly part: number; readonly value: string }
  | { readonly operation: 'replace-content'; readonly part: number; readonly value: string | JsonObject }
  | { readonly operation: 'content-end'; readonly part: number };

/** Only validated native structure crosses the asynchronous payload-publication boundary. */
export class PreparedMessageUpdate {
  private constructor(readonly part: number | null, readonly operation: MessageUpdateInput['operation'], readonly payload: SessionPayload | null) {
    if (payload !== null) Object.freeze(payload);
    Object.freeze(this);
  }

  static async prepare(input: MessageUpdateInput, payloads: SessionPayloads): Promise<PreparedMessageUpdate> {
    if (input.operation === 'content-end') return new PreparedMessageUpdate(input.part, input.operation, null);

    if (input.operation === 'envelope-metadata' && ('role' in input.value || 'content' in input.value)) {
      throw new KinuError('bad_input', 'envelope metadata cannot replace message structure');
    }

    if (input.operation === 'replace-content' && v.is(JsonObjectSchema, input.value)
      && (Object.keys(input.value).length === 0 || Object.keys(input.value).some(key => key !== 'output' && key !== 'data' && key !== 'image'))) {
      throw new KinuError('bad_input', 'content replacement cannot change part identity');
    }

    if (input.operation === 'metadata') {
      const metadata = v.parse(JsonObjectSchema, input.value);

      if (Object.keys(metadata).some(key => key !== 'providerOptions')) throw new KinuError('bad_input', 'metadata cannot change native part structure');

      if (metadata.providerOptions !== undefined) v.parse(JsonObjectSchema, metadata.providerOptions);
    }

    const media = input.operation === 'open' && (input.value.type === 'image' || input.value.type === 'file')
      || input.operation === 'replace-content' && v.is(JsonObjectSchema, input.value) && ('data' in input.value || 'image' in input.value);

    const payload = media ? await payloads.prepareMedia(v.parse(JsonObjectSchema, input.value)) : await payloads.prepare(input.value);

    return new PreparedMessageUpdate(input.part, input.operation, payload);
  }
}
