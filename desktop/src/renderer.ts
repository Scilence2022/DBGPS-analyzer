import { createIcons, icons } from "lucide";
import type { DbgpsApi } from "./preload";

declare global {
  interface Window {
    dbgps: DbgpsApi;
  }
}

type Neighbor = {
  base: string;
  kmer: string;
  coverage: number;
  present: boolean;
};

type KmerTreeNode = Neighbor & {
  step: number;
  children: KmerTreeNode[];
  exhausted?: boolean;
};

type GreedyStep = {
  step: number;
  base: string;
  kmer: string;
  canonical: string;
  coverage: number;
};

type KmerResult = {
  type: "kmer";
  query: string;
  queryLength?: number;
  truncated?: boolean;
  leftAnchor?: string;
  rightAnchor?: string;
  canonical: string;
  leftCanonical?: string;
  rightCanonical?: string;
  coverage: number;
  leftCoverage?: number;
  rightCoverage?: number;
  upstream: Neighbor[];
  downstream: Neighbor[];
  inDegree: number;
  outDegree: number;
  upstreamDepth?: number;
  downstreamDepth?: number;
  upstreamTree?: KmerTreeNode[];
  downstreamTree?: KmerTreeNode[];
};

type IndexStart = {
  seed: string;
  seedLength: number;
  leftAnchor: string;
  rightAnchor: string;
  canonical: string;
  leftCanonical?: string;
  rightCanonical?: string;
  coverage: number;
  leftCoverage: number;
  rightCoverage: number;
  upstream: GreedyStep[];
  downstream: GreedyStep[];
};

type IndexResult = {
  type: "index";
  index: string;
  decoded: string;
  encodedLength?: number;
  targetLength?: number;
  decodedLength: number;
  padded?: boolean;
  k: number;
  completed: boolean;
  truncated: boolean;
  upstreamDepth: number;
  downstreamDepth: number;
  maxStartKmers: number;
  startCount: number;
  reportedStarts: number;
  maxStartCoverage?: number;
  startLimitReached: boolean;
  starts: IndexStart[];
  message?: string;
};

type SequenceCoverage = {
  position: number;
  kmer: string;
  canonical: string;
  coverage: number;
};

type SequenceResult = {
  type: "sequence";
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
  coverages: SequenceCoverage[];
  ratios: Array<{ position: number; ratio: number }>;
};

type SummaryResult = {
  type: "ready" | "summary";
  k: number;
  files?: string[];
  distinctKmers: number;
  totalKmerCoverage: number;
};

type AnalyzerResult = KmerResult | IndexResult | SequenceResult | SummaryResult | { type: "error"; message: string };

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
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

type AiSettings = {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
};

type ProviderCatalogItem = {
  id: ProviderId;
  label: string;
  region: string;
  apiStyle: string;
  defaultModel: string;
  defaultBaseUrl: string;
  models: string[];
  apiKeyRequired: boolean;
  envHint: string;
};

type ProviderSettings = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel: string;
  lastRefresh?: string;
  refreshStatus?: string;
};

type AppSettings = {
  activeProvider: ProviderId;
  providers: Record<ProviderId, ProviderSettings>;
  temperature: number;
  maxTokens: number;
  appearance: "light" | "dark" | "system";
  kmerTreeMode: "cards" | "bases";
  sequenceChartType: "bar" | "line";
};

const SETTINGS_STORAGE_KEY = "dbgps-settings-v3";

const PROVIDERS: ProviderCatalogItem[] = [
  {
    id: "openai",
    label: "OpenAI",
    region: "Global",
    apiStyle: "Responses API",
    defaultModel: "gpt-4.1-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "o4-mini"],
    apiKeyRequired: true,
    envHint: "OPENAI_API_KEY"
  },
  {
    id: "google",
    label: "Google",
    region: "Global",
    apiStyle: "Gemini API",
    defaultModel: "gemini-2.5-flash",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    apiKeyRequired: true,
    envHint: "GOOGLE_API_KEY"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    region: "Global",
    apiStyle: "Messages API",
    defaultModel: "claude-sonnet-4-5",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-5", "claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
    apiKeyRequired: true,
    envHint: "ANTHROPIC_API_KEY"
  },
  {
    id: "glm",
    label: "GLM",
    region: "China",
    apiStyle: "OpenAI-compatible",
    defaultModel: "glm-4.5",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4-plus", "glm-4-air"],
    apiKeyRequired: true,
    envHint: "GLM_API_KEY"
  },
  {
    id: "kimi",
    label: "Kimi",
    region: "China",
    apiStyle: "OpenAI-compatible",
    defaultModel: "moonshot-v1-8k",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    apiKeyRequired: true,
    envHint: "KIMI_API_KEY"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    region: "Global",
    apiStyle: "OpenAI-compatible",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    apiKeyRequired: true,
    envHint: "DEEPSEEK_API_KEY"
  },
  {
    id: "minimax-local",
    label: "MiniMax Local",
    region: "China",
    apiStyle: "OpenAI-compatible",
    defaultModel: "MiniMax-Text-01",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    models: ["MiniMax-Text-01", "MiniMax-M1"],
    apiKeyRequired: true,
    envHint: "MINIMAX_LOCAL_API_KEY"
  },
  {
    id: "minimax-global",
    label: "MiniMax Global",
    region: "International",
    apiStyle: "OpenAI-compatible",
    defaultModel: "MiniMax-Text-01",
    defaultBaseUrl: "https://api.minimaxi.chat/v1",
    models: ["MiniMax-Text-01", "MiniMax-M1"],
    apiKeyRequired: true,
    envHint: "MINIMAX_GLOBAL_API_KEY"
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    region: "China",
    apiStyle: "OpenAI-compatible",
    defaultModel: "Qwen/Qwen2.5-72B-Instruct",
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    models: ["Qwen/Qwen2.5-72B-Instruct", "deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1"],
    apiKeyRequired: true,
    envHint: "SILICONFLOW_API_KEY"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    region: "Global",
    apiStyle: "OpenAI-compatible",
    defaultModel: "openai/gpt-4.1-mini",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4.1-mini", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"],
    apiKeyRequired: true,
    envHint: "OPENROUTER_API_KEY"
  },
  {
    id: "local",
    label: "Local",
    region: "Local endpoint",
    apiStyle: "OpenAI-compatible",
    defaultModel: "llama3.1",
    defaultBaseUrl: "http://localhost:11434/v1",
    models: ["llama3.1", "qwen2.5", "deepseek-r1"],
    apiKeyRequired: false,
    envHint: "Optional"
  },
  {
    id: "custom",
    label: "Custom Endpoint",
    region: "Custom API",
    apiStyle: "OpenAI-compatible",
    defaultModel: "custom-model",
    defaultBaseUrl: "http://localhost:8000/v1",
    models: ["custom-model"],
    apiKeyRequired: false,
    envHint: "Optional"
  }
];

const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider])) as Record<ProviderId, ProviderCatalogItem>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const elements = {
  statusText: $("statusText"),
  buildButton: $("buildButton") as HTMLButtonElement,
  stopButton: $("stopButton") as HTMLButtonElement,
  settingsButton: $("settingsButton") as HTMLButtonElement,
  selectFilesButton: $("selectFilesButton") as HTMLButtonElement,
  fileList: $("fileList"),
  kInput: $("kInput") as HTMLInputElement,
  threadsInput: $("threadsInput") as HTMLInputElement,
  readLengthInput: $("readLengthInput") as HTMLInputElement,
  startButton: $("startButton") as HTMLButtonElement,
  queryButton: $("queryButton") as HTMLButtonElement,
  queryOptions: $("queryOptions"),
  queryInput: $("queryInput") as HTMLTextAreaElement,
  indexBaseLengthOption: $("indexBaseLengthOption"),
  indexBaseLengthInput: $("indexBaseLengthInput") as HTMLInputElement,
  upstreamDepthInput: $("upstreamDepthInput") as HTMLInputElement,
  downstreamDepthInput: $("downstreamDepthInput") as HTMLInputElement,
  resultView: $("resultView"),
  diagnosticsSettingsButton: $("diagnosticsSettingsButton") as HTMLButtonElement,
  logView: $("logView"),
  distinctKmers: $("distinctKmers"),
  totalCoverage: $("totalCoverage"),
  summaryK: $("summaryK"),
  summaryFiles: $("summaryFiles"),
  chatMessages: $("chatMessages"),
  chatInput: $("chatInput") as HTMLTextAreaElement,
  sendChatButton: $("sendChatButton") as HTMLButtonElement,
  aiProvider: $("aiProvider"),
  settingsPanel: $("settingsPanel"),
  saveSettingsButton: $("saveSettingsButton") as HTMLButtonElement,
  closeSettingsButton: $("closeSettingsButton") as HTMLButtonElement,
  settingsHeading: $("settingsHeading"),
  settingsSubheading: $("settingsSubheading"),
  providerList: $("providerList"),
  activeProviderSelect: $("activeProviderSelect") as HTMLSelectElement,
  modelAssignmentList: $("modelAssignmentList"),
  refreshEnabledProvidersButton: $("refreshEnabledProvidersButton") as HTMLButtonElement,
  temperatureInput: $("temperatureInput") as HTMLInputElement,
  maxTokensInput: $("maxTokensInput") as HTMLInputElement
};

let selectedFiles: string[] = [];
let analyzerReady = false;
let queryMode: "kmer" | "index" | "sequence" = "kmer";
let latestResult: AnalyzerResult | null = null;
const chatMessages: ChatMessage[] = [];
let appSettings: AppSettings = createDefaultSettings();

function renderIcons() {
  createIcons({ icons });
}

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return new Intl.NumberFormat("en-US").format(parsed);
}

