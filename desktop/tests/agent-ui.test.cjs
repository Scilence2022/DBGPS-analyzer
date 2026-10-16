const { test } = require("node:test");
const assert = require("node:assert/strict");
const ui = require("../dist/agent-ui.js");

test("thread store migrates a legacy flat transcript into one titled thread", () => {
  const legacy = [
    { role: "user", content: "  Why is   record 41 incomplete?  ", ts: 1000 },
    { role: "assistant", content: "Dropout at 41-52.", ts: 2000 },
    { role: "system", content: "" },
    "garbage"
  ];
  const store = ui.normalizeThreadStore(null, legacy, 5000);
  assert.equal(store.threads.length, 1);
  assert.equal(store.activeId, store.threads[0].id);
  assert.equal(store.threads[0].title, "Why is record 41 incomplete?");
  assert.equal(store.threads[0].messages.length, 2);
  assert.equal(store.threads[0].updatedAt, 2000);
});

test("thread store repairs a missing active thread, dedupes, caps, and orders by recency", () => {
  const threads = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, createdAt: i + 1, updatedAt: i + 1, messages: [{ role: "user", content: `q${i}` }] }));
  threads.push({ id: "t39", title: "dup", createdAt: 1, updatedAt: 1, messages: [] });
  const store = ui.normalizeThreadStore({ activeId: "gone", threads }, undefined, 99);
  assert.equal(store.threads.length, ui.THREAD_LIMITS.threads);
  assert.equal(store.threads[0].messages.length, 0, "a fresh empty thread becomes active");
  assert.equal(store.threads[0].id, store.activeId);
  assert.equal(store.threads[1].id, "t39");
  assert.equal(new Set(store.threads.map((t) => t.id)).size, store.threads.length);
});

test("message metadata is validated and keeps only compact trace fields", () => {
  const message = ui.normalizeMessage({
    role: "assistant", content: "ok", ts: 5,
    meta: { mode: "agent", model: "m", stopReason: "completed", trace: [{ callId: "c1", name: "get_batch_rows", arguments: { status: "all" }, status: "running", durationMs: 12, facts: ["a", 3], result: { huge: true } }] }
  });
  assert.equal(message.meta.mode, "agent");
  assert.deepEqual(message.meta.trace, [{ callId: "c1", name: "get_batch_rows", arguments: { status: "all" }, status: "error", durationMs: 12, facts: ["a"] }]);
  assert.equal(ui.normalizeMessage({ role: "user", content: "   " }), null);
});

test("tool calls are described in readable, index-explicit terms", () => {
  assert.deepEqual(ui.describeToolCall("get_sequence_profile", { recordIndex: 41, offset: 32, limit: 32 }).detail, "record 41 (row #42) · windows 32–63");
  assert.equal(ui.describeToolCall("get_sequence_profile", { recordIndex: null, offset: 0, limit: 8 }).detail, "selected Interactive sequence · windows 0–7");
  assert.equal(ui.describeToolCall("get_batch_rows", { status: "incomplete", offset: 0, limit: 25 }).detail, "incomplete · rows 1–25");
  assert.equal(ui.describeToolCall("query_kmer", { kmer: "acgtacgtacgtacgtacgtacg", depth: 2 }).detail, "ACGTACGT…TACGTACG · depth 2");
  assert.equal(ui.describeToolCall("run_shell", {}).detail, "Not in the read-only allowlist");
});

