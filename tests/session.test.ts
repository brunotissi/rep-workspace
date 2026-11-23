import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../server/index";

const users: Record<string, string> = {
  alice: "005000000000001AAA",
  bob: "005000000000002AAA"
};
const account = "001000000000001AAA";
const opportunity = "006000000000001AAA";
const otherOpportunity = "006000000000002AAA";
const decisionContact = "003000000000001AAA";
const client = { clientId: "test-client", clientSecret: "test-secret" };
const page = (records: unknown[] = []) =>
  Response.json({ records, done: true });

async function local(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  function send(path: string, cookie?: string, method = "GET") {
    return new Promise<{
      status: number | undefined;
      location?: string;
      cookies: string[];
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          method,
          path,
          headers: {
            Host: "localhost:5173",
            Origin: "http://localhost:5173",
            ...(cookie ? { Cookie: cookie } : {})
          }
        },
        (res) => {
          res.setEncoding("utf8");
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({
              body,
              status: res.statusCode,
              location: res.headers.location,
              cookies: res.headers["set-cookie"] ?? []
            })
          );
        }
      );
      req.on("error", reject);
      req.end();
    });
  }
  async function begin() {
    const response = await send("/auth/login");
    assert.equal(response.status, 302);
    const redirect = new URL(response.location!);
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    const cookie = response.cookies[0].split(";")[0];
    const state = redirect.searchParams.get("state")!;
    const challenge = redirect.searchParams.get("code_challenge")!;
    return { cookie, state, challenge };
  }
  async function login(user: string) {
    const attempt = await begin();
    const callback =
      "/auth/callback?" +
      new URLSearchParams({ state: attempt.state, code: user });
    const response = await send(callback, attempt.cookie);
    assert.equal(response.location, "/");
    const cookie = response.cookies.find((value) =>
      value.startsWith("rep_session=")
    )!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    return { cookie: cookie.split(";")[0], callback, attempt };
  }
  return { send, begin, login, close: () => server.close() };
}

function tokenResponse(user: string, version = "original") {
  return Response.json({
    instance_url: "https://example.my.salesforce.com",
    access_token: user + "-" + version,
    refresh_token: user + "-refresh"
  });
}

test("OAuth sessions keep tokens and describe data separate, and snapshot access respects the rep's pipeline", async () => {
  const verifiers: Record<string, string> = {};
  const queries: Record<string, string[]> = { alice: [], bob: [] };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) {
      const form = init?.body as URLSearchParams;
      const name = form.get("code")!;
      verifiers[name] = form.get("code_verifier")!;
      return tokenResponse(name);
    }
    const name =
      new Headers(init?.headers)
        .get("authorization")
        ?.split(" ")[1]
        .split("-")[0] ?? "";
    assert.ok(users[name]);
    if (url.pathname.endsWith("/userinfo"))
      return Response.json({ user_id: users[name], preferred_username: name });
    if (url.pathname.endsWith("/Opportunity/describe"))
      return Response.json({
        queryable: true,
        fields: name === "alice" ? [{ name: "Amount" }] : []
      });
    if (url.pathname.includes("/describe"))
      return Response.json({ queryable: true, fields: [] });
    if (url.pathname.endsWith("/query")) {
      const query = url.searchParams.get("q")!;
      queries[name].push(query);
      if (query.includes("OwnerId =")) {
        assert.match(query, new RegExp(users[name]));
        if (
          name === "alice" &&
          (query.includes(opportunity) || query.includes(otherOpportunity))
        )
          return page([
            {
              Id: query.includes(otherOpportunity)
                ? otherOpportunity
                : opportunity
            }
          ]);
      }
      if (name === "alice" && query.includes("FROM Account WHERE Id ="))
        return page([{ Id: account, Name: "Alice's account" }]);
      if (
        name === "alice" &&
        query.startsWith("SELECT ContactId, OpportunityId")
      )
        return page([
          { ContactId: decisionContact, OpportunityId: otherOpportunity }
        ]);
      return page();
    }
    throw new Error("Unexpected simulated Salesforce route.");
  };
  const browser = await local(createApp({ ...client, transport }));
  try {
    const [alice, bob] = await Promise.all([
      browser.login("alice"),
      browser.login("bob")
    ]);
    assert.notEqual(alice.cookie, bob.cookie);
    for (const [name, session] of [
      ["alice", alice],
      ["bob", bob]
    ] as const) {
      assert.equal(
        createHash("sha256").update(verifiers[name]).digest("base64url"),
        session.attempt.challenge
      );
      const who = await browser.send("/api/session", session.cookie);
      assert.deepEqual(JSON.parse(who.body), { username: name });
      assert.equal(
        (await browser.send("/api/pipeline", session.cookie)).status,
        200
      );
    }
    assert.match(queries.alice[0], /FORMAT\(Amount\)/);
    assert.doesNotMatch(queries.bob[0], /Amount/);
    const forbidden = await browser.send(
      "/api/accounts/" + account + "?opportunity=" + opportunity,
      bob.cookie
    );
    assert.equal(forbidden.status, 404);
    assert.equal(queries.bob.length, 2);
    assert.match(
      queries.bob[1],
      new RegExp(account + ".*" + users.bob + ".*" + opportunity)
    );
    const available = await browser.send(
      "/api/accounts/" + account + "?opportunity=" + opportunity,
      alice.cookie
    );
    assert.equal(available.status, 200);
    const snapshot = JSON.parse(available.body);
    assert.equal(snapshot.account.Name, "Alice's account");
    assert.deepEqual(snapshot.decisionMakerIds, [decisionContact]);
    assert.deepEqual(snapshot.selectedDecisionMakerIds, []);
    assert.equal(snapshot.selectedDecisionMaker, false);
    const other = await browser.send(
      "/api/accounts/" + account + "?opportunity=" + otherOpportunity,
      alice.cookie
    );
    assert.equal(other.status, 200);
    const selected = JSON.parse(other.body);
    assert.deepEqual(selected.selectedDecisionMakerIds, [decisionContact]);
    assert.equal(selected.selectedDecisionMaker, true);
    assert.equal(
      (await browser.send(alice.callback, alice.attempt.cookie)).location,
      "/?error=oauth"
    );
    assert.equal(
      (await browser.send("/auth/logout", alice.cookie, "POST")).status,
      204
    );
    assert.equal(
      (await browser.send("/api/session", alice.cookie)).status,
      401
    );
    assert.equal((await browser.send("/api/session", bob.cookie)).status, 200);
  } finally {
    browser.close();
  }
});

