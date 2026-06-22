import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, type OpenDialogOptions } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

type AnalyzerConfig = {
  files: string[];
  k: number;
  threads: number;
  readLength: number;
};

type ProviderId =
  | "openai"
  | "google"
  | "anthropic"
  | "glm"
  | "kimi"
  | "deepseek"
  | "minimax-local"
  | "minimax-global"
  | "siliconflow"
  | "openrouter"
  | "local"
  | "custom";

type ProviderApiStyle = "openai-responses" | "google-gemini" | "anthropic-messages" | "openai-compatible";

type AiSettings = {
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
};

type ProviderRefreshRequest = {
  provider?: ProviderId;
  apiKey?: string;
  baseUrl?: string;
};

type AiRequest = {
  messages?: Array<{ role: string; content: string }>;
  context?: unknown;
  settings?: AiSettings;
};

type ProviderDefinition = {
  id: ProviderId;
  label: string;
  apiStyle: ProviderApiStyle;
  defaultBaseUrl: string;
  defaultModel: string;
  fallbackModels: string[];
  apiKeyEnv?: string;
  modelEnv?: string;
  baseUrlEnv?: string;
  apiKeyRequired: boolean;
};

type PendingQuery = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type SequenceSummaryResult = {
  type: "sequenceSummary";
  length: number;
  k: number;
  kmerCount: number;
  observed: number;
  missing: number;
  complete: boolean;
  minCoverage: number;
  maxCoverage: number;
  meanCoverage: number;
  maxAdjacentRatio: number;
};

type AnalyzerSummaryResult = {
  type: "ready" | "summary";
  k: number;
  distinctKmers: number;
  totalKmerCoverage: number;
  files?: string[];
};

type InteractiveBatchRow = {
  index: number;
  name: string;
  rawLength: number;
  analyzedLength: number;
  status: "ok" | "skipped" | "error";
  message?: string;
  summary?: SequenceSummaryResult;
};

let mainWindow: BrowserWindow | null = null;
let session: AnalyzerSession | null = null;

// In a packaged app the analyzer binary is shipped as an extra resource; in dev
// it lives at the repo root (two levels up from desktop/dist) and can be built
// on demand with `make`.
const repoRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..", "..");
const analyzerPath = path.join(repoRoot, "DBGPS-analyzer");
const linksPath = path.join(repoRoot, "DBGPS-links");
const filterPath = path.join(repoRoot, "DBGPS-seq-filter");
const MAX_ANALYZER_STDOUT_LINE_BYTES = 64 * 1024 * 1024;
const INTERACTIVE_BATCH_CHUNK_SIZE = 250;
const ADD_FILE_TIMEOUT_MS = 300000;

const providerDefinitions: Record<ProviderId, ProviderDefinition> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    apiStyle: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    fallbackModels: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "o4-mini"],
    apiKeyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    baseUrlEnv: "OPENAI_BASE_URL",
    apiKeyRequired: true
  },
  google: {
    id: "google",
    label: "Google",
    apiStyle: "google-gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    fallbackModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    apiKeyEnv: "GOOGLE_API_KEY",
    modelEnv: "GOOGLE_MODEL",
    baseUrlEnv: "GOOGLE_BASE_URL",
    apiKeyRequired: true
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    apiStyle: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    fallbackModels: ["claude-sonnet-4-5", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    apiKeyRequired: true
  },
  glm: {
    id: "glm",
    label: "GLM",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.5",
    fallbackModels: ["glm-4.5", "glm-4-plus", "glm-4-air"],
    apiKeyEnv: "GLM_API_KEY",
    modelEnv: "GLM_MODEL",
    baseUrlEnv: "GLM_BASE_URL",
    apiKeyRequired: true
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    fallbackModels: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    apiKeyEnv: "KIMI_API_KEY",
    modelEnv: "KIMI_MODEL",
    baseUrlEnv: "KIMI_BASE_URL",
    apiKeyRequired: true
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
    apiKeyEnv: "DEEPSEEK_API_KEY",
    modelEnv: "DEEPSEEK_MODEL",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyRequired: true
  },
  "minimax-local": {
    id: "minimax-local",
    label: "MiniMax Local",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    defaultModel: "MiniMax-Text-01",
    fallbackModels: ["MiniMax-Text-01", "MiniMax-M1"],
    apiKeyEnv: "MINIMAX_LOCAL_API_KEY",
    modelEnv: "MINIMAX_LOCAL_MODEL",
    baseUrlEnv: "MINIMAX_LOCAL_BASE_URL",
    apiKeyRequired: true
  },
  "minimax-global": {
    id: "minimax-global",
    label: "MiniMax Global",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "https://api.minimaxi.chat/v1",
    defaultModel: "MiniMax-Text-01",
    fallbackModels: ["MiniMax-Text-01", "MiniMax-M1"],
    apiKeyEnv: "MINIMAX_GLOBAL_API_KEY",
    modelEnv: "MINIMAX_GLOBAL_MODEL",
    baseUrlEnv: "MINIMAX_GLOBAL_BASE_URL",
    apiKeyRequired: true
  },
  siliconflow: {
    id: "siliconflow",
    label: "SiliconFlow",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-72B-Instruct",
    fallbackModels: ["Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1"],
    apiKeyEnv: "SILICONFLOW_API_KEY",
    modelEnv: "SILICONFLOW_MODEL",
    baseUrlEnv: "SILICONFLOW_BASE_URL",
    apiKeyRequired: true
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4.1-mini",
    fallbackModels: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"],
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    apiKeyRequired: true
  },
  local: {
    id: "local",
    label: "Local",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    fallbackModels: ["llama3.1", "qwen2.5", "deepseek-r1"],
    modelEnv: "LOCAL_MODEL",
    baseUrlEnv: "LOCAL_BASE_URL",
    apiKeyRequired: false
  },
  custom: {
    id: "custom",
    label: "Custom Endpoint",
    apiStyle: "openai-compatible",
    defaultBaseUrl: "http://localhost:8000/v1",
    defaultModel: "custom-model",
    fallbackModels: ["custom-model"],
    apiKeyEnv: "CUSTOM_LLM_API_KEY",
    modelEnv: "CUSTOM_LLM_MODEL",
    baseUrlEnv: "CUSTOM_LLM_BASE_URL",
    apiKeyRequired: false
  }
};

