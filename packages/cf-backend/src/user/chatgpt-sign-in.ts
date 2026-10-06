import { Effect } from 'effect';
import {
  DEVICE_CHATGPT, DeviceChatGptStatusSchema, CHATGPT_CRED_KEY, CHATGPT_PASTE_REDIRECT, ChatGptPasteSignInSchema, ChatGptRegistrationSchema, chatgptHostId, chatgptRegistrationOf, finishChatGptPasteSignIn, startChatGptPasteSignIn, type ChatGptPasteOutcome, type DeviceChatGptStatus, nanoid, type UserCaller,
} from '@kinu.run/core';
import { attempt, attemptInItsWords, KinuError, logged, renderThrownChain, settle } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { UserCredentials } from './credentials';
import type { UserDevices } from './devices';
import type { UserObjectHost } from './user-host';

const CHATGPT_SIGNED_OUT_MARK = 'signed out';

const CHATGPT_MACHINE_SIGN_IN_KEY = 'chatgpt.machine-sign-in';

const CHATGPT_PASTE_SIGN_IN_KEY = 'chatgpt.paste-sign-in';

/** The account's issued ChatGPT client, kept across sign-outs; `planDeclined` asks for consent again. */
const CHATGPT_REGISTRATION_KEY = 'chatgpt.registration';

const ChatGptKnownRegistrationSchema = v.object({ registration: ChatGptRegistrationSchema, planDeclined: v.boolean() });

const ChatGptPasteHeldSchema = v.object({ ...ChatGptPasteSignInSchema.entries, revision: v.number() });

const ChatGptMachineSignInSchema = v.variant('state', [
  v.object({ state: v.literal('waiting_for_machine'), attempt: v.string() }),
  v.object({ state: v.literal('open'), attempt: v.string(), authorizeUrl: v.string(), device: v.object({ id: v.string(), label: v.string() }) }),
]);

/** A sign-in through a machine the web started and no machine has finished. */
export type ChatGptMachineSignIn =
  | { readonly state: 'waiting_for_machine' }
  | { readonly state: 'open'; readonly authorizeUrl: string; readonly device: { readonly id: string; readonly label: string } };

function shownSignIn(held: v.InferOutput<typeof ChatGptMachineSignInSchema>): ChatGptMachineSignIn {
  return held.state === 'open' ? { state: 'open', authorizeUrl: held.authorizeUrl, device: held.device } : { state: 'waiting_for_machine' };
}

/** The ChatGPT plan as this account holds it: through a machine, by its own sign-in, or both. */
export interface ChatGptPlanStatus {
  readonly device: { readonly id: string; readonly label: string } | null;
  readonly status: DeviceChatGptStatus | null;
  /** The account's own sign-in (paste-back), held in its credential vault. */
  readonly account: { readonly email: string | null } | null;
  readonly machineSignIn: ChatGptMachineSignIn | null;
  readonly changed: boolean;
}

/** The last sign-in state a read saw. */
const CHATGPT_SIGN_IN_SEEN_KEY = 'chatgpt_sign_in_seen';

export interface UserChatGptSignInHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier'> {
  readonly devices: UserDevices;
  readonly vault: Pick<UserCredentials, 'bumpCredentialsRevision' | 'commitCredential' | 'credentialRevision' | 'disconnectCredential' | 'readCredential' | 'sealCredential'>;
}

/** Sign in with ChatGPT, on a machine or pasted back. */
export class UserChatGptSignIn {
  constructor(private readonly host: UserChatGptSignInHost) {}

  /** In memory, so an eviction mid-answer frees it for the next HELLO. */
  private chatgptOpening: string | null = null;

  /** Null from a daemon without a ChatGPT sign-in. */
  async chatgptSignIns(): Promise<Array<{ readonly id: string; readonly label: string; readonly status: DeviceChatGptStatus | null }>> {
    const live = this.host.devices._devices.connectedDeviceIds().filter((id) => this.host.devices.isActiveDevice(id));

    return Promise.all(live.map(async (id) => {
      const answer = v.safeParse(DeviceChatGptStatusSchema, await this.host.devices._devices.chatgpt(id, DEVICE_CHATGPT.status));

      return { id, label: this.host.devices.deviceLabel(id), status: answer.success ? answer.output : null };
    }));
  }

  /** The machine the ChatGPT plan signs in on: one already signed in, else the first that can sign in. */
  private async chatgptMachine(): Promise<{ readonly id: string; readonly label: string; readonly status: DeviceChatGptStatus } | null> {
    const machines = (await this.chatgptSignIns()).flatMap((machine) => (machine.status === null ? [] : [{ ...machine, status: machine.status }]));

    return machines.find((machine) => machine.status.signedIn) ?? machines[0] ?? null;
  }