test("transient refresh failure preserves the session, concurrent requests share a refresh, and revoked grants clear it", async () => {
  let mode: "temporary" | "success" | "revoked" = "temporary";
  let refreshes = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) {
      const form = init?.body as URLSearchParams;
      if (form.get("grant_type") === "authorization_code")
        return tokenResponse("alice");
      assert.equal(form.get("refresh_token"), "alice-refresh");
      refreshes++;
      if (mode === "temporary") return new Response(null, { status: 503 });
      if (mode === "revoked")
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return tokenResponse("alice", "renewed");
    }
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname.endsWith("/userinfo"))
      return Response.json({
        user_id: users.alice,
        preferred_username: "alice"
      });
    if (mode === "revoked" || authorization !== "Bearer alice-renewed")
      return new Response(null, { status: 401 });
    if (url.pathname.endsWith("/describe"))
      return Response.json({ queryable: true, fields: [] });
    return page();
  };
  const browser = await local(createApp({ ...client, transport }));
  try {
    const { cookie } = await browser.login("alice");
    const temporary = await browser.send("/api/pipeline", cookie);
    assert.equal(temporary.status, 503);
    assert.equal(temporary.cookies.length, 0);
    assert.doesNotMatch(temporary.body, /alice-refresh|test-secret/);
    mode = "success";
    const refreshed = await Promise.all([
      browser.send("/api/pipeline", cookie),
      browser.send("/api/pipeline", cookie)
    ]);
    assert.deepEqual(
      refreshed.map((result) => result.status),
      [200, 200]
    );
    assert.equal(refreshes, 2);
    mode = "revoked";
    const revoked = await browser.send("/api/pipeline", cookie);
    assert.equal(revoked.status, 401);
    assert.match(revoked.cookies.join(" "), /rep_session=;/);
    assert.equal((await browser.send("/api/session", cookie)).status, 401);
  } finally {
    browser.close();
  }
});

test("expired local sessions and logout invalidate authentication without a Salesforce write", async () => {
  let time = 100;
  let exchanges = 0;
  const transport: typeof fetch = async () => {
    exchanges++;
    return tokenResponse("alice");
  };
  const browser = await local(
    createApp({ ...client, transport, now: () => time })
  );
  try {
    const attempt = await browser.begin();
    assert.equal(
      (await browser.send("/auth/logout", attempt.cookie, "POST")).status,
      204
    );
    const callback =
      "/auth/callback?" +
      new URLSearchParams({ state: attempt.state, code: "alice" });
    assert.equal(
      (await browser.send(callback, attempt.cookie)).location,
      "/?error=oauth"
    );
    assert.equal(exchanges, 0);
    const login = await browser.login("alice");
    time += 8 * 60 * 60 * 1000;
    const expired = await browser.send("/api/session", login.cookie);
    assert.equal(expired.status, 401);
    assert.match(expired.cookies.join(" "), /rep_session=;/);
    assert.equal(exchanges, 1);
  } finally {
    browser.close();
  }
});

test("an in-flight identity read cannot publish a logged-out session's result", async () => {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: typeof fetch = async (input) => {
    if (String(input).endsWith("/token")) return tokenResponse("alice");
    start();
    await hold;
    return Response.json({
      user_id: users.alice,
      preferred_username: "Alice private identity"
    });
  };
  const browser = await local(createApp({ ...client, transport }));
  try {
    const { cookie } = await browser.login("alice");
    const pending = browser.send("/api/session", cookie);
    await started;
    assert.equal(
      (await browser.send("/auth/logout", cookie, "POST")).status,
      204
    );
    release();
    const response = await pending;
    assert.equal(response.status, 401);
    assert.doesNotMatch(response.body, /Alice private identity/);
    assert.equal(response.cookies.length, 0);
  } finally {
    release();
    browser.close();
  }
});