function sendWindow(channel: string, payload: unknown) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

type BoundedLineReader = { close: () => void };

function createBoundedLineReader(
  input: NodeJS.ReadableStream,
  maxLineBytes: number,
  onLine: (line: string) => void,
  onError: (error: Error) => void
): BoundedLineReader {
  let chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let closed = false;

  const close = () => {
    closed = true;
    chunks = [];
    bufferedBytes = 0;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onInputError);
  };

  const fail = (error: Error) => {
    if (closed) return;
    close();
    onError(error);
  };

  const append = (chunk: Buffer) => {
    if (chunk.length === 0) return true;
    bufferedBytes += chunk.length;
    if (bufferedBytes > maxLineBytes) {
      fail(new Error(
        `Analyzer response exceeded ${Math.round(maxLineBytes / 1024 / 1024)} MiB. ` +
        "Run a smaller batch or inspect individual strands."
      ));
      return false;
    }
    chunks.push(chunk);
    return true;
  };

  const emitLine = () => {
    let lineBuffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bufferedBytes);
    chunks = [];
    bufferedBytes = 0;
    if (lineBuffer.at(-1) === 13) lineBuffer = lineBuffer.subarray(0, -1);
    try {
      onLine(lineBuffer.toString("utf8"));
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  function onData(data: Buffer) {
    if (closed) return;
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      if (newline < 0) {
        append(data.subarray(start));
        return;
      }
      if (!append(data.subarray(start, newline))) return;
      emitLine();
      start = newline + 1;
    }
  }

  function onEnd() {
    if (closed || bufferedBytes === 0) return;
    emitLine();
  }

  function onInputError(error: Error) {
    fail(error);
  }

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onInputError);

  return { close };
}

function toPositiveInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function runMake(target = "DBGPS-analyzer"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("make", [target], { cwd: repoRoot });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output || `make ${target} failed with code ${code}`));
    });
  });
}

function toolSources(binName: string) {
  const cSource = `${binName}.c`;
  const shared = ["dbgps_core.h", "kseq.h", "ketopt.h", "kthread.c", "kthread.h", "Makefile"];
  return [cSource, ...shared].map((file) => path.join(repoRoot, file));
}

function needsBuild(binName: string) {
  const target = path.join(repoRoot, binName);
  if (!existsSync(target)) return true;
  const targetMtime = statSync(target).mtimeMs;
  return toolSources(binName).some((source) => existsSync(source) && statSync(source).mtimeMs > targetMtime);
}

// Ensure a tool binary exists and is fresh. In a packaged app it must already
// be bundled; in dev it is built on demand with `make <binName>`.
async function ensureBuilt(binName: string, force = false) {
  const target = path.join(repoRoot, binName);
  if (app.isPackaged) {
    if (!existsSync(target)) throw new Error(`Bundled ${binName} not found at ${target}.`);
    return "";
  }
  if (!force && !needsBuild(binName)) return "";
  return runMake(binName);
}

const TOOL_BINARIES = ["DBGPS-analyzer", "DBGPS-links", "DBGPS-seq-filter"];

async function ensureAnalyzerBuilt(force = false) {
  return ensureBuilt("DBGPS-analyzer", force);
}

// --------------------------------------------------------------------------- #
// Secret storage: API keys are persisted out of the renderer, encrypted with
// the OS keychain (Electron safeStorage) when available. The renderer never
// writes keys to localStorage.
// --------------------------------------------------------------------------- #
type SecretsFile = { encrypted: boolean; values: Record<string, string> };

function secretsPath() {
  return path.join(app.getPath("userData"), "provider-secrets.json");
}

function loadSecrets(): Record<string, string> {
  const file = secretsPath();
  if (!existsSync(file)) return {};
  let parsed: SecretsFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [provider, stored] of Object.entries(parsed.values || {})) {
    if (typeof stored !== "string" || !stored) continue;
    if (parsed.encrypted && safeStorage.isEncryptionAvailable()) {
      try {
        out[provider] = safeStorage.decryptString(Buffer.from(stored, "base64"));
      } catch {
        /* skip values that cannot be decrypted (e.g. moved between machines) */
      }
    } else if (!parsed.encrypted) {
      out[provider] = stored;
    }
  }
  return out;
}

function saveSecrets(map: Record<string, string>) {
  const encrypt = safeStorage.isEncryptionAvailable();
  const values: Record<string, string> = {};
  for (const [provider, key] of Object.entries(map || {})) {
    if (typeof key !== "string" || !key) continue;
    values[provider] = encrypt
      ? safeStorage.encryptString(key).toString("base64")
      : key;
  }
  const payload: SecretsFile = { encrypted: encrypt, values };
  const file = secretsPath();
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  // writeFileSync's mode only applies on creation; enforce it on every rewrite.
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort (e.g. unsupported filesystem) */
  }
  return { ok: true, encrypted: encrypt };
}

class AnalyzerSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: BoundedLineReader | null = null;
  private pending: PendingQuery[] = [];
  private ready = false;
  private k = 31;

  async start(config: AnalyzerConfig) {
    await ensureAnalyzerBuilt(false);

    const k = toPositiveInt(config.k, 31, 1, 31);
    const threads = toPositiveInt(config.threads, 3, 1, 64);
    const readLength = toPositiveInt(config.readLength, 200, k, 100000);
    const files = Array.isArray(config.files) ? config.files.filter((file) => typeof file === "string" && file.length > 0) : [];
    if (files.length === 0) throw new Error("Select at least one NGS FASTA/FASTQ file.");

    const args = ["-i", "-k", String(k), "-t", String(threads), "-L", String(readLength), ...files];
    this.k = k;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Analyzer did not become ready within 120 seconds."));
        this.stop();
      }, 120000);

      const handleFailure = (error: Error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(error);
        }
        sendWindow("analyzer:event", { kind: "stderr", line: `${error.message}\n` });
        this.rejectPending(error);
        this.stop();
      };

      this.child = spawn(analyzerPath, args, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
      this.stdout = createBoundedLineReader(this.child.stdout, MAX_ANALYZER_STDOUT_LINE_BYTES, (line) => {
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          sendWindow("analyzer:event", { kind: "stdout", line });
          return;
        }

        const typed = payload as { type?: string; message?: string; k?: number };
        if (!this.ready) {
          if (typed.type === "ready") {
            this.ready = true;
            if (Number.isFinite(Number(typed.k))) this.k = Number(typed.k);
            clearTimeout(timeout);
            if (!settled) {
              settled = true;
              resolve(payload);
            }
            sendWindow("analyzer:event", { kind: "ready", payload });
            return;
          }
          if (typed.type === "error") {
            clearTimeout(timeout);
            if (!settled) {
              settled = true;
              reject(new Error(typed.message || "Analyzer failed to start."));
            }
            return;
          }
        }

        const query = this.pending.shift();
        if (query) {
          clearTimeout(query.timer);
          query.resolve(payload);
        } else {
          sendWindow("analyzer:event", { kind: "data", payload });
        }
      }, handleFailure);

      this.child.stderr.on("data", (chunk: Buffer) => {
        sendWindow("analyzer:event", { kind: "stderr", line: chunk.toString() });
      });

      this.child.on("error", (error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.rejectPending(error);
      });

      this.child.on("close", (code) => {
        this.ready = false;
        clearTimeout(timeout);
        sendWindow("analyzer:event", { kind: "exit", code });
        if (!settled) {
          settled = true;
          reject(new Error(`Analyzer exited with code ${code}`));
        }
        this.rejectPending(new Error(`Analyzer exited with code ${code}`));
      });
    });
  }

  query(command: string, timeoutMs = 60000) {
    if (!this.child || !this.ready || this.child.killed) {
      throw new Error("Analyzer is not running.");
    }
    const normalized = command.trim();
    if (!normalized) throw new Error("Query command is empty.");

    return new Promise((resolve, reject) => {
      const pending: PendingQuery = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending = this.pending.filter((item) => item !== pending);
          reject(new Error("Analyzer query timed out."));
        }, timeoutMs)
      };
      this.pending.push(pending);
      this.child?.stdin.write(`${normalized}\n`, (error) => {
        if (!error) return;
        clearTimeout(pending.timer);
        this.pending = this.pending.filter((item) => item !== pending);
        reject(error);
      });
    });
  }

  async addFiles(files: string[]) {
    if (!this.child || !this.ready || this.child.killed) {
      throw new Error("Analyzer is not running.");
    }
    const normalized = files.filter((file) => typeof file === "string" && file.length > 0);
    if (normalized.length === 0) throw new Error("Select at least one additional NGS FASTA/FASTQ file.");

    let latest: AnalyzerSummaryResult | null = null;
    for (const file of normalized) {
      const payload = await this.query(`addFile ${file}`, ADD_FILE_TIMEOUT_MS);
      const typed = payload as { type?: string; message?: string };
      if (typed.type === "error") {
        throw new Error(typed.message || `Failed to count ${file}`);
      }
      if (typed.type !== "summary" && typed.type !== "ready") {
        throw new Error(`Unexpected analyzer response while adding ${file}: ${typed.type || "unknown"}`);
      }
      latest = payload as AnalyzerSummaryResult;
    }

    if (!latest) throw new Error("Analyzer did not return an updated summary.");
    return latest;
  }

  // Pump a whole chunk of commands into the kernel in one shot and collect the
  // responses in order. The kernel reads stdin lines sequentially and emits one
  // JSON line per command, so the FIFO `pending` queue matches them up. This
  // collapses N renderer<->main IPC round-trips into one for batch scoring.
  queryBatch(commands: string[]) {
    if (!this.child || !this.ready || this.child.killed) {
      throw new Error("Analyzer is not running.");
    }
    const normalized = commands.map((c) => c.trim()).filter((c) => c.length > 0);
    // Scale the timeout with the chunk size; the kernel scores each strand in
    // microseconds, so this is a generous upper bound, not an expected wait.
    const timeoutMs = Math.max(60000, normalized.length * 50);
    return Promise.all(normalized.map((command) => this.query(command, timeoutMs)));
  }

  stop() {
    if (this.child && !this.child.killed) {
      this.child.stdin.write("exit\n");
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill();
      }, 500);
    }
    this.stdout?.close();
    this.ready = false;
  }

  getK() {
    return this.k;
  }

  private rejectPending(error: Error) {
    for (const query of this.pending) {
      clearTimeout(query.timer);
      query.reject(error);
    }
    this.pending = [];
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function providerDefinition(provider?: ProviderId) {
  return provider && providerDefinitions[provider] ? providerDefinitions[provider] : providerDefinitions.openai;
}

function envValue(name?: string) {
  return name ? process.env[name] || "" : "";
}

function normalizeAiSettings(settings?: AiSettings) {
  const definition = providerDefinition(settings?.provider);
  const temperature = Number.isFinite(Number(settings?.temperature)) ? Number(settings?.temperature) : 0.2;
  const maxTokens = Number.isFinite(Number(settings?.maxTokens)) ? Math.max(128, Math.trunc(Number(settings?.maxTokens))) : 900;
  return {
    provider: definition.id,
    apiStyle: definition.apiStyle,
    apiKeyRequired: definition.apiKeyRequired,
    label: definition.label,
    model: (settings?.model || envValue(definition.modelEnv) || definition.defaultModel).trim(),
    apiKey: (settings?.apiKey || envValue(definition.apiKeyEnv)).trim(),
    baseUrl: normalizeBaseUrl(settings?.baseUrl || envValue(definition.baseUrlEnv) || definition.defaultBaseUrl),
    temperature,
    maxTokens
  };
}

function requireSetting(value: string, message: string) {
  if (!value) throw new Error(message);
  return value;
}

function diagnosticSystemPrompt() {
  return "You are a DNA information storage sequencing quality diagnostician. Explain DBGPS k-mer graph evidence concisely in English. Focus on coverage, dropout, path completeness, adjacent coverage ratio, and graph branching. Be explicit about which evidence supports each diagnosis.";
}

function diagnosticUserPrompt(request: AiRequest) {
  const messages = request.messages || [];
  const latestQuestion = messages.filter((message) => message.role === "user").at(-1)?.content || "";
  const history = messages
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  return [
    `Analyzer context JSON:\n${JSON.stringify(request.context).slice(0, 12000)}`,
    history ? `Recent conversation:\n${history}` : "",
    `Current user question:\n${latestQuestion || "Diagnose the current analyzer result."}`
  ].filter(Boolean).join("\n\n");
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await response.text();
    let payload: any = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { text };
      }
    }

    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || payload?.text || response.statusText;
      throw new Error(`Provider request failed (${response.status}): ${String(detail).slice(0, 600)}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function extractResponsesText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks: string[] = [];
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function extractChatCompletionText(payload: any) {
  return String(payload?.choices?.[0]?.message?.content || "").trim();
}

function extractAnthropicText(payload: any) {
  const chunks: string[] = [];
  for (const item of payload?.content || []) {
    if (item?.type === "text" && typeof item.text === "string") chunks.push(item.text);
  }
  return chunks.join("\n").trim();
}

function extractGoogleText(payload: any) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map((part: any) => typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n").trim();
}

function uniqueModels(models: string[]) {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function parseOpenAiCompatibleModels(payload: any) {
  return uniqueModels((payload?.data || []).map((item: any) => item.id || item.name || item.model));
}

function parseAnthropicModels(payload: any) {
  return uniqueModels((payload?.data || []).map((item: any) => item.id || item.name));
}

function parseGoogleModels(payload: any) {
  return uniqueModels((payload?.models || [])
    .filter((item: any) => {
      const methods = item?.supportedGenerationMethods;
      return !Array.isArray(methods) || methods.includes("generateContent");
    })
    .map((item: any) => String(item.name || "").replace(/^models\//, ""))
    .filter((name: string) => name && !name.toLowerCase().includes("embedding")));
}

async function getJson(url: string, headers: Record<string, string>, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await response.text();
    let payload: any = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { text };
      }
    }

    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || payload?.text || response.statusText;
      throw new Error(`Model refresh failed (${response.status}): ${String(detail).slice(0, 600)}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshProviderModels(request: ProviderRefreshRequest) {
  const definition = providerDefinition(request.provider);
  const apiKey = (request.apiKey || envValue(definition.apiKeyEnv)).trim();
  const baseUrl = normalizeBaseUrl(request.baseUrl || envValue(definition.baseUrlEnv) || definition.defaultBaseUrl);

  if (definition.apiKeyRequired && !apiKey) {
    throw new Error(`${definition.label} requires an API key before refreshing models.`);
  }

  if (definition.apiStyle === "google-gemini") {
    const query = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
    const payload = await getJson(`${baseUrl}/models${query}`, {});
    return { provider: definition.id, source: "remote", models: parseGoogleModels(payload) };
  }

  if (definition.apiStyle === "anthropic-messages") {
    const payload = await getJson(`${baseUrl}/models`, {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    });
    return { provider: definition.id, source: "remote", models: parseAnthropicModels(payload) };
  }

  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const payload = await getJson(`${baseUrl}/models`, headers);
  return { provider: definition.id, source: "remote", models: parseOpenAiCompatibleModels(payload) };
}

async function aiDiagnose(request: AiRequest) {
  const settings = normalizeAiSettings(request.settings);

  requireSetting(settings.model, "Select or enter a model before sending an AI diagnosis request.");
  if (settings.apiKeyRequired) {
    requireSetting(settings.apiKey, `${settings.label} API key is required before sending an AI diagnosis request.`);
  }
  const system = diagnosticSystemPrompt();
  const user = diagnosticUserPrompt(request);

  if (settings.apiStyle === "openai-responses") {
    const payload = await postJson(`${settings.baseUrl}/responses`, {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    }, {
      model: settings.model,
      instructions: system,
      input: user,
      temperature: settings.temperature,
      max_output_tokens: settings.maxTokens
    });
    const content = extractResponsesText(payload);
    if (!content) throw new Error("OpenAI returned an empty response.");
    return { provider: "openai", model: settings.model, content };
  }

  if (settings.apiStyle === "google-gemini") {
    const payload = await postJson(`${settings.baseUrl}/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`, {
      "Content-Type": "application/json"
    }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: settings.temperature,
        maxOutputTokens: settings.maxTokens
      }
    });
    const content = extractGoogleText(payload);
    if (!content) throw new Error("Google returned an empty response.");
    return { provider: settings.provider, model: settings.model, content };
  }

  if (settings.apiStyle === "anthropic-messages") {
    const payload = await postJson(`${settings.baseUrl}/messages`, {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01"
    }, {
      model: settings.model,
      system,
      messages: [{ role: "user", content: user }],
      temperature: settings.temperature,
      max_tokens: settings.maxTokens
    });
    const content = extractAnthropicText(payload);
    if (!content) throw new Error("Anthropic returned an empty response.");
    return { provider: "anthropic", model: settings.model, content };
  }

  requireSetting(settings.baseUrl, "Base URL is required for OpenAI-compatible providers.");
  const compatibleHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey) compatibleHeaders.Authorization = `Bearer ${settings.apiKey}`;

  const payload = await postJson(`${settings.baseUrl}/chat/completions`, compatibleHeaders, {
    model: settings.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: settings.temperature,
    max_tokens: settings.maxTokens
  });
  const content = extractChatCompletionText(payload);
  if (!content) throw new Error(`${settings.label} returned an empty response.`);
  return { provider: settings.provider, model: settings.model, content };
}

