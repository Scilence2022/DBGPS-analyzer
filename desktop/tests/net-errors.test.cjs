const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { networkFailure, describeNetworkFailure, cleanIpcError, isLoopbackHost } = require("../dist/net-errors.js");

function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("a real refused connection is classified and explained for a local server", async () => {
  const port = await closedPort();
  const url = `http://localhost:${port}/v1/chat/completions`;
  let caught;
  try { await fetch(url); } catch (error) { caught = error; }
  assert.ok(caught, "fetch should reject");
  assert.equal(networkFailure(caught).kind, "refused");
  const message = describeNetworkFailure(caught, url);
  assert.match(message, new RegExp(`Cannot connect to http://localhost:${port}`));
  assert.match(message, /ollama serve/);
  assert.doesNotMatch(message, /fetch failed/);
});

test("endpoint is hidden when requested and remote refusal points at settings", () => {
  const error = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
  const hidden = describeNetworkFailure(error, "https://api.example.com/v1", false);
  assert.doesNotMatch(hidden, /example\.com/);
  assert.match(hidden, /Settings → Providers/);
  assert.match(describeNetworkFailure(error, "https://api.example.com/v1"), /https:\/\/api\.example\.com/);
});

test("dns, timeout, reset, tls and dual-stack aggregate errors map to kinds", () => {
  const wrap = (cause) => Object.assign(new TypeError("fetch failed"), { cause });
  assert.equal(networkFailure(wrap({ code: "ENOTFOUND" })).kind, "dns");
  assert.equal(networkFailure(wrap({ code: "UND_ERR_CONNECT_TIMEOUT" })).kind, "timeout");
  assert.equal(networkFailure(wrap({ code: "ECONNRESET" })).kind, "reset");
  assert.equal(networkFailure(wrap({ code: "CERT_HAS_EXPIRED" })).kind, "tls");
  assert.equal(networkFailure(wrap({ errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] })).kind, "refused");
  assert.equal(networkFailure(new TypeError("fetch failed")).kind, "other");
});

test("aborts and ordinary errors are not rewritten", () => {
  assert.equal(networkFailure(Object.assign(new Error("aborted"), { name: "AbortError" })), null);
  assert.equal(networkFailure(new Error("Provider request failed (404)")), null);
  assert.equal(describeNetworkFailure(new RangeError("x"), "http://localhost"), null);
});

test("electron's IPC prefix is stripped from displayed errors", () => {
  assert.equal(cleanIpcError("Error invoking remote method 'ai:chat': TypeError: fetch failed"), "fetch failed");
  assert.equal(cleanIpcError("Error invoking remote method 'ai:chat': Error: Cannot connect to http://localhost:11434"), "Cannot connect to http://localhost:11434");
  assert.equal(cleanIpcError("plain message"), "plain message");
  assert.ok(isLoopbackHost("127.0.0.1") && isLoopbackHost("[::1]") && !isLoopbackHost("api.openai.com"));
});
