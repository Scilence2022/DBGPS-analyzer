import { app, BrowserWindow, dialog, ipcMain, nativeTheme, type OpenDialogOptions } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { existsSync } from "node:fs";
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

let mainWindow: BrowserWindow | null = null;
let session: AnalyzerSession | null = null;

const repoRoot = path.resolve(__dirname, "..", "..");
const analyzerPath = path.join(repoRoot, "DBGPS-analyzer");

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

function toPositiveInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function runMake(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("make", ["DBGPS-analyzer"], { cwd: repoRoot });
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
      else reject(new Error(output || `make DBGPS-analyzer failed with code ${code}`));
    });
  });
}

async function ensureAnalyzerBuilt(force = false) {
  if (!force && existsSync(analyzerPath)) return "";
  return runMake();
}

class AnalyzerSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: Interface | null = null;
  private pending: PendingQuery[] = [];
  private ready = false;

  async start(config: AnalyzerConfig) {
    await ensureAnalyzerBuilt(false);

    const k = toPositiveInt(config.k, 31, 1, 31);
    const threads = toPositiveInt(config.threads, 3, 1, 64);
    const readLength = toPositiveInt(config.readLength, 200, k, 100000);
    const files = Array.isArray(config.files) ? config.files.filter((file) => typeof file === "string" && file.length > 0) : [];
    if (files.length === 0) throw new Error("Select at least one NGS FASTA/FASTQ file.");

    const args = ["-i", "-k", String(k), "-t", String(threads), "-L", String(readLength), ...files];

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Analyzer did not become ready within 120 seconds."));
        this.stop();
      }, 120000);

      this.child = spawn(analyzerPath, args, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
      this.stdout = createInterface({ input: this.child.stdout });

      this.stdout.on("line", (line) => {
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          sendWindow("analyzer:event", { kind: "stdout", line });
          return;
        }

        const typed = payload as { type?: string; message?: string };
        if (!this.ready) {
          if (typed.type === "ready") {
            this.ready = true;
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
      });

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

  query(command: string) {
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
        }, 60000)
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
        { name: "FASTA/FASTQ", extensions: ["fa", "fasta", "fq", "fastq", "gz"] },
        { name: "All files", extensions: ["*"] }
      ]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("analyzer:build", async () => {
    const log = await ensureAnalyzerBuilt(true);
    return { ok: true, log };
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

  ipcMain.handle("analyzer:stop", async () => {
    session?.stop();
    session = null;
    return { ok: true };
  });

  ipcMain.handle("ai:diagnose", async (_event, request) => aiDiagnose(request));
  ipcMain.handle("ai:refreshModels", async (_event, request) => refreshProviderModels(request));

  createWindow();
});

app.on("window-all-closed", () => {
  session?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