// --------------------------------------------------------------------------- #
// One-shot CLI tool runners: DBGPS-links, DBGPS-seq-filter, batch DBGPS-analyzer,
// and a combined diagnostics report that runs all three.
// --------------------------------------------------------------------------- #
type ToolRunResult = { code: number | null; stdout: string; stderr: string; command: string };

function runTool(binPath: string, args: string[], timeoutMs = 600000): Promise<ToolRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(binPath)} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, command: `${path.basename(binPath)} ${args.join(" ")}` });
    });
  });
}

// --------------------------------------------------------------------------- #
// Sequence file parsing. Two input formats are supported across the app:
//   1. FASTA (">name\nACGT...") / FASTQ ("@name\n...").
//   2. Tab-delimited "Head-Index<TAB>DNA" tables, one record per line. An
//      optional header row (whose DNA column is not a DNA string) is skipped.
// The CLI tools read FASTA/FASTQ via kseq, so tab-delimited reference inputs are
// transparently converted to a temporary FASTA before a tool is invoked.
// --------------------------------------------------------------------------- #
type SeqRecord = { name: string; seq: string };

const DNA_LINE_RE = /^[ACGTNacgtn]+$/;

function readSeqFileText(file: string): string {
  const raw = readFileSync(file);
  const data = file.endsWith(".gz") ? gunzipSync(raw) : raw;
  return data.toString("latin1");
}

