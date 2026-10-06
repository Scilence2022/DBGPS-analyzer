const assert = require("node:assert/strict");
const { test } = require("node:test");
const { requestAgentTurn } = require("../dist/agent-providers.js");

const styles = ["openai-responses", "openai-compatible", "anthropic-messages", "google-gemini"];
const schema = {
  type: "object",
  properties: {
    label: { type: "string" },
    optional: { type: ["string", "null"] },
    nested: { type: "object", properties: { count: { type: "integer", minimum: 0 } }, additionalProperties: false }
  },
  required: ["label"],
  additionalProperties: false
};
const tool = { name: "inspect_data", description: "Inspect the selected data.", parameters: schema };
const call = { id: "call_1", name: tool.name, arguments: { label: "selected" } };
const encoder = new TextEncoder();

function request(style, overrides = {}) {
  return {
    settings: { apiStyle: style, baseUrl: "https://provider.invalid/v1/", model: "ordinary-model", apiKey: "test-secret", temperature: 0.2, maxTokens: 2048 },
    system: "Diagnose data using read-only tools.",
    messages: [{ role: "user", content: "Inspect the selected data." }],
    tools: [structuredClone(tool)],
    previous: [],
    signal: new AbortController().signal,
    ...overrides
  };
}

function payload(style, calls = [call], text = "Inspecting.") {
  switch (style) {
    case "openai-responses": return {
      status: "completed", error: null, incomplete_details: null,
      output: [
        { type: "reasoning", id: "rs_original", summary: [], encrypted_content: "opaque-reasoning" },
        { type: "message", role: "assistant", id: "msg_original", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
        ...calls.map((call, index) => ({ type: "function_call", id: `fc_item_${index}`, status: "completed", call_id: call.id, name: call.name, arguments: ` ${JSON.stringify(call.arguments)} ` }))
      ]
    };
    case "openai-compatible": return {
      choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: {
        role: "assistant", content: text, reasoning_content: "provider-native-reasoning",
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: ` ${JSON.stringify(call.arguments)} ` } })) } : {})
      } }]
    };
    case "anthropic-messages": return {
      type: "message", role: "assistant", stop_reason: calls.length ? "tool_use" : "end_turn",
      content: [
        { type: "thinking", thinking: "private thought", signature: "opaque-signature" },
        { type: "redacted_thinking", data: "opaque-redacted" },
        { type: "text", text },
        ...calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments }))
      ]
    };
    case "google-gemini": return {
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [
        { text: "private thought", thought: true, thoughtSignature: "original-thought-signature" },
        { text, thoughtSignature: "original-text-signature" },
        ...calls.map((call) => ({ functionCall: { ...(call.id === undefined ? {} : { id: call.id }), name: call.name, args: call.arguments }, thoughtSignature: "original-call-signature" }))
      ] } }]
    };
  }
}

function native(style, value) {
  if (style === "openai-responses") return value.output;
  if (style === "openai-compatible") return value.choices[0].message;
  if (style === "anthropic-messages") return value.content;
  return value.candidates[0].content;
}

function mockFetch(t, responses) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    assert.ok(responses.length, "No live endpoint may be called");
    const value = responses.shift();
    return value instanceof Response ? value : new Response(JSON.stringify(value));
  });
  return requests;
}

function assertTools(style, body, enabled) {
  if (style === "google-gemini") {
    assert.equal(body.toolConfig.functionCallingConfig.mode, enabled ? "AUTO" : "NONE");
    assert.deepEqual(body.tools, enabled ? [{ functionDeclarations: [{ name: tool.name, description: tool.description, parametersJsonSchema: schema }] }] : []);
  } else if (style === "anthropic-messages") {
    assert.deepEqual(body.tool_choice, { type: enabled ? "auto" : "none" });
    assert.deepEqual(body.tools, enabled ? [{ name: tool.name, description: tool.description, input_schema: schema }] : []);
  } else {
    assert.equal(body.tool_choice, enabled ? "auto" : "none");
    assert.deepEqual(body.tools, enabled ? [style === "openai-responses" ? { type: "function", ...tool, strict: false } : { type: "function", function: tool }] : []);
  }
}

