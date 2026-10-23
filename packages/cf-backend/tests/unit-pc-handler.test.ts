// Both rails pick a UserDO by name: refuse malformed ids and over-budget sources before any
// idFromName, so a random user id never wakes a Durable Object.
import { describe, expect, setSystemTime, test } from "bun:test";
import {
  type DeviceChallengeProof, type DeviceConnectProof, type DeviceEnrolment, type PcIngressEnv, type PcUserNamespace,
} from "@kinu.run/core";
import { pcRoutes } from "../src/pc-routes";
import type { UserCaller } from "@kinu.run/core";
import { KinuError } from "@kinu.run/core/obs";
import { makeKv } from "./helpers/kv";
import * as v from "valibot";

const GOOD_USER = "0123456789abcdef0123456789abcdef";

const GOOD_DEVICE = "dev-abc123";

const GOOD_NONCE = `pcc_${"n".repeat(43)}`;

const GOOD_SIGNATURE = "g".repeat(86);

const WRONG_SIGNATURE = "w".repeat(86); // well-shaped, so admitted knocks reach the DO and fail there

/** What an earlier protocol's daemon posts: the bearer no hub takes now. */
const EARLIER_TOKEN = `pdt_${"x".repeat(32)}`;

const GOOD_KEY = "k".repeat(43);

const GOOD_TICKET = `pct_${"y".repeat(32)}`;

const GOOD_PROOF = { user: GOOD_USER, device: GOOD_DEVICE, secret: '', nonce: GOOD_NONCE, signature: GOOD_SIGNATURE };

/** A connect secret the hub never handed: the one a copy of the key could make up. */
const STALE_SECRET = 'S'.repeat(43);

const GOOD_JOIN = `pjt_${GOOD_USER}_${"j".repeat(43)}`;

const JOIN_URL = "https://kinu.test/pc/join";

const TICKET_URL = "https://kinu.test/pc/connect-ticket";

const CONNECT_URL = "https://kinu.test/pc/connect";

/** The header a device's upgrade names its account in, spelled as the wire carries it (core `DEVICE_CONNECT_ACCOUNT_HEADER`). */
const ACCOUNT_HEADER = "x-kinu-auth-account";

const KNOCKS_PER_WINDOW = 30;

const TicketReplySchema = v.object({ ticket: v.string(), expiresAt: v.number() });

interface FakeUserId {
  readonly name: string;
}

interface RecordedUserDO {
  idNames: string[];
  /** Each signature a ticket or a refusal was asked with, and the origin it named. */
  proofs: Array<{ origin: string; signature: string }>;
  challenges: string[];
  joins: string[];
  refusals: Array<{ version: string; runtime: string; reason: string }>;
  fetched: Request[];
  ns: PcUserNamespace<FakeUserId>;
}

function makeUserDO(): RecordedUserDO {
  const idNames: string[] = [];
  const proofs: RecordedUserDO['proofs'] = [];
  const challenges: string[] = [];
  const joins: string[] = [];
  const refusals: Array<{ version: string; runtime: string; reason: string }> = [];
  const fetched: Request[] = [];

  const ns = {
    idFromName(name: string): FakeUserId {
      idNames.push(name);

      return { name };
    },
    get(_id: FakeUserId) {
      return {
        async issueDeviceConnectChallenge(_caller: UserCaller, deviceId: string) {
          challenges.push(deviceId);

          return deviceId === GOOD_DEVICE ? { ok: true as const, nonce: GOOD_NONCE, expiresAt: Date.now() + 60_000 } : { ok: false as const, refusal: 'unauthorized' as const };
        },
        async issueDeviceConnectTicket(_caller: UserCaller, proof: DeviceConnectProof) {
          proofs.push({ origin: proof.origin, signature: proof.signature });

          if (proof.signature === GOOD_SIGNATURE) return { ok: true as const, ticket: GOOD_TICKET, expiresAt: Date.now() + 60_000 };

          return { ok: false as const, refusal: proof.secret === STALE_SECRET ? 'cloned' as const : 'unauthorized' as const };
        },
        async recordDeviceUpdateRefusal(_caller: UserCaller, proof: DeviceChallengeProof, refusal: { version: string; runtime: string; reason: string }) {
          proofs.push({ origin: proof.origin, signature: proof.signature });

          if (proof.signature !== GOOD_SIGNATURE) return false;
          refusals.push(refusal);

          return true;
        },
        async fetch(request: Request) {
          fetched.push(request);

          return new Response("socket accepted");
        },
        async joinDevice(_caller: UserCaller, ticket: string, enrolment: DeviceEnrolment) {
          joins.push(ticket);

          if (ticket !== GOOD_JOIN || joins.length > 1) throw new KinuError('bad_input', 'This connect command has expired or was already used.');

          return { deviceId: 'dev-issued', label: enrolment.label ?? 'Your PC' };
        },
      };
    },
  };

  return { idNames, proofs, challenges, joins, refusals, fetched, ns };
}