// First non-empty line starts with ">" — a FASTA file we can read here.
function startsWithFasta(text: string): boolean {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.startsWith(">");
  }
  return true;
}

// First non-empty line starts with ">" or "@" — a file the CLI tools read
// directly (FASTA or FASTQ); it must not be treated as tab-delimited.
function isCliReadable(text: string): boolean {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.startsWith(">") || trimmed.startsWith("@");
  }
  return true;
}

function parseFastaText(text: string): SeqRecord[] {
  const records: SeqRecord[] = [];
  let name = "";
  let seq: string[] = [];
  const flush = () => {
    if (name) records.push({ name, seq: seq.join("") });
    seq = [];
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith(">")) {
      flush();
      name = line.slice(1).trim().split(/\s+/)[0] || `seq${records.length + 1}`;
    } else if (name) {
      seq.push(line.trim());
    }
  }
  flush();
  return records;
}

function parseTabDelimitedText(text: string): SeqRecord[] {
  const records: SeqRecord[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) continue;
    const cols = line.split("\t").map((c) => c.trim());
    // The DNA column is the last column that looks like a DNA string; the first
    // column is the record name. Header rows have no DNA column and are skipped.
    let dnaIdx = -1;
    for (let i = cols.length - 1; i >= 0; i--) {
      if (cols[i] && DNA_LINE_RE.test(cols[i])) { dnaIdx = i; break; }
    }
    if (dnaIdx < 0) continue;
    const rawName = cols[0] && dnaIdx !== 0 ? cols[0] : `seq${records.length + 1}`;
    records.push({ name: rawName.replace(/\s+/g, "_"), seq: cols[dnaIdx].toUpperCase() });
  }
  return records;
}

function parseSequenceRecords(file: string): SeqRecord[] {
  const text = readSeqFileText(file);
  return startsWithFasta(text) ? parseFastaText(text) : parseTabDelimitedText(text);
}

// Count records, transparently handling FASTA, FASTQ-less tab-delimited, and gzip.
function countRecords(file: string): number {
  return parseSequenceRecords(file).length;
}

// Convert a tab-delimited reference file to a temporary FASTA so the FASTA/FASTQ
// CLI tools can consume it. FASTA/FASTQ inputs pass through unchanged.
type NormalizedInput = { path: string; cleanup: () => void };

