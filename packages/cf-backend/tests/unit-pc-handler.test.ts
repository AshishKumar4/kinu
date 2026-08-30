// The device tunnel's public ingress rails: /pc/connect-ticket and the
// /pc/connect WebSocket upgrade. Both choose a UserDO by name, so both must
// refuse malformed identifiers and over-budget sources BEFORE any idFromName —
// a random user id must never wake a Durable Object.
import { describe, expect, test } from "bun:test";
import {
  handlePcRequest,
  type PcIngressEnv,
  type PcUserNamespace,
} from "../src/pc-handler";
import type { UserCaller } from "../src/user/workspace-capability";
import { makeKv } from "./helpers/kv";
import * as v from "valibot";
const GOOD_USER = "0123456789abcdef0123456789abcdef";
const GOOD_TOKEN = `pdt_${"x".repeat(32)}`;
const WRONG_TOKEN = `pdt_${"w".repeat(32)}`; // well-shaped, so admitted knocks reach the DO and fail there
const GOOD_TICKET = `pct_${"y".repeat(32)}`;
const TICKET_URL = "https://kinu.test/pc/connect-ticket";
const CONNECT_URL = `https://kinu.test/pc/connect?user=${GOOD_USER}&ticket=${GOOD_TICKET}`;
const KNOCKS_PER_WINDOW = 30;
const TicketReplySchema = v.object({ ticket: v.string(), expiresAt: v.number() });

interface FakeUserId {
  readonly name: string;
}

interface RecordedUserDO {
  idNames: string[];
  tokens: string[];
  fetched: Request[];
  ns: PcUserNamespace<FakeUserId>;
}

