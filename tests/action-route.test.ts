import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../server/index";

test("action endpoint rejects anonymous, cross-origin, unsupported, and malformed requests", async () => {
  const server = createApp({
    transport: async () => {
      throw new Error("Unexpected outbound request");
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  function post(origin: string, contentType: string, body: string) {
    return new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/actions",
          method: "POST",
          headers: {
            Host: "localhost:5173",
            Origin: origin,
            "Content-Type": contentType,
            "Content-Length": Buffer.byteLength(body)
          }
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  }
  try {
    const localhost = "http://localhost:5173";
    const json = "application/json";
    assert.equal(await post(localhost, json, "{}"), 401);
    assert.equal(await post("http://example.com", json, "{}"), 403);
    assert.equal(await post(localhost, "text/plain", "{}"), 415);
    assert.equal(await post(localhost, json, "{"), 400);
  } finally {
    server.close();
  }
});

const accountId = "001000000000001AAA";
const foreignAccountId = "001000000000002AAA";
const opportunityId = "006000000000001AAA";
const userId = "005000000000001AAA";
const contactId = "003000000000001AAA";
const closeDate = {
  kind: "closeDate",
  accountId,
  opportunityId,
  previousDate: "2026-11-15",
  date: "2026-11-25"
};
const invalidDate = "Enter a valid date between today and 2099-12-31.";

const rejectionCases = [
  {
    name: "anonymous well-formed action",
    anonymous: true,
    body: closeDate,
    status: 401,
    message: "Unauthorized",
    reads: []
  },
  {
    name: "authenticated action with an invalid field",
    body: { ...closeDate, previousDate: null },
    status: 400,
    message: "The action is missing a valid date or contact.",
    reads: []
  },
  {
    name: "authenticated action for a mismatched account",
    body: { ...closeDate, accountId: foreignAccountId },
    status: 404,
    message:
      "The selected account or opportunity is unavailable in your pipeline.",
    reads: ["describe", "opportunity"]
  },
  {
    name: "authenticated role action for a contact outside the account",
    body: { kind: "contactRole", accountId, opportunityId, contactId },
    status: 400,
    message: "Select a visible contact from this account.",
    reads: ["opportunity", "contact"]
  },
  {
    name: "authenticated close-date action with a past date",
    body: { ...closeDate, date: "2026-11-23" },
    status: 400,
    message: invalidDate,
    reads: []
  },
  {
    name: "authenticated close-date action with an impossible date",
    body: { ...closeDate, date: "2027-02-29" },
    status: 400,
    message: invalidDate,
    reads: []
  }
];

for (const scenario of rejectionCases) {
  test(
    "HTTP rejects " + scenario.name + " without a Salesforce write",
    async () => {
      const reads: string[] = [];
      const mutations: string[] = [];
      const unexpected: string[] = [];
      const app = createApp({
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        now: () => Date.parse("2026-11-24T00:00:00Z"),
        transport: async (input, init) => {
          const url = new URL(String(input));
          if (
            url.pathname === "/services/oauth2/token" &&
            init?.method === "POST"
          )
            return Response.json({
              access_token: "fixture-access-token",
              instance_url: "https://example.my.salesforce.com"
            });
          if (init?.method && init.method !== "GET") {
            mutations.push(init.method);
            throw new Error("Unexpected outbound mutation in F1");
          }
          if (url.pathname === "/services/oauth2/userinfo")
            return Response.json({
              user_id: userId,
              preferred_username: "fixture-rep"
            });
          if (url.pathname.endsWith("/Opportunity/describe")) {
            reads.push("describe");
            return Response.json({
              queryable: true,
              updateable: true,
              fields: [{ name: "CloseDate", updateable: true }]
            });
          }
          const soql = url.searchParams.get("q") ?? "";
          if (soql.includes("FROM Opportunity WHERE")) {
            reads.push("opportunity");
            assert.match(soql, new RegExp("OwnerId = '" + userId + "'"));
            assert.match(soql, new RegExp("Id = '" + opportunityId + "'"));
            const records = soql.includes("AccountId = '" + accountId + "'")
              ? [{ Id: opportunityId, CloseDate: closeDate.previousDate }]
              : [];
            return Response.json({ records, done: true });
          }
          if (soql.includes("FROM Contact WHERE")) {
            reads.push("contact");
            assert.match(soql, new RegExp("Id = '" + contactId + "'"));
            assert.match(soql, new RegExp("AccountId = '" + accountId + "'"));
            return Response.json({ records: [], done: true });
          }
          unexpected.push(url.pathname);
          throw new Error("No mocked response for request");
        }
      });
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      function send(path: string, cookie?: string, body?: object) {
        return new Promise<{
          status?: number;
          location?: string;
          cookies: string[];
          body: string;
        }>((resolve, reject) => {
          const data = body && JSON.stringify(body);
          const req = request(
            {
              hostname: "127.0.0.1",
              port,
              path,
              method: data ? "POST" : "GET",
              headers: {
                Host: "localhost:5173",
                Origin: "http://localhost:5173",
                ...(cookie ? { Cookie: cookie } : {}),
                ...(data
                  ? {
                      "Content-Type": "application/json",
                      "Content-Length": Buffer.byteLength(data)
                    }
                  : {})
              }
            },
            (res) => {
              let raw = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                raw += chunk;
              });
              res.on("end", () =>
                resolve({
                  status: res.statusCode,
                  location: res.headers.location,
                  cookies: res.headers["set-cookie"] ?? [],
                  body: raw
                })
              );
            }
          );
          req.on("error", reject);
          req.end(data);
        });
      }
      try {
        let cookie: string | undefined;
        if (!scenario.anonymous) {
          const login = await send("/auth/login");
          assert.equal(login.status, 302);
          const state = new URL(login.location!).searchParams.get("state");
          assert.ok(state);
          const callback = await send(
            "/auth/callback?" +
              new URLSearchParams({ state, code: "fixture-code" }),
            login.cookies[0].split(";")[0]
          );
          assert.equal(callback.location, "/");
          cookie = callback.cookies
            .find((value) => value.startsWith("rep_session="))
            ?.split(";")[0];
          assert.ok(cookie);
        }
        const result = await send("/api/actions", cookie, scenario.body);
        assert.equal(result.status, scenario.status);
        if (scenario.anonymous) assert.equal(result.body, scenario.message);
        else
          assert.deepEqual(JSON.parse(result.body), {
            error: scenario.message,
            uncertain: false
          });
        assert.deepEqual(reads, scenario.reads);
        assert.deepEqual(mutations, []);
        assert.deepEqual(unexpected, []);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
}