function normalizeToFasta(file: string, primerFront = 0, primerBack = 0): NormalizedInput {
  const text = readSeqFileText(file);
  const needsTrim = primerFront > 0 || primerBack > 0;
  if (isCliReadable(text) && !needsTrim) return { path: file, cleanup: () => {} };
  const records = isCliReadable(text) ? parseFastaText(text) : parseTabDelimitedText(text);
  if (records.length === 0) throw new Error(`No sequences found in ${path.basename(file)}.`);
  const fasta = records.map((r) => {
    const seq = needsTrim ? r.seq.slice(primerFront, primerBack > 0 ? r.seq.length - primerBack : undefined) : r.seq;
    return `>${r.name}\n${seq}`;
  }).join("\n") + "\n";
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const safeBase = path.basename(file).replace(/[^\w.-]/g, "_");
  const out = path.join(tmpdir(), `dbgps-${safeBase}-${stamp}.fa`);
  writeFileSync(out, fasta, "utf8");
  return { path: out, cleanup: () => { try { unlinkSync(out); } catch { /* best effort */ } } };
}

type LinksRequest = { file: string; k?: number; m?: number; primerLen?: number };
async function runLinks(req: LinksRequest) {
  if (!req || !req.file) throw new Error("Select a reference file for cross-link analysis.");
  await ensureBuilt("DBGPS-links");
  const k = toPositiveInt(req.k, 31, 1, 31);
  const m = toPositiveInt(req.m, 1, 0, 1 << 20);
  const primerLen = toPositiveInt(req.primerLen, 0, 0, 100000);
  const norm = normalizeToFasta(req.file, primerLen, primerLen);
  try {
    const args = ["-k", String(k), "-m", String(m), norm.path];
    const result = await runTool(linksPath, args);
    const match = result.stdout.match(/Total cross links\s+(\d+)/i);
    const command = result.command.replace(norm.path, req.file);
    return { ...result, command, file: req.file, k, m, primerLen, crossLinks: match ? Number(match[1]) : null };
  } finally {
    norm.cleanup();
  }
}

type FilterRequest = { file: string; k?: number; m?: number; primerLen?: number; listFiltered?: boolean };
async function runFilter(req: FilterRequest) {
  if (!req || !req.file) throw new Error("Select a FASTA file to filter.");
  await ensureBuilt("DBGPS-seq-filter");
  const k = toPositiveInt(req.k, 31, 1, 31);
  const m = toPositiveInt(req.m, 0, 0, 1 << 20);
  const primerLen = toPositiveInt(req.primerLen, 18, 0, 100000);
  const listFiltered = Boolean(req.listFiltered);
  const norm = normalizeToFasta(req.file);
  try {
    const baseArgs = ["-k", String(k), "-m", String(m), "-p", String(primerLen)];
    const args = listFiltered ? [...baseArgs, "-s", norm.path] : [...baseArgs, norm.path];
    const result = await runTool(filterPath, args);
    let saveOutput = result.stdout;
    if (listFiltered) {
      const passedResult = await runTool(filterPath, [...baseArgs, norm.path]);
      saveOutput = passedResult.stdout;
    }
    const passedCount = (saveOutput.match(/^>/gm) || []).length;
    // In default mode the filtered strands are marked with " * " on stderr; in -s
    // mode each filtered strand name is one stdout line.
    const filteredCount = listFiltered
      ? result.stdout.split("\n").filter((line) => line.trim().length > 0).length
      : (result.stderr.match(/\*/g) || []).length;
    const skippedCount = (result.stderr.match(/^Skipping /gm) || []).length;
    const command = result.command.replace(norm.path, req.file);
    return {
      ...result,
      command,
      file: req.file,
      k,
      m,
      primerLen,
      listFiltered,
      passedCount,
      filteredCount,
      skippedCount,
      saveOutput,
      saveDefaultName: "passed.fa"
    };
  } finally {
    norm.cleanup();
  }
}

type SmKdKnRow = {
  ratio: number; coverage: number; total: number; paths: number; noise: number;
  exist: number; lost: number; sm: number; kd: number; kn: number;
};

function parseSmKdKn(stdout: string): SmKdKnRow[] {
  const rows: SmKdKnRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes("\t") || line.startsWith("Ratio")) continue;
    const f = line.split("\t");
    if (f.length < 10 || !/^[-\d.]/.test(f[0])) continue;
    rows.push({
      ratio: Number(f[0]), coverage: Number(f[1]), total: Number(f[2]), paths: Number(f[3]),
      noise: Number(f[4]), exist: Number(f[5]), lost: Number(f[6]),
      sm: Number(f[7]), kd: Number(f[8]), kn: Number(f[9])
    });
  }
  return rows;
}

type AnalyzerBatchRequest = {
  strandsFile: string; ngsFiles: string[];
  k?: number; threads?: number; readLength?: number;
  minCov?: number; maxCov?: number; ratio?: number; maxR?: number; step?: number; skip?: number;
};
type InteractiveBatchRequest = { file: string; primerFront?: number; primerBack?: number };
type BatchSequenceRequest = { file: string; index: number; primerFront?: number; primerBack?: number };

function sliceAnalyzedSequence(record: SeqRecord, primerFront: number, primerBack: number) {
  const raw = record.seq.replace(/\s+/g, "").toUpperCase();
  const end = primerBack > 0 ? Math.max(primerFront, raw.length - primerBack) : raw.length;
  const seq = raw.slice(primerFront, end);
  return { raw, seq, analyzedLength: Math.max(0, end - primerFront) };
}

function invalidDnaBase(seq: string) {
  const match = /[^ACGT]/.exec(seq);
  return match ? { base: match[0], position: match.index + 1 } : null;
}