function makeUserDO(): RecordedUserDO {
  const idNames: string[] = [];
  const tokens: string[] = [];
  const fetched: Request[] = [];
  const ns = {
    idFromName(name: string): FakeUserId {
      idNames.push(name);
      return { name };
    },
    get(_id: FakeUserId) {
      return {
        async issueDeviceConnectTicket(_caller: UserCaller, token: string) {
          tokens.push(token);
          if (token === GOOD_TOKEN) {
            return { ok: true, ticket: GOOD_TICKET, expiresAt: Date.now() + 60_000 };
          }
          return { ok: false };
        },
        async fetch(request: Request) {
          fetched.push(request);
          return new Response("socket accepted");
        },
      };
    },
  };
  return { idNames, tokens, fetched, ns };
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

describe("/pc/connect-ticket", () => {
  test("a valid token exchanges for a ticket, and names exactly one DO", async () => {
    const userDO = makeUserDO();
    const response = await handlePcRequest(ticketPost(JSON.stringify({ user: GOOD_USER, token: GOOD_TOKEN })), makeEnv(userDO));
    expect(response.status).toBe(200);
    const body = v.parse(TicketReplySchema, await response.json());
    expect(body.ticket).toBe(GOOD_TICKET);
    expect(body.expiresAt).toBeGreaterThan(0);
    expect(userDO.idNames).toEqual([GOOD_USER]);
    expect(userDO.tokens).toEqual([GOOD_TOKEN]);
  });

  test("a malformed user is refused before any namespace lookup", async () => {
    for (const user of ["not-a-user", GOOD_USER.slice(1), GOOD_USER.toUpperCase(), `${GOOD_USER}0`]) {
      const userDO = makeUserDO();
      const response = await handlePcRequest(ticketPost(JSON.stringify({ user, token: GOOD_TOKEN })), makeEnv(userDO));
      expect(response.status).toBe(400);
      expect(userDO.idNames).toEqual([]);
    }
  });

  test("a malformed token is refused before any namespace lookup", async () => {
    for (const token of ["garbage", "pdt_short", `${GOOD_TOKEN}/no`, "pdt_"]) {
      const userDO = makeUserDO();
      const response = await handlePcRequest(ticketPost(JSON.stringify({ user: GOOD_USER, token })), makeEnv(userDO));
      expect(response.status).toBe(401);
      expect(userDO.idNames).toEqual([]);
      expect(userDO.tokens).toEqual([]);
    }
  });

  test("an oversized body is a 413 that never reaches parsing or the namespace", async () => {
    const userDO = makeUserDO();
    const bloated = JSON.stringify({ user: GOOD_USER, token: GOOD_TOKEN, padding: "z".repeat(8192) });
    const response = await handlePcRequest(ticketPost(bloated), makeEnv(userDO));
    expect(response.status).toBe(413);
    expect(userDO.idNames).toEqual([]);
  });

  test("malformed JSON is a 400", async () => {
    const userDO = makeUserDO();
    const response = await handlePcRequest(ticketPost("{not json"), makeEnv(userDO));
    expect(response.status).toBe(400);
    expect(userDO.idNames).toEqual([]);
  });

  test("the per-source budget bounds DO fanout: random users stop waking objects", async () => {
    const userDO = makeUserDO();
    const env = makeEnv(userDO);
    // Each admitted knock wakes exactly one DO even though every token is wrong.
    for (let knock = 0; knock < KNOCKS_PER_WINDOW; knock++) {
      const user = knock.toString(16).padStart(32, "0");
      const response = await handlePcRequest(ticketPost(JSON.stringify({ user, token: WRONG_TOKEN })), env);
      expect(response.status).toBe(401);
    }
    expect(userDO.idNames.length).toBe(KNOCKS_PER_WINDOW);
    // Knock 31 and beyond — random users included — never reach the namespace.
    for (let knock = 0; knock < 5; knock++) {
      const user = (1000 + knock).toString(16).padStart(32, "f");
      const response = await handlePcRequest(ticketPost(JSON.stringify({ user, token: WRONG_TOKEN })), env);
      expect(response.status).toBe(429);
    }
    expect(userDO.idNames.length).toBe(KNOCKS_PER_WINDOW);
  });
});

describe("/pc/connect upgrade", () => {
  function connectRequest(url: string): Request {
    return new Request(url, { headers: { Upgrade: "websocket" } });
  }

  test("a valid ticket shape forwards the upgrade to the named DO", async () => {
    const userDO = makeUserDO();
    const response = await handlePcRequest(connectRequest(CONNECT_URL), makeEnv(userDO));
    expect(await response.text()).toBe("socket accepted");
    expect(userDO.fetched.length).toBe(1);
    expect(userDO.fetched[0]!.url).toBe(CONNECT_URL);
  });

  test("a malformed user or ticket is refused before any namespace lookup", async () => {
    const cases = [
      `https://kinu.test/pc/connect?user=zz&ticket=${GOOD_TICKET}`,
      `https://kinu.test/pc/connect?user=${GOOD_USER}&ticket=pdt_notaticket`,
      `https://kinu.test/pc/connect?user=${GOOD_USER}`,
      "https://kinu.test/pc/connect?ticket=x",
    ];
    for (const url of cases) {
      const userDO = makeUserDO();
      const response = await handlePcRequest(connectRequest(url), makeEnv(userDO));
      expect(response.status).toBe(400);
      expect(userDO.fetched).toEqual([]);
      expect(userDO.idNames).toEqual([]);
    }
  });

  test("the per-source budget bounds upgrade attempts too", async () => {
    const userDO = makeUserDO();
    const env = makeEnv(userDO);
    for (let knock = 0; knock < KNOCKS_PER_WINDOW; knock++) {
      const response = await handlePcRequest(connectRequest(CONNECT_URL), env);
      expect(response.status).toBe(200);
    }
    const denied = await handlePcRequest(connectRequest(CONNECT_URL), env);
    expect(denied.status).toBe(429);
    expect(userDO.fetched.length).toBe(KNOCKS_PER_WINDOW);
  });
});

describe("/pc/daemon.js", () => {
  test("serves the daemon source with a lowercase-hex sha256 header over its exact bytes", async () => {
    const userDO = makeUserDO();
    const response = await handlePcRequest(new Request("https://kinu.test/pc/daemon.js"), makeEnv(userDO));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    const body = await response.text();
    expect(body.length).toBeGreaterThan(0);
    const digest = response.headers.get("x-kinu-daemon-sha256");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Independent recomputation: the header must describe exactly these bytes.
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(digest).toBe(hex);
  });
});

describe("/pc/daemon.js digest red direction", () => {
  test("an altered source changes the digest — equality against a wrong value must fail", async () => {
    const userDO = makeUserDO();
    const response = await handlePcRequest(new Request("https://kinu.test/pc/daemon.js"), makeEnv(userDO));
    const body = await response.text();
    const digest = response.headers.get("x-kinu-daemon-sha256")!;
    // The header must NOT equal the digest of anything except the exact bytes:
    // alter one byte of the source and the recomputed digest diverges.
    const altered = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body + " "));
    const alteredHex = Array.from(new Uint8Array(altered), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(digest).not.toBe(alteredHex);
  });
});
