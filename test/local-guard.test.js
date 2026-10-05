// The bridge spends on every /v1/responses call, so a web page in the user's
// browser must not reach it. Native clients (Codex) send no Origin and pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createBridge } from "../src/server.js";

function startBridge() {
  let upstreamCalls = 0;
  const fetchImpl = async () => {
    upstreamCalls++;
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  };
  const server = createBridge({ upstream: "http://direct/v1", fetchImpl });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, calls: () => upstreamCalls }),
    );
  });
}

function send(port, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = request(
      { host: "127.0.0.1", port, path, method: body ? "POST" : "GET", headers, agent: false },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

test("a drive-by text/plain POST from a web page is refused before any spend", async () => {
  const { server, port, calls } = await startBridge();
  try {
    const res = await send(
      port,
      "/v1/responses",
      { Origin: "https://evil.example", "Content-Type": "text/plain" },
      JSON.stringify({ model: "x", input: "hi" }),
    );
    assert.equal(res.status, 403);
    assert.equal(calls(), 0);

    const toggle = await send(port, "/dashboard/api/toggle?name=x&on=1", { Origin: "https://evil.example" }, "x");
    assert.equal(toggle.status, 403, "dashboard switches are not reachable cross-site");
  } finally {
    server.close();
  }
});

test("DNS-rebinding Host and Sec-Fetch-Site: cross-site are refused", async () => {
  const { server, port } = await startBridge();
  try {
    assert.equal((await send(port, "/health", { Host: `attacker.example:${port}` })).status, 403);
    assert.equal((await send(port, "/health", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  } finally {
    server.close();
  }
});

test("native clients and the same-origin dashboard still work", async () => {
  const { server, port } = await startBridge();
  try {
    assert.equal((await send(port, "/health")).status, 200);
    assert.equal((await send(port, "/health", { Origin: `http://127.0.0.1:${port}` })).status, 200);
  } finally {
    server.close();
  }
});