function isSequenceSummary(payload: unknown): payload is SequenceSummaryResult {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    (payload as { type?: string }).type === "sequenceSummary" &&
    Number.isFinite(Number((payload as { kmerCount?: unknown }).kmerCount))
  );
}

async function runAnalyzerBatch(req: AnalyzerBatchRequest) {
  if (!req || !req.strandsFile) throw new Error("Select a reference strand file.");
  const ngsFiles = Array.isArray(req.ngsFiles) ? req.ngsFiles.filter((f) => typeof f === "string" && f) : [];
  if (ngsFiles.length === 0) throw new Error("Select at least one NGS reads file.");
  await ensureBuilt("DBGPS-analyzer");
  const k = toPositiveInt(req.k, 31, 1, 31);
  const threads = toPositiveInt(req.threads, 3, 1, 64);
  const readLength = toPositiveInt(req.readLength, 200, k, 100000);
  const args = ["-k", String(k), "-t", String(threads), "-L", String(readLength)];
  if (req.minCov != null) args.push("-c", String(toPositiveInt(req.minCov, 0, 0, 1 << 20)));
  if (req.maxCov != null) args.push("-C", String(toPositiveInt(req.maxCov, 0, 0, 1 << 20)));
  if (req.ratio != null && Number.isFinite(Number(req.ratio))) args.push("-r", String(Number(req.ratio)));
  if (req.maxR != null && Number.isFinite(Number(req.maxR))) args.push("-R", String(Number(req.maxR)));
  if (req.step != null && Number.isFinite(Number(req.step))) args.push("-I", String(Number(req.step)));
  if (req.skip != null) args.push("-s", String(toPositiveInt(req.skip, 0, 0, 1 << 20)));
  const norm = normalizeToFasta(req.strandsFile);
  try {
    args.push(norm.path, ...ngsFiles);
    const result = await runTool(analyzerPath, args);
    const command = result.command.replace(norm.path, req.strandsFile);
    return { ...result, command, k, rows: parseSmKdKn(result.stdout) };
  } finally {
    norm.cleanup();
  }
}

async function runInteractiveBatch(req: InteractiveBatchRequest) {
  if (!session) throw new Error("Analyzer is not running.");
  if (!req || !req.file) throw new Error("Select a reference file for Batch QC.");
  const primerFront = toPositiveInt(req.primerFront, 0, 0, 100000);
  const primerBack = toPositiveInt(req.primerBack, 0, 0, 100000);
  const k = session.getK();
  const rows: InteractiveBatchRow[] = [];
  const queries: Array<{ row: InteractiveBatchRow; seq: string }> = [];

  const records = parseSequenceRecords(req.file);
  records.forEach((record, index) => {
    const { raw, seq, analyzedLength } = sliceAnalyzedSequence(record, primerFront, primerBack);
    const row: InteractiveBatchRow = {
      index,
      name: record.name || `seq${index + 1}`,
      rawLength: raw.length,
      analyzedLength,
      status: "ok"
    };
    rows.push(row);

    if (analyzedLength < k) {
      row.status = "skipped";
      row.message = `shorter than k=${k} after primer trim`;
      return;
    }

    const invalid = invalidDnaBase(seq);
    if (invalid) {
      row.status = "error";
      row.message = `invalid DNA base '${invalid.base}' at analyzed position ${invalid.position}`;
      return;
    }

    queries.push({ row, seq });
  });

  let completed = rows.length - queries.length;
  sendWindow("analyzer:event", { kind: "batchProgress", done: completed, total: rows.length });

  for (let i = 0; i < queries.length; i += INTERACTIVE_BATCH_CHUNK_SIZE) {
    const chunk = queries.slice(i, i + INTERACTIVE_BATCH_CHUNK_SIZE);
    const payloads = await session.queryBatch(chunk.map((item) => `sequenceSummary ${item.seq}`));

    payloads.forEach((payload, offset) => {
      const row = chunk[offset].row;
      if (isSequenceSummary(payload)) {
        row.summary = payload;
      } else {
        row.status = "error";
        row.message = payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message || "sequence summary failed")
          : "sequence summary failed";
      }
      completed += 1;
    });
    sendWindow("analyzer:event", { kind: "batchProgress", done: completed, total: rows.length });
  }

  const ok = rows.filter((row) => row.status === "ok" && row.summary).length;
  const skipped = rows.filter((row) => row.status === "skipped").length;
  const errors = rows.length - ok - skipped;
  return { type: "batch", file: req.file, k, primerFront, primerBack, total: rows.length, ok, skipped, errors, rows };
}

async function loadBatchSequence(req: BatchSequenceRequest) {
  if (!req || !req.file) throw new Error("No sequence file provided.");
  const index = toPositiveInt(req.index, 0, 0, Number.MAX_SAFE_INTEGER);
  const primerFront = toPositiveInt(req.primerFront, 0, 0, 100000);
  const primerBack = toPositiveInt(req.primerBack, 0, 0, 100000);
  const records = parseSequenceRecords(req.file);
  const record = records[index];
  if (!record) throw new Error(`No sequence found at row ${index + 1}.`);
  const raw = record.seq.replace(/\s+/g, "");
  const end = primerBack > 0 ? Math.max(primerFront, raw.length - primerBack) : raw.length;
  return {
    index,
    name: record.name || `seq${index + 1}`,
    rawLength: raw.length,
    analyzedLength: Math.max(0, end - primerFront),
    seq: raw.slice(primerFront, end)
  };
}

