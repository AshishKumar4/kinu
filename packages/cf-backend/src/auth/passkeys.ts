/**
 * WebAuthn for built-in sign-in, through SimpleWebAuthn. Each check answers the verified result, or the refusal
 * the route returns: the library throws on any response it does not accept, and that is refused with its reason.
 */
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { Effect } from 'effect';
import { json } from '@kinu.run/core';
import { attempt, renderThrownChain, settle, type KinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';

export const AttestationSchema = v.object({
  id: v.string(), rawId: v.string(), type: v.literal('public-key'),
  response: v.object({
    clientDataJSON: v.string(), attestationObject: v.string(), transports: v.optional(v.array(v.string())),
  }),
  clientExtensionResults: v.optional(v.object({}), {}),
});

export const AssertionSchema = v.object({
  id: v.string(), rawId: v.string(), type: v.literal('public-key'),
  response: v.object({
    clientDataJSON: v.string(), authenticatorData: v.string(), signature: v.string(), userHandle: v.optional(v.string()),
  }),
  clientExtensionResults: v.optional(v.object({}), {}),
});

export interface Party {
  readonly origin: string;
  readonly rpID: string;
}

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));

const ClientDataSchema = v.pipe(v.string(), v.parseJson(), v.object({ challenge: v.string() }));

/** The challenge a response answers, read from its own client data before anything is verified. */
export function answeredChallenge(clientDataJSON: string): string | null {
  const parsed = v.safeParse(ClientDataSchema, new TextDecoder().decode(fromBase64Url(clientDataJSON)));

  return parsed.success ? parsed.output.challenge : null;
}

const refused = (failure: KinuError): Response =>
  json({ body: { error: `The passkey could not be verified: ${renderThrownChain({ cause: failure })}` } }, { status: 401 });

export function verifyNewPasskey(response: v.InferOutput<typeof AttestationSchema>, party: Party) {
  return settle(Effect.match(
    attempt({ doing: 'verifying the new passkey', otherwise: 'denied' }, () => verifyRegistrationResponse({
      response, expectedChallenge: answeredChallenge(response.response.clientDataJSON) ?? '',
      expectedOrigin: party.origin, expectedRPID: party.rpID, requireUserVerification: true,
    })),
    { onFailure: refused, onSuccess: (verified) => verified },
  ));
}

export interface KnownPasskey {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly counter: number;
}

export function verifyPasskeyAnswer(response: v.InferOutput<typeof AssertionSchema>, passkey: KnownPasskey, party: Party) {
  return settle(Effect.match(
    attempt({ doing: 'verifying the passkey', otherwise: 'denied' }, () => verifyAuthenticationResponse({
      response, expectedChallenge: answeredChallenge(response.response.clientDataJSON) ?? '',
      expectedOrigin: party.origin, expectedRPID: party.rpID, requireUserVerification: true,
      credential: { id: passkey.credentialId, publicKey: fromBase64Url(passkey.publicKey), counter: passkey.counter },
    })),
    { onFailure: refused, onSuccess: (verified) => verified },
  ));
}