function makeEnv(userDO: RecordedUserDO): PcIngressEnv<FakeUserId> {
  return {
    AUTH_KV: makeKv(),
    UserDO: userDO.ns,
    CREDENTIAL_ENCRYPTION_KEY: "test-root-secret",
  };
}

function ticketPost(body: string): Request {
  return new Request(TICKET_URL, { method: "POST", body });
}

describe("/pc/connect-challenge", () => {
  const challengePost = (body: string) => new Request("https://kinu.test/pc/connect-challenge", { method: "POST", body });

  test("a live device of the account is answered a nonce, naming exactly one DO", async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(challengePost(JSON.stringify({ user: GOOD_USER, device: GOOD_DEVICE })), makeEnv(userDO));

    expect(response.status).toBe(200);
    expect(v.parse(v.object({ nonce: v.string(), expiresAt: v.number() }), await response.json()).nonce).toBe(GOOD_NONCE);
    expect(userDO.idNames).toEqual([GOOD_USER]);
    expect(userDO.challenges).toEqual([GOOD_DEVICE]);
  });

  test("a malformed user or device is refused before any namespace lookup", async () => {
    for (const body of [{ user: "not-a-user", device: GOOD_DEVICE }, { user: GOOD_USER, device: "dev-has:colon" }, { user: GOOD_USER }]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(challengePost(JSON.stringify(body)), makeEnv(userDO));
      expect(response.status).toBe(400);
      expect(userDO.idNames).toEqual([]);
    }
  });

  test("a device the account does not hold is 401", async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(challengePost(JSON.stringify({ user: GOOD_USER, device: "dev-unknown" })), makeEnv(userDO));
    expect(response.status).toBe(401);
  });

  test("only POST asks for one", async () => {
    const userDO = makeUserDO();
    expect((await pcRoutes.fetch(new Request("https://kinu.test/pc/connect-challenge"), makeEnv(userDO))).status).toBe(405);
    expect(userDO.idNames).toEqual([]);
  });
});

describe("/pc/connect-ticket", () => {
  test("a signed challenge exchanges for a ticket, names exactly one DO, and carries the hub's own origin", async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(ticketPost(JSON.stringify(GOOD_PROOF)), makeEnv(userDO));
    expect(response.status).toBe(200);
    const body = v.parse(TicketReplySchema, await response.json());
    expect(body.ticket).toBe(GOOD_TICKET);
    expect(body.expiresAt).toBeGreaterThan(0);
    expect(userDO.idNames).toEqual([GOOD_USER]);
    expect(userDO.proofs).toEqual([{ origin: "https://kinu.test", signature: GOOD_SIGNATURE }]);
  });

  test("a malformed user, device, nonce or connect secret is refused before any namespace lookup", async () => {
    for (const fields of [
      { user: "not-a-user" }, { user: GOOD_USER.toUpperCase() }, { device: "" }, { device: "dev-a:b" }, { nonce: "pct_short" },
      { secret: undefined }, { secret: 0 }, { secret: "short" }, { secret: `${"S".repeat(42)}=` }, { signature: undefined },
    ]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(ticketPost(JSON.stringify({ ...GOOD_PROOF, ...fields })), makeEnv(userDO));
      expect(response.status).toBe(400);
      expect(userDO.idNames).toEqual([]);
    }
  });

  test("an earlier protocol's bearer is refused before any namespace lookup, in words that name kinu update", async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(ticketPost(JSON.stringify({ user: GOOD_USER, token: EARLIER_TOKEN })), makeEnv(userDO));
    expect(response.status).toBe(401);
    expect(v.parse(v.object({ error: v.string() }), await response.json()).error).toContain("kinu update");
    expect(userDO.idNames).toEqual([]);
  });

  test("a device revoked for a second holder of its key is told so, and to connect again", async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(ticketPost(JSON.stringify({ ...GOOD_PROOF, signature: WRONG_SIGNATURE, secret: STALE_SECRET })), makeEnv(userDO));
    expect(response.status).toBe(401);
    const said = v.parse(v.object({ error: v.string() }), await response.json()).error;
    expect(said).toContain("two machines used its key");
    expect(said).toContain("kinu connect");
  });

  test("an oversized body is a 413 that never reaches parsing or the namespace", async () => {
    const userDO = makeUserDO();
    const bloated = JSON.stringify({ ...GOOD_PROOF, padding: "z".repeat(8192) });
    const response = await pcRoutes.fetch(ticketPost(bloated), makeEnv(userDO));
    expect(response.status).toBe(413);
    expect(userDO.idNames).toEqual([]);
  });

  test("malformed JSON is a 400", async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(ticketPost("{not json"), makeEnv(userDO));
    expect(response.status).toBe(400);
    expect(userDO.idNames).toEqual([]);
  });

  test("the per-source budget bounds DO fanout: random users stop waking objects", async () => {
    const userDO = makeUserDO();
    const env = makeEnv(userDO);

    // The budget is per minute window: every knock lands inside one, however slowly the run goes.
    setSystemTime(new Date('2026-01-01T00:00:00Z'));

    try {
      for (let knock = 0; knock < KNOCKS_PER_WINDOW; knock++) {
        const user = knock.toString(16).padStart(32, "0");
        const response = await pcRoutes.fetch(ticketPost(JSON.stringify({ ...GOOD_PROOF, user, signature: WRONG_SIGNATURE })), env);
        expect(response.status).toBe(401);
      }

      expect(userDO.idNames.length).toBe(KNOCKS_PER_WINDOW);

      for (let knock = 0; knock < 5; knock++) {
        const user = (1000 + knock).toString(16).padStart(32, "f");
        const response = await pcRoutes.fetch(ticketPost(JSON.stringify({ ...GOOD_PROOF, user, signature: WRONG_SIGNATURE })), env);
        expect(response.status).toBe(429);
      }

      expect(userDO.idNames.length).toBe(KNOCKS_PER_WINDOW);
    } finally {
      setSystemTime();
    }
  });
});

