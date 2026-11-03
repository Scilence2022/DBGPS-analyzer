const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractClaims, evidenceNumbers, verifyAgentAnswer, revisionNote } = require("../dist/agent-verify.js");
const { runReadOnlyAgent } = require("../dist/agent.js");
const { verificationLabel, summarizeVerification, normalizeMessage } = require("../dist/agent-ui.js");

const ok = (data, name = "get_decodability") => ({ callId: "c", name, arguments: {}, snapshotId: "s", status: "ok", startedAt: "", result: { ok: true, data } });
const check = (answer, trace, question = "") => verifyAgentAnswer({ answer, question, system: "", snapshot: {}, trace });

test("claims skip list markers and small values but keep commas, decimals and percents", () => {
  const claims = extractClaims("1. Strand 101010311 fails at k-mer 50.\n2) Yield 203,145 (96.7%), ratio 3.7, cutoff 1.\nSee F1 and v2.");
  assert.deepEqual(claims.map((c) => c.text), ["101010311", "50", "203,145", "96.7%", "3.7"]);
  assert.equal(claims[2].value, 203145);
  assert.equal(claims[3].percent, true);
  assert.equal(claims[4].decimals, 1);
});

test("evidence numbers come from JSON values and from numbers written in strings", () => {
  const { all, totals } = evidenceNumbers([{ total: 210000, name: "101010311", rows: Array.from({ length: 20 }, (_, i) => ({ coverage: 1000 + i, total: 5 })) }, "at 95.4%"]);
  assert.ok(all.includes(210000) && all.includes(101010311) && all.includes(1007));
  assert.ok(Math.abs(all.find((v) => v > 0.95 && v < 0.96) - 0.954) < 1e-12);
  assert.deepEqual(totals, [210000], "a total inside a page of rows is not a reported total");
});

test("values read from evidence, sums, differences and shares are traced; others are not", () => {
  const trace = [ok({ total: 210000, configs: [{ decodable: 203145 }, { decodable: 208625 }] }), ok({ rows: [{ name: "101010311", failure: "ratio_rise", position: 50 }] })];
  const v = check("Strand 101010311 fails at k-mer 50. Exempting the hotspots recovers 5,480 more strands, 208,625 against 203,145 (99.3% of 210,000). It would also fix 4,321 others.", trace);
  const status = Object.fromEntries(v.values.map((item) => [item.text, item.status]));
  assert.equal(status["101010311"], "supported");
  assert.equal(status["50"], "supported");
  assert.equal(status["5,480"], "derived");
  assert.equal(status["208,625"], "supported");
  assert.equal(status["99.3%"], "derived");
  assert.equal(status["4,321"], "unsupported");
  assert.equal(v.unsupported, 1);
  assert.equal(v.checked, 8);
  assert.match(revisionNote(v), /4,321/);
});

test("a derived value needs its operands stated in the answer", () => {
  const trace = [ok({ total: 210000, configs: [{ decodable: 203145 }, { decodable: 208625 }], failures: { a: 8735, b: 186892 } })];
  assert.equal(check("It recovers 5,480 more strands.", trace).unsupported, 1);
  assert.equal(check("It recovers 5,480 more strands (208,625 − 203,145).", trace).unsupported, 0);
  assert.equal(check("A shortfall of 4.7%.", trace).unsupported, 1);
  const shown = check("A shortfall of 8,735 of 186,892, 4.7%.", trace);
  assert.equal(shown.unsupported, 0);
  assert.equal(shown.values.find((item) => item.text === "4.7%").from, "8735 / 186892 × 100");
});

test("rounded values match evidence at the precision written", () => {
  const trace = [ok({ fraction: 0.96736, ratio: 3.7, coverage: [{ ratioToPrevious: 3.333 }] })];
  const v = check("About 96.7% decode; 0.97 of strands; a step of 3.33 and 3.7.", trace);
  assert.equal(v.unsupported, 0, JSON.stringify(v.values));
});