test("result facts and jump targets come from deterministic tool data", () => {
  const profile = { ok: true, data: { coverageSlice: { total: 89, positions: [{ position: 40, coverage: 31 }, { position: 41, coverage: 0 }, { position: 42, coverage: 0 }] } } };
  assert.deepEqual(ui.toolResultFacts("get_sequence_profile", profile), ["3 of 89 windows", "min 0 · max 31", "2 zero-support windows"]);
  assert.deepEqual(ui.profileSeries(profile).map((p) => p.coverage), [31, 0, 0]);
  assert.deepEqual(ui.toolResultFacts("get_batch_rows", { ok: false, error: "No completed Batch QC snapshot" }), ["No completed Batch QC snapshot"]);
  assert.deepEqual(ui.toolTargets({ name: "get_sequence_profile", arguments: { recordIndex: 7, offset: 0, limit: 1 } }), [{ kind: "batch-record", index: 7 }]);
  assert.deepEqual(ui.toolTargets({ name: "query_kmer", arguments: { kmer: "acg", depth: 1 } }), [{ kind: "kmer", kmer: "ACG" }]);
  const rows = { ok: true, data: { rows: Array.from({ length: 9 }, (_, index) => ({ index: index * 2 })) } };
  assert.deepEqual(ui.toolTargets({ name: "get_batch_rows", arguments: {}, result: rows }).map((t) => t.index), [0, 2, 4, 6, 8]);
  assert.deepEqual(ui.toolTargets({ name: "get_batch_rows", arguments: {}, result: { ok: false } }), []);
});

test("compact trace keeps durations and facts, never payloads", () => {
  const [entry] = ui.compactTrace([{ callId: "c", name: "query_kmer", arguments: { kmer: "AAA", depth: 0 }, snapshotId: "s", status: "ok", startedAt: "2026-10-16T00:00:00.000Z", finishedAt: "2026-10-16T00:00:01.250Z", result: { ok: true, data: { coverage: 9, inDegree: 1, outDegree: 2, secret: "x" } } }]);
  assert.deepEqual(entry, { callId: "c", name: "query_kmer", arguments: { kmer: "AAA", depth: 0 }, status: "ok", durationMs: 1250, facts: ["coverage 9", "in 1 · out 2"] });
});

test("slash commands complete by prefix and expand with extra focus", () => {
  assert.deepEqual(ui.matchSlashCommands("/t").map((c) => c.name), ["triage"]);
  assert.ok(ui.matchSlashCommands("/").length >= 8);
  assert.deepEqual(ui.matchSlashCommands("/triage now"), []);
  assert.deepEqual(ui.matchSlashCommands("hello /t"), []);
  const parsed = ui.parseSlashCommand("/explain focus on the 3' end");
  assert.equal(parsed.command.name, "explain");
  assert.match(parsed.prompt, /Additional focus: focus on the 3' end$/);
  assert.equal(ui.parseSlashCommand("/new").command.action, "new");
  assert.equal(ui.parseSlashCommand("/unknown"), null);
});

test("suggestions follow evidence state", () => {
  const none = ui.agentSuggestions(null, null);
  assert.equal(none[0].label, "How do I start an analysis?");
  const status = { datasetVersion: "d", k: 31, indexScope: null, batch: { total: 120, complete: 119, incomplete: 1, skipped: 0, errors: 0, cachedProfiles: 120, primerFront: 18, primerBack: 18 }, selectedSequence: false, tools: [], limits: {} };
  const ready = ui.agentSuggestions("Batch QC", status);
  assert.deepEqual(ready.map((s) => s.label), ["Triage 1 incomplete strand", "Explain this Batch QC", "Summarize index and batch", "What should I check next?"]);
  assert.equal(ready[0].mode, "agent");
});

test("only inline DNA code spans become links", () => {
  const html = '<p><code>ACGTACGT</code> and <code>acgt</code> and <code>ACGTX</code></p><pre class="md-code"><code>ACGTACGTACGT</code></pre>';
  const out = ui.linkifyDnaCode(html, 8);
  assert.match(out, /<code class="dna-link" role="button" tabindex="0" data-dna="ACGTACGT" title="Open in Interactive">ACGTACGT<\/code>/);
  assert.match(out, /<code>acgt<\/code>/);
  assert.match(out, /<code>ACGTX<\/code>/);
  assert.match(out, /<pre class="md-code"><code>ACGTACGTACGT<\/code><\/pre>/);
});

test("relative time is compact", () => {
  const now = Date.UTC(2026, 9, 16, 12);
  assert.equal(ui.relativeTime(now - 10_000, now), "just now");
  assert.equal(ui.relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(ui.relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(ui.relativeTime(now - 30 * 3_600_000, now), "yesterday");
});
