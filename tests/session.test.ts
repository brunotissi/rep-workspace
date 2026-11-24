import { decodePipeline } from "../client/pipeline";
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
        if (query.includes("ORDER BY Id") && name === "alice")
          return page([
            {
              Id: opportunity,
              AccountId: account,
              Name: "Overdue deal",
              CloseDate: "2000-01-01"
            }
          ]);
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
      const response = await browser.send("/api/pipeline", session.cookie);
      assert.equal(response.status, 200);
      const pipeline = decodePipeline(JSON.parse(response.body));
      assert.deepEqual(
        pipeline.rows.map((row) => row.health.status),
        name === "alice" ? ["Red"] : []
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

test("Pipeline HTTP sanitizes quota and continuation failures and recovers without partial rows", async () => {
  let mode: "quota429" | "quota403" | "continuation" | "ok" = "quota429";
  let mutations = 0;
  const privateText =
    "synthetic private upstream body SELECT Id FROM Opportunity";
  const cursor = "/services/data/v68.0/query/f3-next";
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) return tokenResponse("alice");
    if (init?.method && init.method !== "GET") {
      mutations++;
      throw new Error("Unexpected mutation");
    }
    if (url.pathname.endsWith("/userinfo"))
      return Response.json({
        user_id: users.alice,
        preferred_username: "alice"
      });
    if (url.pathname.endsWith("/describe"))
      return Response.json({
        queryable: true,
        fields: [{ name: "CloseDate" }]
      });
    if (url.pathname === cursor)
      return Response.json(
        [{ errorCode: "UNKNOWN_EXCEPTION", message: privateText }],
        { status: 500 }
      );
    const sql = url.searchParams.get("q") ?? "";
    if (sql.includes("FROM Opportunity WHERE")) {
      if (mode === "quota429" || mode === "quota403")
        return Response.json(
          [
            {
              errorCode:
                mode === "quota403" ? "REQUEST_LIMIT_EXCEEDED" : "OTHER",
              message: privateText
            }
          ],
          { status: mode === "quota403" ? 403 : 429 }
        );
      const row = {
        Id: opportunity,
        Name: "Synthetic renewal",
        CloseDate: "2026-11-15"
      };
      return mode === "continuation"
        ? Response.json({ records: [row], done: false, nextRecordsUrl: cursor })
        : page([row]);
    }
    if (sql.includes("FROM OpportunityContactRole")) return page();
    throw new Error("Unexpected mock route");
  };
  const browser = await local(
    createApp({
      ...client,
      transport,
      now: () => Date.parse("2026-11-24T00:00:00Z")
    })
  );
  try {
    const { cookie } = await browser.login("alice");
    for (const failure of ["quota429", "quota403", "continuation"] as const) {
      mode = failure;
      const response = await browser.send("/api/pipeline", cookie);
      assert.equal(response.status, failure === "continuation" ? 502 : 429);
      assert.deepEqual(JSON.parse(response.body), {
        error:
          failure === "continuation"
            ? "Salesforce could not load this information."
            : "The Salesforce API limit was reached. Try again later.",
        uncertain: false
      });
    }
    mode = "ok";
    const recovered = await browser.send("/api/pipeline", cookie);
    assert.equal(recovered.status, 200);
    assert.deepEqual(
      decodePipeline(JSON.parse(recovered.body)).rows.map((row) => row.Id),
      [opportunity]
    );
    assert.equal(mutations, 0);
  } finally {
    browser.close();
  }
});