describe("/pc/connect upgrade", () => {
  function connectRequest(url: string, account: string | null = GOOD_USER): Request {
    const headers = new Headers({ Upgrade: "websocket" });

    if (account !== null) headers.set(ACCOUNT_HEADER, account);

    return new Request(url, { headers });
  }

  test("an upgrade naming its account in the header is forwarded to that account's DO, its URL bare", async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(connectRequest(CONNECT_URL), makeEnv(userDO));
    expect(await response.text()).toBe("socket accepted");
    expect(userDO.idNames).toEqual([GOOD_USER]);
    expect(userDO.fetched.length).toBe(1);
    expect(userDO.fetched[0].url).toBe(CONNECT_URL);
  });

  test("a missing or malformed account is refused before any namespace lookup", async () => {
    for (const account of [null, "zz", GOOD_USER.toUpperCase()]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(connectRequest(CONNECT_URL, account), makeEnv(userDO));
      expect(response.status).toBe(400);
      expect(userDO.fetched).toEqual([]);
      expect(userDO.idNames).toEqual([]);
    }
  });

  test("the per-source budget bounds upgrade attempts too", async () => {
    const userDO = makeUserDO();
    const env = makeEnv(userDO);

    // The budget is per minute window: every knock lands inside one, however slowly the run goes.
    setSystemTime(new Date('2026-01-01T00:00:00Z'));

    try {
      for (let knock = 0; knock < KNOCKS_PER_WINDOW; knock++) {
        const response = await pcRoutes.fetch(connectRequest(CONNECT_URL), env);
        expect(response.status).toBe(200);
      }

      const denied = await pcRoutes.fetch(connectRequest(CONNECT_URL), env);
      expect(denied.status).toBe(429);
      expect(userDO.fetched.length).toBe(KNOCKS_PER_WINDOW);
    } finally {
      setSystemTime();
    }
  });
});