function compactPath(file: string) {
  const parts = file.split(/[\\/]/);
  if (parts.length <= 3) return file;
  return `${parts.at(-3)}/${parts.at(-2)}/${parts.at(-1)}`;
}

function setStatus(text: string, state: "idle" | "running" | "error" = "idle") {
  elements.statusText.textContent = text;
  document.body.dataset.status = state;
}

function createDefaultSettings(): AppSettings {
  const providers = {} as Record<ProviderId, ProviderSettings>;
  for (const provider of PROVIDERS) {
    providers[provider.id] = {
      enabled: ["openai", "anthropic", "google", "local"].includes(provider.id),
      baseUrl: provider.defaultBaseUrl,
      apiKey: "",
      models: provider.models,
      selectedModel: provider.defaultModel
    };
  }

  return {
    activeProvider: "openai",
    providers,
    temperature: 0.2,
    maxTokens: 900,
    appearance: "system",
    kmerTreeMode: "cards",
    sequenceChartType: "bar"
  };
}

function mergeSettings(input: unknown): AppSettings {
  const defaults = createDefaultSettings();
  if (!input || typeof input !== "object") return defaults;
  const stored = input as Partial<AppSettings>;
  const providers = { ...defaults.providers };

  for (const provider of PROVIDERS) {
    const storedProvider = stored.providers?.[provider.id];
    if (storedProvider) {
      providers[provider.id] = {
        ...providers[provider.id],
        ...storedProvider,
        models: Array.isArray(storedProvider.models) && storedProvider.models.length > 0 ? storedProvider.models : provider.models,
        selectedModel: storedProvider.selectedModel || provider.defaultModel,
        baseUrl: storedProvider.baseUrl || provider.defaultBaseUrl
      };
    }
  }

  if (!firstEnabledProvider(providers)) providers.openai.enabled = true;

  const activeProvider = stored.activeProvider && providers[stored.activeProvider]?.enabled
    ? stored.activeProvider
    : firstEnabledProvider(providers) || defaults.activeProvider;
  const appearance = stored.appearance === "light" || stored.appearance === "dark" || stored.appearance === "system" ? stored.appearance : "system";
  const kmerTreeMode = stored.kmerTreeMode === "bases" || stored.kmerTreeMode === "cards" ? stored.kmerTreeMode : "cards";
  const sequenceChartType = stored.sequenceChartType === "line" || stored.sequenceChartType === "bar" ? stored.sequenceChartType : "bar";

  return {
    activeProvider,
    providers,
    temperature: Number.isFinite(Number(stored.temperature)) ? Number(stored.temperature) : defaults.temperature,
    maxTokens: Number.isFinite(Number(stored.maxTokens)) ? Number(stored.maxTokens) : defaults.maxTokens,
    appearance,
    kmerTreeMode,
    sequenceChartType
  };
}

function loadSettings() {
  try {
    appSettings = mergeSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}"));
  } catch {
    appSettings = createDefaultSettings();
  }
}

// API keys are never written to localStorage; they live in the OS keychain via
// the main process. `secretsReady` guards against persisting an empty secrets
// map before the stored keys have been loaded back in at startup.
let secretsReady = false;

function persistSecrets() {
  if (!secretsReady) return;
  const map: Record<string, string> = {};
  for (const provider of PROVIDERS) {
    const key = appSettings.providers[provider.id]?.apiKey;
    if (key) map[provider.id] = key;
  }
  window.dbgps.saveSecrets(map).catch(() => {});
}

async function loadSecrets() {
  try {
    const secrets = await window.dbgps.loadSecrets();
    for (const id of Object.keys(secrets) as ProviderId[]) {
      if (appSettings.providers[id]) appSettings.providers[id].apiKey = secrets[id];
    }
  } catch {
    /* keychain unavailable: continue with no stored keys */
  } finally {
    secretsReady = true;
    // Migrate + scrub: persist keys to the keychain and rewrite localStorage
    // without them, removing any plaintext keys left by pre-keychain versions.
    saveSettings();
    renderSettings();
    updateProviderBadge();
  }
}

function saveSettings() {
  const providers: Record<string, ProviderSettings> = {};
  for (const id of Object.keys(appSettings.providers) as ProviderId[]) {
    providers[id] = { ...appSettings.providers[id], apiKey: "" };
  }
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...appSettings, providers }));
  persistSecrets();
}

function rerenderLatestResult() {
  if (latestResult?.type === "kmer") renderKmerResult(latestResult);
  else if (latestResult?.type === "index") renderIndexResult(latestResult);
  else if (latestResult?.type === "sequence") renderSequenceResult(latestResult);
  renderIcons();
}

function commitSettings() {
  saveSettings();
  applyAppearance();
  updateProviderBadge();
  rerenderLatestResult();
  appendLog("Settings saved.");
}

function enabledProviders() {
  return PROVIDERS.filter((provider) => appSettings.providers[provider.id]?.enabled);
}

function firstEnabledProvider(providers: Record<ProviderId, ProviderSettings>) {
  return PROVIDERS.find((provider) => providers[provider.id]?.enabled)?.id;
}

function ensureActiveProvider() {
  if (!appSettings.providers[appSettings.activeProvider]?.enabled) {
    appSettings.activeProvider = firstEnabledProvider(appSettings.providers) || "openai";
  }
}

function currentAiSettings(): AiSettings {
  ensureActiveProvider();
  const provider = appSettings.activeProvider;
  const settings = appSettings.providers[provider];
  return {
    provider,
    model: settings.selectedModel || PROVIDER_BY_ID[provider].defaultModel,
    apiKey: settings.apiKey || "",
    baseUrl: settings.baseUrl || PROVIDER_BY_ID[provider].defaultBaseUrl,
    temperature: appSettings.temperature,
    maxTokens: appSettings.maxTokens
  };
}

function applyAppearance() {
  const theme = appSettings.appearance === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : appSettings.appearance;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.appearance = appSettings.appearance;
  document.querySelectorAll<HTMLButtonElement>(".appearance-card").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === appSettings.appearance);
  });
  document.querySelectorAll<HTMLButtonElement>(".graph-mode-card").forEach((button) => {
    button.classList.toggle("active", button.dataset.graphMode === appSettings.kmerTreeMode);
  });
}

function updateProviderBadge() {
  const settings = currentAiSettings();
  elements.aiProvider.textContent = PROVIDER_BY_ID[settings.provider].label;
  elements.aiProvider.title = settings.model;
}

function appendLog(text: string) {
  const normalized = text.trim();
  if (!normalized) return;
  const now = new Date().toLocaleTimeString();
  elements.logView.textContent += `[${now}] ${normalized}\n`;
  elements.logView.scrollTop = elements.logView.scrollHeight;
}

function modelOptions(providerId: ProviderId, selectedModel: string) {
  const models = appSettings.providers[providerId].models;
  const allModels = models.includes(selectedModel) ? models : [selectedModel, ...models];
  return allModels
    .map((model) => `<option value="${escapeHtml(model)}" ${model === selectedModel ? "selected" : ""}>${escapeHtml(model)}</option>`)
    .join("");
}

function renderProviderList() {
  elements.providerList.innerHTML = PROVIDERS.map((provider) => {
    const settings = appSettings.providers[provider.id];
    const status = settings.refreshStatus || `${settings.models.length} catalog models`;
    const lastRefresh = settings.lastRefresh ? `Last refresh: ${escapeHtml(settings.lastRefresh)}` : "Not refreshed this session";

    return `
      <article class="provider-card" data-provider-id="${provider.id}">
        <div class="provider-card-main">
          <label class="provider-enabled">
            <input type="checkbox" data-provider-enabled="${provider.id}" ${settings.enabled ? "checked" : ""} />
            <span>
              <strong>${escapeHtml(provider.label)}</strong>
              <small>${escapeHtml(provider.region)} · ${escapeHtml(provider.apiStyle)}</small>
            </span>
          </label>
          <span class="provider-status">${escapeHtml(status)}</span>
        </div>
        <div class="provider-fields">
          <label>
            <span>Base URL</span>
            <input data-provider-base-url="${provider.id}" type="url" value="${escapeHtml(settings.baseUrl)}" />
          </label>
          <label>
            <span>API key</span>
            <input class="secret-input" data-provider-api-key="${provider.id}" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(settings.apiKey)}" placeholder="${escapeHtml(provider.envHint)}" />
          </label>
          <button type="button" class="icon-button refresh-provider-button" data-refresh-provider="${provider.id}">
            <i data-lucide="refresh-cw"></i>
            <span>Refresh models</span>
          </button>
        </div>
        <div class="model-chip-list">
          ${settings.models.slice(0, 8).map((model) => `<code>${escapeHtml(model)}</code>`).join("")}
          ${settings.models.length > 8 ? `<span class="chip-more">+${settings.models.length - 8}</span>` : ""}
        </div>
        <p class="provider-note">${lastRefresh}</p>
      </article>
    `;
  }).join("");
  renderIcons();
}

function renderModelSelection() {
  ensureActiveProvider();
  elements.activeProviderSelect.innerHTML = enabledProviders()
    .map((provider) => `<option value="${provider.id}" ${provider.id === appSettings.activeProvider ? "selected" : ""}>${escapeHtml(provider.label)}</option>`)
    .join("");
  elements.temperatureInput.value = String(appSettings.temperature);
  elements.maxTokensInput.value = String(appSettings.maxTokens);

  const enabled = enabledProviders();
  elements.modelAssignmentList.innerHTML = enabled.length > 0
    ? enabled.map((provider) => {
        const settings = appSettings.providers[provider.id];
        return `
          <div class="model-assignment-row" data-provider-id="${provider.id}">
            <div>
              <strong>${escapeHtml(provider.label)}</strong>
              <span>${escapeHtml(provider.apiStyle)} · ${settings.models.length} models</span>
            </div>
            <select data-model-assignment="${provider.id}">
              ${modelOptions(provider.id, settings.selectedModel)}
            </select>
          </div>
        `;
      }).join("")
    : `<div class="empty-settings">Enable at least one provider in the Providers tab.</div>`;
}

