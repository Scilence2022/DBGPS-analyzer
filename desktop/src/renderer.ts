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
  decodedLength: number;
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
  upstreamDepthInput: $("upstreamDepthInput") as HTMLInputElement,
  downstreamDepthInput: $("downstreamDepthInput") as HTMLInputElement,
  resultView: $("resultView"),
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

function saveSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings));
}

function rerenderLatestResult() {
  if (latestResult?.type === "kmer") renderKmerResult(latestResult);
  else if (latestResult?.type === "index") renderIndexResult(latestResult);
  else if (latestResult?.type === "sequence") renderSequenceResult(latestResult);
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
            <input class="secret-input" data-provider-api-key="${provider.id}" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(settings.apiKey)}" placeholder="${escapeHtml(provider.envHint)}" />
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

function renderTreeNodeCard(node: { kmer: string; coverage: number; base?: string; step?: number }, center = false, maxCoverage = node.coverage) {
  const meta = center ? "Query k-mer" : `Step ${formatNumber(node.step)} · ${escapeHtml(node.base || "")}`;
  const detail = center
    ? `Query k-mer: ${node.kmer}\nCoverage: ${formatNumber(node.coverage)}`
    : `Base: ${node.base || ""}\nStep: ${formatNumber(node.step)}\nk-mer: ${node.kmer}\nCoverage: ${formatNumber(node.coverage)}`;
  if (appSettings.kmerTreeMode === "bases") {
    const size = center ? 86 : circularNodeSize(node.coverage, maxCoverage);
    return `
      <div class="tree-node-card compact ${center ? "center" : ""} ${coverageClass(node.coverage)}" style="--node-size:${size}px" title="${escapeHtml(detail)}">
        ${center ? `<code>${escapeHtml(node.kmer)}</code>` : `<strong>${escapeHtml(node.base || "?")}</strong>`}
        <span>${formatNumber(node.coverage)}</span>
      </div>
    `;
  }

  return `
    <div class="tree-node-card ${center ? "center" : ""} ${coverageClass(node.coverage)}" title="${escapeHtml(detail)}">
      <span>${meta}</span>
      <code>${escapeHtml(node.kmer)}</code>
      <strong class="coverage ${coverageClass(node.coverage)}">${formatNumber(node.coverage)}</strong>
    </div>
  `;
}

function renderTreeNodes(nodes: KmerTreeNode[] | undefined, direction: "upstream" | "downstream", maxCoverage: number, showEmpty = true): string {
  if (!nodes || nodes.length === 0) {
    return showEmpty ? `<div class="tree-empty">No covered branches</div>` : "";
  }

  return nodes.map((node) => {
    const children = renderTreeNodes(node.children, direction, maxCoverage, false);
    const card = renderTreeNodeCard(node, false, maxCoverage);
    return direction === "upstream"
      ? `
        <div class="tree-node-row upstream">
          <div class="tree-children">${children}</div>
          <span class="tree-edge" aria-hidden="true"></span>
          ${card}
        </div>
      `
      : `
        <div class="tree-node-row downstream">
          ${card}
          <span class="tree-edge" aria-hidden="true"></span>
          <div class="tree-children">${children}</div>
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
        ${renderTreeNodeCard({ kmer: leftAnchor, coverage: data.leftCoverage ?? data.coverage }, true, maxCoverage)}
        <span class="anchor-gap">...</span>
        ${renderTreeNodeCard({ kmer: rightAnchor, coverage: data.rightCoverage ?? data.coverage }, true, maxCoverage)}
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
        <small>${data.completed ? "auto-completed to k-mer" : data.truncated ? "end-anchored" : "exact k-mer length"}</small>
      </div>
      <div class="metric">
        <span>Decoded DNA</span>
        <strong><code>${escapeHtml(data.decoded)}</code></strong>
      </div>
      <div class="metric">
        <span>Decoded / k</span>
        <strong>${formatNumber(data.decodedLength)} / ${formatNumber(data.k)}</strong>
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

function updateQueryModeControls() {
  elements.queryOptions.classList.toggle("hidden", queryMode === "sequence");
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
    return `index ${input} ${depthInputValue(elements.upstreamDepthInput)} ${depthInputValue(elements.downstreamDepthInput)}`;
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
elements.resultView.addEventListener("click", (event) => {
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

loadSettings();
renderSettings();
updateQueryModeControls();
renderFileList();
renderIcons();