describe('/pc/update-refused', () => {
  const refusal = {
    user: GOOD_USER, device: GOOD_DEVICE, nonce: GOOD_NONCE, signature: GOOD_SIGNATURE, version: '0.3.0+served', runtime: 'Bun 1.4.0', reason: 'Bun 1.4.2 install failed',
  };

  function post(body: string): Request {
    return new Request('https://kinu.test/pc/update-refused', { method: 'POST', body });
  }

  test('malformed JSON is a 400 before any namespace lookup', async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(post('{not json'), makeEnv(userDO));
    expect(response.status).toBe(400);
    expect(userDO.idNames).toEqual([]);
  });

  test('an oversized body is a 413 before parsing or naming a DO', async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(post(JSON.stringify({ ...refusal, padding: 'z'.repeat(32 * 1024) })), makeEnv(userDO));
    expect(response.status).toBe(413);
    expect(userDO.idNames).toEqual([]);
    expect(userDO.refusals).toEqual([]);
  });

  test('missing or malformed fields are 400 and never name a DO', async () => {
    for (const field of ['user', 'device', 'nonce', 'signature', 'version', 'runtime', 'reason']) {
      for (const value of [undefined, null, 123, '']) {
        const userDO = makeUserDO();
        const response = await pcRoutes.fetch(post(JSON.stringify({ ...refusal, [field]: value })), makeEnv(userDO));
        expect(response.status).toBe(400);
        expect(userDO.idNames).toEqual([]);
      }
    }
  });

  test('a blank version or runtime is refused, and bounded version, runtime and reason lengths are enforced', async () => {
    for (const fields of [
      { version: ' \n ' }, { version: 'v'.repeat(201) }, { runtime: ' ' }, { runtime: 'b'.repeat(201) }, { reason: 'r'.repeat(2001) },
    ]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(post(JSON.stringify({ ...refusal, ...fields })), makeEnv(userDO));
      expect(response.status).toBe(400);
      expect(userDO.idNames).toEqual([]);
    }
  });

  test('a real daemon reason and the supported length boundaries are accepted without truncation', async () => {
    for (const reason of ['r'.repeat(1000), '\u754c'.repeat(2000)]) {
      const userDO = makeUserDO();
      const version = 'v'.repeat(200);
      const response = await pcRoutes.fetch(post(JSON.stringify({ ...refusal, version: ` ${version} `, reason })), makeEnv(userDO));
      expect(response.status).toBe(200);
      expect(userDO.refusals).toEqual([{ version, runtime: 'Bun 1.4.0', reason }]);
    }
  });

  test('the user shape gate runs before idFromName', async () => {
    for (const user of ['not-a-user', GOOD_USER.slice(1), GOOD_USER.toUpperCase(), `${GOOD_USER}0`]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(post(JSON.stringify({ ...refusal, user })), makeEnv(userDO));
      expect(response.status).toBe(400);
      expect(userDO.idNames).toEqual([]);
    }
  });

  test("an earlier protocol's bearer is refused before idFromName, naming kinu update", async () => {
    const userDO = makeUserDO();
    const { user, version, runtime, reason } = refusal;
    const response = await pcRoutes.fetch(post(JSON.stringify({ user, token: EARLIER_TOKEN, version, runtime, reason })), makeEnv(userDO));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('kinu update');
    expect(userDO.idNames).toEqual([]);
    expect(userDO.refusals).toEqual([]);
  });

  test('a signature the device\'s key did not make records nothing', async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(post(JSON.stringify({ ...refusal, signature: WRONG_SIGNATURE })), makeEnv(userDO));
    expect(response.status).toBe(401);
    expect(userDO.refusals).toEqual([]);
  });

  test('the ingress knock budget is enforced in its own bucket before naming another DO', async () => {
    const userDO = makeUserDO();
    const env = makeEnv(userDO);

    // The budget is per minute window: every knock lands inside one, however slowly the run goes.
    setSystemTime(new Date('2026-01-01T00:00:00Z'));

    try {
      for (let knock = 0; knock < KNOCKS_PER_WINDOW; knock++) {
        expect((await pcRoutes.fetch(ticketPost(JSON.stringify({ ...GOOD_PROOF, signature: WRONG_SIGNATURE })), env)).status).toBe(401);
      }

      for (let knock = 0; knock < KNOCKS_PER_WINDOW; knock++) {
        expect((await pcRoutes.fetch(post(JSON.stringify({ ...refusal, signature: WRONG_SIGNATURE })), env)).status).toBe(401);
      }

      expect(userDO.idNames).toHaveLength(2 * KNOCKS_PER_WINDOW);
      expect((await pcRoutes.fetch(post(JSON.stringify(refusal)), env)).status).toBe(429);
      expect(userDO.idNames).toHaveLength(2 * KNOCKS_PER_WINDOW);
    } finally {
      setSystemTime();
    }
  });

  test('only POST records a refusal', async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(new Request('https://kinu.test/pc/update-refused'), makeEnv(userDO));
    expect(response.status).toBe(405);
    expect(userDO.idNames).toEqual([]);
  });
});