function renderSettings() {
  ensureActiveProvider();
  renderProviderList();
  renderModelSelection();
  applyAppearance();
  updateProviderBadge();
}

function openSettings(tab = "providers") {
  elements.settingsPanel.hidden = false;
  selectSettingsTab(tab);
  renderIcons();
}

function closeSettings() {
  elements.settingsPanel.hidden = true;
}

function selectSettingsTab(tab: string) {
  const titles: Record<string, { title: string; subtitle: string }> = {
    providers: {
      title: "Providers",
      subtitle: "Configure provider credentials, endpoints, and model inventories."
    },
    models: {
      title: "Model Selection",
      subtitle: "Assign detailed model choices across enabled providers."
    },
    appearance: {
      title: "Appearance",
      subtitle: "Choose the desktop style used across the analyzer."
    },
    diagnostics: {
      title: "Diagnostics",
      subtitle: "Tune result visualization and graph display behavior."
    }
  };
  const active = titles[tab] ? tab : "providers";
  elements.settingsHeading.textContent = titles[active].title;
  elements.settingsSubheading.textContent = titles[active].subtitle;

  document.querySelectorAll<HTMLButtonElement>(".settings-tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === active);
  });
  document.querySelectorAll<HTMLElement>(".settings-tab").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${active === "models" ? "models" : active}SettingsTab`);
  });
}

async function refreshProviderModels(providerId: ProviderId) {
  const provider = PROVIDER_BY_ID[providerId];
  const settings = appSettings.providers[providerId];
  settings.refreshStatus = "Refreshing...";
  renderProviderList();

  try {
    const result = await window.dbgps.refreshProviderModels({
      provider: providerId,
      apiKey: settings.apiKey || "",
      baseUrl: settings.baseUrl
    });
    if (result.models.length === 0) {
      settings.refreshStatus = "No models returned";
    } else {
      settings.models = result.models;
      if (!settings.models.includes(settings.selectedModel)) settings.selectedModel = settings.models[0];
      settings.lastRefresh = new Date().toLocaleString();
      settings.refreshStatus = `${result.models.length} refreshed models`;
    }
    saveSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    settings.refreshStatus = message;
    appendLog(`${provider.label} model refresh failed: ${message}`);
  }

  renderSettings();
}

async function refreshEnabledProviders() {
  for (const provider of enabledProviders()) {
    await refreshProviderModels(provider.id);
  }
}

function renderFileList() {
  if (selectedFiles.length === 0) {
    elements.fileList.textContent = "No files selected";
    return;
  }
  elements.fileList.innerHTML = selectedFiles
    .map((file) => `<span title="${escapeHtml(file)}">${escapeHtml(compactPath(file))}</span>`)
    .join("");
}

function renderSummary(data: SummaryResult) {
  elements.distinctKmers.textContent = formatNumber(data.distinctKmers);
  elements.totalCoverage.textContent = formatNumber(data.totalKmerCoverage);
  elements.summaryK.textContent = formatNumber(data.k);
  elements.summaryFiles.textContent = formatNumber(data.files?.length ?? selectedFiles.length);
}

function coverageClass(coverage: number) {
  if (coverage <= 0) return "zero";
  if (coverage < 3) return "low";
  return "ok";
}

function renderNeighborTable(title: string, neighbors: Neighbor[]) {
  return `
    <div class="neighbor-block">
      <h3>${escapeHtml(title)}</h3>
      <div class="neighbor-list">
        ${neighbors
          .map(
            (node) => `
              <div class="neighbor-row ${node.present ? "present" : "missing"}">
                <span class="base">${escapeHtml(node.base)}</span>
                <code>${escapeHtml(node.kmer)}</code>
                <span class="coverage ${coverageClass(node.coverage)}">${formatNumber(node.coverage)}</span>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function maxTreeCoverage(nodes: KmerTreeNode[] | undefined, current = 0): number {
  if (!nodes) return current;
  return nodes.reduce((max, node) => maxTreeCoverage(node.children, Math.max(max, node.coverage)), current);
}

function circularNodeSize(coverage: number, maxCoverage: number) {
  if (maxCoverage <= 0) return 30;
  const scale = Math.max(1, maxCoverage / 3);
  return Math.round(30 + 38 * (1 - Math.exp(-coverage / scale)));
}

function renderTreeNodeCard(
  node: { kmer: string; coverage: number; base?: string; step?: number },
  center = false,
  maxCoverage = node.coverage,
  anchorDirection: "left" | "right" | null = null
) {
  const meta = center ? "Query k-mer" : `Step ${formatNumber(node.step)} · ${escapeHtml(node.base || "")}`;
  const detail = center
    ? `Query k-mer: ${node.kmer}\nCoverage: ${formatNumber(node.coverage)}`
    : `Base: ${node.base || ""}\nStep: ${formatNumber(node.step)}\nk-mer: ${node.kmer}\nCoverage: ${formatNumber(node.coverage)}`;
  const anchorClass = center && anchorDirection ? ` anchor-${anchorDirection}` : "";
  if (appSettings.kmerTreeMode === "bases") {
    const size = center ? 86 : circularNodeSize(node.coverage, maxCoverage);
    return `
      <div class="tree-node-card compact ${center ? "center" : ""}${anchorClass} ${coverageClass(node.coverage)}" style="--node-size:${size}px" title="${escapeHtml(detail)}">
        ${center ? `<code>${escapeHtml(node.kmer)}</code>` : `<strong>${escapeHtml(node.base || "?")}</strong>`}
        <span>${formatNumber(node.coverage)}</span>
      </div>
    `;
  }

  return `
    <div class="tree-node-card ${center ? "center" : ""}${anchorClass} ${coverageClass(node.coverage)}" title="${escapeHtml(detail)}">
      <span>${meta}</span>
      <code>${escapeHtml(node.kmer)}</code>
      <strong class="coverage ${coverageClass(node.coverage)}">${formatNumber(node.coverage)}</strong>
    </div>
  `;
}

function renderTreeExpandButton(direction: "upstream" | "downstream", path: string, kmer: string) {
  const icon = direction === "upstream" ? "arrow-left" : "arrow-right";
  const label = direction === "upstream" ? "Search one more upstream step" : "Search one more downstream step";
  return `
    <button type="button" class="tree-expand-button ${direction}" data-expand-tree="${direction}" data-tree-path="${escapeHtml(path)}" data-tree-kmer="${escapeHtml(kmer)}" title="${label}" aria-label="${label}">
      <i data-lucide="${icon}"></i>
    </button>
  `;
}

function renderTreeNodes(nodes: KmerTreeNode[] | undefined, direction: "upstream" | "downstream", maxCoverage: number, showEmpty = true, pathPrefix = ""): string {
  if (!nodes || nodes.length === 0) {
    return showEmpty ? `<div class="tree-empty">No covered branches</div>` : "";
  }

  return nodes.map((node, index) => {
    const path = pathPrefix ? `${pathPrefix}.${index}` : String(index);
    const hasChildren = Boolean(node.children?.length);
    const children = hasChildren ? renderTreeNodes(node.children, direction, maxCoverage, false, path) : "";
    const leafAction = !hasChildren && !node.exhausted ? renderTreeExpandButton(direction, path, node.kmer) : "";
    const card = renderTreeNodeCard(node, false, maxCoverage);
    return direction === "upstream"
      ? `
        <div class="tree-node-row upstream">
          <div class="tree-children ${hasChildren ? "has-branches" : "terminal-action"}">${hasChildren ? children : leafAction}</div>
          <span class="tree-edge" aria-hidden="true"></span>
          ${card}
        </div>
      `
      : `
        <div class="tree-node-row downstream">
          ${card}
          <span class="tree-edge" aria-hidden="true"></span>
          <div class="tree-children ${hasChildren ? "has-branches" : "terminal-action"}">${hasChildren ? children : leafAction}</div>
        </div>
      `;
  }).join("");
}

function renderKmerTree(data: KmerResult) {
  const maxCoverage = Math.max(data.coverage, data.leftCoverage ?? 0, data.rightCoverage ?? 0, maxTreeCoverage(data.upstreamTree), maxTreeCoverage(data.downstreamTree));
  const leftAnchor = data.leftAnchor || data.query;
  const rightAnchor = data.rightAnchor || data.query;
  const splitAnchors = data.truncated && leftAnchor !== rightAnchor;
  const center = splitAnchors
    ? `
      <div class="tree-anchor-pair">
        ${renderTreeNodeCard({ kmer: leftAnchor, coverage: data.leftCoverage ?? data.coverage }, true, maxCoverage, "left")}
        <span class="anchor-gap">...</span>
        ${renderTreeNodeCard({ kmer: rightAnchor, coverage: data.rightCoverage ?? data.coverage }, true, maxCoverage, "right")}
      </div>
    `
    : renderTreeNodeCard({ kmer: leftAnchor, coverage: data.coverage }, true, maxCoverage);
  return `
    <div class="kmer-tree-panel ${appSettings.kmerTreeMode === "bases" ? "compact-mode" : "card-mode"}">
      <div class="tree-side upstream">
        <div class="tree-side-title">Upstream · ${formatNumber(data.upstreamDepth ?? 1)} steps</div>
        ${renderTreeNodes(data.upstreamTree, "upstream", maxCoverage)}
      </div>
      <div class="tree-center">
        ${center}
      </div>
      <div class="tree-side downstream">
        <div class="tree-side-title">Downstream · ${formatNumber(data.downstreamDepth ?? 1)} steps</div>
        ${renderTreeNodes(data.downstreamTree, "downstream", maxCoverage)}
      </div>
    </div>
  `;
}

function renderKmerResult(data: KmerResult) {
  const leftAnchor = data.leftAnchor || data.query;
  const rightAnchor = data.rightAnchor || data.query;
  const splitAnchors = data.truncated && leftAnchor !== rightAnchor;
  elements.resultView.className = "result-view";
  elements.resultView.innerHTML = `
    <div class="result-grid">
      <div class="focus-kmer">
        <span>${splitAnchors ? "Input sequence" : "Query"}</span>
        <code>${escapeHtml(data.query)}</code>
        ${splitAnchors ? `<small>${formatNumber(data.queryLength ?? data.query.length)} bases, end-anchored</small>` : `<strong class="coverage ${coverageClass(data.coverage)}">${formatNumber(data.coverage)}</strong>`}
      </div>
      ${
        splitAnchors
          ? `
            <div class="metric">
              <span>Left anchor</span>
              <strong><code>${escapeHtml(leftAnchor)}</code> ${formatNumber(data.leftCoverage ?? data.coverage)}</strong>
            </div>
            <div class="metric">
              <span>Right anchor</span>
              <strong><code>${escapeHtml(rightAnchor)}</code> ${formatNumber(data.rightCoverage ?? data.coverage)}</strong>
            </div>
          `
          : `
            <div class="metric">
              <span>Canonical</span>
              <strong>${escapeHtml(data.canonical)}</strong>
            </div>
          `
      }
      <div class="metric">
        <span>In degree</span>
        <strong>${formatNumber(data.inDegree)}</strong>
      </div>
      <div class="metric">
        <span>Out degree</span>
        <strong>${formatNumber(data.outDegree)}</strong>
      </div>
    </div>
    ${renderKmerTree(data)}
    <div class="neighbor-grid">
      ${renderNeighborTable("Upstream k-mers", data.upstream)}
      ${renderNeighborTable("Downstream k-mers", data.downstream)}
    </div>
  `;
}

function findTreeNode(nodes: KmerTreeNode[] | undefined, path: string) {
  if (!nodes) return null;
  const indexes = path.split(".").map((part) => Number(part));
  let current: KmerTreeNode | undefined;
  let level = nodes;
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= level.length) return null;
    current = level[index];
    level = current.children || [];
  }
  return current || null;
}

function shiftTreeSteps(nodes: KmerTreeNode[] | undefined, baseStep: number): KmerTreeNode[] {
  return (nodes || []).map((node) => ({
    ...node,
    step: baseStep + node.step,
    children: shiftTreeSteps(node.children, baseStep)
  }));
}

async function expandTreeNode(button: HTMLButtonElement) {
  if (!analyzerReady || latestResult?.type !== "kmer") return;
  const direction = button.dataset.expandTree === "upstream" ? "upstream" : button.dataset.expandTree === "downstream" ? "downstream" : null;
  const path = button.dataset.treePath || "";
  const kmer = button.dataset.treeKmer || "";
  if (!direction || !path || !kmer) return;

  const node = findTreeNode(direction === "upstream" ? latestResult.upstreamTree : latestResult.downstreamTree, path);
  if (!node) return;

  button.disabled = true;
  button.classList.add("loading");
  setStatus("Expanding graph", "running");
  try {
    const command = direction === "upstream" ? `kmer ${kmer} 1 0` : `kmer ${kmer} 0 1`;
    const result = (await window.dbgps.queryAnalyzer(command)) as AnalyzerResult;
    if (result.type !== "kmer") {
      throw new Error(result.type === "error" ? result.message : "Unexpected expansion result.");
    }
    const next = direction === "upstream" ? result.upstreamTree : result.downstreamTree;
    node.children = shiftTreeSteps(next, node.step);
    node.exhausted = node.children.length === 0;
    if (direction === "upstream") {
      latestResult.upstreamDepth = Math.max(latestResult.upstreamDepth ?? 0, node.step + 1);
    } else {
      latestResult.downstreamDepth = Math.max(latestResult.downstreamDepth ?? 0, node.step + 1);
    }
    renderKmerResult(latestResult);
    renderIcons();
    setStatus("Kernel running", "running");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`Graph expansion failed: ${message}`);
    setStatus("Expansion failed", "error");
  } finally {
    button.disabled = false;
    button.classList.remove("loading");
  }
}

function renderGreedyPath(title: string, steps: GreedyStep[], direction: "upstream" | "downstream") {
  const compact = appSettings.kmerTreeMode === "bases";
  return `
    <div class="greedy-path ${direction} ${compact ? "compact" : ""}">
      <h3>${escapeHtml(title)}</h3>
      ${
        steps.length === 0
          ? `<div class="tree-empty">No covered greedy step</div>`
          : steps
              .map(
                (step) => {
                  const detail = `Step: ${step.step}\nBase: ${step.base}\nk-mer: ${step.kmer}\nCoverage: ${formatNumber(step.coverage)}`;
                  return compact
                    ? `
                      <div class="greedy-step compact ${coverageClass(step.coverage)}" title="${escapeHtml(detail)}">
                        <strong>${escapeHtml(step.base)}</strong>
                        <span>${formatNumber(step.coverage)}</span>
                      </div>
                    `
                    : `
                      <div class="greedy-step ${coverageClass(step.coverage)}">
                        <span>${formatNumber(step.step)} · ${escapeHtml(step.base)}</span>
                        <code>${escapeHtml(step.kmer)}</code>
                        <strong class="coverage ${coverageClass(step.coverage)}">${formatNumber(step.coverage)}</strong>
                      </div>
                    `;
                }
              )
              .join("")
      }
    </div>
  `;
}

function renderIndexStart(start: IndexStart) {
  const splitAnchors = start.leftAnchor !== start.rightAnchor;
  return `
    <div class="index-start">
      <div class="index-start-header">
        <div>
          <span>${splitAnchors ? "Decoded sequence anchors" : "Starting k-mer"}</span>
          <code>${escapeHtml(splitAnchors ? start.seed : start.leftAnchor)}</code>
        </div>
        <strong class="coverage ${coverageClass(start.coverage)}">${formatNumber(start.coverage)}</strong>
      </div>
      <div class="index-anchor-grid">
        <div class="metric">
          <span>Left anchor</span>
          <strong><code>${escapeHtml(start.leftAnchor)}</code> ${formatNumber(start.leftCoverage)}</strong>
        </div>
        <div class="metric">
          <span>Right anchor</span>
          <strong><code>${escapeHtml(start.rightAnchor)}</code> ${formatNumber(start.rightCoverage)}</strong>
        </div>
      </div>
      <div class="greedy-grid">
        ${renderGreedyPath("Upstream greedy path", start.upstream, "upstream")}
        ${renderGreedyPath("Downstream greedy path", start.downstream, "downstream")}
      </div>
    </div>
  `;
}

function renderIndexResult(data: IndexResult) {
  elements.resultView.className = "result-view";
  elements.resultView.innerHTML = `
    <div class="result-grid">
      <div class="focus-kmer">
        <span>Index</span>
        <code>${escapeHtml(data.index)}</code>
        <small>${data.padded ? "padded with A" : data.completed ? "auto-completed to k-mer" : data.truncated ? "end-anchored" : "exact k-mer length"}</small>
      </div>
      <div class="metric">
        <span>Decoded DNA</span>
        <strong><code>${escapeHtml(data.decoded)}</code></strong>
      </div>
      <div class="metric">
        <span>Encoded / target / k</span>
        <strong>${formatNumber(data.encodedLength ?? data.decodedLength)} / ${formatNumber(data.targetLength ?? data.decodedLength)} / ${formatNumber(data.k)}</strong>
      </div>
      <div class="metric ${data.startCount > 0 ? "metric-ok" : "metric-alert"}">
        <span>Starts</span>
        <strong>${formatNumber(data.reportedStarts)}${data.startLimitReached ? ` / ${formatNumber(data.maxStartKmers)}+` : ""}</strong>
      </div>
    </div>
    ${
      data.starts.length === 0
        ? `<div class="empty-state">${escapeHtml(data.message || "No covered start k-mers")}</div>`
        : `<div class="index-start-list">${data.starts.map(renderIndexStart).join("")}</div>`
    }
  `;
}

function renderSequenceChartControls() {
  const options: Array<{ type: "bar" | "line"; label: string }> = [
    { type: "bar", label: "Bars" },
    { type: "line", label: "Line" }
  ];
  return `
    <div class="sequence-chart-header">
      <div>
        <strong>Coverage by k-mer position</strong>
        <span>Coordinates show ordered k-mer position and coverage.</span>
      </div>
      <div class="chart-toggle" role="tablist" aria-label="Sequence path chart type">
        ${options
          .map(
            (option) => `
              <button type="button" class="${appSettings.sequenceChartType === option.type ? "active" : ""}" data-sequence-chart="${option.type}" role="tab" aria-selected="${appSettings.sequenceChartType === option.type}">
                ${escapeHtml(option.label)}
              </button>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function chartAxisLabels(data: SequenceCoverage[]) {
  if (data.length === 0) return { first: 0, mid: 0, last: 0 };
  const first = data[0].position;
  const mid = data[Math.floor((data.length - 1) / 2)].position;
  const last = data[data.length - 1].position;
  return { first, mid, last };
}

function renderCoverageBarPlot(data: SequenceCoverage[], maxCoverage: number) {
  return `
    <div class="coverage-bars" aria-label="k-mer coverage bars">
      ${data
        .map((item) => {
          const height = Math.max(4, Math.round((item.coverage / maxCoverage) * 100));
          return `<span class="${coverageClass(item.coverage)}" style="--h:${height}%" title="${escapeHtml(item.position)} ${escapeHtml(item.kmer)} cov=${escapeHtml(item.coverage)}"></span>`;
        })
        .join("")}
    </div>
  `;
}

function renderCoverageLinePlot(data: SequenceCoverage[], maxCoverage: number) {
  const points = data
    .map((item, index) => {
      const x = data.length > 1 ? (index / (data.length - 1)) * 100 : 50;
      const y = 100 - (item.coverage / maxCoverage) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `
    <svg class="coverage-line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="k-mer coverage line chart">
      <line x1="0" y1="0" x2="100" y2="0" class="chart-grid-line"></line>
      <line x1="0" y1="50" x2="100" y2="50" class="chart-grid-line"></line>
      <line x1="0" y1="100" x2="100" y2="100" class="chart-grid-line baseline"></line>
      <polyline points="${points}" class="coverage-line"></polyline>
    </svg>
  `;
}

function renderSequenceCoverageChart(data: SequenceResult) {
  const shown = data.coverages.slice(0, 180);
  const maxCoverage = Math.max(1, ...shown.map((item) => item.coverage));
  const halfCoverage = Math.round(maxCoverage / 2);
  const xLabels = chartAxisLabels(shown);
  const plot = appSettings.sequenceChartType === "line"
    ? renderCoverageLinePlot(shown, maxCoverage)
    : renderCoverageBarPlot(shown, maxCoverage);

  return `
    <section class="sequence-chart-panel">
      ${renderSequenceChartControls()}
      <div class="sequence-chart-frame">
        <div class="y-axis-label">Coverage</div>
        <div class="y-axis">
          <span>${formatNumber(maxCoverage)}</span>
          <span>${formatNumber(halfCoverage)}</span>
          <span>0</span>
        </div>
        <div class="chart-plot">${plot}</div>
        <div class="x-axis-label">Position</div>
        <div class="x-axis">
          <span>${formatNumber(xLabels.first)}</span>
          <span>${formatNumber(xLabels.mid)}</span>
          <span>${formatNumber(xLabels.last)}</span>
        </div>
      </div>
      ${data.coverages.length > shown.length ? `<p class="table-note">Showing the first ${shown.length} of ${data.coverages.length} k-mers.</p>` : ""}
    </section>
  `;
}

function renderSequenceTable(data: SequenceResult) {
  const rows = data.coverages.slice(0, 220);
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Position</th>
            <th>k-mer</th>
            <th>Canonical</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (item) => `
                <tr class="${item.coverage === 0 ? "missing-row" : ""}">
                  <td>${formatNumber(item.position)}</td>
                  <td><code>${escapeHtml(item.kmer)}</code></td>
                  <td><code>${escapeHtml(item.canonical)}</code></td>
                  <td><span class="coverage ${coverageClass(item.coverage)}">${formatNumber(item.coverage)}</span></td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSequenceResult(data: SequenceResult) {
  elements.resultView.className = "result-view";
  elements.resultView.innerHTML = `
    <div class="result-grid">
      <div class="metric ${data.complete ? "metric-ok" : "metric-alert"}">
        <span>Path</span>
        <strong>${data.complete ? "Complete" : "Broken"}</strong>
      </div>
      <div class="metric">
        <span>Observed</span>
        <strong>${formatNumber(data.observed)} / ${formatNumber(data.kmerCount)}</strong>
      </div>
      <div class="metric">
        <span>Min / Max</span>
        <strong>${formatNumber(data.minCoverage)} / ${formatNumber(data.maxCoverage)}</strong>
      </div>
      <div class="metric">
        <span>Max ratio</span>
        <strong>${Number(data.maxAdjacentRatio).toFixed(3)}</strong>
      </div>
    </div>
    ${renderSequenceCoverageChart(data)}
    ${renderSequenceTable(data)}
  `;
}

function renderResult(result: AnalyzerResult) {
  latestResult = result;
  if (result.type === "error") {
    elements.resultView.className = "result-view empty-state error-text";
    elements.resultView.textContent = result.message;
    return;
  }
  if (result.type === "kmer") renderKmerResult(result);
  else if (result.type === "index") renderIndexResult(result);
  else if (result.type === "sequence") renderSequenceResult(result);
  else renderSummary(result);
  renderIcons();
}

function setAnalyzerReady(ready: boolean) {
  analyzerReady = ready;
  elements.queryButton.disabled = !ready;
  elements.stopButton.disabled = !ready;
  elements.startButton.disabled = ready;
}

async function selectFiles() {
  selectedFiles = await window.dbgps.selectFiles();
  renderFileList();
}

async function buildAnalyzer() {
  elements.buildButton.disabled = true;
  setStatus("Building C kernel", "running");
  try {
    const result = await window.dbgps.buildAnalyzer();
    appendLog(result.log || "DBGPS-analyzer is up to date.");
    setStatus("Build complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message);
    setStatus("Build failed", "error");
  } finally {
    elements.buildButton.disabled = false;
  }
}

async function startAnalyzer() {
  if (selectedFiles.length === 0) await selectFiles();
  if (selectedFiles.length === 0) return;

  setAnalyzerReady(false);
  setStatus("Loading sequencing k-mer table", "running");
  elements.startButton.disabled = true;

  try {
    const ready = (await window.dbgps.startAnalyzer({
      files: selectedFiles,
      k: Number(elements.kInput.value),
      threads: Number(elements.threadsInput.value),
      readLength: Number(elements.readLengthInput.value)
    })) as SummaryResult;
    renderSummary(ready);
    latestResult = ready;
    setAnalyzerReady(true);
    setStatus("Kernel running", "running");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message);
    setStatus("Kernel failed to start", "error");
    setAnalyzerReady(false);
    elements.startButton.disabled = false;
  }
}

async function stopAnalyzer() {
  await window.dbgps.stopAnalyzer();
  setAnalyzerReady(false);
  elements.startButton.disabled = false;
  setStatus("Kernel stopped");
}

function depthInputValue(input: HTMLInputElement) {
  const parsed = Number(input.value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(6, Math.max(0, Math.trunc(parsed)));
}

function indexBaseLengthValue() {
  const parsed = Number(elements.indexBaseLengthInput.value);
  const fallback = Number(elements.kInput.value) || 31;
  if (!Number.isFinite(parsed)) return Math.min(300, Math.max(1, Math.trunc(fallback)));
  return Math.min(300, Math.max(1, Math.trunc(parsed)));
}

function updateQueryModeControls() {
  elements.queryOptions.classList.toggle("hidden", queryMode === "sequence");
  elements.indexBaseLengthOption.classList.toggle("hidden", queryMode !== "index");
  if (queryMode === "kmer") {
    elements.queryInput.placeholder = "Enter a k-mer or longer A/C/G/T sequence";
  } else if (queryMode === "index") {
    elements.queryInput.placeholder = "Enter a decimal index";
  } else {
    elements.queryInput.placeholder = "Enter a full A/C/G/T sequence path";
  }
}

function buildQueryCommand() {
  const input = elements.queryInput.value.trim().replace(/\s+/g, "");
  if (!input) return "";
  if (queryMode === "kmer") {
    return `kmer ${input} ${depthInputValue(elements.upstreamDepthInput)} ${depthInputValue(elements.downstreamDepthInput)}`;
  }
  if (queryMode === "index") {
    return `index ${input} ${indexBaseLengthValue()} ${depthInputValue(elements.upstreamDepthInput)} ${depthInputValue(elements.downstreamDepthInput)}`;
  }
  return `sequence ${input}`;
}

async function runQuery() {
  const command = buildQueryCommand();
  if (!command) return;
  elements.queryButton.disabled = true;
  setStatus("Querying", "running");
  try {
    const result = (await window.dbgps.queryAnalyzer(command)) as AnalyzerResult;
    renderResult(result);
    setStatus("Kernel running", "running");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderResult({ type: "error", message });
    setStatus("Query failed", "error");
  } finally {
    elements.queryButton.disabled = !analyzerReady;
  }
}

function appendChat(role: "user" | "assistant", content: string) {
  chatMessages.push({ role, content });
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = content;
  elements.chatMessages.appendChild(div);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

async function sendChat() {
  const question = elements.chatInput.value.trim();
  if (!question) return;
  appendChat("user", question);
  elements.chatInput.value = "";
  elements.sendChatButton.disabled = true;
  try {
    const result = await window.dbgps.aiDiagnose({
      messages: chatMessages,
      context: latestResult,
      settings: currentAiSettings()
    });
    elements.aiProvider.textContent = PROVIDER_BY_ID[result.provider as ProviderId]?.label || result.provider;
    elements.aiProvider.title = result.model;
    appendChat("assistant", result.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendChat("assistant", `Diagnosis failed: ${message}`);
  } finally {
    elements.sendChatButton.disabled = false;
  }
}

document.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segmented button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    queryMode = button.dataset.mode === "sequence" ? "sequence" : button.dataset.mode === "index" ? "index" : "kmer";
    updateQueryModeControls();
  });
});

elements.selectFilesButton.addEventListener("click", selectFiles);
elements.buildButton.addEventListener("click", buildAnalyzer);
elements.startButton.addEventListener("click", startAnalyzer);
elements.stopButton.addEventListener("click", stopAnalyzer);
elements.queryButton.addEventListener("click", runQuery);
elements.diagnosticsSettingsButton.addEventListener("click", () => openSettings("diagnostics"));
elements.resultView.addEventListener("click", (event) => {
  const expandButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-expand-tree]");
  if (expandButton) {
    expandTreeNode(expandButton);
    return;
  }

  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sequence-chart]");
  const chartType = button?.dataset.sequenceChart;
  if (chartType === "bar" || chartType === "line") {
    appSettings.sequenceChartType = chartType;
    saveSettings();
    if (latestResult?.type === "sequence") renderSequenceResult(latestResult);
  }
});
elements.sendChatButton.addEventListener("click", sendChat);
elements.settingsButton.addEventListener("click", () => openSettings("providers"));
elements.saveSettingsButton.addEventListener("click", commitSettings);
elements.closeSettingsButton.addEventListener("click", closeSettings);
elements.settingsPanel.addEventListener("click", (event) => {
  if (event.target === elements.settingsPanel) closeSettings();
});
document.querySelectorAll<HTMLButtonElement>(".settings-tab-button").forEach((button) => {
  button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab || "providers"));
});
elements.refreshEnabledProvidersButton.addEventListener("click", refreshEnabledProviders);
elements.providerList.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  const enabledProvider = target.dataset.providerEnabled as ProviderId | undefined;
  const baseUrlProvider = target.dataset.providerBaseUrl as ProviderId | undefined;
  const apiKeyProvider = target.dataset.providerApiKey as ProviderId | undefined;

  if (enabledProvider) {
    if (!target.checked && appSettings.providers[enabledProvider].enabled && enabledProviders().length === 1) {
      target.checked = true;
      appendLog("Keep at least one AI provider enabled.");
      return;
    }
    appSettings.providers[enabledProvider].enabled = target.checked;
    ensureActiveProvider();
    saveSettings();
    renderSettings();
  } else if (baseUrlProvider) {
    appSettings.providers[baseUrlProvider].baseUrl = target.value.trim();
    saveSettings();
  } else if (apiKeyProvider) {
    appSettings.providers[apiKeyProvider].apiKey = target.value.trim();
    saveSettings();
  }
});
elements.providerList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-refresh-provider]");
  if (button?.dataset.refreshProvider) refreshProviderModels(button.dataset.refreshProvider as ProviderId);
});
elements.activeProviderSelect.addEventListener("change", () => {
  appSettings.activeProvider = elements.activeProviderSelect.value as ProviderId;
  saveSettings();
  renderSettings();
});
elements.modelAssignmentList.addEventListener("change", (event) => {
  const select = event.target as HTMLSelectElement;
  const providerId = select.dataset.modelAssignment as ProviderId | undefined;
  if (!providerId) return;
  appSettings.providers[providerId].selectedModel = select.value;
  saveSettings();
  renderSettings();
});
elements.temperatureInput.addEventListener("input", () => {
  appSettings.temperature = Number(elements.temperatureInput.value) || 0.2;
  saveSettings();
});
elements.maxTokensInput.addEventListener("input", () => {
  appSettings.maxTokens = Math.max(128, Math.trunc(Number(elements.maxTokensInput.value) || 900));
  saveSettings();
});
document.querySelectorAll<HTMLButtonElement>(".appearance-card").forEach((button) => {
  button.addEventListener("click", () => {
    const choice = button.dataset.themeChoice;
    if (choice === "light" || choice === "dark" || choice === "system") {
      appSettings.appearance = choice;
      saveSettings();
      applyAppearance();
    }
  });
});
document.querySelectorAll<HTMLButtonElement>(".graph-mode-card").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.graphMode;
    if (mode === "cards" || mode === "bases") {
      appSettings.kmerTreeMode = mode;
      saveSettings();
      applyAppearance();
      rerenderLatestResult();
    }
  });
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (appSettings.appearance === "system") applyAppearance();
});