for (const style of styles) {
  test(`${style}: native round trips preserve schemas and original continuation`, async (t) => {
    const first = payload(style);
    const secondCall = { ...call, id: "call_2", arguments: { label: "second" } };
    const second = payload(style, [secondCall], "Checking.");
    const final = payload(style, [], "Complete.");
    const requests = mockFetch(t, [first, second, final]);
    const input = request(style);
    const original = structuredClone(input);
    const firstReply = await requestAgentTurn(input);
    assert.equal(firstReply.text, "Inspecting.");
    assert.deepEqual(firstReply.calls, [call]);
    assert.deepEqual(firstReply.continuation, native(style, first));
    assert.deepEqual(input.tools, original.tools);
    assert.deepEqual(input.messages, original.messages);
    const resultText = '{"note":"keep output structured, not in system text"}';
    const firstTurn = { reply: firstReply, outputs: [{ callId: call.id, output: resultText }] };
    const secondReply = await requestAgentTurn({ ...input, previous: [firstTurn] });
    assert.deepEqual(secondReply.calls, [secondCall]);
    assert.deepEqual(secondReply.continuation, native(style, second));
    const secondTurn = { reply: secondReply, outputs: [{ callId: secondCall.id, output: "second result" }] };
    const snapshot = structuredClone([firstTurn, secondTurn]);
    const finalReply = await requestAgentTurn({ ...input, tools: [], previous: [firstTurn, secondTurn] });
    assert.equal(finalReply.text, "Complete.");
    assert.deepEqual(finalReply.calls, []);
    assert.deepEqual([firstTurn, secondTurn], snapshot);
    for (const [index, entry] of requests.entries()) {
      assert.equal(entry.init.method, "POST");
      assert.equal(entry.init.signal, input.signal);
      assert.equal(entry.init.headers["Content-Type"], "application/json");
      assertTools(style, entry.body, index !== 2);
      if (style !== "google-gemini") assert.equal(entry.body.stream, false);
    }
    const body = requests[2].body;
    if (style === "openai-responses") {
      assert.equal(requests[0].url, "https://provider.invalid/v1/responses");
      assert.equal(body.store, false);
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      assert.equal(body.instructions, input.system);
      assert.equal(body.max_output_tokens, 2048);
      assert.deepEqual(body.input[0], { role: "user", content: [{ type: "input_text", text: input.messages[0].content }] });
      assert.deepEqual(body.input.slice(1, first.output.length + 1), first.output);
      assert.deepEqual(body.input[first.output.length + 1], { type: "function_call_output", call_id: call.id, output: resultText });
      assert.deepEqual(body.input.slice(first.output.length + 2, -1), second.output);
      assert.equal(body.previous_response_id, undefined);
      assert.equal(requests[0].init.headers.Authorization, "Bearer test-secret");
    } else if (style === "openai-compatible") {
      assert.equal(requests[0].url, "https://provider.invalid/v1/chat/completions");
      assert.equal(body.max_tokens, 2048);
      assert.deepEqual(body.messages, [
        { role: "system", content: input.system }, ...input.messages, first.choices[0].message,
        { role: "tool", tool_call_id: call.id, content: resultText }, second.choices[0].message,
        { role: "tool", tool_call_id: secondCall.id, content: "second result" }
      ]);
      assert.equal(requests[0].init.headers.Authorization, "Bearer test-secret");
    } else if (style === "anthropic-messages") {
      assert.equal(requests[0].url, "https://provider.invalid/v1/messages");
      assert.equal(body.system, input.system);
      assert.equal(body.max_tokens, 2048);
      assert.deepEqual(body.messages, [
        ...input.messages, { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: resultText }] },
        { role: "assistant", content: second.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: secondCall.id, content: "second result" }] }
      ]);
      assert.equal(requests[0].init.headers["x-api-key"], "test-secret");
      assert.equal(requests[0].init.headers["anthropic-version"], "2023-06-01");
    } else {
      assert.equal(requests[0].url, "https://provider.invalid/v1/models/ordinary-model:generateContent");
      assert.deepEqual(body.systemInstruction, { parts: [{ text: input.system }] });
      assert.deepEqual(body.generationConfig, { temperature: 0.2, maxOutputTokens: 2048 });
      assert.deepEqual(body.contents, [
        { role: "user", parts: [{ text: input.messages[0].content }] }, first.candidates[0].content,
        { role: "user", parts: [{ functionResponse: { id: call.id, name: call.name, response: { output: resultText } } }] },
        second.candidates[0].content,
        { role: "user", parts: [{ functionResponse: { id: secondCall.id, name: secondCall.name, response: { output: "second result" } } }] }
      ]);
      assert.equal(requests[0].init.headers["x-goog-api-key"], "test-secret");
      assert.ok(!requests[0].url.includes("test-secret"));
    }
  });

  test(`${style}: disabled tools cannot return calls`, async (t) => {
    const requests = mockFetch(t, [payload(style)]);
    await assert.rejects(requestAgentTurn(request(style, { tools: [] })), /tools are disabled/);
    assertTools(style, requests[0].body, false);
  });

  test(`${style}: accepts exactly six calls and rejects seven or duplicate IDs`, async (t) => {
    const six = Array.from({ length: 6 }, (_, index) => ({ ...call, id: `call_${index}` }));
    mockFetch(t, [payload(style, six), payload(style, [...six, { ...call, id: "call_7" }]), payload(style, [call, call])]);
    assert.equal((await requestAgentTurn(request(style))).calls.length, 6);
    await assert.rejects(requestAgentTurn(request(style)), /more than 6/);
    await assert.rejects(requestAgentTurn(request(style)), /Duplicate tool call ID/);
  });

  test(`${style}: rejects malformed call IDs, names, and arguments`, async (t) => {
    for (const id of [null, 42, "", "has whitespace", "line\nbreak", "x".repeat(257)]) {
      mockFetch(t, [payload(style, [{ ...call, id }])]);
      await assert.rejects(requestAgentTurn(request(style)), /tool call ID/);
    }
    mockFetch(t, [payload(style, [{ ...call, name: "" }]), payload(style, [{ ...call, arguments: [] }]), payload(style, [{ ...call, arguments: null }])]);
    for (let index = 0; index < 3; index++) await assert.rejects(requestAgentTurn(request(style)), /Malformed/);
  });

  test(`${style}: rejects nonstring, oversized, and empty text and oversized arguments`, async (t) => {
    mockFetch(t, [payload(style, [], 123), payload(style, [], "x".repeat(64001)), payload(style, [], ""), payload(style, [{ ...call, arguments: { label: "x".repeat(32001) } }])]);
    await assert.rejects(requestAgentTurn(request(style)), /expected a string/);
    await assert.rejects(requestAgentTurn(request(style)), /size limit/);
    await assert.rejects(requestAgentTurn(request(style)), /no text or tool calls/);
    await assert.rejects(requestAgentTurn(request(style)), /size limit/);
  });

  test(`${style}: validates previous continuation and exact output correlation before fetching`, async (t) => {
    const requests = mockFetch(t, [payload(style), payload(style)]);
    const reply = await requestAgentTurn(request(style));
    const turn = { reply, outputs: [{ callId: call.id, output: "result" }] };
    const invalid = [
      { ...turn, outputs: [] },
      { ...turn, outputs: [{ callId: "unknown", output: "result" }] },
      { ...turn, outputs: [turn.outputs[0], turn.outputs[0]] },
      { ...turn, outputs: [{ callId: call.id, output: 42 }] },
      { ...turn, reply: { ...reply, calls: [{ ...call, name: "other" }] } },
      { ...turn, reply: { ...reply, continuation: {} } }
    ];
    for (const invalidTurn of invalid) await assert.rejects(requestAgentTurn(request(style, { previous: [invalidTurn] })));
    await assert.rejects(requestAgentTurn(request(style, { previous: [turn, turn] })), /Duplicate tool call ID/);
    assert.equal(requests.length, 1);
    await assert.rejects(requestAgentTurn(request(style, { previous: [turn] })), /Duplicate tool call ID/);
    assert.equal(requests.length, 2);
  });
}