type ReportRequest = {
  referenceFile: string; ngsFiles?: string[];
  k?: number; threads?: number; readLength?: number;
  primerLen?: number; linksM?: number; filterM?: number;
};
async function runReport(req: ReportRequest) {
  if (!req || !req.referenceFile) throw new Error("Select a reference strand FASTA file.");
  const k = toPositiveInt(req.k, 31, 1, 31);
  const ngsFiles = Array.isArray(req.ngsFiles) ? req.ngsFiles.filter((f) => typeof f === "string" && f) : [];
  const primerLen = toPositiveInt(req.primerLen, 18, 0, 100000);
  const totalStrands = countRecords(req.referenceFile);

  // The three tools are independent processes; run them concurrently.
  const [links, filter, analyzer] = await Promise.all([
    runLinks({ file: req.referenceFile, k, m: req.linksM ?? 1 }),
    runFilter({ file: req.referenceFile, k, m: req.filterM ?? 0, primerLen, listFiltered: true }),
    ngsFiles.length
      ? runAnalyzerBatch({ strandsFile: req.referenceFile, ngsFiles, k, threads: req.threads, readLength: req.readLength })
      : Promise.resolve(null)
  ]);

  const entangledNames = filter.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const headline = analyzer && analyzer.rows.length ? analyzer.rows[0] : null;

  return {
    generatedAt: new Date().toISOString(),
    referenceFile: req.referenceFile,
    ngsFiles,
    k,
    primerLen,
    totalStrands,
    crossLinks: links.crossLinks,
    linksM: links.m,
    linksCommand: links.command,
    entangled: entangledNames.length,
    passed: Math.max(0, totalStrands - entangledNames.length),
    entangledNames: entangledNames.slice(0, 1000),
    entangledTruncated: entangledNames.length > 1000,
    filterM: filter.m,
    filterCommand: filter.command,
    analyzer: analyzer ? { rows: analyzer.rows, headline, command: analyzer.command } : null
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111418" : "#f5f7f8",
    title: "DBGPS Analyzer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("analyzer:selectFiles", async () => {
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Sequences", extensions: ["fa", "fasta", "fq", "fastq", "txt", "tsv", "tab", "gz"] },
        { name: "All files", extensions: ["*"] }
      ]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("analyzer:build", async () => {
    const logs: string[] = [];
    for (const bin of TOOL_BINARIES) {
      logs.push(await ensureBuilt(bin, true));
    }
    return { ok: true, log: logs.filter(Boolean).join("\n") || "All DBGPS tools are up to date." };
  });

  ipcMain.handle("analyzer:start", async (_event, config: AnalyzerConfig) => {
    session?.stop();
    session = new AnalyzerSession();
    return session.start(config);
  });

  ipcMain.handle("analyzer:query", async (_event, command: string) => {
    if (!session) throw new Error("Analyzer is not running.");
    return session.query(command);
  });

  ipcMain.handle("analyzer:addFiles", async (_event, files: string[]) => {
    if (!session) throw new Error("Analyzer is not running.");
    return session.addFiles(Array.isArray(files) ? files : []);
  });

  // Batch scoring for the Batch QC view. Returns one payload per command, with
  // the heavy per-k-mer `coverages`/`ratios` arrays stripped — the table only
  // needs the summary scalars, and the drill-down re-queries a single strand on
  // demand. This keeps the IPC payload (and renderer memory) bounded even for
  // hundreds of thousands of strands.
  ipcMain.handle("analyzer:queryBatch", async (_event, commands: string[]) => {
    if (!session) throw new Error("Analyzer is not running.");
    const payloads = await session.queryBatch(Array.isArray(commands) ? commands : []);
    return payloads.map((payload) => {
      if (payload && typeof payload === "object" && (payload as { type?: string }).type === "sequence") {
        const { coverages, ratios, ...summary } = payload as Record<string, unknown>;
        void coverages;
        void ratios;
        return summary;
      }
      return payload;
    });
  });

  ipcMain.handle("analyzer:stop", async () => {
    session?.stop();
    session = null;
    return { ok: true };
  });

  ipcMain.handle("ai:diagnose", async (_event, request) => aiDiagnose(request));
  ipcMain.handle("ai:refreshModels", async (_event, request) => refreshProviderModels(request));

  ipcMain.handle("secrets:load", async () => loadSecrets());
  ipcMain.handle("secrets:save", async (_event, map: Record<string, string>) => saveSecrets(map));

  ipcMain.handle("sequence:parse", async (_event, file: string) => {
    if (!file || typeof file !== "string") throw new Error("No sequence file provided.");
    return parseSequenceRecords(file);
  });

  ipcMain.handle("links:run", async (_event, request: LinksRequest) => runLinks(request));
  ipcMain.handle("filter:run", async (_event, request: FilterRequest) => runFilter(request));
  ipcMain.handle("analyzer:runBatch", async (_event, request: AnalyzerBatchRequest) => runAnalyzerBatch(request));
  ipcMain.handle("analyzer:runInteractiveBatch", async (_event, request: InteractiveBatchRequest) => runInteractiveBatch(request));
  ipcMain.handle("sequence:batchRecord", async (_event, request: BatchSequenceRequest) => loadBatchSequence(request));
  ipcMain.handle("report:run", async (_event, request: ReportRequest) => runReport(request));

  ipcMain.handle("file:save", async (_event, request: { defaultName?: string; content?: string }) => {
    const options = { defaultPath: request?.defaultName || "dbgps-report.html" };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };
    writeFileSync(result.filePath, String(request?.content ?? ""), "utf8");
    return { saved: true, path: result.filePath };
  });

  createWindow();
});

app.on("window-all-closed", () => {
  session?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
