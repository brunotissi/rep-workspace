import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { app } from "../server/index";

test("action endpoint rejects anonymous, cross-origin, unsupported, and malformed requests", async () => {
  const server = app.listen(0, "127.0.0.1");
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