  async chatgptPlan(caller: UserCaller): Promise<ChatGptPlanStatus> {
    await this.host.requireTier(caller, 'credentials.model');
    const machine = await this.chatgptMachine();
    const device = machine === null ? null : { id: machine.id, label: machine.label };
    const status = machine?.status ?? null;

    if (status?.signedIn === true) this.host.ctx.storage.kv.delete(CHATGPT_MACHINE_SIGN_IN_KEY);
    const signingIn = v.safeParse(ChatGptMachineSignInSchema, this.host.ctx.storage.kv.get(CHATGPT_MACHINE_SIGN_IN_KEY));
    const held = await this.host.vault.readCredential(CHATGPT_CRED_KEY);
    const account = held?.kind === 'oauth' ? { email: chatgptRegistrationOf(held)?.email ?? null } : null;

    return { device, status, account, machineSignIn: signingIn.success ? shownSignIn(signingIn.output) : null, changed: this.noteChatGptSignIn(device, status) };
  }

  /** The first read to see a sign-in start or end raises the credential revision (ADR P1). */
  private noteChatGptSignIn(device: { readonly id: string } | null, status: DeviceChatGptStatus | null): boolean {
    const now = device === null || status?.signedIn !== true ? CHATGPT_SIGNED_OUT_MARK : `${device.id} ${status.email ?? ''}`;
    const seen = this.host.ctx.storage.kv.get<string>(CHATGPT_SIGN_IN_SEEN_KEY);

    if (seen === now || (seen === undefined && now === CHATGPT_SIGNED_OUT_MARK)) return false;
    this.host.ctx.storage.kv.put(CHATGPT_SIGN_IN_SEEN_KEY, now);
    this.host.vault.bumpCredentialsRevision();

    return true;
  }

  /** With no machine connected, it waits for the next (`continueChatGptSignIn`). */
  async startChatGptSignIn(caller: UserCaller): Promise<ChatGptMachineSignIn> {
    await this.host.requireTier(caller, 'device.manage');
    const machine = await this.chatgptMachine();
    const signIn = nanoid(12);

    this.host.ctx.storage.kv.put(CHATGPT_MACHINE_SIGN_IN_KEY, { state: 'waiting_for_machine', attempt: signIn });

    if (machine === null) return { state: 'waiting_for_machine' };
    this.chatgptOpening = signIn;

    return settle(Effect.gen({ self: this }, function* () {
      yield* this.openChatGptSignIn(machine, signIn);
      const held = v.safeParse(ChatGptMachineSignInSchema, this.host.ctx.storage.kv.get(CHATGPT_MACHINE_SIGN_IN_KEY));

      if (!held.success || held.output.attempt !== signIn) return yield* Effect.fail(new KinuError('cancelled', 'This ChatGPT sign-in was cancelled or started again'));

      return shownSignIn(held.output);
    }));
  }

  /** Its caller claims `signIn` first. */
  private openChatGptSignIn(machine: { readonly id: string; readonly label: string }, signIn: string): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const answer = yield* attemptInItsWords('unavailable', () => this.host.devices._devices.chatgpt(machine.id, DEVICE_CHATGPT.signIn));
      const started = v.safeParse(v.object({ authorizeUrl: v.string() }), answer);

      if (!started.success) return yield* Effect.fail(new KinuError('io', `${machine.label} answered the ChatGPT sign-in without a URL`));
      const held = v.safeParse(ChatGptMachineSignInSchema, this.host.ctx.storage.kv.get(CHATGPT_MACHINE_SIGN_IN_KEY));

      // Cancelled or started again meanwhile.
      if (!held.success || held.output.attempt !== signIn) return;