elements.queryInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runQuery();
});

elements.chatInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendChat();
});

window.dbgps.onAnalyzerEvent((event) => {
  const payload = event as { kind?: string; line?: string; code?: number };
  if (payload.kind === "stderr" && payload.line) appendLog(payload.line);
  if (payload.kind === "exit") {
    setAnalyzerReady(false);
    elements.startButton.disabled = false;
    setStatus(`Kernel exited: ${payload.code ?? ""}`.trim());
  }
});

// ===========================================================================
// Multi-tool workbench: Cross-links, Seq-Filter, and the combined Report view.
// ===========================================================================
type ViewName = "interactive" | "links" | "filter" | "report";
type LinksResult = Awaited<ReturnType<DbgpsApi["runLinks"]>>;
type FilterResult = Awaited<ReturnType<DbgpsApi["runFilter"]>>;
type ReportResult = Awaited<ReturnType<DbgpsApi["runReport"]>>;
type SmKdKnRow = NonNullable<ReportResult["analyzer"]>["rows"][number];
type Verdict = { level: "ok" | "warn" | "bad"; text: string };

const ui = {
  viewTabs: Array.from(document.querySelectorAll<HTMLButtonElement>(".view-tab")),
  linksSelectButton: $("linksSelectButton") as HTMLButtonElement,
  linksFile: $("linksFile"),
  linksK: $("linksK") as HTMLInputElement,
  linksM: $("linksM") as HTMLInputElement,
  linksRunButton: $("linksRunButton") as HTMLButtonElement,
  linksResult: $("linksResult"),
  filterSelectButton: $("filterSelectButton") as HTMLButtonElement,
  filterFile: $("filterFile"),
  filterK: $("filterK") as HTMLInputElement,
  filterM: $("filterM") as HTMLInputElement,
  filterPrimer: $("filterPrimer") as HTMLInputElement,
  filterListFiltered: $("filterListFiltered") as HTMLInputElement,
  filterRunButton: $("filterRunButton") as HTMLButtonElement,
  filterSaveButton: $("filterSaveButton") as HTMLButtonElement,
  filterResult: $("filterResult"),
  reportRefButton: $("reportRefButton") as HTMLButtonElement,
  reportRefFile: $("reportRefFile"),
  reportNgsButton: $("reportNgsButton") as HTMLButtonElement,
  reportNgsFiles: $("reportNgsFiles"),
  reportK: $("reportK") as HTMLInputElement,
  reportThreads: $("reportThreads") as HTMLInputElement,
  reportReadLength: $("reportReadLength") as HTMLInputElement,
  reportPrimer: $("reportPrimer") as HTMLInputElement,
  reportLinksM: $("reportLinksM") as HTMLInputElement,
  reportFilterM: $("reportFilterM") as HTMLInputElement,
  reportRunButton: $("reportRunButton") as HTMLButtonElement,
  reportAiButton: $("reportAiButton") as HTMLButtonElement,
  reportExportHtmlButton: $("reportExportHtmlButton") as HTMLButtonElement,
  reportExportMdButton: $("reportExportMdButton") as HTMLButtonElement,
  reportResult: $("reportResult")
};