test("Gemini: omitted IDs have unique local correlation without modifying signed native parts", async (t) => {
  const calls = [{ ...call, id: undefined }, { ...call, id: undefined, arguments: { label: "second" } }];
  const first = payload("google-gemini", calls);
  delete first.candidates[0].content.parts[2].functionCall.args;
  const second = payload("google-gemini", [{ ...call, id: undefined }]);
  const requests = mockFetch(t, [first, second, payload("google-gemini", [], "Done.")]);
  const input = request("google-gemini");
  const reply = await requestAgentTurn(input);
  assert.deepEqual(reply.continuation, first.candidates[0].content);
  assert.deepEqual(reply.calls.map((call) => call.arguments), [{}, { label: "second" }]);
  assert.notEqual(reply.calls[0].id, reply.calls[1].id);
  const turn = { reply, outputs: reply.calls.map((call, index) => ({ callId: call.id, output: `result ${index}` })).reverse() };
  const nextReply = await requestAgentTurn({ ...input, previous: [turn] });
  assert.ok(!reply.calls.some((call) => call.id === nextReply.calls[0].id));
  await requestAgentTurn({ ...input, tools: [], previous: [turn, { reply: nextReply, outputs: [{ callId: nextReply.calls[0].id, output: "next" }] }] });
  assert.deepEqual(requests[1].body.contents[1], first.candidates[0].content);
  assert.deepEqual(requests[1].body.contents[2].parts, [
    { functionResponse: { name: tool.name, response: { output: "result 0" } } },
    { functionResponse: { name: tool.name, response: { output: "result 1" } } }
  ]);
});

