import type { AgentApiStyle, AgentProvider, AgentProviderReply, AgentProviderRequest, AgentToolCall } from "./agent-types";

const MAX_REQUEST_UNITS = 256000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TEXT_UNITS = 64000;
const MAX_ARGUMENT_UNITS = 32000;
const MAX_CALLS = 6;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed provider object.");
  return value as JsonObject;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Malformed provider array.");
  return value;
}

function string(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string") throw new Error(`Malformed ${label}: expected a string.`);
  if (value.length > limit) throw new Error(`${label} exceeds the size limit.`);
  return value;
}

function identifier(value: unknown): string {
  const id = string(value, 256, "tool call ID");
  if (!id || /[\s\x00-\x1f\x7f]/.test(id)) throw new Error("Malformed tool call ID.");
  return id;
}

function toolName(value: unknown): string {
  const name = string(value, 128, "tool name");
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Malformed tool name.");
  return name;
}

function serialize(value: unknown, limit: number, label: string): string {
  let result: string | undefined;
  try { result = JSON.stringify(value); } catch { throw new Error(`Malformed ${label}: not JSON serializable.`); }
  return string(result, limit, label);
}

function argumentsObject(value: unknown, encoded: boolean): JsonObject {
  if (encoded) {
    const json = string(value, MAX_ARGUMENT_UNITS, "tool arguments");
    try { value = JSON.parse(json); } catch { throw new Error("Malformed tool arguments: invalid JSON."); }
  }
  const args = object(value);
  serialize(args, MAX_ARGUMENT_UNITS, "tool arguments");
  return args;
}

function addCall(calls: AgentToolCall[], id: unknown, name: unknown, args: unknown, encoded = false): void {
  if (calls.length >= MAX_CALLS) throw new Error("Provider returned more than 6 tool calls.");
  const callId = identifier(id);
  if (calls.some((call) => call.id === callId)) throw new Error("Duplicate tool call ID.");
  calls.push({ id: callId, name: toolName(name), arguments: argumentsObject(args, encoded) });
}

function completeItem(item: JsonObject): void {
  if (item.status !== undefined && item.status !== "completed") throw new Error("Provider returned an incomplete output item.");
}

function responsesContinuation(value: unknown): AgentProviderReply {
  const items = array(value);
  const calls: AgentToolCall[] = [];
  let text = "";
  for (const value of items) {
    const item = object(value);
    completeItem(item);
    if (item.type === "function_call") {
      addCall(calls, item.call_id, item.name, item.arguments, true);
    } else if (item.type === "message") {
      if (item.role !== "assistant") throw new Error("Malformed provider message role.");
      for (const value of array(item.content)) {
        const part = object(value);
        if (part.type === "refusal") throw new Error("Provider refused the request.");
        if (part.type !== "output_text") throw new Error("Unsupported provider content.");
        text += string(part.text, MAX_TEXT_UNITS, "provider text");
      }
    } else if (item.type === "reasoning") {
      for (const value of array(item.summary)) string(object(value).text, MAX_TEXT_UNITS, "provider reasoning text");
      if (item.content !== undefined) {
        for (const value of array(item.content)) string(object(value).text, MAX_TEXT_UNITS, "provider reasoning text");
      }
    } else {
      throw new Error("Unsupported provider output item.");
    }
  }
  return reply(text, calls, items);
}

function compatibleContinuation(value: unknown): AgentProviderReply {
  const message = object(value);
  if (message.role !== "assistant") throw new Error("Malformed provider message role.");
  if (message.refusal != null) throw new Error("Provider refused the request.");
  const calls: AgentToolCall[] = [];
  if (message.tool_calls !== undefined) {
    for (const value of array(message.tool_calls)) {
      const call = object(value);
      if (call.type !== "function") throw new Error("Unsupported provider tool call.");
      const fn = object(call.function);
      addCall(calls, call.id, fn.name, fn.arguments, true);
    }
  }
  const text = message.content == null && calls.length ? "" : string(message.content, MAX_TEXT_UNITS, "provider text");
  return reply(text, calls, message);
}