let linksFile = "";
let filterFile = "";
let filterOutput = "";
let reportRefFile = "";
let reportNgsFiles: string[] = [];
let latestReport: ReportResult | null = null;
let reportNarrative = "";

function errMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function truncateText(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}\n… (truncated)` : value;
}
function fmtFloat(value: number) {
  return Number.isFinite(value) ? value.toFixed(4) : "n/a";
}
function fmtPct(value: number) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function setView(view: ViewName) {
  document.body.dataset.view = view;
  document.querySelectorAll<HTMLElement>(".view").forEach((el) => {
    el.classList.toggle("active", el.id === `view-${view}`);
  });
  ui.viewTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  renderIcons();
}

function renderPathChip(target: HTMLElement, files: string[], empty: string) {
  if (!files.length) {
    target.textContent = empty;
    return;
  }
  target.innerHTML = files
    .map((file) => `<span title="${escapeHtml(file)}">${escapeHtml(compactPath(file))}</span>`)
    .join("");
}

async function pickOneFile(): Promise<string> {
  const files = await window.dbgps.selectFiles();
  return files[0] || "";
}

// ---- Cross-links view ----
async function selectLinksFile() {
  const file = await pickOneFile();
  if (file) {
    linksFile = file;
    renderPathChip(ui.linksFile, [file], "No file selected");
  }
}

async function runLinksTool() {
  if (!linksFile) {
    await selectLinksFile();
    if (!linksFile) return;
  }
  ui.linksRunButton.disabled = true;
  ui.linksResult.classList.remove("empty-state");
  ui.linksResult.innerHTML = `<div class="tool-loading">Counting cross-links…</div>`;
  try {
    const result = await window.dbgps.runLinks({
      file: linksFile,
      k: Number(ui.linksK.value),
      m: Number(ui.linksM.value)
    });
    renderLinksResult(result);
  } catch (error) {
    ui.linksResult.innerHTML = `<div class="error-card">${escapeHtml(errMessage(error))}</div>`;
  } finally {
    ui.linksRunButton.disabled = false;
    renderIcons();
  }
}

function renderLinksResult(result: LinksResult) {
  const cl = result.crossLinks;
  const note = cl === 0
    ? "No cross-links detected — strands appear well separated at this k."
    : "Cross-links are k-mers shared by different strands (potential entanglement). Remove primers before counting to avoid false positives.";
  ui.linksResult.classList.remove("empty-state");
  ui.linksResult.innerHTML = `
    <div class="report-metrics">
      <div class="metric-card"><span>Total cross-links</span><strong>${cl == null ? "-" : formatNumber(cl)}</strong></div>
      <div class="metric-card"><span>k-mer</span><strong>${formatNumber(result.k)}</strong></div>
      <div class="metric-card"><span>min shared strands</span><strong>${formatNumber(result.m)}</strong></div>
    </div>
    <p class="muted">${note}</p>
    <details><summary>Command &amp; log</summary><pre class="tool-log">${escapeHtml(result.command)}\n\n${escapeHtml(truncateText(result.stderr || result.stdout, 8000))}</pre></details>
  `;
}

// ---- Seq-Filter view ----
async function selectFilterFile() {
  const file = await pickOneFile();
  if (file) {
    filterFile = file;
    renderPathChip(ui.filterFile, [file], "No file selected");
  }
}

async function runFilterTool() {
  if (!filterFile) {
    await selectFilterFile();
    if (!filterFile) return;
  }
  ui.filterRunButton.disabled = true;
  ui.filterResult.classList.remove("empty-state");
  ui.filterResult.innerHTML = `<div class="tool-loading">Filtering…</div>`;
  try {
    const result = await window.dbgps.runFilter({
      file: filterFile,
      k: Number(ui.filterK.value),
      m: Number(ui.filterM.value),
      primerLen: Number(ui.filterPrimer.value),
      listFiltered: ui.filterListFiltered.checked
    });
    renderFilterResult(result);
  } catch (error) {
    filterOutput = "";
    ui.filterSaveButton.disabled = true;
    ui.filterResult.innerHTML = `<div class="error-card">${escapeHtml(errMessage(error))}</div>`;
  } finally {
    ui.filterRunButton.disabled = false;
    renderIcons();
  }
}

function renderFilterResult(result: FilterResult) {
  filterOutput = result.stdout;
  ui.filterSaveButton.disabled = !filterOutput.trim();
  const headline = result.listFiltered
    ? `<div class="metric-card"><span>Filtered (entangled)</span><strong>${formatNumber(result.filteredCount)}</strong></div>`
    : `<div class="metric-card"><span>Passed</span><strong>${formatNumber(result.passedCount)}</strong></div>`;
  const note = result.listFiltered
    ? "Listing names of entangled strands that exceed the cross-link threshold."
    : "Emitting strands that passed the entanglement filter as FASTA.";
  ui.filterResult.classList.remove("empty-state");
  ui.filterResult.innerHTML = `
    <div class="report-metrics">
      ${headline}
      <div class="metric-card"><span>k-mer</span><strong>${formatNumber(result.k)}</strong></div>
      <div class="metric-card"><span>max cross-links</span><strong>${formatNumber(result.m)}</strong></div>
      <div class="metric-card"><span>primer length</span><strong>${formatNumber(result.primerLen)}</strong></div>
    </div>
    <p class="muted">${note}</p>
    <details open><summary>Output (${result.listFiltered ? "filtered names" : "passed FASTA"})</summary><pre class="tool-log">${escapeHtml(truncateText(result.stdout, 20000)) || "(empty)"}</pre></details>
    <details><summary>Command &amp; log</summary><pre class="tool-log">${escapeHtml(result.command)}\n\n${escapeHtml(truncateText(result.stderr, 8000))}</pre></details>
  `;
}

async function saveFilterOutput() {
  if (!filterOutput.trim()) return;
  const name = ui.filterListFiltered.checked ? "filtered-names.txt" : "passed.fa";
  try {
    const res = await window.dbgps.saveFile({ defaultName: name, content: filterOutput });
    if (res.saved) appendLog(`Saved filter output to ${res.path}`);
  } catch (error) {
    appendLog(`Save failed: ${errMessage(error)}`);
  }
}

// ---- Report view ----
async function selectReportRef() {
  const file = await pickOneFile();
  if (file) {
    reportRefFile = file;
    renderPathChip(ui.reportRefFile, [file], "No reference selected");
  }
}

async function selectReportNgs() {
  const files = await window.dbgps.selectFiles();
  reportNgsFiles = files;
  renderPathChip(ui.reportNgsFiles, files, "No reads selected");
}

async function generateReport() {
  if (!reportRefFile) {
    await selectReportRef();
    if (!reportRefFile) return;
  }
  ui.reportRunButton.disabled = true;
  reportNarrative = "";
  ui.reportResult.classList.remove("empty-state");
  ui.reportResult.innerHTML = `<div class="tool-loading">Running DBGPS-analyzer, DBGPS-links, and DBGPS-seq-filter…</div>`;
  try {
    const result = await window.dbgps.runReport({
      referenceFile: reportRefFile,
      ngsFiles: reportNgsFiles,
      k: Number(ui.reportK.value),
      threads: Number(ui.reportThreads.value),
      readLength: Number(ui.reportReadLength.value),
      primerLen: Number(ui.reportPrimer.value),
      linksM: Number(ui.reportLinksM.value),
      filterM: Number(ui.reportFilterM.value)
    });
    renderReport(result);
  } catch (error) {
    latestReport = null;
    ui.reportAiButton.disabled = true;
    ui.reportExportHtmlButton.disabled = true;
    ui.reportExportMdButton.disabled = true;
    ui.reportResult.innerHTML = `<div class="error-card">${escapeHtml(errMessage(error))}</div>`;
  } finally {
    ui.reportRunButton.disabled = false;
    renderIcons();
  }
}

function reportVerdicts(report: ReportResult): Verdict[] {
  const verdicts: Verdict[] = [];
  const total = report.totalStrands || 0;
  const entFrac = total ? report.entangled / total : 0;
  if (report.entangled === 0) {
    verdicts.push({ level: "ok", text: `No entangled strands among ${formatNumber(total)} references at k=${report.k}.` });
  } else {
    verdicts.push({
      level: entFrac > 0.1 ? "bad" : "warn",
      text: `${formatNumber(report.entangled)} of ${formatNumber(total)} strands (${fmtPct(entFrac)}) are entangled (share k-mers above the filter threshold).`
    });
  }
  if (report.crossLinks != null) {
    verdicts.push({
      level: report.crossLinks === 0 ? "ok" : "warn",
      text: `${formatNumber(report.crossLinks)} cross-links between reference strands at k=${report.k}.`
    });
  }
  const h = report.analyzer?.headline;
  if (h) {
    verdicts.push({
      level: h.sm >= 0.95 ? "ok" : h.sm >= 0.8 ? "warn" : "bad",
      text: `Strand recovery Sm = ${fmtPct(h.sm)} (${formatNumber(h.paths)}/${formatNumber(h.total)} strands fully covered).`
    });
    verdicts.push({
      level: h.kd <= 0.05 ? "ok" : h.kd <= 0.2 ? "warn" : "bad",
      text: `k-mer dropout Kd = ${fmtPct(h.kd)}.`
    });
    if (Number.isFinite(h.kn)) {
      verdicts.push({
        level: h.kn <= 0.5 ? "ok" : h.kn <= 2 ? "warn" : "bad",
        text: `k-mer noise Kn = ${fmtFloat(h.kn)}.`
      });
    }
  } else {
    verdicts.push({ level: "warn", text: "No NGS reads provided — Sm/Kd/Kn (coverage, dropout, noise) were not computed." });
  }
  return verdicts;
}

function smkdknTable(rows: SmKdKnRow[]) {
  if (!rows.length) return `<p class="muted">No analyzer rows.</p>`;
  const head = ["Ratio", "Cov", "Total", "Paths", "Noise", "Exist", "Lost", "Sm", "Kd", "Kn"];
  const body = rows.map((r) => {
    const cells = [
      r.ratio.toFixed(2), r.coverage, r.total, r.paths, r.noise, r.exist, r.lost,
      fmtFloat(r.sm), fmtFloat(r.kd), Number.isFinite(r.kn) ? fmtFloat(r.kn) : "nan"
    ];
    return `<tr>${cells.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`;
  }).join("");
  return `<table class="data-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}

function verdictIcon(level: Verdict["level"]) {
  return level === "ok" ? "check-circle" : level === "warn" ? "alert-triangle" : "x-circle";
}

function renderReport(report: ReportResult) {
  latestReport = report;
  ui.reportResult.classList.remove("empty-state");
  ui.reportAiButton.disabled = false;
  ui.reportExportHtmlButton.disabled = false;
  ui.reportExportMdButton.disabled = false;
  const h = report.analyzer?.headline || null;
  const verdicts = reportVerdicts(report);
  const narrative = reportNarrative
    ? `<div class="narrative-body">${escapeHtml(reportNarrative).replace(/\n/g, "<br/>")}</div>`
    : `<p class="muted">Click "Interpret with AI" for a narrative diagnosis using the active provider.</p>`;
  ui.reportResult.innerHTML = `
    <div class="report">
      <div class="report-head">
        <h3>DBGPS diagnostics report</h3>
        <p class="muted">${escapeHtml(new Date(report.generatedAt).toLocaleString())} · k=${formatNumber(report.k)} · ${escapeHtml(compactPath(report.referenceFile))}</p>
      </div>
      <div class="report-metrics">
        <div class="metric-card"><span>Reference strands</span><strong>${formatNumber(report.totalStrands)}</strong></div>
        <div class="metric-card"><span>Entangled</span><strong>${formatNumber(report.entangled)}</strong></div>
        <div class="metric-card"><span>Cross-links</span><strong>${report.crossLinks == null ? "-" : formatNumber(report.crossLinks)}</strong></div>
        ${h ? `<div class="metric-card"><span>Recovery Sm</span><strong>${fmtPct(h.sm)}</strong></div>
        <div class="metric-card"><span>Dropout Kd</span><strong>${fmtPct(h.kd)}</strong></div>
        <div class="metric-card"><span>Noise Kn</span><strong>${Number.isFinite(h.kn) ? fmtFloat(h.kn) : "n/a"}</strong></div>` : ""}
      </div>
      <div class="report-section">
        <h4>Verdicts</h4>
        <ul class="verdict-list">${verdicts.map((v) => `<li class="verdict ${v.level}"><i data-lucide="${verdictIcon(v.level)}"></i><span>${escapeHtml(v.text)}</span></li>`).join("")}</ul>
      </div>
      ${report.analyzer
        ? `<div class="report-section"><h4>Coverage metrics — DBGPS-analyzer</h4>${smkdknTable(report.analyzer.rows)}</div>`
        : `<div class="report-section"><h4>Coverage metrics — DBGPS-analyzer</h4><p class="muted">No NGS reads provided; Sm/Kd/Kn not computed.</p></div>`}
      <div class="report-section">
        <h4>Entanglement — DBGPS-seq-filter (m=${formatNumber(report.filterM)}, p=${formatNumber(report.primerLen)})</h4>
        <p>${formatNumber(report.passed)} passed · ${formatNumber(report.entangled)} entangled${report.entangledTruncated ? " (list truncated to 1000)" : ""}</p>
        ${report.entangledNames.length ? `<details><summary>Entangled strand names (${formatNumber(report.entangledNames.length)})</summary><pre class="tool-log">${escapeHtml(report.entangledNames.join("\n"))}</pre></details>` : ""}
      </div>
      <div class="report-section">
        <h4>Cross-links — DBGPS-links (m=${formatNumber(report.linksM)})</h4>
        <p>${report.crossLinks == null ? "n/a" : formatNumber(report.crossLinks)} k-mers shared across reference strands.</p>
      </div>
      <div class="report-section narrative">
        <h4>AI interpretation</h4>
        ${narrative}
      </div>
      <details><summary>Commands</summary><pre class="tool-log">${escapeHtml([report.linksCommand, report.filterCommand, report.analyzer?.command].filter(Boolean).join("\n"))}</pre></details>
    </div>`;
  renderIcons();
}

async function interpretReport() {
  if (!latestReport) return;
  ui.reportAiButton.disabled = true;
  reportNarrative = "Generating AI interpretation…";
  renderReport(latestReport);
  try {
    const instruction =
      "You are given a DBGPS DNA data-storage diagnostics report (JSON) combining strand recovery (Sm), " +
      "k-mer dropout (Kd), k-mer noise (Kn), cross-link counts, and entanglement filtering across a set of " +
      "reference strands. Write a concise interpretation: overall data quality, the most likely failure modes " +
      "(dropout, noise, entanglement/chimeras), and concrete recommendations (coverage cutoffs, primer removal, " +
      "resynthesis, deeper sequencing).";
    const result = await window.dbgps.aiDiagnose({
      messages: [{ role: "user", content: instruction }],
      context: latestReport,
      settings: currentAiSettings()
    });
    reportNarrative = result.content;
  } catch (error) {
    reportNarrative = `AI interpretation failed: ${errMessage(error)}`;
  } finally {
    ui.reportAiButton.disabled = false;
    if (latestReport) renderReport(latestReport);
  }
}

function buildReportMarkdown(report: ReportResult, narrative: string) {
  const lines: string[] = [];
  lines.push("# DBGPS Diagnostics Report", "");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Reference: ${report.referenceFile}`);
  lines.push(`- NGS reads: ${report.ngsFiles.length ? report.ngsFiles.join(", ") : "(none)"}`);
  lines.push(`- k-mer: ${report.k} · primer length: ${report.primerLen}`, "");
  lines.push("## Summary", "", "| Metric | Value |", "| --- | --- |");
  lines.push(`| Reference strands | ${report.totalStrands} |`);
  lines.push(`| Entangled strands | ${report.entangled} |`);
  lines.push(`| Passed strands | ${report.passed} |`);
  lines.push(`| Cross-links | ${report.crossLinks == null ? "n/a" : report.crossLinks} |`);
  const h = report.analyzer?.headline;
  if (h) {
    lines.push(`| Strand recovery Sm | ${fmtPct(h.sm)} |`);
    lines.push(`| k-mer dropout Kd | ${fmtPct(h.kd)} |`);
    lines.push(`| k-mer noise Kn | ${Number.isFinite(h.kn) ? fmtFloat(h.kn) : "n/a"} |`);
  }
  lines.push("", "## Verdicts", "");
  for (const v of reportVerdicts(report)) lines.push(`- **${v.level.toUpperCase()}** — ${v.text}`);
  if (report.analyzer) {
    lines.push("", "## Coverage metrics (DBGPS-analyzer)", "");
    lines.push("| Ratio | Cov | Total | Paths | Noise | Exist | Lost | Sm | Kd | Kn |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of report.analyzer.rows) {
      lines.push(`| ${r.ratio.toFixed(2)} | ${r.coverage} | ${r.total} | ${r.paths} | ${r.noise} | ${r.exist} | ${r.lost} | ${fmtFloat(r.sm)} | ${fmtFloat(r.kd)} | ${Number.isFinite(r.kn) ? fmtFloat(r.kn) : "nan"} |`);
    }
  }
  if (report.entangledNames.length) {
    lines.push("", `## Entangled strands (${report.entangledNames.length}${report.entangledTruncated ? ", truncated" : ""})`, "", "```", ...report.entangledNames, "```");
  }
  if (narrative) lines.push("", "## AI interpretation", "", narrative);
  lines.push("", "## Commands", "", "```", report.linksCommand, report.filterCommand, ...(report.analyzer ? [report.analyzer.command] : []), "```", "");
  return lines.join("\n");
}