test("Compatible: null assistant content is valid only with native calls", async (t) => {
  mockFetch(t, [payload("openai-compatible", [call], null), payload("openai-compatible", [], null)]);
  assert.equal((await requestAgentTurn(request("openai-compatible"))).text, "");
  await assert.rejects(requestAgentTurn(request("openai-compatible")), /expected a string/);
});

test("OpenAI: reasoning models omit temperature exactly as main.ts does", async (t) => {
  for (const style of ["openai-responses", "openai-compatible"]) {
    for (const model of ["o1", "O3-mini", "openai/o4-mini", "gpt-5", "vendor/GPT-5.2", "gpt-4.1"]) {
      const requests = mockFetch(t, [payload(style, [], "Done.")]);
      const input = request(style);
      await requestAgentTurn({ ...input, settings: { ...input.settings, model } });
      assert.equal(Object.hasOwn(requests[0].body, "temperature"), model === "gpt-4.1");
    }
  }
});

test("provider failure and incomplete responses never execute otherwise valid tool calls", async (t) => {
  const failures = [];
  for (const status of ["failed", "incomplete", "in_progress", "canceled", undefined]) failures.push(["openai-responses", { ...payload("openai-responses"), status }]);
  failures.push(["openai-responses", { ...payload("openai-responses"), incomplete_details: { reason: "max_output_tokens" } }]);
  for (const finish_reason of ["length", "content_filter", null]) {
    const value = payload("openai-compatible"); value.choices[0].finish_reason = finish_reason; failures.push(["openai-compatible", value]);
  }
  for (const stop_reason of ["max_tokens", "pause_turn", "refusal", null]) failures.push(["anthropic-messages", { ...payload("anthropic-messages"), stop_reason }]);
  for (const finishReason of ["MAX_TOKENS", "SAFETY", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", undefined]) {
    const value = payload("google-gemini"); value.candidates[0].finishReason = finishReason; failures.push(["google-gemini", value]);
  }
  failures.push(["google-gemini", { ...payload("google-gemini"), promptFeedback: { blockReason: "SAFETY" } }]);
  for (const style of styles) failures.push([style, { ...payload(style), error: { message: "test-secret https://raw-endpoint.invalid private request" } }]);
  for (const [style, value] of failures) {
    mockFetch(t, [value]);
    await assert.rejects(requestAgentTurn(request(style)), (error) => {
      assert.doesNotMatch(error.message, /test-secret|raw-endpoint|private request/);
      return true;
    });
  }
});

test("malformed native envelopes, tool JSON, item status, and contradictory stop reasons are rejected", async (t) => {
  const failures = [];
  for (const style of styles) failures.push([style, {}], [style, null]);
  for (const style of ["openai-responses", "openai-compatible"]) {
    const value = payload(style);
    if (style === "openai-responses") value.output[2].arguments = "{bad json";
    else value.choices[0].message.tool_calls[0].function.arguments = "{bad json";
    failures.push([style, value]);
  }
  const unfinished = payload("openai-responses"); unfinished.output[2].status = "in_progress";
  const contradictory = payload("openai-compatible"); contradictory.choices[0].finish_reason = "stop";
  const nonArray = payload("openai-compatible"); nonArray.choices[0].message.tool_calls = {};
  const wrongRole = payload("google-gemini"); wrongRole.candidates[0].content.role = "user";
  failures.push(["openai-responses", unfinished], ["openai-compatible", contradictory], ["openai-compatible", nonArray], ["google-gemini", wrongRole],
    ["anthropic-messages", { ...payload("anthropic-messages"), stop_reason: "end_turn" }]);
  for (const [style, value] of failures) {
    mockFetch(t, [value]);
    await assert.rejects(requestAgentTurn(request(style)));
  }
});

test("serialized request body is capped at exactly 256000 UTF-16 units", async (t) => {
  for (const style of styles) {
    const requests = mockFetch(t, [payload(style, [], "Done."), payload(style, [], "Done.")]);
    const input = request(style, { system: "" });
    await requestAgentTurn(input);
    const remaining = 256000 - requests[0].init.body.length;
    await requestAgentTurn({ ...input, system: "x".repeat(remaining) });
    assert.equal(requests[1].init.body.length, 256000);
    await assert.rejects(requestAgentTurn({ ...input, system: "x".repeat(remaining + 1) }), /request body exceeds/);
    await assert.rejects(requestAgentTurn({ ...input, system: "\n".repeat(remaining) }), /request body exceeds/);
    assert.equal(requests.length, 2);
  }
});

test("HTTP and network errors never echo credentials, raw endpoints, or request contents", async (t) => {
  const secrets = "test-secret https://private-endpoint.invalid private request";
  let canceled = false;
  const errorResponse = new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 401, statusText: secrets });
  mockFetch(t, [errorResponse]);
  await assert.rejects(requestAgentTurn(request("openai-responses")), (error) => {
    assert.equal(error.message, "Provider request failed (HTTP 401).");
    return true;
  });
  assert.ok(canceled);
  t.mock.method(globalThis, "fetch", async () => { throw new Error(secrets); });
  await assert.rejects(requestAgentTurn(request("google-gemini")), { message: "Provider request failed (network error)." });
});