test("failed tool calls are not evidence", () => {
  const failed = { callId: "c", name: "get_decodability", arguments: {}, snapshotId: "s", status: "error", startedAt: "", result: { ok: false, error: "limit 25" } };
  assert.equal(check("It returns 12345 strands.", [failed]).unsupported, 1);
});

test("the question counts as evidence for values the user stated", () => {
  assert.equal(check("Strand 101289622 at ratio 2.55.", [], "Does strand 101289622 decode at ratio 2.55?").unsupported, 0);
});

const settings = { apiStyle: "openai-compatible", baseUrl: "http://127.0.0.1", model: "fixture", apiKey: "", temperature: 0, maxTokens: 128 };
const snapshot = { id: "snap", datasetVersion: "v", batchVersion: null, createdAt: "", context: {} };
const backend = { assertCurrent() {}, getK: () => 31, getSummary: async () => ({ distinctKmers: 8000 }), getDecodability: () => ({}), findDecodability: async () => ({}) };

test("an untraced value prompts one revision, and the draft is kept", async () => {
  const seen = [];
  const run = await runReadOnlyAgent({ snapshot, backend, settings, signal: new AbortController().signal, messages: [{ role: "user", content: "How many distinct k-mers?" }],
    provider: async (request) => {
      seen.push(request);
      if (seen.length === 1) return { text: "", calls: [{ id: "a", name: "get_analysis_summary", arguments: {} }], continuation: {} };
      if (seen.length === 2) return { text: "There are 9,000 distinct k-mers.", calls: [], continuation: {} };
      return { text: "There are 8,000 distinct k-mers.", calls: [], continuation: {} };
    } });
  assert.equal(run.stopReason, "completed");
  assert.equal(run.content, "There are 8,000 distinct k-mers.");
  assert.equal(run.draft.content, "There are 9,000 distinct k-mers.");
  assert.equal(run.draft.verification.unsupported, 1);
  assert.equal(run.verification.unsupported, 0);
  const revision = seen[2];
  assert.equal(revision.previous.length, 0, "native history restarts");
  assert.ok(revision.tools.length > 0, "tools stay available");
  assert.match(revision.messages.at(-1).content, /9,000/);
  assert.match(revision.messages.at(-1).content, /"distinctKmers":8000/);
});

test("only one revision is made, and verification can be turned off", async () => {
  let turns = 0;
  const provider = async () => (++turns === 1 ? { text: "", calls: [{ id: "a", name: "get_analysis_summary", arguments: {} }], continuation: {} } : { text: "There are 9,000.", calls: [], continuation: {} });
  const twice = await runReadOnlyAgent({ snapshot, backend, settings, provider, signal: new AbortController().signal, messages: [{ role: "user", content: "How many?" }] });
  assert.equal(turns, 3);
  assert.equal(twice.verification.unsupported, 1);
  turns = 0;
  const off = await runReadOnlyAgent({ snapshot, backend, settings, provider, verify: false, signal: new AbortController().signal, messages: [{ role: "user", content: "How many?" }] });
  assert.equal(turns, 2);
  assert.equal(off.draft, undefined);
});

test("the verification badge and its persisted summary", () => {
  const verification = check("It returns 12345 strands of 210,000.", [ok({ total: 210000 })]);
  const summary = summarizeVerification(verification, true);
  assert.deepEqual(summary, { checked: 2, unsupported: 1, revised: true, untraced: ["12345"] });
  const label = verificationLabel(summary);
  assert.equal(label.tone, "warn");
  assert.equal(label.text, "1 of 2 values not traced");
  assert.match(label.title, /12345/);
  assert.equal(verificationLabel({ checked: 3, unsupported: 0, revised: false }).text, "3 values traced");
  const restored = normalizeMessage({ role: "assistant", content: "x", meta: { mode: "agent", verification: { ...summary, untraced: ["12345", 7] } } });
  assert.deepEqual(restored.meta.verification, summary);
  assert.equal(normalizeMessage({ role: "assistant", content: "x", meta: { mode: "agent", verification: { checked: 1, unsupported: 2 } } }).meta.verification, undefined);
});