function buildReportHtml(report: ReportResult, narrative: string) {
  const h = report.analyzer?.headline || null;
  const verdicts = reportVerdicts(report)
    .map((v) => `<li class="v-${v.level}">${escapeHtml(v.text)}</li>`)
    .join("");
  const analyzerTable = report.analyzer
    ? `<table><thead><tr>${["Ratio", "Cov", "Total", "Paths", "Noise", "Exist", "Lost", "Sm", "Kd", "Kn"].map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${report.analyzer.rows.map((r) => `<tr>${[r.ratio.toFixed(2), r.coverage, r.total, r.paths, r.noise, r.exist, r.lost, fmtFloat(r.sm), fmtFloat(r.kd), Number.isFinite(r.kn) ? fmtFloat(r.kn) : "nan"].map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<p class="muted">No NGS reads provided; Sm/Kd/Kn not computed.</p>`;
  const summaryRows = [
    ["Reference strands", formatNumber(report.totalStrands)],
    ["Entangled strands", formatNumber(report.entangled)],
    ["Passed strands", formatNumber(report.passed)],
    ["Cross-links", report.crossLinks == null ? "n/a" : formatNumber(report.crossLinks)],
    ...(h ? [["Strand recovery Sm", fmtPct(h.sm)], ["k-mer dropout Kd", fmtPct(h.kd)], ["k-mer noise Kn", Number.isFinite(h.kn) ? fmtFloat(h.kn) : "n/a"]] : [])
  ].map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("");
  const css = "body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1c2530;line-height:1.5}h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #dde3ea;padding-bottom:4px}table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th,td{border:1px solid #dde3ea;padding:5px 8px;text-align:left}th{background:#f4f6f9}ul{padding-left:18px}.v-ok{color:#137a4b}.v-warn{color:#9a6700}.v-bad{color:#b42318}.muted{color:#667085}pre{background:#f4f6f9;border:1px solid #dde3ea;border-radius:6px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap}";
  const narrativeHtml = narrative ? `<h2>AI interpretation</h2><div>${escapeHtml(narrative).replace(/\n/g, "<br/>")}</div>` : "";
  const entangledHtml = report.entangledNames.length
    ? `<h2>Entangled strands (${report.entangledNames.length}${report.entangledTruncated ? ", truncated" : ""})</h2><pre>${escapeHtml(report.entangledNames.join("\n"))}</pre>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DBGPS Diagnostics Report</title><style>${css}</style></head><body>` +
    `<h1>DBGPS Diagnostics Report</h1>` +
    `<p class="muted">Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())} · k=${escapeHtml(String(report.k))} · primer ${escapeHtml(String(report.primerLen))}</p>` +
    `<p class="muted">Reference: ${escapeHtml(report.referenceFile)}<br/>NGS reads: ${escapeHtml(report.ngsFiles.length ? report.ngsFiles.join(", ") : "(none)")}</p>` +
    `<h2>Summary</h2><table>${summaryRows}</table>` +
    `<h2>Verdicts</h2><ul>${verdicts}</ul>` +
    `<h2>Coverage metrics (DBGPS-analyzer)</h2>${analyzerTable}` +
    `<h2>Cross-links (DBGPS-links, m=${escapeHtml(String(report.linksM))})</h2><p>${report.crossLinks == null ? "n/a" : formatNumber(report.crossLinks)} k-mers shared across reference strands.</p>` +
    entangledHtml +
    narrativeHtml +
    `<h2>Commands</h2><pre>${escapeHtml([report.linksCommand, report.filterCommand, report.analyzer?.command].filter(Boolean).join("\n"))}</pre>` +
    `</body></html>`;
}

async function exportReport(format: "html" | "md") {
  if (!latestReport) return;
  const content = format === "html" ? buildReportHtml(latestReport, reportNarrative) : buildReportMarkdown(latestReport, reportNarrative);
  const stamp = latestReport.generatedAt.replace(/[:.]/g, "-");
  const name = `dbgps-report-${stamp}.${format === "html" ? "html" : "md"}`;
  try {
    const res = await window.dbgps.saveFile({ defaultName: name, content });
    if (res.saved) appendLog(`Report exported to ${res.path}`);
  } catch (error) {
    appendLog(`Export failed: ${errMessage(error)}`);
  }
}

ui.viewTabs.forEach((tab) => tab.addEventListener("click", () => setView((tab.dataset.view as ViewName) || "interactive")));
ui.linksSelectButton.addEventListener("click", selectLinksFile);
ui.linksRunButton.addEventListener("click", runLinksTool);
ui.filterSelectButton.addEventListener("click", selectFilterFile);
ui.filterRunButton.addEventListener("click", runFilterTool);
ui.filterSaveButton.addEventListener("click", saveFilterOutput);
ui.reportRefButton.addEventListener("click", selectReportRef);
ui.reportNgsButton.addEventListener("click", selectReportNgs);
ui.reportRunButton.addEventListener("click", generateReport);
ui.reportAiButton.addEventListener("click", interpretReport);
ui.reportExportHtmlButton.addEventListener("click", () => exportReport("html"));
ui.reportExportMdButton.addEventListener("click", () => exportReport("md"));

loadSettings();
renderSettings();
updateQueryModeControls();
renderFileList();
renderIcons();
setView("interactive");
void loadSecrets();