function anthropicContinuation(value: unknown): AgentProviderReply {
  const content = array(value);
  const calls: AgentToolCall[] = [];
  let text = "";
  for (const value of content) {
    const block = object(value);
    switch (block.type) {
      case "text": text += string(block.text, MAX_TEXT_UNITS, "provider text"); break;
      case "tool_use": addCall(calls, block.id, block.name, block.input); break;
      case "thinking":
        string(block.thinking, MAX_REQUEST_UNITS, "provider thinking");
        string(block.signature, MAX_REQUEST_UNITS, "provider thinking signature");
        break;
      case "redacted_thinking": string(block.data, MAX_REQUEST_UNITS, "provider thinking"); break;
      default: throw new Error("Unsupported provider content block.");
    }
  }
  return reply(text, calls, content);
}

function geminiContinuation(value: unknown, round: number): AgentProviderReply {
  const content = object(value);
  if (content.role !== "model") throw new Error("Malformed provider message role.");
  const calls: AgentToolCall[] = [];
  let text = "";
  for (const value of array(content.parts)) {
    const part = object(value);
    if (part.thought !== undefined && typeof part.thought !== "boolean") throw new Error("Malformed provider thought flag.");
    if (part.thoughtSignature !== undefined) string(part.thoughtSignature, MAX_REQUEST_UNITS, "provider thought signature");
    if (part.text !== undefined) {
      if (part.functionCall !== undefined) throw new Error("Malformed provider part.");
      const partText = string(part.text, MAX_TEXT_UNITS, "provider text");
      if (!part.thought) text += partText;
    } else if (part.functionCall !== undefined) {
      const call = object(part.functionCall);
      // Older Gemini models omit IDs. Keep local correlation separate from the signed native part.
      addCall(calls, call.id === undefined ? `gemini_${round}_${calls.length}` : call.id, call.name, call.args === undefined ? {} : call.args);
    } else if (part.thoughtSignature === undefined) {
      throw new Error("Unsupported provider part.");
    }
  }
  return reply(text, calls, content);
}

function reply(text: string, calls: AgentToolCall[], continuation: unknown): AgentProviderReply {
  string(text, MAX_TEXT_UNITS, "provider text");
  serialize(continuation, MAX_REQUEST_UNITS, "provider reply");
  if (!text.trim() && !calls.length) throw new Error("Provider returned no text or tool calls.");
  return { text, calls, continuation };
}

function parseContinuation(style: AgentApiStyle, continuation: unknown, round: number): AgentProviderReply {
  switch (style) {
    case "openai-responses": return responsesContinuation(continuation);
    case "openai-compatible": return compatibleContinuation(continuation);
    case "anthropic-messages": return anthropicContinuation(continuation);
    case "google-gemini": return geminiContinuation(continuation, round);
    default: throw new Error("Unsupported agent API style.");
  }
}

function parseResponse(style: AgentApiStyle, value: unknown, round: number): AgentProviderReply {
  const payload = object(value);
  if (payload.error != null || payload.type === "error") throw new Error("Provider reported a response error.");
  switch (style) {
    case "openai-responses":
      if (payload.status !== "completed" || payload.incomplete_details != null) throw new Error("Provider response failed or is incomplete.");
      if (payload.output_text !== undefined) string(payload.output_text, MAX_TEXT_UNITS, "provider text");
      return responsesContinuation(payload.output);
    case "openai-compatible": {
      const choices = array(payload.choices);
      if (choices.length !== 1) throw new Error("Malformed provider choices.");
      const choice = object(choices[0]);
      if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") throw new Error("Provider response failed or is incomplete.");
      const result = compatibleContinuation(choice.message);
      if ((choice.finish_reason === "tool_calls") !== Boolean(result.calls.length)) throw new Error("Malformed provider stop reason.");
      return result;
    }
    case "anthropic-messages": {
      if (payload.role !== "assistant") throw new Error("Malformed provider message role.");
      if (!["end_turn", "stop_sequence", "tool_use"].includes(String(payload.stop_reason))) throw new Error("Provider response failed or is incomplete.");
      const result = anthropicContinuation(payload.content);
      if ((payload.stop_reason === "tool_use") !== Boolean(result.calls.length)) throw new Error("Malformed provider stop reason.");
      return result;
    }
    case "google-gemini": {
      if (payload.promptFeedback !== undefined && object(payload.promptFeedback).blockReason != null) throw new Error("Provider blocked the request.");
      const candidates = array(payload.candidates);
      if (candidates.length !== 1) throw new Error("Malformed provider candidates.");
      const candidate = object(candidates[0]);
      if (candidate.finishReason !== "STOP") throw new Error("Provider response failed or is incomplete.");
      return geminiContinuation(candidate.content, round);
    }
    default: throw new Error("Unsupported agent API style.");
  }
}