describe('/pc/join', () => {
  const join = (body: { readonly ticket: string; readonly label?: string; readonly publicKey?: string }) => new Request(JOIN_URL, {
    method: 'POST', body: JSON.stringify({ publicKey: GOOD_KEY, ...body }),
  });

  test("a connect command's ticket registers its device once, at the account the ticket names", async () => {
    const userDO = makeUserDO();
    const env = makeEnv(userDO);
    const joined = await pcRoutes.fetch(join({ ticket: GOOD_JOIN, label: 'Build box' }), env);

    expect(joined.status).toBe(201);
    // Nothing secret comes back: the machine keeps its key, and the hub its public half.
    expect(v.parse(v.record(v.string(), v.string()), await joined.json()))
      .toEqual({ deviceId: 'dev-issued', label: 'Build box', userId: GOOD_USER, origin: 'https://kinu.test' });
    expect(userDO.idNames).toEqual([GOOD_USER]);

    // Pasted twice, the account says why in words the person who pasted it can act on.
    const again = await pcRoutes.fetch(join({ ticket: GOOD_JOIN }), env);

    expect(again.status).toBe(400);
    expect(v.parse(v.object({ error: v.string() }), await again.json()).error).toContain('already used');
  });

  test('a ticket that is not one is refused before any namespace lookup, naming the way in that needs none', async () => {
    for (const ticket of ['', `pjt_${GOOD_USER}_short`, `pjt_NOTHEX_${"j".repeat(43)}`, GOOD_TICKET]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(join({ ticket }), makeEnv(userDO));

      expect(response.status).toBe(400);
      expect(v.parse(v.object({ error: v.string() }), await response.json()).error).toContain('kinu connect');
      expect(userDO.idNames).toEqual([]);
    }
  });

  test('a public key that is not 32 bytes as base64url is refused before any namespace lookup', async () => {
    for (const publicKey of ['', 'k'.repeat(42), 'k'.repeat(44), `${'k'.repeat(42)}+`]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(join({ ticket: GOOD_JOIN, publicKey }), makeEnv(userDO));

      expect(response.status).toBe(400);
      expect(userDO.idNames).toEqual([]);
    }
  });

  // Staging 0d1c0a5b1, 2026-10-23: a join with no key, as an earlier CLI sends it, was told its ticket was bad.
  test('a good ticket with no key, as an earlier Kinu command sends it, is told to update before any namespace lookup', async () => {
    const userDO = makeUserDO();
    const response = await pcRoutes.fetch(new Request(JOIN_URL, { method: 'POST', body: JSON.stringify({ ticket: GOOD_JOIN, label: 'Build box' }) }), makeEnv(userDO));

    expect(response.status).toBe(400);
    expect(v.parse(v.object({ error: v.string() }), await response.json()).error).toContain('kinu update');
    expect(userDO.idNames).toEqual([]);
  });

  test('the per-source budget bounds join attempts in their own bucket', async () => {
    const userDO = makeUserDO();
    const env = makeEnv(userDO);

    for (let knock = 0; knock < KNOCKS_PER_WINDOW; knock++) await pcRoutes.fetch(join({ ticket: `pjt_${GOOD_USER}_${String(knock).padStart(43, 'k')}` }), env);
    expect((await pcRoutes.fetch(join({ ticket: GOOD_JOIN }), env)).status).toBe(429);
    expect(userDO.joins).not.toContain(GOOD_JOIN);
    // Its own bucket: the daemon's ticket rail still answers.
    expect((await pcRoutes.fetch(ticketPost(JSON.stringify(GOOD_PROOF)), env)).status).toBe(200);
  });

  test('only POST joins', async () => {
    const userDO = makeUserDO();

    expect((await pcRoutes.fetch(new Request(JOIN_URL), makeEnv(userDO))).status).toBe(405);
    expect(userDO.idNames).toEqual([]);
  });
});

describe("the removed daemon-download rails", () => {
  // F7: the daemon ships inside the CLI release; no route here serves executable bytes.
  test("/pc/daemon.js and /pc/install are 404, and neither wakes a Durable Object", async () => {
    for (const url of ["https://kinu.test/pc/daemon.js", "https://kinu.test/pc/install"]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(new Request(url), makeEnv(userDO));
      expect(response.status).toBe(404);
      expect(response.headers.get("x-kinu-daemon-sha256")).toBeNull();
      expect(userDO.idNames).toEqual([]);
    }
  });
});

describe("no route answers with a script", () => {
  test("every /pc path but the tunnel's rails is a 404 without a body to execute", async () => {
    for (const path of ["/pc/daemon.js", "/pc/install", "/pc/agent.js", "/pc/"]) {
      const userDO = makeUserDO();
      const response = await pcRoutes.fetch(new Request(`https://kinu.test${path}`), makeEnv(userDO));
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).not.toBe("application/javascript; charset=utf-8");
      expect(response.headers.get("content-type")).not.toBe("text/x-shellscript; charset=utf-8");
    }
  });
});