test("Snapshot HTTP partial reads preserve known overdue evidence without inventing activity or role absence", async () => {
  let failure: "Contact" | "Task" | "Event" | "Role" = "Contact";
  let mutations = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) return tokenResponse("alice");
    if (init?.method && init.method !== "GET") {
      mutations++;
      throw new Error("Unexpected mutation");
    }
    if (url.pathname.endsWith("/userinfo"))
      return Response.json({
        user_id: users.alice,
        preferred_username: "alice"
      });
    if (url.pathname.endsWith("/describe"))
      return Response.json({
        queryable: true,
        fields: [
          "CloseDate",
          "AccountId",
          "ActivityDate",
          "Subject",
          "Title"
        ].map((name) => ({ name }))
      });
    const sql = url.searchParams.get("q") ?? "";
    if (
      sql.includes(
        "FROM " +
          (failure === "Role" ? "OpportunityContactRole" : failure) +
          " "
      )
    )
      return Response.json(
        [
          {
            errorCode: "INVALID_FIELD",
            message: "Synthetic private query text"
          }
        ],
        { status: 400 }
      );
    if (sql.includes("FROM Account"))
      return page([{ Id: account, Name: "Synthetic account" }]);
    if (sql.includes("MIN(CloseDate)"))
      return page([
        { AccountId: account, openCount: 1, nearestClose: "2026-11-15" }
      ]);
    if (sql.includes("FROM Opportunity WHERE")) {
      const overdue = {
        Id: opportunity,
        Name: "Synthetic renewal",
        AccountId: account,
        CloseDate: "2026-11-15"
      };
      return page(
        sql.includes("ORDER BY Id") && sql.includes("OwnerId")
          ? [
              overdue,
              {
                ...overdue,
                Id: otherOpportunity,
                Name: "Later renewal",
                CloseDate: "2026-12-15"
              }
            ]
          : [overdue]
      );
    }
    return page();
  };
  const browser = await local(
    createApp({
      ...client,
      transport,
      now: () => Date.parse("2026-11-24T00:00:00Z")
    })
  );
  try {
    const { cookie } = await browser.login("alice");
    for (const missing of ["Contact", "Task", "Event", "Role"] as const) {
      failure = missing;
      const response = await browser.send(
        "/api/accounts/" + account + "?opportunity=" + opportunity,
        cookie
      );
      assert.equal(response.status, 200);
      assert.doesNotMatch(
        response.body,
        /Synthetic private query text|INVALID_FIELD|test-secret|alice-refresh/
      );
      const snapshot = JSON.parse(response.body);
      assert.equal(snapshot.account.Id, account);
      assert.equal(snapshot.opportunities.data[0].Id, opportunity);
      assert.equal(snapshot.health.data.status, "Red");
      assert.match(snapshot.health.data.reasons.join(" "), /overdue/);
      if (missing === "Role") {
        assert.equal(snapshot.selectedDecisionMaker, undefined);
        assert.equal(snapshot.selectedDecisionMakerIds, undefined);
        assert.doesNotMatch(
          snapshot.health.data.reasons.join(" "),
          /No decision-maker role is visible/
        );
        assert.ok(
          !snapshot.actions.items.some(
            (item: { kind: string }) => item.kind === "contactRole"
          )
        );
      } else {
        const section =
          snapshot[
            ({ Contact: "contacts", Task: "tasks", Event: "events" } as const)[
              missing
            ]
          ];
        assert.deepEqual(section, {
          error:
            "This information is unavailable with your Salesforce permissions."
        });
      }
      if (missing === "Task" || missing === "Event") {
        assert.equal(snapshot.health.data.activity, undefined);
        assert.equal(snapshot.actions.followUp.activity, "unknown");
        assert.equal(snapshot.actions.followUp.lookup, "skipped");
        assert.ok(
          !snapshot.actions.items.some(
            (item: { kind: string }) => item.kind === "task"
          )
        );
      }
    }
    const pipelineResponse = await browser.send("/api/pipeline", cookie);
    assert.equal(pipelineResponse.status, 200);
    const pipeline = decodePipeline(JSON.parse(pipelineResponse.body));
    assert.deepEqual(
      pipeline.rows.map((row) => row.health.reasonCodes),
      [["overdue", "unknownDecisionMaker"], ["unknownDecisionMaker"]]
    );
    assert.equal(pipeline.rows[0].health.status, "Red");
    assert.equal(pipeline.rows[1].health.unassessed, true);
    assert.equal(mutations, 0);
  } finally {
    browser.close();
  }
});

test("Pipeline allowed empty scope and a subsequently unavailable selection have distinct HTTP responses", async () => {
  let available = false;
  let mutations = 0;
  const row = {
    Id: opportunity,
    Name: "Synthetic owned deal",
    AccountId: account,
    CloseDate: "2026-11-15"
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/token")) return tokenResponse("alice");
    if (init?.method && init.method !== "GET") {
      mutations++;
      throw new Error("Unexpected mutation");
    }
    if (url.pathname.endsWith("/userinfo"))
      return Response.json({
        user_id: users.alice,
        preferred_username: "alice"
      });
    if (url.pathname.endsWith("/describe"))
      return Response.json({
        queryable: true,
        fields: ["AccountId", "CloseDate"].map((name) => ({ name }))
      });
    const sql = url.searchParams.get("q") ?? "";
    if (sql.includes("FROM Opportunity WHERE")) {
      assert.ok(sql.includes("OwnerId = '" + users.alice + "'"));
      return page(available ? [row] : []);
    }
    if (sql.includes("FROM Account"))
      return page([{ Id: account, Name: "Synthetic account" }]);
    if (sql.includes("FROM OpportunityContactRole")) return page();
    throw new Error("Unexpected mock route");
  };
  const browser = await local(
    createApp({
      ...client,
      transport,
      now: () => Date.parse("2026-11-24T00:00:00Z")
    })
  );
  try {
    const { cookie } = await browser.login("alice");
    const empty = await browser.send("/api/pipeline", cookie);
    assert.equal(empty.status, 200);
    assert.deepEqual(decodePipeline(JSON.parse(empty.body)).rows, []);

    available = true;
    const loaded = await browser.send("/api/pipeline", cookie);
    assert.equal(loaded.status, 200);
    assert.deepEqual(
      decodePipeline(JSON.parse(loaded.body)).rows.map((record) => record.Id),
      [opportunity]
    );

    available = false;
    const selection = await browser.send(
      "/api/accounts/" + account + "?opportunity=" + opportunity,
      cookie
    );
    assert.equal(selection.status, 404);
    assert.deepEqual(JSON.parse(selection.body), {
      error:
        "The selected account or opportunity is unavailable in your pipeline.",
      uncertain: false
    });
    assert.equal(mutations, 0);
  } finally {
    browser.close();
  }
});