function isReasoningModel(model: string): boolean {
  const id = (model.split("/").pop() || "").toLowerCase();
  return /^o\d/.test(id) || id.startsWith("gpt-5");
}

function buildRequest(request: AgentProviderRequest): { url: string; headers: Record<string, string>; body: JsonObject; ids: Set<string> } {
  const { settings, system, messages, tools, previous } = request;
  string(system, MAX_REQUEST_UNITS, "system text");
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") throw new Error("Malformed request message role.");
    string(message.content, MAX_REQUEST_UNITS, "message text");
  }
  const names = new Set<string>();
  for (const tool of tools) {
    const name = toolName(tool.name);
    if (names.has(name)) throw new Error("Duplicate tool definition.");
    names.add(name);
    string(tool.description, MAX_REQUEST_UNITS, "tool description");
    object(tool.parameters);
  }
  const ids = new Set<string>();
  const history = previous.map((turn, round) => {
    const native = parseContinuation(settings.apiStyle, turn.reply.continuation, round);
    if (native.text !== turn.reply.text || serialize(native.calls, MAX_REQUEST_UNITS, "tool calls") !== serialize(turn.reply.calls, MAX_REQUEST_UNITS, "tool calls")) {
      throw new Error("Provider continuation does not match the previous reply.");
    }
    const outputs = new Map<string, string>();
    for (const output of turn.outputs) {
      const id = identifier(output.callId);
      if (outputs.has(id) || !native.calls.some((call) => call.id === id)) throw new Error("Duplicate or unmatched tool output ID.");
      outputs.set(id, string(output.output, MAX_REQUEST_UNITS, "tool output"));
    }
    for (const call of native.calls) {
      if (ids.has(call.id)) throw new Error("Duplicate tool call ID in previous turns.");
      ids.add(call.id);
      if (!outputs.has(call.id)) throw new Error("Missing tool output.");
    }
    return { native, outputs };
  });
  const baseUrl = string(settings.baseUrl, 8192, "provider base URL").replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body: JsonObject = { model: settings.model, stream: false };
  let url: string;
  switch (settings.apiStyle) {
    case "openai-responses": {
      url = `${baseUrl}/responses`;
      if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
      const input: unknown[] = messages.map((message) => ({ role: message.role, content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }] }));
      for (const { native, outputs } of history) {
        input.push(...array(native.continuation));
        for (const call of native.calls) input.push({ type: "function_call_output", call_id: call.id, output: outputs.get(call.id) });
      }
      Object.assign(body, { instructions: system, input, store: false, include: ["reasoning.encrypted_content"], max_output_tokens: settings.maxTokens,
        tools: tools.map((tool) => ({ type: "function", ...tool, strict: false })), tool_choice: tools.length ? "auto" : "none" });
      if (!isReasoningModel(settings.model)) body.temperature = settings.temperature;
      break;
    }
    case "openai-compatible": {
      url = `${baseUrl}/chat/completions`;
      if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
      const chat: unknown[] = [{ role: "system", content: system }, ...messages];
      for (const { native, outputs } of history) {
        chat.push(native.continuation);
        for (const call of native.calls) chat.push({ role: "tool", tool_call_id: call.id, content: outputs.get(call.id) });
      }
      Object.assign(body, { messages: chat, max_tokens: settings.maxTokens, tools: tools.map((tool) => ({ type: "function", function: tool })), tool_choice: tools.length ? "auto" : "none" });
      if (!isReasoningModel(settings.model)) body.temperature = settings.temperature;
      break;
    }
    case "anthropic-messages": {
      url = `${baseUrl}/messages`;
      headers["x-api-key"] = settings.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      const chat: unknown[] = [...messages];
      for (const { native, outputs } of history) {
        chat.push({ role: "assistant", content: native.continuation });
        if (native.calls.length) chat.push({ role: "user", content: native.calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: outputs.get(call.id) })) });
      }
      Object.assign(body, { system, messages: chat, max_tokens: settings.maxTokens, temperature: settings.temperature,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })), tool_choice: { type: tools.length ? "auto" : "none" } });
      break;
    }
    case "google-gemini": {
      url = `${baseUrl}/models/${encodeURIComponent(settings.model.replace(/^models\//, ""))}:generateContent`;
      if (settings.apiKey) headers["x-goog-api-key"] = settings.apiKey;
      const contents: unknown[] = messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }));
      for (const { native, outputs } of history) {
        contents.push(native.continuation);
        const nativeCalls = array(object(native.continuation).parts).map(object).filter((part) => part.functionCall !== undefined).map((part) => object(part.functionCall));
        if (native.calls.length) contents.push({ role: "user", parts: native.calls.map((call, index) => ({ functionResponse: {
          ...(nativeCalls[index].id === undefined ? {} : { id: nativeCalls[index].id }), name: call.name, response: { output: outputs.get(call.id) }
        } })) });
      }
      // JSON Schema is not Gemini's restricted OpenAPI Schema; preserve it in the JSON Schema field.
      return { url, headers, ids, body: { systemInstruction: { parts: [{ text: system }] }, contents,
        generationConfig: { temperature: settings.temperature, maxOutputTokens: settings.maxTokens },
        tools: tools.length ? [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) }] : [],
        toolConfig: { functionCallingConfig: { mode: tools.length ? "AUTO" : "NONE" } } } };
    }
    default: throw new Error("Unsupported agent API style.");
  }
  return { url, headers, body, ids };
}