test("bounded response reader accepts 1 MiB, rejects larger streams, and cancels early", async (t) => {
  const value = { ...payload("openai-responses", [], "Done."), padding: "" };
  const size = JSON.stringify(value).length;
  value.padding = "x".repeat(1024 * 1024 - size);
  mockFetch(t, [new Response(JSON.stringify(value))]);
  assert.equal((await requestAgentTurn(request("openai-responses"))).text, "Done.");
  let canceled = false;
  const chunks = [new Uint8Array(600000).fill(32), new Uint8Array(448577).fill(32)];
  const stream = new ReadableStream({ pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); }, cancel() { canceled = true; } });
  mockFetch(t, [new Response(stream, { headers: { "Content-Length": "1" } })]);
  await assert.rejects(requestAgentTurn(request("openai-responses")), /1 MiB size limit/);
  assert.ok(canceled);
  // The limit is bytes, not JavaScript string length.
  mockFetch(t, [new Response("\u00e9".repeat(524289))]);
  await assert.rejects(requestAgentTurn(request("openai-responses")), /1 MiB size limit/);
});

test("bounded response reader decodes split UTF-8 and sanitizes invalid JSON, UTF-8, and read errors", async (t) => {
  const bytes = encoder.encode(JSON.stringify(payload("openai-responses", [], "Caf\u00e9.")));
  const boundary = bytes.indexOf(0xc3) + 1;
  mockFetch(t, [new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, boundary)); controller.enqueue(bytes.slice(boundary)); controller.close(); } }))]);
  assert.equal((await requestAgentTurn(request("openai-responses"))).text, "Caf\u00e9.");
  mockFetch(t, [new Response("test-secret invalid JSON"), new Response(new Uint8Array([0xff])), new Response(null)]);
  await assert.rejects(requestAgentTurn(request("openai-responses")), { message: "Provider returned invalid JSON." });
  await assert.rejects(requestAgentTurn(request("openai-responses")), { message: "Provider returned invalid UTF-8." });
  await assert.rejects(requestAgentTurn(request("openai-responses")), /empty response body/);
  mockFetch(t, [new Response(new ReadableStream({ start(controller) { controller.error(new Error("test-secret private endpoint")); } }))]);
  await assert.rejects(requestAgentTurn(request("openai-responses")), { message: "Provider response could not be read." });
});