      this.host.ctx.storage.kv.put(CHATGPT_MACHINE_SIGN_IN_KEY, {
        state: 'open', attempt: signIn, authorizeUrl: started.output.authorizeUrl, device: { id: machine.id, label: machine.label },
      });
    }).pipe(Effect.ensuring(Effect.sync(() => {
      if (this.chatgptOpening === signIn) this.chatgptOpening = null;
    })));
  }

  /** A sign-in the web started while no machine was connected opens on the first that says HELLO. */
  continueChatGptSignIn(deviceId: string): Effect.Effect<void> {
    const waiting = v.safeParse(ChatGptMachineSignInSchema, this.host.ctx.storage.kv.get(CHATGPT_MACHINE_SIGN_IN_KEY));

    if (!waiting.success || waiting.output.state !== 'waiting_for_machine' || this.chatgptOpening === waiting.output.attempt) return Effect.void;
    const signIn = waiting.output.attempt;

    this.chatgptOpening = signIn;

    return logged('user.chatgpt_sign_in_unopened', { doing: 'opening the ChatGPT sign-in on the machine that connected', otherwise: 'unavailable' },
      this.openChatGptSignIn({ id: deviceId, label: this.host.devices.deviceLabel(deviceId) }, signIn), { device: deviceId });
  }

  /** Forgets a sign-in the owner started and did not finish, on a machine or by paste-back. */
  async cancelChatGptSignIn(caller: UserCaller): Promise<void> {
    await this.host.requireTier(caller, 'device.manage');
    this.host.ctx.storage.kv.delete(CHATGPT_MACHINE_SIGN_IN_KEY);
    this.host.ctx.storage.kv.delete(CHATGPT_PASTE_SIGN_IN_KEY);
  }

  /** Paste-back sign-in: the account itself holds the login, so no machine is needed. The PKCE verifier stays here. */
  async startChatGptPasteSignIn(caller: UserCaller): Promise<{ readonly authorizeUrl: string; readonly redirectUri: string }> {
    await this.host.requireTier(caller, 'subscription_auth');
    const known = v.safeParse(ChatGptKnownRegistrationSchema, this.host.ctx.storage.kv.get(CHATGPT_REGISTRATION_KEY));

    const { url, held } = await startChatGptPasteSignIn({
      hostId: await chatgptHostId((this.host.env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim()),
      registration: known.success ? known.output.registration : null,
      consent: known.success && known.output.planDeclined,
    });

    this.host.ctx.storage.kv.put(CHATGPT_PASTE_SIGN_IN_KEY, { ...held, revision: this.host.vault.credentialRevision(CHATGPT_CRED_KEY) });

    return { authorizeUrl: url, redirectUri: CHATGPT_PASTE_REDIRECT };
  }

  /**
   * `returned` is the 127.0.0.1 address the sign-in ended on. An address that is not this sign-in's is refused and
   * the sign-in stays open; a decline or a sign-in without plan usage closes it with nothing stored.
   */
  async finishChatGptPasteSignIn(caller: UserCaller, returned: string): Promise<{ readonly outcome: ChatGptPasteOutcome['outcome']; readonly email: string | null }> {
    await this.host.requireTier(caller, 'subscription_auth');

    return settle(Effect.gen({ self: this }, function* () {
      const pending = v.safeParse(ChatGptPasteHeldSchema, this.host.ctx.storage.kv.get(CHATGPT_PASTE_SIGN_IN_KEY));

      if (!pending.success) return yield* Effect.fail(new KinuError('missing', 'No ChatGPT sign-in is in progress: start it again.'));
      const held = pending.output;
      const finished = yield* attemptInItsWords('denied', () => finishChatGptPasteSignIn(held, returned));

      const sealed = finished.outcome === 'signed_in'
        ? yield* attempt({ doing: 'sealing the ChatGPT credential', otherwise: 'io' }, () => this.host.vault.sealCredential(CHATGPT_CRED_KEY, finished.credential))
        : null;

      const current = v.safeParse(ChatGptPasteHeldSchema, this.host.ctx.storage.kv.get(CHATGPT_PASTE_SIGN_IN_KEY));
      const superseded = new KinuError('unavailable', 'That ChatGPT sign-in was superseded before it completed: start it again.');

      if (!current.success || current.output.state !== held.state) return yield* Effect.fail(superseded);

      if (finished.outcome === 'declined') {
        this.host.ctx.storage.kv.delete(CHATGPT_PASTE_SIGN_IN_KEY);

        return { outcome: finished.outcome, email: null };
      }

      const { registration } = finished;

      if (sealed !== null && finished.outcome === 'signed_in'
        && !this.host.vault.commitCredential({ key: CHATGPT_CRED_KEY, kind: finished.credential.kind, sealed, expectRevision: held.revision })) {
        return yield* Effect.fail(superseded);
      }

      this.host.ctx.storage.kv.put(CHATGPT_REGISTRATION_KEY, { registration, planDeclined: finished.outcome === 'plan_declined' });
      this.host.ctx.storage.kv.delete(CHATGPT_PASTE_SIGN_IN_KEY);

      return { outcome: finished.outcome, email: registration.email };
    }));
  }

  /**
   * Signs ChatGPT out everywhere this account holds it: OpenAI revokes the machine's session and the account's own,
   * each forgets its tokens, and each keeps its registration for the next sign-in.
   */
  async signOutChatGpt(caller: UserCaller): Promise<{ readonly unconfirmed: string | null }> {
    await this.host.requireTier(caller, 'device.manage');
    await this.host.requireTier(caller, 'subscription_auth');
    this.host.ctx.storage.kv.delete(CHATGPT_MACHINE_SIGN_IN_KEY);
    this.host.ctx.storage.kv.delete(CHATGPT_PASTE_SIGN_IN_KEY);

    if ((await this.host.vault.readCredential(CHATGPT_CRED_KEY)) !== null) await this.host.vault.disconnectCredential(CHATGPT_CRED_KEY);
    const holding = (await this.chatgptSignIns()).filter(({ status }) => status?.signedIn === true || status?.pending === true);

    const answers = await Promise.allSettled(holding.map(async (machine) => {
      const answer = v.safeParse(v.object({ unconfirmed: v.nullable(v.string()) }), await this.host.devices._devices.chatgpt(machine.id, DEVICE_CHATGPT.signOut));

      return answer.success ? answer.output.unconfirmed : 'it did not say whether OpenAI revoked the sign-in';
    }));

    this.noteChatGptSignIn(null, null);

    const unconfirmed = answers.flatMap((answer, at) => {
      const said = answer.status === 'fulfilled' ? answer.value : renderThrownChain({ cause: answer.reason });

      return said === null ? [] : [`${holding[at]?.label ?? ''}: ${said}`];
    });

    return { unconfirmed: unconfirmed.length === 0 ? null : unconfirmed.join('; ') };
  }
}