function abortError(): Error {
  const error = new Error("Agent provider request canceled.");
  error.name = "AbortError";
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal, cancel?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
      cancel?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  });
}

async function fetchJson(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<unknown> {
  const discard = (response: Response) => { void response.body?.cancel().catch(() => {}); };
  let received: Response | undefined;
  let response: Response;
  try {
    response = await withAbort(fetch(url, { method: "POST", headers, body, signal }).then((response) => {
      received = response;
      if (signal.aborted) { discard(response); throw abortError(); }
      return response;
    }), signal, () => { if (received) discard(received); });
  } catch {
    checkAbort(signal);
    throw new Error("Provider request failed (network error).");
  }
  if (signal.aborted) { discard(response); throw abortError(); }
  if (!response.ok) {
    discard(response);
    // Never expose statusText, server error bodies, URLs, or fetch exception messages.
    const status = Number.isInteger(response.status) ? response.status : 0;
    throw new Error(`Provider request failed (HTTP ${status}).`);
  }
  if (!response.body) throw new Error("Provider returned an empty response body.");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let finished = false;
  try {
    for (;;) {
      checkAbort(signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await withAbort(reader.read(), signal, cancel); } catch {
        checkAbort(signal);
        throw new Error("Provider response could not be read.");
      }
      checkAbort(signal);
      if (chunk.done) { finished = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Provider response exceeds the 1 MiB size limit.");
      try { text += decoder.decode(chunk.value, { stream: true }); } catch { throw new Error("Provider returned invalid UTF-8."); }
    }
    try { text += decoder.decode(); } catch { throw new Error("Provider returned invalid UTF-8."); }
  } finally {
    if (!finished) cancel();
    reader.releaseLock();
  }
  checkAbort(signal);
  try { return JSON.parse(text); } catch { throw new Error("Provider returned invalid JSON."); }
}

export const requestAgentTurn: AgentProvider = async (request) => {
  checkAbort(request.signal);
  const { url, headers, body, ids } = buildRequest(request);
  const serialized = serialize(body, MAX_REQUEST_UNITS, "provider request body");
  checkAbort(request.signal);
  const payload = await fetchJson(url, headers, serialized, request.signal);
  const result = parseResponse(request.settings.apiStyle, payload, request.previous.length);
  for (const call of result.calls) {
    if (ids.has(call.id)) throw new Error("Duplicate tool call ID in provider response.");
  }
  if (!request.tools.length && result.calls.length) throw new Error("Provider returned tool calls while tools are disabled.");
  checkAbort(request.signal);
  return result;
};