test("abort before fetch, during pending fetch, and during a stalled body read is honored", async (t) => {
  const before = new AbortController(); before.abort("test-secret custom abort reason");
  const requests = mockFetch(t, []);
  await assert.rejects(requestAgentTurn(request("openai-responses", { signal: before.signal })), { name: "AbortError", message: "Agent provider request canceled." });
  assert.equal(requests.length, 0);
  const fetching = new AbortController();
  t.mock.method(globalThis, "fetch", () => new Promise(() => {}));
  const pendingFetch = requestAgentTurn(request("openai-responses", { signal: fetching.signal }));
  fetching.abort();
  await assert.rejects(pendingFetch, { name: "AbortError" });
  let cancelCount = 0;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const stream = new ReadableStream({ pull() { started(); }, cancel() { cancelCount++; } }, { highWaterMark: 0 });
  const controller = new AbortController();
  mockFetch(t, [new Response(stream)]);
  const pendingRead = requestAgentTurn(request("openai-responses", { signal: controller.signal }));
  await reading;
  controller.abort("private request");
  await assert.rejects(pendingRead, { name: "AbortError", message: "Agent provider request canceled." });
  assert.ok(cancelCount >= 1);
});

test("abort while fetch resolves cancels a response whose reader has not been acquired", async (t) => {
  const controller = new AbortController();
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }));
  t.mock.method(globalThis, "fetch", async () => { controller.abort(); return response; });
  await assert.rejects(requestAgentTurn(request("google-gemini", { signal: controller.signal })), { name: "AbortError" });
  assert.ok(canceled);
});

test("an aborted pending fetch cancels its body even if the mock fetch completes later", async (t) => {
  const controller = new AbortController();
  let complete;
  const fetching = new Promise((resolve) => { complete = resolve; });
  let canceled = false;
  t.mock.method(globalThis, "fetch", () => fetching);
  const pending = requestAgentTurn(request("google-gemini", { signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  complete(new Response(new ReadableStream({ cancel() { canceled = true; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(canceled);
});

test("native continuation size and aggregate public text are bounded", async (t) => {
  for (const style of styles) {
    const giant = payload(style);
    const aggregate = payload(style, [], "a".repeat(40000));
    if (style === "openai-responses") {
      giant.output[0].encrypted_content = "x".repeat(256001);
      aggregate.output[1].content.push({ type: "output_text", text: "b".repeat(40000) });
    } else if (style === "openai-compatible") {
      giant.choices[0].message.reasoning_content = "x".repeat(256001);
      aggregate.choices[0].message.content = "a".repeat(80000);
    } else if (style === "anthropic-messages") {
      giant.content[1].data = "x".repeat(256001);
      aggregate.content.push({ type: "text", text: "b".repeat(40000) });
    } else {
      giant.candidates[0].content.parts[0].thoughtSignature = "x".repeat(256001);
      aggregate.candidates[0].content.parts.push({ text: "b".repeat(40000) });
    }
    mockFetch(t, [giant, aggregate]);
    await assert.rejects(requestAgentTurn(request(style)), /size limit/);
    await assert.rejects(requestAgentTurn(request(style)), /size limit/);
  }
});

test("mandatory native call IDs and nonstring Responses reasoning text are rejected", async (t) => {
  for (const style of styles.filter((style) => style !== "google-gemini")) {
    mockFetch(t, [payload(style, [{ ...call, id: undefined }])]);
    await assert.rejects(requestAgentTurn(request(style)), /tool call ID/);
  }
  const value = payload("openai-responses");
  value.output[0].summary = [{ type: "summary_text", text: { invalid: true } }];
  mockFetch(t, [value]);
  await assert.rejects(requestAgentTurn(request("openai-responses")), /expected a string/);
});
