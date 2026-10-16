import { createIcons, icons } from "lucide";
import type { DStoreQCApi } from "./preload";
import type { AgentProgress, AgentRun, AgentStatus, AgentToolTrace } from "./agent-types";
import {
  agentSuggestions, compactTrace, createThread, deriveThreadTitle, describeToolCall, linkifyDnaCode, matchSlashCommands,
  normalizeThreadStore, parseSlashCommand, profileSeries, relativeTime, THREAD_LIMITS, TOOL_LABELS, toolResultFacts, toolTargets,
  type ChatMessage, type ChatMessageMeta, type ChatMode, type ChatThread, type CompactTrace, type SlashAction, type SlashCommand,
  type Suggestion, type ThreadStore, type ToolTarget
} from "./agent-ui";
import { adjacentFoldChanges, describeFoldEdge, foldAxisCap, formatFold, type FoldEdge } from "./fold-change";
import { analyzerScope, type AnalyzerScope, type AnalyzerSummaryResult } from "./analyzer-config";

declare global {
  interface Window {
    dstoreqc: DStoreQCApi;
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

type SequenceResult = AnalyzerScope & {
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

type SummaryResult = AnalyzerSummaryResult;

type AnalyzerResult = KmerResult | IndexResult | SequenceResult | SummaryResult | (AnalyzerScope & { type: "error"; message: string });

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
  sequenceChartSeries: "coverage" | "ratio" | "both";
  primerFront: number;
  primerBack: number;
  agentTools?: boolean;
  chatWidth: number;
  chatCollapsed: boolean;
  chatExpanded: boolean;
};

// Keep the existing storage key when reusing a profile from before the rename.
const SETTINGS_STORAGE_KEY = "dbgps-settings-v3";
const DEFAULT_PRIMER = 18;

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
    defaultModel: "claude-sonnet-5",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-4-5"],
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
  addFilesButton: $("addFilesButton") as HTMLButtonElement,
  fileList: $("fileList"),
  kInput: $("kInput") as HTMLInputElement,
  threadsInput: $("threadsInput") as HTMLInputElement,
  readLengthInput: $("readLengthInput") as HTMLInputElement,
  bloomInput: $("bloomInput") as HTMLInputElement,
  bloomOptions: $("bloomOptions"),
  selectBloomReferenceButton: $("selectBloomReferenceButton") as HTMLButtonElement,
  bloomReferenceFile: $("bloomReferenceFile"),
  bloomBitsInput: $("bloomBitsInput") as HTMLInputElement,
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
  distinctKmersLabel: $("distinctKmersLabel"),
  totalCoverage: $("totalCoverage"),
  totalCoverageLabel: $("totalCoverageLabel"),
  summaryScope: $("summaryScope"),
  summaryK: $("summaryK"),
  summaryFiles: $("summaryFiles"),
  layout: document.querySelector(".layout") as HTMLElement,
  chatPanel: $("chatPanel"),
  chatResizer: $("chatResizer"),
  chatRail: $("chatRail") as HTMLButtonElement,
  chatRailBadge: $("chatRailBadge"),
  threadsButton: $("threadsButton") as HTMLButtonElement,
  threadTitle: $("threadTitle"),
  agentSubtitle: $("agentSubtitle"),
  newThreadButton: $("newThreadButton") as HTMLButtonElement,
  expandChatButton: $("expandChatButton") as HTMLButtonElement,
  collapseChatButton: $("collapseChatButton") as HTMLButtonElement,
  threadsDrawer: $("threadsDrawer"),
  threadSearchInput: $("threadSearchInput") as HTMLInputElement,
  threadList: $("threadList"),
  capabilitiesButton: $("capabilitiesButton") as HTMLButtonElement,
  agentReadinessDot: $("agentReadinessDot"),
  agentReadinessText: $("agentReadinessText"),
  agentCapabilities: $("agentCapabilities"),
  agentLimitsText: $("agentLimitsText"),
  agentToolList: $("agentToolList"),
  agentRunbar: $("agentRunbar"),
  agentRunbarText: $("agentRunbarText"),
  agentRunbarMeta: $("agentRunbarMeta"),
  agentRunbarProgress: $("agentRunbarProgress"),
  chatSuggestions: $("chatSuggestions"),
  chatComposer: $("chatComposer") as HTMLFormElement,
  editBanner: $("editBanner"),
  cancelEditButton: $("cancelEditButton") as HTMLButtonElement,
  slashMenu: $("slashMenu"),
  chatMessages: $("chatMessages"),
  chatInput: $("chatInput") as HTMLTextAreaElement,
  sendChatButton: $("sendChatButton") as HTMLButtonElement,
  stopChatButton: $("stopChatButton") as HTMLButtonElement,
  exportChatButton: $("exportChatButton") as HTMLButtonElement,
  chatContextChip: $("chatContextChip") as HTMLButtonElement,
  chatContextLabel: $("chatContextLabel"),
  chatContextEmpty: $("chatContextEmpty"),
  contextPinButton: $("contextPinButton") as HTMLButtonElement,
  contextPreviewButton: $("contextPreviewButton") as HTMLButtonElement,
  contextDialog: $("contextDialog"),
  contextDialogTitle: $("contextDialogTitle"),
  contextDialogMeta: $("contextDialogMeta"),
  contextDialogBody: $("contextDialogBody"),
  closeContextDialogButton: $("closeContextDialogButton") as HTMLButtonElement,
  aiProvider: $("aiProvider"),
  chatProviderSwitch: $("chatProviderSwitch"),
  chatProviderSelect: $("chatProviderSelect") as HTMLSelectElement,
  chatModelSelect: $("chatModelSelect") as HTMLSelectElement,
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
let analyzerLoading = false;
let bloomReferenceFile = "";
let loadedScope: AnalyzerScope = {};
let queryMode: "kmer" | "index" | "sequence" = "kmer";
let latestResult: AnalyzerResult | null = null;
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
    maxTokens: 4096,
    appearance: "system",
    kmerTreeMode: "cards",
    sequenceChartType: "bar",
    sequenceChartSeries: "both",
    primerFront: DEFAULT_PRIMER,
    primerBack: DEFAULT_PRIMER,
    agentTools: false,
    chatWidth: 400,
    chatCollapsed: false,
    chatExpanded: false
  };
}

function normalizePrimer(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100000, Math.max(0, Math.trunc(parsed)));
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
  const sequenceChartSeries =
    stored.sequenceChartSeries === "coverage" || stored.sequenceChartSeries === "ratio" || stored.sequenceChartSeries === "both"
      ? stored.sequenceChartSeries
      : "both";

  return {
    activeProvider,
    providers,
    temperature: Number.isFinite(Number(stored.temperature)) ? Number(stored.temperature) : defaults.temperature,
    maxTokens: Number.isFinite(Number(stored.maxTokens)) ? Number(stored.maxTokens) : defaults.maxTokens,
    appearance,
    kmerTreeMode,
    sequenceChartType,
    sequenceChartSeries,
    primerFront: normalizePrimer(stored.primerFront, defaults.primerFront),
    primerBack: normalizePrimer(stored.primerBack, defaults.primerBack),
    agentTools: typeof stored.agentTools === "boolean" ? stored.agentTools : Boolean(defaults.agentTools),
    chatWidth: Number.isFinite(Number(stored.chatWidth)) ? Math.min(760, Math.max(320, Math.trunc(Number(stored.chatWidth)))) : defaults.chatWidth,
    chatCollapsed: stored.chatCollapsed === true,
    chatExpanded: stored.chatExpanded === true
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
  window.dstoreqc.saveSecrets(map).catch(() => {});
}

async function loadSecrets() {
  try {
    const secrets = await window.dstoreqc.loadSecrets();
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
  elements.agentSubtitle.textContent = `${PROVIDER_BY_ID[settings.provider].label} · ${settings.model}`;
  elements.agentSubtitle.title = elements.agentSubtitle.textContent;
}

// The chat header mirrors the Settings modal's provider routing: same appSettings
// fields, same PROVIDERS catalog, same model list source as modelAssignmentList.
function renderChatProviderSwitch() {
  ensureActiveProvider();
  const active = appSettings.activeProvider;
  elements.chatProviderSelect.innerHTML = enabledProviders()
    .map((provider) => `<option value="${provider.id}" ${provider.id === active ? "selected" : ""}>${escapeHtml(provider.label)}</option>`)
    .join("");
  elements.chatModelSelect.innerHTML = modelOptions(active, appSettings.providers[active].selectedModel);
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
  renderChatProviderSwitch();
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
    const result = await window.dstoreqc.refreshProviderModels({
      provider: providerId,
      apiKey: settings.apiKey || "",
      baseUrl: settings.baseUrl
    });
    if (result.models.length === 0) {
      settings.refreshStatus = "No models returned";
    } else {
      settings.models = result.models;
      // The refreshed list is sorted alphabetically, so models[0] is an arbitrary
      // model (often a legacy or non-chat one). Prefer the provider's curated
      // default when the previously-selected model is gone.
      if (!settings.models.includes(settings.selectedModel)) {
        settings.selectedModel = settings.models.includes(provider.defaultModel)
          ? provider.defaultModel
          : settings.models[0];
      }
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
  loadedScope = analyzerScope(data);
  const reference = data.indexScope === "reference";
  elements.distinctKmersLabel.textContent = reference ? "Observed reference k-mers" : "Distinct k-mers";
  elements.totalCoverageLabel.textContent = reference ? "Reference coverage" : "Total coverage";
  elements.summaryScope.hidden = !reference;
  elements.summaryScope.textContent = reference
    ? `Reference scope: ${data.referenceFile || bloomReferenceFile}; ${formatNumber(data.targetKmers)} target keys; minimum ${formatNumber(data.bloom?.bitsPerKey)} bits/key. Global noise (Kn), off-target coverage and graph queries: unavailable.`
    : "";
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
    const result = (await window.dstoreqc.queryAnalyzer(command)) as AnalyzerResult;
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

function renderSequenceChartControls(hasEdges: boolean, series: "coverage" | "ratio" | "both") {
  const typeOptions: Array<{ type: "bar" | "line"; label: string }> = [
    { type: "bar", label: "Bars" },
    { type: "line", label: "Line" }
  ];
  const seriesOptions: Array<{ value: "coverage" | "ratio" | "both"; label: string }> = [
    { value: "coverage", label: "Coverage" },
    { value: "ratio", label: "Fold change" },
    { value: "both", label: "Both" }
  ];
  const showCoverage = series !== "ratio";
  const showFold = series !== "coverage";
  const legend = [
    showCoverage ? '<span class="legend-item"><i class="swatch coverage"></i>Coverage</span><span class="legend-item"><i class="swatch low"></i>Low (&lt; 3)</span><span class="legend-item"><i class="swatch zero"></i>Zero</span>' : "",
    showFold ? '<span class="legend-item"><i class="swatch rise"></i>Rise</span><span class="legend-item"><i class="swatch drop"></i>Drop</span><span class="legend-item"><i class="swatch edge"></i>Into / out of zero</span>' : ""
  ].join("");
  return `
    <div class="sequence-chart-header">
      <div>
        <strong>Coverage by k-mer position</strong>
        <span>${showFold ? "Fold change is signed log₂(next / current) between adjacent k-mers: below 0 coverage falls, above 0 it rises; dashed guides mark 2-fold." : "Coverage of each ordered k-mer window along the sequence."}</span>
        <div class="chart-legend">${legend}</div>
      </div>
      <div class="chart-toggles">
        ${
          hasEdges
            ? `<div class="chart-toggle series" role="tablist" aria-label="Chart series">
          ${seriesOptions
            .map(
              (option) => `
              <button type="button" class="${series === option.value ? "active" : ""}" data-sequence-series="${option.value}" role="tab" aria-selected="${series === option.value}">
                ${escapeHtml(option.label)}
              </button>
            `
            )
            .join("")}
        </div>`
            : ""
        }
        ${
          showCoverage
            ? `<div class="chart-toggle" role="tablist" aria-label="Coverage chart type">
          ${typeOptions
            .map(
              (option) => `
              <button type="button" class="${appSettings.sequenceChartType === option.type ? "active" : ""}" data-sequence-chart="${option.type}" role="tab" aria-selected="${appSettings.sequenceChartType === option.type}">
                ${escapeHtml(option.label)}
              </button>
            `
            )
            .join("")}
        </div>`
            : ""
        }
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

// Both tracks share one x scale: window i occupies [i, i + 1] in a viewBox N
// units wide, so the fold-change bar for edge i sits exactly on the boundary
// between the two coverage bars it compares.
function renderCoverageTrack(data: SequenceCoverage[], maxCoverage: number) {
  const n = data.length;
  const grid = `<line x1="0" y1="50" x2="${n}" y2="50" class="chart-grid-line"></line>`;
  let marks: string;
  if (appSettings.sequenceChartType === "line") {
    const points = data
      .map((item, i) => `${(i + 0.5).toFixed(2)},${(100 - (item.coverage / maxCoverage) * 100).toFixed(2)}`)
      .join(" ");
    const zeros = data
      .map((item, i) => (item.coverage === 0 ? `<rect class="cov-zero" x="${i}" y="97" width="1" height="3"><title>${escapeHtml(item.position)} ${escapeHtml(item.kmer)} cov=0</title></rect>` : ""))
      .join("");
    marks = `<polyline points="${points}" class="coverage-line"></polyline>${zeros}`;
  } else {
    marks = data
      .map((item, i) => {
        const height = item.coverage === 0 ? 3 : Math.max(1.5, (item.coverage / maxCoverage) * 100);
        return `<rect class="cov-${coverageClass(item.coverage)}" x="${(i + 0.12).toFixed(2)}" y="${(100 - height).toFixed(2)}" width="0.76" height="${height.toFixed(2)}"><title>${escapeHtml(item.position)} ${escapeHtml(item.kmer)} cov=${escapeHtml(item.coverage)}</title></rect>`;
      })
      .join("");
  }
  return `<svg class="track-svg" viewBox="0 0 ${n} 100" preserveAspectRatio="none" role="img" aria-label="k-mer coverage">${grid}${marks}</svg>`;
}

function renderFoldTrack(edges: FoldEdge[], n: number, cap: number) {
  const y = (log2: number) => 50 - (Math.max(-cap, Math.min(cap, log2)) / cap) * 50;
  const guides = [1, -1].map((v) => `<line x1="0" y1="${y(v).toFixed(2)}" x2="${n}" y2="${y(v).toFixed(2)}" class="fold-guide"></line>`).join("");
  const bars = edges
    .map((edge) => {
      if (edge.kind === "both-zero") return "";
      const x = (edge.edge + 1 - 0.32).toFixed(2);
      const title = `<title>${escapeHtml(describeFoldEdge(edge))}</title>`;
      if (edge.kind !== "change") {
        const up = edge.kind === "from-zero";
        return `<rect class="fold-edge" x="${x}" y="${up ? 0 : 50}" width="0.64" height="50">${title}</rect>`;
      }
      const top = Math.min(50, y(edge.log2!));
      const height = Math.max(0.8, Math.abs(y(edge.log2!) - 50));
      const strong = Math.abs(edge.log2!) >= 1;
      const clipped = Math.abs(edge.log2!) > cap;
      return `<rect class="fold-${edge.log2! >= 0 ? "rise" : "drop"}${strong ? " strong" : ""}${clipped ? " clipped" : ""}" x="${x}" y="${(edge.log2! >= 0 ? top : 50).toFixed(2)}" width="0.64" height="${height.toFixed(2)}">${title}</rect>`;
    })
    .join("");
  return `<svg class="track-svg" viewBox="0 0 ${n} 100" preserveAspectRatio="none" role="img" aria-label="signed log2 fold change between adjacent k-mers">${guides}<line x1="0" y1="50" x2="${n}" y2="50" class="fold-zero"></line>${bars}</svg>`;
}

function renderSequenceCoverageChart(data: SequenceResult) {
  const shown = data.coverages.slice(0, 180);
  const xLabels = chartAxisLabels(shown);
  const edges = adjacentFoldChanges(shown.map((item) => item.coverage));
  const hasEdges = edges.length > 0;
  // Fold change needs at least one adjacent pair; otherwise fall back.
  const series = hasEdges ? appSettings.sequenceChartSeries : "coverage";
  const maxCoverage = Math.max(1, ...shown.map((item) => item.coverage));
  const cap = foldAxisCap(edges);
  const showCoverage = series !== "ratio";
  const showFold = series !== "coverage";
  const both = showCoverage && showFold;

  const coverageRow = showCoverage ? `
        <div class="y-axis-label">Coverage</div>
        <div class="y-axis">
          <span>${formatNumber(maxCoverage)}</span>
          <span>${formatNumber(Math.round(maxCoverage / 2))}</span>
          <span>0</span>
        </div>
        <div class="chart-plot${both ? " short" : ""}">${renderCoverageTrack(shown, maxCoverage)}</div>` : "";
  const foldRow = showFold ? `
        <div class="y-axis-label fold" title="Signed log₂ fold change between adjacent k-mers">log₂ FC</div>
        <div class="y-axis fold">
          <span title="${escapeHtml(formatFold(cap))}">+${cap}</span>
          <span>0</span>
          <span title="${escapeHtml(formatFold(-cap))}">−${cap}</span>
        </div>
        <div class="chart-plot fold-plot${both ? " compact" : ""}">${renderFoldTrack(edges, shown.length, cap)}</div>` : "";

  return `
    <section class="sequence-chart-panel">
      ${renderSequenceChartControls(hasEdges, series)}
      <div class="sequence-chart-frame">
        ${coverageRow}
        ${foldRow}
        <div class="x-axis">
          <span>${formatNumber(xLabels.first)}</span>
          <span>${formatNumber(xLabels.mid)}</span>
          <span>${formatNumber(xLabels.last)}</span>
        </div>
        <div class="x-axis-label">Position (k-mer window)</div>
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

function sequenceResultHtml(data: SequenceResult) {
  return `
    ${data.indexScope === "reference" ? `<p class="index-scope">Reference scope: ${escapeHtml(data.referenceFile)}. Only full-reference keys are indexed; global noise (Kn) and off-target coverage are unavailable.</p>` : ""}
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

function renderSequenceResult(data: SequenceResult) {
  elements.resultView.className = "result-view";
  elements.resultView.innerHTML = sequenceResultHtml(data);
}

function renderResult(result: AnalyzerResult) {
  latestResult = result;
  updateChatContextChip();
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
  elements.addFilesButton.disabled = !ready;
  elements.selectFilesButton.disabled = ready;
  elements.kInput.disabled = ready;
  elements.threadsInput.disabled = ready;
  elements.readLengthInput.disabled = ready;
  updateBloomControls();
  updateQueryModeControls();
  refreshAgentStatus();
}

function updateBloomControls() {
  const locked = analyzerReady || analyzerLoading;
  elements.bloomInput.disabled = locked;
  elements.bloomOptions.hidden = !elements.bloomInput.checked;
  elements.selectBloomReferenceButton.disabled = locked || !elements.bloomInput.checked;
  elements.bloomBitsInput.disabled = locked || !elements.bloomInput.checked;
}

async function selectBloomReference() {
  if (analyzerReady || analyzerLoading) return;
  const files = await window.dstoreqc.selectFiles();
  if (!files[0]) return;
  bloomReferenceFile = files[0];
  elements.bloomReferenceFile.innerHTML = `<span title="${escapeHtml(bloomReferenceFile)}">${escapeHtml(compactPath(bloomReferenceFile))}</span>`;
}

async function selectFiles() {
  if (analyzerReady) return;
  selectedFiles = await window.dstoreqc.selectFiles();
  renderFileList();
}

async function addSequencingFiles() {
  if (!analyzerReady) return;
  const files = await window.dstoreqc.selectFiles();
  const newFiles = files.filter((file) => !selectedFiles.includes(file));
  if (newFiles.length === 0) {
    if (files.length > 0) appendLog("No new sequencing files selected.");
    return;
  }

  elements.addFilesButton.disabled = true;
  elements.queryButton.disabled = true;
  setStatus(`Counting ${formatNumber(newFiles.length)} additional NGS file${newFiles.length === 1 ? "" : "s"}`, "running");

  try {
    const summary = (await window.dstoreqc.addAnalyzerFiles(newFiles)) as SummaryResult;
    selectedFiles = summary.files?.length ? summary.files : [...selectedFiles, ...newFiles];
    renderFileList();
    renderSummary(summary);
    latestResult = summary;
    updateChatContextChip();
    appendLog(`Added ${formatNumber(newFiles.length)} NGS file${newFiles.length === 1 ? "" : "s"} to the running kernel.`);
    setStatus("Kernel running", "running");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message);
    setStatus("Failed to add sequencing files", "error");
  } finally {
    elements.addFilesButton.disabled = !analyzerReady;
    elements.queryButton.disabled = !analyzerReady;
  }
}

async function buildAnalyzer() {
  elements.buildButton.disabled = true;
  setStatus("Building C kernel", "running");
  try {
    const result = await window.dstoreqc.buildAnalyzer();
    appendLog(result.log || "DStoreQC is up to date.");
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
  if (analyzerLoading) return;
  if (selectedFiles.length === 0) await selectFiles();
  if (selectedFiles.length === 0) return;

  setAnalyzerReady(false);
  setStatus("Loading sequencing k-mer table", "running");
  elements.startButton.disabled = true;
  elements.selectFilesButton.disabled = true;
  elements.addFilesButton.disabled = true;
  elements.kInput.disabled = true;
  elements.threadsInput.disabled = true;
  elements.readLengthInput.disabled = true;
  analyzerLoading = true;
  updateBloomControls();

  try {
    const ready = (await window.dstoreqc.startAnalyzer({
      files: selectedFiles,
      k: Number(elements.kInput.value),
      threads: Number(elements.threadsInput.value),
      readLength: Number(elements.readLengthInput.value),
      ...(elements.bloomInput.checked ? {
        bloom: true,
        bloomReference: bloomReferenceFile,
        bloomBits: Number(elements.bloomBitsInput.value)
      } : {})
    })) as SummaryResult;
    if (ready.files?.length) {
      selectedFiles = ready.files;
      renderFileList();
    }
    renderSummary(ready);
    latestResult = ready;
    updateChatContextChip();
    setAnalyzerReady(true);
    setStatus("Kernel running", "running");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message);
    setStatus("Kernel failed to start", "error");
    setAnalyzerReady(false);
    elements.startButton.disabled = false;
  } finally {
    analyzerLoading = false;
    updateBloomControls();
  }
}

async function stopAnalyzer() {
  await window.dstoreqc.stopAnalyzer();
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
  const reference = analyzerReady ? loadedScope.indexScope === "reference" : elements.bloomInput.checked;
  if (reference) queryMode = "sequence";
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
    button.disabled = reference && button.dataset.mode !== "sequence";
    button.title = button.disabled ? "Unavailable in reference mode" : "";
    button.classList.toggle("active", button.dataset.mode === queryMode);
    button.setAttribute("aria-selected", String(button.dataset.mode === queryMode));
  });
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
    const result = (await window.dstoreqc.queryAnalyzer(command)) as AnalyzerResult;
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

// ===========================================================================
// AI ChatBox: a streaming, context-aware diagnostics assistant.
//
// The conversation is a real multi-turn transcript (`chatMessages`). On send we
// stream the reply token-by-token over the "ai:chunk" IPC channel, render it as
// Markdown live, and resolve with the full text when the stream ends. A compact
// snapshot of the active view's result travels with the question as context.
// ===========================================================================
// --- Minimal, XSS-safe Markdown renderer (input is escaped before any tag is
// inserted, so only the tags we emit can ever reach the DOM). ---
function formatInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
}

// Split one GFM table row into trimmed cells: drop a single optional leading and
// trailing pipe, then split on pipes that are not backslash-escaped. Returns null
// for a line that carries no pipe at all.
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "|") { cell += "|"; i++; continue; }
    if (body[i] === "|") { cells.push(cell); cell = ""; continue; }
    cell += body[i];
  }
  cells.push(cell);
  return cells.map((text) => text.trim());
}

// A GFM delimiter row (`---`, `:--`, `--:`, `:-:`) doubles as the per-column
// alignment spec. Returns null when the line is not a delimiter row, which is what
// distinguishes a real table from an ordinary paragraph that happens to use pipes.
function tableAlignments(line: string): Array<"left" | "right" | "center" | null> | null {
  const cells = tableCells(line);
  if (!cells) return null;
  const align: Array<"left" | "right" | "center" | null> = [];
  for (const cell of cells) {
    const match = cell.match(/^(:?)-+(:?)$/);
    if (!match) return null;
    align.push(match[1] && match[2] ? "center" : match[2] ? "right" : match[1] ? "left" : null);
  }
  return align;
}

// A table starts where a pipe row is followed by a delimiter row of equal width.
function startsTable(lines: string[], i: number): boolean {
  const header = tableCells(lines[i]);
  if (!header || i + 1 >= lines.length) return false;
  const align = tableAlignments(lines[i + 1]);
  return Boolean(align && align.length === header.length);
}

function renderMarkdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const inline = (text: string) => formatInline(escapeHtml(text));

  for (let i = 0; i < lines.length;) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push(
        `<div class="md-code-wrap"><button type="button" class="md-code-copy" aria-label="Copy code block">Copy</button>` +
        `<pre class="md-code"><code>${escapeHtml(code.join("\n"))}</code></pre></div>`
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h${heading[1].length} class="md-h">${inline(heading[2].trim())}</h${heading[1].length}>`);
      i++;
      continue;
    }

    // Tables are checked before lists so a delimiter row is never mistaken for a
    // bullet. The system prompt asks the model for tables, so this branch matters.
    if (startsTable(lines, i)) {
      closeList();
      const header = tableCells(line) as string[];
      const align = tableAlignments(lines[i + 1]) as Array<"left" | "right" | "center" | null>;
      const cell = (text: string, tag: "th" | "td", at: "left" | "right" | "center" | null) =>
        `<${tag}${at ? ` class="md-al-${at}"` : ""}>${inline(text)}</${tag}>`;
      const head = `<tr>${header.map((text, n) => cell(text, "th", align[n])).join("")}</tr>`;
      const body: string[] = [];
      i += 2;
      while (i < lines.length) {
        const cells = tableCells(lines[i]);
        if (!cells) break;
        // Normalize to the header width so a ragged row cannot skew the columns.
        const row = Array.from({ length: header.length }, (_, n) => cells[n] ?? "");
        body.push(`<tr>${row.map((text, n) => cell(text, "td", align[n])).join("")}</tr>`);
        i++;
      }
      out.push(
        `<div class="md-table-wrap"><table class="md-table"><thead>${head}</thead><tbody>${body.join("")}</tbody></table></div>`
      );
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") { closeList(); out.push('<ul class="md-list">'); listType = "ul"; }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++;
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") { closeList(); out.push('<ol class="md-list">'); listType = "ol"; }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote class="md-quote">${inline(quote[1])}</blockquote>`);
      i++;
      continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }

    closeList();
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|```|>)/.test(lines[i]) &&
      // A table may follow a paragraph with no blank line between them; without
      // this the header and delimiter rows get absorbed into the paragraph.
      !startsTable(lines, i)
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br/>")}</p>`);
  }

  closeList();
  return out.join("\n");
}

// --- Per-view context: the chat always reflects the active view's latest result. ---
let latestLinks: LinksResult | null = null;
let latestFilter: FilterResult | null = null;
let latestBatch: InteractiveBatchResult | null = null;

function currentViewName(): ViewName {
  return (document.body.dataset.view as ViewName) || "interactive";
}

// Percentiles over a numeric sample, using nearest-rank on a sorted copy.
function percentiles(sorted: number[], points: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!sorted.length) return out;
  for (const p of points) {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    out[`p${p}`] = sorted[idx];
  }
  return out;
}

// The per-k-mer coverage array is far too large to send, but dropping it outright
// leaves the assistant unable to see the very distribution it is asked to interpret
// (a mean of 40 looks fine whether the strand is evenly covered or has a hole in it).
// Summarize instead: spread, zero-coverage gaps, and the sharpest adjacency ratios.
function summarizeCoverage(coverages: SequenceCoverage[], ratios: Array<{ position: number; ratio: number }>) {
  if (!coverages.length) return null;
  const values = coverages.map((entry) => entry.coverage);
  const sorted = [...values].sort((a, b) => a - b);

  // Contiguous runs of zero-coverage k-mers: a single long run is a dropout region,
  // many short ones look like uniform under-sequencing. The distinction matters.
  const gaps: Array<{ start: number; length: number }> = [];
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 0) { run++; continue; }
    if (run) gaps.push({ start: coverages[i - run].position, length: run });
    run = 0;
  }
  if (run) gaps.push({ start: coverages[values.length - run].position, length: run });
  gaps.sort((a, b) => b.length - a.length);

  const sharpest = [...ratios]
    .sort((a, b) => Math.abs(Math.log(b.ratio || 1)) - Math.abs(Math.log(a.ratio || 1)))
    .slice(0, 8)
    .map((entry) => ({ position: entry.position, ratio: Number(entry.ratio.toFixed(2)) }));

  return {
    note: "Summary of the per-k-mer coverage profile; the full array is too large to include.",
    kmers: values.length,
    zeroCoverageKmers: values.filter((value) => value === 0).length,
    ...percentiles(sorted, [5, 25, 50, 75, 95]),
    largestZeroRuns: gaps.slice(0, 5),
    sharpestAdjacencyRatios: sharpest
  };
}

// Drop the heavy per-k-mer arrays/trees so the context payload stays small.
function compactInteractive(result: AnalyzerResult): unknown {
  if (result.type === "sequence") {
    const { coverages, ratios, ...rest } = result;
    return { ...rest, coverageProfile: summarizeCoverage(coverages ?? [], ratios ?? []) };
  }
  if (result.type === "kmer") {
    const { upstreamTree, downstreamTree, ...rest } = result;
    void upstreamTree;
    void downstreamTree;
    return rest;
  }
  return result;
}

function compactBatch(batch: InteractiveBatchResult): unknown {
  return {
    ...analyzerScope(batch),
    datasetVersion: batch.datasetVersion,
    file: compactPath(batch.file),
    k: batch.k,
    primerFront: batch.primerFront,
    primerBack: batch.primerBack,
    total: batch.total,
    ok: batch.ok,
    skipped: batch.skipped,
    errors: batch.errors,
    sampleRows: batch.rows.slice(0, 25).map((row) => ({
      index: row.index,
      name: row.name,
      status: row.status,
      message: row.message,
      observed: row.summary?.observed,
      kmerCount: row.summary?.kmerCount,
      complete: row.summary?.complete,
      minCoverage: row.summary?.minCoverage,
      meanCoverage: row.summary?.meanCoverage,
      maxAdjacentRatio: row.summary?.maxAdjacentRatio
    })),
    rowsTruncated: batch.rows.length > 25
  };
}

// The report panel shows rule-based verdicts computed from fixed thresholds, right
// above the AI narrative. Sending them along means the assistant argues from the
// same graded assessment the user is reading rather than inventing its own.
function reportContext(report: ReportResult): unknown {
  return {
    ...report,
    ruleBasedVerdicts: reportVerdicts(report).map((verdict) => ({ level: verdict.level, text: verdict.text }))
  };
}

function buildChatContext(): { label: string; data: unknown } | null {
  switch (currentViewName()) {
    case "interactive":
      return latestResult && (latestResult.type !== "error" || latestResult.indexScope === "reference")
        ? { label: "Interactive result", data: compactInteractive(latestResult) }
        : null;
    case "report":
      return latestReport ? { label: "Diagnostics report", data: reportContext(latestReport) } : null;
    case "links":
      return latestLinks
        ? { label: "Cross-links", data: { file: compactPath(latestLinks.file), k: latestLinks.k, m: latestLinks.m, primerLen: latestLinks.primerLen, crossLinks: latestLinks.crossLinks, command: latestLinks.command } }
        : null;
    case "filter":
      return latestFilter
        ? { label: "Seq-Filter", data: { file: compactPath(latestFilter.file), k: latestFilter.k, m: latestFilter.m, primerLen: latestFilter.primerLen, passedCount: latestFilter.passedCount, filteredCount: latestFilter.filteredCount, skippedCount: latestFilter.skippedCount, command: latestFilter.command } }
        : null;
    case "batch":
      return latestBatch ? { label: "Batch QC", data: compactBatch(latestBatch) } : null;
    default:
      return null;
  }
}

function contextPayloadSize(data: unknown): string {
  try {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    if (!text) return "";
    return text.length < 1000 ? `${text.length} chars` : `${(text.length / 1000).toFixed(1)}k chars`;
  } catch {
    // Circular or otherwise unserializable context: show the chip without a size.
    return "";
  }
}

// Delegated "Copy" for fenced code blocks. Both Markdown hosts (chat transcript
// and report narrative) attach this to their container, so re-renders never
// need per-button wiring.
function handleMarkdownCopyClick(event: Event) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".md-code-copy");
  if (!button) return;
  const code = button.closest(".md-code-wrap")?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
  }, () => {
    button.textContent = "Copy failed";
    setTimeout(() => { button.textContent = "Copy"; }, 1600);
  });
}

// --- Desktop Agent panel: threads, modes, live evidence timeline ---
// Incremental render: finalized Markdown blocks are parsed once into `stableEl`
// (append-only) and only the trailing, still-growing block is re-parsed into
// `liveEl` each animation frame. Per-frame cost is therefore O(current block)
// rather than O(whole response), avoiding the O(N^2) full re-parse and the DOM
// churn (and selection loss) of replacing the entire message every frame.
type ActiveChat = {
  id: string;
  threadId: string;
  mode: ChatMode;
  model: string;
  bubble: HTMLElement;
  body: HTMLElement;
  text: string;
  stableEl: HTMLElement | null;
  liveEl: HTMLElement | null;
  stableLen: number;
  trace: AgentToolTrace[];
  progress: AgentProgress | null;
  startedAt: number;
};

// One row of the evidence timeline, built either from a live trace (with the
// full result) or from the compact copy kept in the saved transcript.
type TimelineItem = {
  callId: string;
  name: string;
  arguments: unknown;
  status: AgentToolTrace["status"];
  durationMs?: number;
  facts: string[];
  targets: ToolTarget[];
  series: Array<{ position: number; coverage: number }> | null;
  result?: unknown;
};

const THREAD_STORAGE_KEY = "dstoreqc.chatThreads.v1";
// Pre-thread profiles kept one flat transcript under this key; it is migrated once.
const LEGACY_CHAT_STORAGE_KEY = "dbgps.chatTranscript";
const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 320;
const MAX_CHAT_WIDTH = 760;
const FALLBACK_AGENT_LIMITS = { modelTurns: 5, toolCalls: 6, deadlineMs: 120000 };
// Full runs (with evidence payloads) live only in memory, keyed by snapshot id,
// for timeline evidence, JSON export, and follow-up evidence ids.
const MAX_RETAINED_RUNS = 16;

let threadStore: ThreadStore = { activeId: "", threads: [] };
let chatMode: ChatMode = "chat";
let agentStatus: AgentStatus | null = null;
let contextEnabled = true;
let pinnedContext: { label: string; data: unknown } | null = null;
let editingIndex: number | null = null;
let slashMatches: SlashCommand[] = [];
let slashIndex = 0;
const agentRuns = new Map<string, AgentRun>();
let activeChat: ActiveChat | null = null;
let chatStreamCounter = 0;
let chatRenderScheduled = false;
let runbarTimer: number | undefined;
let agentStatusTimer: number | undefined;
let unseenReplies = 0;

// Report-side streaming: mirrors the chat stream so "Interpret with AI" renders
// incrementally into the report's own narrative element. Stream ids share
// chatStreamCounter with chat replies, so an incoming chunk routes to exactly
// one of the two and a new chat never disturbs a running report stream.
type ActiveReportStream = {
  id: string;
  body: HTMLElement;
  text: string;
  stableEl: HTMLElement | null;
  liveEl: HTMLElement | null;
  stableLen: number;
  raf: boolean;
};
let activeReportStream: ActiveReportStream | null = null;

function scheduleReportStreamRender() {
  const stream = activeReportStream;
  if (!stream || stream.raf) return;
  stream.raf = true;
  requestAnimationFrame(() => {
    stream.raf = false;
    if (activeReportStream !== stream) return;
    if (!stream.stableEl || !stream.liveEl) {
      // First chunk: swap the placeholder for the stable/live containers.
      stream.body.textContent = "";
      stream.stableEl = document.createElement("div");
      stream.liveEl = document.createElement("div");
      stream.body.append(stream.stableEl, stream.liveEl);
    }
    const boundary = stableMarkdownBoundary(stream.text);
    if (boundary > stream.stableLen) {
      stream.stableEl.insertAdjacentHTML(
        "beforeend",
        renderMarkdownToHtml(stream.text.slice(stream.stableLen, boundary))
      );
      stream.stableLen = boundary;
    }
    stream.liveEl.innerHTML = renderMarkdownToHtml(stream.text.slice(stream.stableLen));
  });
}

// Assistant Markdown with pure-DNA code spans turned into "open in Interactive" links.
function renderAssistantMarkdown(text: string): string {
  return linkifyDnaCode(renderMarkdownToHtml(text), 8);
}

function agentLimits() {
  return agentStatus?.limits ?? FALLBACK_AGENT_LIMITS;
}

// ---- Threads ----------------------------------------------------------------
function activeThread(): ChatThread {
  let thread = threadStore.threads.find((item) => item.id === threadStore.activeId);
  if (!thread) {
    thread = createThread();
    threadStore.threads.unshift(thread);
    threadStore.activeId = thread.id;
  }
  return thread;
}

// The live transcript is always the active thread's own array, so pushes and
// splices on it are the thread's state with no copy to keep in sync.
let chatMessages: ChatMessage[] = [];

function persistThreads() {
  const threads = threadStore.threads.filter((thread) => thread.messages.length || thread.id === threadStore.activeId);
  // On a quota error keep halving the number of stored threads (most recent
  // first) rather than losing the whole history.
  for (let keep = threads.length; keep >= 1; keep = Math.floor(keep / 2)) {
    try {
      localStorage.setItem(THREAD_STORAGE_KEY, JSON.stringify({ activeId: threadStore.activeId, threads: threads.slice(0, keep) }));
      localStorage.removeItem(LEGACY_CHAT_STORAGE_KEY);
      return;
    } catch {
      /* quota exceeded or storage disabled: retry smaller, else stay in memory */
    }
  }
}

function touchThread() {
  const thread = activeThread();
  if (chatMessages.length > THREAD_LIMITS.messages) chatMessages.splice(0, chatMessages.length - THREAD_LIMITS.messages);
  thread.updatedAt = Date.now();
  if (!thread.title) thread.title = deriveThreadTitle(chatMessages);
  threadStore.threads.sort((a, b) => b.updatedAt - a.updatedAt);
  persistThreads();
  renderThreadHeader();
  if (!elements.threadsDrawer.hidden) renderThreadList();
}

function loadThreads() {
  const read = (key: string) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  threadStore = normalizeThreadStore(read(THREAD_STORAGE_KEY), read(LEGACY_CHAT_STORAGE_KEY));
  chatMessages = activeThread().messages;
  renderThread();
}

function switchThread(id: string) {
  if (activeChat || !threadStore.threads.some((thread) => thread.id === id)) return;
  threadStore.activeId = id;
  chatMessages = activeThread().messages;
  cancelEdit();
  persistThreads();
  renderThread();
  closeThreadsDrawer();
}

function newThread() {
  if (activeChat) return;
  cancelEdit();
  const current = activeThread();
  if (current.messages.length) {
    const thread = createThread();
    threadStore.threads.unshift(thread);
    threadStore.threads = threadStore.threads.slice(0, THREAD_LIMITS.threads);
    threadStore.activeId = thread.id;
    chatMessages = thread.messages;
    persistThreads();
    renderThread();
  }
  closeThreadsDrawer();
  openChatPanel();
  elements.chatInput.focus();
}

function deleteThread(id: string) {
  if (activeChat && activeChat.threadId === id) return;
  threadStore.threads = threadStore.threads.filter((thread) => thread.id !== id);
  if (threadStore.activeId === id) {
    const next = threadStore.threads[0] || createThread();
    if (!threadStore.threads.includes(next)) threadStore.threads.unshift(next);
    threadStore.activeId = next.id;
    chatMessages = next.messages;
    cancelEdit();
    renderThread();
  }
  persistThreads();
  renderThreadList();
}

function renderThreadHeader() {
  const thread = activeThread();
  elements.threadTitle.textContent = thread.title || "New conversation";
  elements.threadTitle.title = thread.title || "";
}

function renderThreadList() {
  const query = elements.threadSearchInput.value.trim().toLowerCase();
  const threads = threadStore.threads.filter((thread) => {
    if (!query) return true;
    return thread.title.toLowerCase().includes(query) || thread.messages.some((m) => m.content.toLowerCase().includes(query));
  });
  if (!threads.length) {
    elements.threadList.innerHTML = `<li class="thread-empty">${query ? "No matching conversations" : "No conversations yet"}</li>`;
    return;
  }
  elements.threadList.innerHTML = threads.map((thread) => {
    const active = thread.id === threadStore.activeId;
    const agentTurns = thread.messages.filter((m) => m.role === "assistant" && m.meta?.mode === "agent").length;
    return `<li class="thread-item${active ? " active" : ""}" role="option" aria-selected="${active}">
      <button type="button" class="thread-open" data-thread-open="${escapeHtml(thread.id)}" ${activeChat ? "disabled" : ""}>
        <strong>${escapeHtml(thread.title || "New conversation")}</strong>
        <span>${escapeHtml(relativeTime(thread.updatedAt))} · ${formatNumber(thread.messages.length)} messages${agentTurns ? ` · ${formatNumber(agentTurns)} agent` : ""}</span>
      </button>
      <button type="button" class="thread-delete" data-thread-delete="${escapeHtml(thread.id)}" title="Delete conversation" aria-label="Delete conversation" ${activeChat?.threadId === thread.id ? "disabled" : ""}>
        <i data-lucide="trash-2"></i>
      </button>
    </li>`;
  }).join("");
  renderIcons();
}

function openThreadsDrawer() {
  elements.threadsDrawer.hidden = false;
  elements.threadsButton.setAttribute("aria-expanded", "true");
  elements.threadSearchInput.value = "";
  renderThreadList();
  elements.threadSearchInput.focus();
}

function closeThreadsDrawer() {
  elements.threadsDrawer.hidden = true;
  elements.threadsButton.setAttribute("aria-expanded", "false");
}

// ---- Messages -----------------------------------------------------------------
function createMessageBubble(role: "user" | "assistant"): { bubble: HTMLElement; body: HTMLElement } {
  const bubble = document.createElement("div");
  bubble.className = `message ${role}`;
  const body = document.createElement("div");
  body.className = "message-body";
  bubble.appendChild(body);
  elements.chatMessages.appendChild(bubble);
  return { bubble, body };
}

function formatChatTime(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function messageActionButton(icon: string, label: string, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `message-action ${className}`.trim();
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<i data-lucide="${icon}"></i>`;
  return button;
}

function flashButton(button: HTMLButtonElement, label: string) {
  const previous = button.title;
  button.title = label;
  button.classList.add("flash");
  setTimeout(() => { button.title = previous; button.classList.remove("flash"); }, 1200);
}

// Footer row attached once a message is final: copy, edit/regenerate/retry,
// evidence export, and a quiet provenance line (time, model, stop reason).
function attachMessageActions(bubble: HTMLElement, message: ChatMessage, index: number | null) {
  bubble.querySelector(".message-actions")?.remove();
  if (!message.content.trim()) return;
  const row = document.createElement("div");
  row.className = "message-actions";

  const copy = messageActionButton("copy", "Copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      flashButton(copy, "Copied");
    } catch {
      flashButton(copy, "Copy failed");
    }
  });
  row.appendChild(copy);

  if (message.role === "user" && index != null) {
    const edit = messageActionButton("pencil", "Edit and resend", "action-edit");
    edit.addEventListener("click", () => beginEdit(index));
    row.appendChild(edit);
  }
  if (message.role === "assistant" && index != null && index === chatMessages.length - 1) {
    const regenerate = messageActionButton("rotate-ccw", "Regenerate", "action-regenerate");
    regenerate.addEventListener("click", () => { void regenerateLast(); });
    row.appendChild(regenerate);
  }
  if (message.role === "assistant" && index == null && message.meta?.error) {
    const retry = messageActionButton("rotate-ccw", "Retry", "action-regenerate");
    retry.addEventListener("click", () => { void regenerateLast(bubble); });
    row.appendChild(retry);
  }
  const run = message.meta?.snapshotId ? agentRuns.get(message.meta.snapshotId) : undefined;
  if (run) {
    const exportButton = messageActionButton("file-json", "Export evidence and tool-call record (JSON)");
    exportButton.addEventListener("click", async () => {
      try {
        await window.dstoreqc.saveFile({ defaultName: `DStoreQC-agent-${run.snapshot.id}.json`, content: JSON.stringify(run, null, 2) });
      } catch (error) {
        appendLog(`Evidence export failed: ${errMessage(error)}`);
      }
    });
    row.appendChild(exportButton);
  }

  const meta = document.createElement("span");
  meta.className = "message-meta";
  const parts: string[] = [];
  if (message.ts != null && Number.isFinite(message.ts)) parts.push(formatChatTime(message.ts));
  if (message.role === "assistant" && message.meta?.model) parts.push(message.meta.model);
  meta.textContent = parts.join(" · ");
  if (message.role === "assistant" && message.meta?.stopReason && message.meta.stopReason !== "completed") {
    const badge = document.createElement("span");
    badge.className = `stop-badge ${message.meta.stopReason}`;
    badge.textContent = message.meta.stopReason.replaceAll("_", " ");
    meta.appendChild(badge);
  }
  row.appendChild(meta);
  bubble.appendChild(row);
  renderIcons();
}

function renderMessage(message: ChatMessage, index: number): HTMLElement {
  const { bubble, body } = createMessageBubble(message.role);
  if (message.meta?.mode === "agent") bubble.classList.add("agent");
  if (message.meta?.error) bubble.classList.add("error");
  if (message.role === "user") {
    body.textContent = message.content;
    const tags: string[] = [];
    if (message.meta?.command) tags.push(`<span class="message-tag command">/${escapeHtml(message.meta.command)}</span>`);
    if (message.meta?.mode === "agent") tags.push('<span class="message-tag agent"><i data-lucide="bot"></i>Agent</span>');
    if (message.meta?.contextLabel) tags.push(`<span class="message-tag context"><i data-lucide="paperclip"></i>${escapeHtml(message.meta.contextLabel)}</span>`);
    if (tags.length) bubble.insertAdjacentHTML("afterbegin", `<div class="message-tags">${tags.join("")}</div>`);
  } else {
    const run = message.meta?.snapshotId ? agentRuns.get(message.meta.snapshotId) : undefined;
    if (run) renderTimeline(bubble, timelineFromTrace(run.trace), { running: false, stopReason: run.stopReason, snapshotId: run.snapshot.id });
    else if (message.meta?.mode === "agent") {
      renderTimeline(bubble, timelineFromCompact(message.meta.trace || []), { running: false, stopReason: message.meta.stopReason, snapshotId: message.meta.snapshotId, restored: true });
    }
    body.innerHTML = renderAssistantMarkdown(message.content);
  }
  attachMessageActions(bubble, message, index);
  return bubble;
}

function renderThread() {
  elements.chatMessages.innerHTML = "";
  if (!chatMessages.length) renderChatWelcome();
  else chatMessages.forEach((message, index) => renderMessage(message, index));
  renderThreadHeader();
  renderSuggestions();
  renderIcons();
  scrollChatToBottom();
}

function scrollChatToBottom() {
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// Only auto-scroll while streaming when the user is already reading the newest
// content; otherwise leave their scroll position so they can read back without
// being yanked to the bottom on every token.
function isChatPinnedToBottom(threshold = 56): boolean {
  const el = elements.chatMessages;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

// Offset in `text` up to which every Markdown block is complete: the position
// just after the last blank line that is not inside a fenced code block. Content
// before it will not change as more tokens arrive, so it can be rendered once and
// cached instead of re-parsed every frame.
function stableMarkdownBoundary(text: string): number {
  const lines = text.split("\n");
  let inFence = false;
  let offset = 0;
  let boundary = 0;
  // The last element of `lines` is the still-growing line; never treat it as stable.
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (/^```/.test(line.trimStart())) inFence = !inFence;
    offset += line.length + 1; // include the trailing "\n"
    if (!inFence && line.trim() === "") boundary = offset;
  }
  return boundary;
}

// ---- Welcome and suggestions ---------------------------------------------------
function currentSuggestions(limit: number) {
  return agentSuggestions((pinnedContext ?? buildChatContext())?.label ?? null, agentStatus, limit);
}

function suggestionButton(suggestion: Suggestion, className: string) {
  const agent = suggestion.mode === "agent";
  return `<button type="button" class="${className}" data-suggest-prompt="${escapeHtml(suggestion.prompt)}" data-suggest-mode="${suggestion.mode || ""}" title="${escapeHtml(suggestion.prompt)}">` +
    `${agent ? '<i data-lucide="bot"></i>' : '<i data-lucide="message-square"></i>'}<span>${escapeHtml(suggestion.label)}</span></button>`;
}

function renderChatWelcome() {
  elements.chatMessages.querySelector(".chat-welcome")?.remove();
  if (chatMessages.length > 0) return;
  const welcome = document.createElement("div");
  welcome.className = "chat-welcome";
  welcome.innerHTML = `
    <div class="welcome-mark"><i data-lucide="sparkles"></i></div>
    <h3>What should we look at?</h3>
    <p><strong>Chat</strong> explains the result you attach. <strong>Agent</strong> can also read the loaded index and Batch QC cache — read-only, bounded, and every step is shown.</p>
    <div class="welcome-grid">${currentSuggestions(4).map((s) => suggestionButton(s, "welcome-card")).join("")}</div>
    <p class="welcome-tip"><kbd>/</kbd> commands · <kbd>⌘K</kbd> focus · <kbd>⌘J</kbd> hide panel</p>`;
  elements.chatMessages.appendChild(welcome);
  renderIcons();
}

function renderSuggestions() {
  const show = !activeChat && chatMessages.length > 0 && editingIndex == null;
  elements.chatSuggestions.hidden = !show;
  if (!show) return;
  elements.chatSuggestions.innerHTML = currentSuggestions(3).map((s) => suggestionButton(s, "suggestion-chip")).join("");
  renderIcons();
}

// ---- Mode, readiness, and capabilities -----------------------------------------
function setChatMode(mode: ChatMode) {
  chatMode = mode;
  appSettings.agentTools = mode === "agent";
  saveSettings();
  elements.chatPanel.dataset.mode = mode;
  document.querySelectorAll<HTMLButtonElement>("[data-chat-mode]").forEach((button) => {
    const active = button.dataset.chatMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  elements.chatInput.placeholder = mode === "agent"
    ? "Ask the agent — it can read the loaded index and Batch QC cache"
    : "Ask about your analysis, or type / for commands";
}

function renderReadiness() {
  const status = agentStatus;
  let level: "off" | "ready" | "partial" = "off";
  let text = "No index loaded";
  if (status?.datasetVersion) {
    level = status.batch ? "ready" : "partial";
    text = `${status.indexScope === "reference" ? "Ref · " : ""}k=${status.k}`;
    if (status.batch) text += ` · ${formatNumber(status.batch.total)} strands`;
  }
  elements.agentReadinessDot.className = `readiness-dot ${level}`;
  elements.agentReadinessText.textContent = text;
  elements.capabilitiesButton.title = status?.datasetVersion
    ? `${status.indexScope === "reference" ? "Reference-scoped" : "Read"} index loaded (k=${status.k})${status.batch ? `, Batch QC cached (${formatNumber(status.batch.total)} strands)` : ", no Batch QC cache"}. Click for agent tools.`
    : "No read index loaded. Click for agent tools.";
  const limits = agentLimits();
  elements.agentLimitsText.textContent = `≤ ${limits.toolCalls} tool calls · ≤ ${limits.modelTurns} model turns · ${Math.round(limits.deadlineMs / 1000)} s`;
  const tools = status?.tools ?? Object.keys(TOOL_LABELS).map((name) => ({ name, available: false, reason: "Agent status unavailable." }));
  elements.agentToolList.innerHTML = tools.map((tool) => {
    const label = TOOL_LABELS[tool.name] || { title: tool.name, icon: "wrench", blurb: "" };
    return `<li class="agent-tool ${tool.available ? "available" : "unavailable"}">
      <i data-lucide="${label.icon}"></i>
      <div><strong>${escapeHtml(label.title)}</strong><span>${escapeHtml(tool.available ? label.blurb : tool.reason || "Unavailable")}</span></div>
      <span class="tool-state">${tool.available ? "Ready" : "Waiting"}</span>
    </li>`;
  }).join("");
  renderIcons();
}

function refreshAgentStatus() {
  if (agentStatusTimer) window.clearTimeout(agentStatusTimer);
  agentStatusTimer = window.setTimeout(async () => {
    try {
      agentStatus = await window.dstoreqc.getAgentStatus();
    } catch {
      agentStatus = null;
    }
    renderReadiness();
    renderSuggestions();
    if (!chatMessages.length && !activeChat) renderChatWelcome();
  }, 120);
}

function toggleCapabilities(force?: boolean) {
  const open = force ?? elements.agentCapabilities.hidden;
  elements.agentCapabilities.hidden = !open;
  elements.capabilitiesButton.setAttribute("aria-expanded", String(open));
}

// ---- Context tray ---------------------------------------------------------------
function currentChatContext(): { label: string; data: unknown } | null {
  if (!contextEnabled) return null;
  return pinnedContext ?? buildChatContext();
}

function updateChatContextChip() {
  const shown = pinnedContext ?? buildChatContext();
  const has = Boolean(shown);
  elements.chatContextChip.hidden = !has;
  elements.contextPinButton.hidden = !has;
  elements.contextPreviewButton.hidden = !has;
  elements.chatContextEmpty.hidden = has;
  if (shown) {
    const size = contextPayloadSize(shown.data);
    elements.chatContextLabel.textContent = `${shown.label}${size ? ` · ${size}` : ""}`;
    elements.chatContextChip.classList.toggle("off", !contextEnabled);
    elements.chatContextChip.classList.toggle("pinned", Boolean(pinnedContext));
    elements.chatContextChip.title = contextEnabled
      ? `${pinnedContext ? "Pinned" : "Follows the active view"} — attached to the next message. Click to detach.`
      : "Detached — click to attach to the next message.";
    elements.contextPinButton.setAttribute("aria-pressed", String(Boolean(pinnedContext)));
    elements.contextPinButton.classList.toggle("active", Boolean(pinnedContext));
    elements.contextPinButton.title = pinnedContext ? "Unpin: follow the active view again" : "Pin this context across views";
  }
  refreshAgentStatus();
}

function togglePinnedContext() {
  pinnedContext = pinnedContext ? null : buildChatContext();
  updateChatContextChip();
}

function openContextDialog() {
  const shown = pinnedContext ?? buildChatContext();
  if (!shown) return;
  let json = "";
  try {
    json = JSON.stringify(shown.data, null, 2) ?? "";
  } catch {
    json = "(context is not serializable)";
  }
  elements.contextDialogTitle.textContent = shown.label;
  elements.contextDialogMeta.textContent = `${contextPayloadSize(shown.data) || "size unknown"} · ${pinnedContext ? "pinned" : "follows the active view"} · ${contextEnabled ? "attached" : "detached"}`;
  elements.contextDialogBody.textContent = json;
  elements.contextDialog.hidden = false;
  elements.closeContextDialogButton.focus();
}

function closeContextDialog() {
  elements.contextDialog.hidden = true;
}

// ---- Evidence timeline ----------------------------------------------------------
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function timelineFromTrace(trace: AgentToolTrace[]): TimelineItem[] {
  return trace.map((item) => {
    const start = Date.parse(item.startedAt);
    const end = item.finishedAt ? Date.parse(item.finishedAt) : NaN;
    return {
      callId: item.callId,
      name: item.name,
      arguments: item.arguments,
      status: item.status,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined,
      facts: item.status === "running" ? [] : toolResultFacts(item.name, item.result),
      targets: toolTargets(item),
      series: profileSeries(item.result),
      result: item.result
    };
  });
}

function timelineFromCompact(trace: CompactTrace[]): TimelineItem[] {
  return trace.map((item) => ({ ...item, facts: item.facts || [], targets: toolTargets(item), series: null }));
}

function sparklineSvg(series: Array<{ position: number; coverage: number }>) {
  const max = Math.max(1, ...series.map((point) => point.coverage));
  const width = series.length * 4;
  const bars = series.map((point, i) => {
    const h = point.coverage === 0 ? 3 : Math.max(2, (point.coverage / max) * 26);
    return `<rect class="${point.coverage === 0 ? "zero" : ""}" x="${i * 4}" y="${28 - h}" width="3" height="${h}"><title>window ${point.position}: ${point.coverage}</title></rect>`;
  }).join("");
  return `<svg class="step-sparkline" viewBox="0 0 ${width} 28" preserveAspectRatio="none" role="img" aria-label="Coverage of windows ${series[0].position}–${series[series.length - 1].position}">${bars}</svg>`;
}

function stepIcon(item: TimelineItem) {
  if (item.status === "running") return '<span class="trace-spinner" role="status" aria-label="running"></span>';
  return `<i data-lucide="${item.status === "ok" ? (TOOL_LABELS[item.name]?.icon || "check") : "circle-alert"}"></i>`;
}

function targetButton(target: ToolTarget) {
  if (target.kind === "batch-record") {
    const known = batchRows.some((row) => row.index === target.index);
    return `<button type="button" class="step-link" data-open-record="${target.index}" ${known ? "" : 'title="Not in the current Batch QC table"'}><i data-lucide="table-2"></i>Row #${target.index + 1}</button>`;
  }
  return `<button type="button" class="step-link" data-open-kmer="${target.kmer}"><i data-lucide="external-link"></i>Open in Interactive</button>`;
}

function renderTimeline(bubble: HTMLElement, items: TimelineItem[], state: { running: boolean; stopReason?: string; snapshotId?: string; restored?: boolean }) {
  let container = bubble.querySelector<HTMLElement>(".agent-steps");
  if (!container) {
    container = document.createElement("div");
    container.className = "agent-steps";
    bubble.insertBefore(container, bubble.querySelector(".message-body"));
  }
  // Open while working; afterwards collapse unless the user chose otherwise.
  const open = state.running || (container.dataset.userToggled === "true" ? container.dataset.open === "true" : false);
  const evidenceOpen = new Set(Array.from(container.querySelectorAll<HTMLElement>(".step-evidence:not([hidden])")).map((el) => el.dataset.callId));
  container.dataset.open = String(open);
  container.classList.toggle("running", state.running);

  let total = 0;
  for (const item of items) total += item.durationMs || 0;
  const tools = `${items.length} tool call${items.length === 1 ? "" : "s"}`;
  const summary = state.running
    ? `Working · ${tools}`
    : items.length ? `${tools}${total ? ` · ${formatDurationMs(total)}` : ""}` : "Answered without tools";
  const stop = !state.running && state.stopReason && state.stopReason !== "completed"
    ? `<span class="stop-badge ${escapeHtml(state.stopReason)}">${escapeHtml(state.stopReason.replaceAll("_", " "))}</span>` : "";
  const snapshot = state.snapshotId ? `<span class="steps-snapshot" title="Evidence snapshot ${escapeHtml(state.snapshotId)}">${escapeHtml(state.snapshotId.slice(0, 8))}</span>` : "";

  const list = items.map((item, i) => {
    const call = describeToolCall(item.name, item.arguments);
    const evidence = item.result !== undefined
      ? `<button type="button" class="step-link subtle" data-step-evidence="${escapeHtml(item.callId)}"><i data-lucide="braces"></i>Evidence</button>` : "";
    const actions = item.targets.map(targetButton).join("") + evidence;
    return `<li class="step ${item.status}">
      <span class="step-index" aria-hidden="true">${i + 1}</span>
      <div class="step-main">
        <div class="step-head">${stepIcon(item)}<strong>${escapeHtml(call.title)}</strong>${item.durationMs != null ? `<span class="step-dur">${escapeHtml(formatDurationMs(item.durationMs))}</span>` : ""}</div>
        <div class="step-detail">${escapeHtml(call.detail)}</div>
        ${item.facts.length ? `<div class="step-facts">${item.facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}</div>` : ""}
        ${item.series ? sparklineSvg(item.series) : ""}
        ${actions ? `<div class="step-actions">${actions}</div>` : ""}
        ${item.result !== undefined ? `<pre class="step-evidence" data-call-id="${escapeHtml(item.callId)}" ${evidenceOpen.has(item.callId) ? "" : "hidden"}>${escapeHtml(JSON.stringify(item.result, null, 2))}</pre>` : ""}
      </div>
    </li>`;
  }).join("");

  container.innerHTML = `<button type="button" class="steps-summary" aria-expanded="${open}">
      <i data-lucide="${state.running ? "loader-circle" : "list-checks"}" class="${state.running ? "spin" : ""}"></i>
      <span>${escapeHtml(summary)}</span>${stop}${snapshot}
      <i data-lucide="chevron-down" class="steps-chevron"></i>
    </button>
    ${items.length ? `<ol class="steps-list"${open ? "" : " hidden"}>${list}</ol>` : ""}
    ${state.restored && items.length ? `<p class="steps-note"${open ? "" : " hidden"}>Evidence payloads are kept only for this session; the step summary was saved with the conversation.</p>` : ""}`;
  renderIcons();
}

function toggleTimeline(container: HTMLElement) {
  const open = container.dataset.open !== "true";
  container.dataset.open = String(open);
  container.dataset.userToggled = "true";
  container.querySelector(".steps-summary")?.setAttribute("aria-expanded", String(open));
  container.querySelectorAll<HTMLElement>(".steps-list, .steps-note").forEach((el) => { el.hidden = !open; });
}

// ---- Jumps from the conversation into the workbench ------------------------------
function openInInteractive(dna: string) {
  setView("interactive");
  const k = Number(elements.kInput.value) || 31;
  queryMode = dna.length > k ? "sequence" : "kmer";
  updateQueryModeControls();
  elements.queryInput.value = dna;
  if (analyzerReady) void runQuery();
  else {
    elements.queryInput.focus();
    appendLog("Start the kernel to run this query.");
  }
}

function openBatchRecord(index: number) {
  setView("batch");
  const position = batchRows.findIndex((row) => row.index === index);
  if (position < 0) {
    appendLog(`Batch record ${index} (row #${index + 1}) is not in the current Batch QC table.`);
    return;
  }
  batchPage = Math.floor(position / BATCH_PAGE_SIZE);
  batchHighlightIndex = index;
  void showBatchDetail(index);
}

// ---- Run status bar -----------------------------------------------------------------
function updateRunbar() {
  const chat = activeChat;
  if (!chat) return;
  const elapsed = Date.now() - chat.startedAt;
  const seconds = `${Math.floor(elapsed / 1000)}s`;
  if (chat.mode === "agent") {
    const limits = agentLimits();
    const running = chat.trace.find((item) => item.status === "running");
    const text = running
      ? `${describeToolCall(running.name, running.arguments).title}…`
      : chat.progress ? (chat.progress.finalTurn ? "Writing the answer…" : chat.trace.length ? "Reading the evidence…" : "Planning…") : "Opening an evidence snapshot…";
    elements.agentRunbarText.textContent = text;
    elements.agentRunbarMeta.textContent = `turn ${chat.progress?.modelTurns ?? 0}/${limits.modelTurns} · tools ${chat.trace.length}/${limits.toolCalls} · ${seconds}`;
    elements.agentRunbar.classList.remove("indeterminate");
    elements.agentRunbarProgress.style.width = `${Math.min(100, (elapsed / limits.deadlineMs) * 100)}%`;
  } else {
    const words = chat.text.trim() ? chat.text.trim().split(/\s+/).length : 0;
    elements.agentRunbarText.textContent = words ? "Writing…" : `Waiting for ${chat.model}…`;
    elements.agentRunbarMeta.textContent = `${words ? `${formatNumber(words)} words · ` : ""}${seconds}`;
    elements.agentRunbar.classList.add("indeterminate");
    elements.agentRunbarProgress.style.width = "";
  }
}

function startRunbar() {
  elements.agentRunbar.hidden = false;
  updateRunbar();
  if (runbarTimer) window.clearInterval(runbarTimer);
  runbarTimer = window.setInterval(updateRunbar, 250);
}

function stopRunbar() {
  if (runbarTimer) window.clearInterval(runbarTimer);
  runbarTimer = undefined;
  elements.agentRunbar.hidden = true;
}

// ---- Send / stream / finalize ---------------------------------------------------------
function setChatBusy(busy: boolean) {
  elements.sendChatButton.hidden = busy;
  elements.stopChatButton.hidden = !busy;
  // Fold the Stop button's disabled state into the busy machine so a prior
  // cancel can never leave it stuck disabled at the start of the next stream.
  if (busy) elements.stopChatButton.disabled = false;
  elements.newThreadButton.disabled = busy;
  document.querySelectorAll<HTMLButtonElement>("[data-chat-mode]").forEach((button) => { button.disabled = busy; });
  // Provider must not change mid-stream: swap the quick switcher for the pill.
  elements.chatProviderSwitch.hidden = busy;
  elements.aiProvider.hidden = !busy;
  elements.chatPanel.classList.toggle("busy", busy);
  elements.chatRail.classList.toggle("busy", busy);
  if (!elements.threadsDrawer.hidden) renderThreadList();
  renderSuggestions();
}

function scheduleAssistantRender() {
  if (chatRenderScheduled) return;
  chatRenderScheduled = true;
  requestAnimationFrame(() => {
    chatRenderScheduled = false;
    if (!activeChat) return;
    const pinned = isChatPinnedToBottom();
    if (!activeChat.stableEl || !activeChat.liveEl) {
      // First token: swap the typing indicator for the stable/live containers.
      activeChat.body.textContent = "";
      activeChat.stableEl = document.createElement("div");
      activeChat.liveEl = document.createElement("div");
      activeChat.body.append(activeChat.stableEl, activeChat.liveEl);
    }
    const boundary = stableMarkdownBoundary(activeChat.text);
    if (boundary > activeChat.stableLen) {
      // Append only the newly-completed blocks; existing stable DOM is untouched.
      activeChat.stableEl.insertAdjacentHTML(
        "beforeend",
        renderAssistantMarkdown(activeChat.text.slice(activeChat.stableLen, boundary))
      );
      activeChat.stableLen = boundary;
    }
    activeChat.liveEl.innerHTML = renderAssistantMarkdown(activeChat.text.slice(activeChat.stableLen));
    if (pinned) scrollChatToBottom();
  });
}

// `persistContent` lets the bubble show something the transcript does not keep —
// used on the error path so the user sees "partial + ⚠️ error" while the upstream
// history records only the text the model actually produced.
function finalizeAssistant(content: string, opts: { persist: boolean; error?: boolean; persistContent?: string; meta?: ChatMessageMeta }) {
  const chat = activeChat;
  if (!chat) return;
  const pinned = isChatPinnedToBottom();
  chat.bubble.classList.remove("streaming");
  if (opts.error) chat.bubble.classList.add("error");
  // Collapse the incremental stable/live containers into one authoritative render.
  chat.body.innerHTML = renderAssistantMarkdown(content);
  const ts = Date.now();
  const persisted = opts.persistContent ?? content;
  const meta: ChatMessageMeta = { ...(opts.meta || { mode: chat.mode, model: chat.model }), ...(opts.error ? { error: true } : {}) };
  let index: number | null = null;
  // A reply that lands after the user switched threads still belongs to the
  // thread that asked; it is saved there even though it is not on screen.
  const thread = threadStore.threads.find((item) => item.id === chat.threadId);
  if (opts.persist && persisted.trim() && thread) {
    thread.messages.push({ role: "assistant", content: persisted, ts, meta: { ...meta, error: undefined } });
    if (thread.messages === chatMessages) index = chatMessages.length - 1;
  }
  attachMessageActions(chat.bubble, { role: "assistant", content, ts, meta }, index);
  activeChat = null;
  stopRunbar();
  setChatBusy(false);
  touchThread();
  if (elements.layout.classList.contains("chat-collapsed")) {
    unseenReplies++;
    elements.chatRailBadge.textContent = String(unseenReplies);
    elements.chatRailBadge.hidden = false;
  }
  refreshAgentStatus();
  if (pinned) scrollChatToBottom();
}

function apiKeyMissingNotice(settings: AiSettings, mode: ChatMode) {
  const { bubble, body } = createMessageBubble("assistant");
  bubble.classList.add("error");
  const text = `**${PROVIDER_BY_ID[settings.provider].label}** needs an API key. Add one in **Settings → Providers**, or switch to a local endpoint.`;
  body.innerHTML = renderMarkdownToHtml(text);
  attachMessageActions(bubble, { role: "assistant", content: text, meta: { mode, error: true } }, null);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "inline-action";
  open.innerHTML = '<i data-lucide="settings"></i><span>Open provider settings</span>';
  open.addEventListener("click", () => openSettings("providers"));
  bubble.insertBefore(open, bubble.querySelector(".message-actions"));
  renderIcons();
  scrollChatToBottom();
}

// Snapshot ids of this thread's agent answers still retained in memory, so a
// follow-up can cite earlier evidence (main keeps the matching runs per window).
function threadSnapshotIds() {
  return chatMessages
    .map((message) => message.meta?.snapshotId)
    .filter((id): id is string => Boolean(id && agentRuns.has(id)))
    .slice(-8);
}

async function sendMessage(content: string, mode: ChatMode, command?: string) {
  if (activeChat || !content.trim()) return;
  closeSlashMenu();
  elements.chatMessages.querySelector(".chat-welcome")?.remove();
  // Only the newest reply can be regenerated.
  elements.chatMessages.querySelectorAll(".action-regenerate").forEach((button) => button.remove());

  const settings = currentAiSettings();
  const context = currentChatContext();
  const userMessage: ChatMessage = {
    role: "user", content, ts: Date.now(),
    meta: { mode, contextLabel: context?.label, command }
  };
  chatMessages.push(userMessage);
  renderMessage(userMessage, chatMessages.length - 1);
  touchThread();
  scrollChatToBottom();

  if (PROVIDER_BY_ID[settings.provider]?.apiKeyRequired && !settings.apiKey) {
    apiKeyMissingNotice(settings, mode);
    return;
  }

  const id = `chat-${++chatStreamCounter}-${Date.now()}`;
  const { bubble, body } = createMessageBubble("assistant");
  bubble.classList.add("streaming");
  if (mode === "agent") bubble.classList.add("agent");
  body.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  activeChat = {
    id, threadId: activeThread().id, mode, model: settings.model, bubble, body, text: "",
    stableEl: null, liveEl: null, stableLen: 0, trace: [], progress: null, startedAt: Date.now()
  };
  if (mode === "agent") renderTimeline(bubble, [], { running: true });
  setChatBusy(true);
  startRunbar();
  scrollChatToBottom();

  try {
    const result = await window.dstoreqc.aiChat({
      id,
      messages: chatMessages.map((message) => ({ role: message.role, content: message.content })),
      context: context?.data ?? null,
      contextLabel: context?.label,
      settings,
      mode: mode === "agent" ? "read-only" : "chat",
      evidenceSnapshotIds: threadSnapshotIds()
    });
    elements.aiProvider.textContent = PROVIDER_BY_ID[result.provider as ProviderId]?.label || result.provider;
    elements.aiProvider.title = result.model;
    const base: ChatMessageMeta = { mode, provider: result.provider, model: result.model };
    if (result.agent) {
      const run = result.agent;
      agentRuns.set(run.snapshot.id, run);
      while (agentRuns.size > MAX_RETAINED_RUNS) agentRuns.delete(agentRuns.keys().next().value as string);
      renderTimeline(bubble, timelineFromTrace(run.trace), { running: false, stopReason: run.stopReason, snapshotId: run.snapshot.id });
      finalizeAssistant(result.content, {
        persist: run.stopReason === "completed",
        error: run.stopReason === "error",
        meta: { ...base, stopReason: run.stopReason, snapshotId: run.snapshot.id, trace: compactTrace(run.trace) }
      });
    } else if (result.canceled) {
      const partial = activeChat?.text ?? "";
      finalizeAssistant(partial || "_(stopped)_", { persist: Boolean(partial.trim()), meta: { ...base, stopReason: "canceled" } });
    } else {
      finalizeAssistant(result.content, { persist: true, meta: base });
    }
  } catch (error) {
    // Keep whatever partial answer already streamed in (like the cancel path)
    // and append the error, instead of wiping the bubble to a bare error line.
    // Read the partial before finalizeAssistant clears activeChat.
    const partial = activeChat?.text ?? "";
    const notice = `⚠️ ${errMessage(error)}`;
    const hasPartial = Boolean(partial.trim());
    if (activeChat?.mode === "agent") renderTimeline(bubble, timelineFromTrace(activeChat.trace), { running: false, stopReason: "error" });
    // Keep the partial answer in the transcript (without the error notice) so a
    // follow-up question does not silently lose the turn the model half-answered.
    finalizeAssistant(hasPartial ? `${partial}\n\n${notice}` : notice, {
      persist: hasPartial,
      error: true,
      persistContent: partial,
      meta: { mode, model: settings.model, stopReason: "error" }
    });
  }
}

async function sendChat() {
  if (activeChat) return;
  const raw = elements.chatInput.value.trim();
  if (!raw) return;
  let content = raw;
  let mode = chatMode;
  let command: string | undefined;
  const parsed = parseSlashCommand(raw);
  if (parsed) {
    if (parsed.command.action) {
      clearComposer();
      runSlashAction(parsed.command.action);
      return;
    }
    content = parsed.prompt;
    mode = parsed.command.mode ?? chatMode;
    command = parsed.command.name;
  }
  if (editingIndex != null) {
    chatMessages.splice(editingIndex);
    cancelEdit();
    renderThread();
  }
  clearComposer();
  await sendMessage(content, mode, command);
}

// Re-ask the most recent question: the last exchange is dropped from both the
// transcript and the DOM so the retry is a clean second attempt rather than a
// follow-up that references an answer the user rejected.
async function regenerateLast(errorBubble?: HTMLElement) {
  if (activeChat) return;
  let index = -1;
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i].role === "user") { index = i; break; }
  }
  if (index < 0) return;
  const question = chatMessages[index];
  chatMessages.splice(index);
  errorBubble?.remove();
  touchThread();
  renderThread();
  await sendMessage(question.content, question.meta?.mode ?? chatMode, question.meta?.command);
}

function beginEdit(index: number) {
  if (activeChat || chatMessages[index]?.role !== "user") return;
  editingIndex = index;
  elements.chatInput.value = chatMessages[index].content;
  elements.editBanner.hidden = false;
  elements.chatMessages.querySelectorAll<HTMLElement>(".message").forEach((el, i) => el.classList.toggle("superseded", i >= index));
  renderSuggestions();
  autoGrowChatInput();
  elements.chatInput.focus();
}

function cancelEdit() {
  if (editingIndex == null) return;
  editingIndex = null;
  elements.editBanner.hidden = true;
  elements.chatMessages.querySelectorAll(".message.superseded").forEach((el) => el.classList.remove("superseded"));
  renderSuggestions();
}

function clearComposer() {
  elements.chatInput.value = "";
  closeSlashMenu();
  autoGrowChatInput();
}

async function stopChat() {
  if (!activeChat) return;
  elements.stopChatButton.disabled = true;
  try {
    await window.dstoreqc.cancelAiChat(activeChat.id);
  } catch {
    /* the in-flight request will settle on its own */
  } finally {
    elements.stopChatButton.disabled = false;
  }
}

// ---- Slash commands -------------------------------------------------------------
function runSlashAction(action: SlashAction) {
  if (action === "new") newThread();
  else if (action === "export") void exportChat();
  else if (action === "mode-agent") setChatMode("agent");
  else if (action === "mode-chat") setChatMode("chat");
}

function renderSlashMenu() {
  elements.slashMenu.innerHTML = slashMatches.map((command, i) =>
    `<div class="slash-item${i === slashIndex ? " active" : ""}" role="option" aria-selected="${i === slashIndex}" data-slash-index="${i}">` +
    `<span class="slash-name">/${escapeHtml(command.name)}</span>` +
    `<span class="slash-desc">${escapeHtml(command.description)}</span>` +
    `${command.mode === "agent" ? '<span class="slash-tag">Agent</span>' : command.action ? '<span class="slash-tag muted">Action</span>' : ""}</div>`
  ).join("");
  elements.slashMenu.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
}

function updateSlashMenu() {
  slashMatches = activeChat ? [] : matchSlashCommands(elements.chatInput.value);
  if (!slashMatches.length) {
    closeSlashMenu();
    return;
  }
  slashIndex = Math.min(slashIndex, slashMatches.length - 1);
  elements.slashMenu.hidden = false;
  renderSlashMenu();
}

function closeSlashMenu() {
  slashMatches = [];
  slashIndex = 0;
  elements.slashMenu.hidden = true;
}

function pickSlash(index: number, sendNow: boolean) {
  const command = slashMatches[index];
  if (!command) return;
  if (command.action || sendNow) {
    elements.chatInput.value = `/${command.name}`;
    void sendChat();
    return;
  }
  elements.chatInput.value = `/${command.name} `;
  closeSlashMenu();
  elements.chatInput.focus();
}

// ---- Panel layout -------------------------------------------------------------------
function applyPanelLayout() {
  elements.layout.style.setProperty("--chat-width", `${appSettings.chatWidth}px`);
  elements.layout.classList.toggle("chat-collapsed", appSettings.chatCollapsed);
  elements.layout.classList.toggle("chat-expanded", appSettings.chatExpanded && !appSettings.chatCollapsed);
  elements.chatRail.hidden = !appSettings.chatCollapsed;
  elements.expandChatButton.setAttribute("aria-pressed", String(appSettings.chatExpanded));
  elements.expandChatButton.title = appSettings.chatExpanded ? "Restore panel width" : "Widen panel";
  elements.expandChatButton.innerHTML = `<i data-lucide="${appSettings.chatExpanded ? "minimize-2" : "maximize-2"}"></i>`;
  if (!appSettings.chatCollapsed) {
    unseenReplies = 0;
    elements.chatRailBadge.hidden = true;
  }
  renderIcons();
}

function setPanelState(patch: Partial<Pick<AppSettings, "chatCollapsed" | "chatExpanded" | "chatWidth">>) {
  Object.assign(appSettings, patch);
  saveSettings();
  applyPanelLayout();
}

function openChatPanel() {
  if (appSettings.chatCollapsed) setPanelState({ chatCollapsed: false });
}

function clampChatWidth(width: number) {
  const layoutWidth = elements.layout.clientWidth || window.innerWidth;
  return Math.round(Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, Math.min(width, layoutWidth - 560))));
}

function startChatResize(event: PointerEvent) {
  if (appSettings.chatCollapsed) return;
  event.preventDefault();
  const resizer = elements.chatResizer;
  resizer.setPointerCapture(event.pointerId);
  elements.layout.classList.add("resizing");
  if (appSettings.chatExpanded) {
    appSettings.chatExpanded = false;
    applyPanelLayout();
  }
  const right = elements.chatPanel.getBoundingClientRect().right;
  const move = (e: PointerEvent) => {
    appSettings.chatWidth = clampChatWidth(right - e.clientX);
    elements.layout.style.setProperty("--chat-width", `${appSettings.chatWidth}px`);
  };
  const end = () => {
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", end);
    resizer.removeEventListener("pointercancel", end);
    elements.layout.classList.remove("resizing");
    saveSettings();
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", end);
  resizer.addEventListener("pointercancel", end);
}

// ---- Export -------------------------------------------------------------------------
function chatTranscriptMarkdown(): string {
  const thread = activeThread();
  const lines = [`# ${thread.title || "DStoreQC conversation"}`, "", `_Exported ${new Date().toLocaleString()} from DStoreQC_`, ""];
  for (const message of chatMessages) {
    if (message.role === "user") {
      const tags = [message.meta?.command ? `/${message.meta.command}` : "", message.meta?.mode === "agent" ? "agent" : "", message.meta?.contextLabel ? `context: ${message.meta.contextLabel}` : ""].filter(Boolean);
      lines.push(`## Question${tags.length ? ` (${tags.join(", ")})` : ""}`, "", message.content, "");
      continue;
    }
    const header = [message.meta?.mode === "agent" ? "Agent" : "Assistant", message.meta?.model].filter(Boolean).join(" · ");
    lines.push(`## ${header}`, "");
    const trace = message.meta?.trace;
    if (trace?.length) {
      lines.push(`Evidence steps (snapshot \`${message.meta?.snapshotId || "n/a"}\`):`, "");
      trace.forEach((item, i) => {
        const call = describeToolCall(item.name, item.arguments);
        lines.push(`${i + 1}. **${call.title}** — ${call.detail}${item.status === "error" ? " (failed)" : ""}${item.facts?.length ? `: ${item.facts.join("; ")}` : ""}`);
      });
      lines.push("");
    }
    lines.push(message.content, "");
  }
  return lines.join("\n");
}

async function exportChat() {
  if (!chatMessages.length) {
    appendLog("Nothing to export — the conversation is empty.");
    return;
  }
  try {
    await window.dstoreqc.saveFile({
      defaultName: `dstoreqc-conversation-${new Date().toISOString().slice(0, 10)}.md`,
      content: chatTranscriptMarkdown()
    });
  } catch (error) {
    appendLog(`Conversation export failed: ${errMessage(error)}`);
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
elements.selectBloomReferenceButton.addEventListener("click", selectBloomReference);
elements.bloomInput.addEventListener("change", () => {
  updateBloomControls();
  updateQueryModeControls();
});
elements.addFilesButton.addEventListener("click", addSequencingFiles);
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

  const seriesButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sequence-series]");
  const series = seriesButton?.dataset.sequenceSeries;
  if (series === "coverage" || series === "ratio" || series === "both") {
    appSettings.sequenceChartSeries = series;
    saveSettings();
    if (latestResult?.type === "sequence") renderSequenceResult(latestResult);
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
elements.chatComposer.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendChat();
});
elements.stopChatButton.addEventListener("click", stopChat);
elements.newThreadButton.addEventListener("click", newThread);
elements.exportChatButton.addEventListener("click", () => { void exportChat(); });
elements.threadsButton.addEventListener("click", () => {
  if (elements.threadsDrawer.hidden) openThreadsDrawer();
  else closeThreadsDrawer();
});
elements.threadSearchInput.addEventListener("input", renderThreadList);
elements.threadSearchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeThreadsDrawer();
});
let pendingThreadDelete: string | null = null;
elements.threadList.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const open = target.closest<HTMLButtonElement>("[data-thread-open]");
  if (open?.dataset.threadOpen) {
    switchThread(open.dataset.threadOpen);
    return;
  }
  const remove = target.closest<HTMLButtonElement>("[data-thread-delete]");
  const id = remove?.dataset.threadDelete;
  if (!remove || !id) return;
  // Two-step delete: the first click arms the button, a second confirms.
  if (pendingThreadDelete === id) {
    pendingThreadDelete = null;
    deleteThread(id);
    return;
  }
  pendingThreadDelete = id;
  remove.classList.add("armed");
  remove.title = "Click again to delete";
  setTimeout(() => {
    if (pendingThreadDelete !== id) return;
    pendingThreadDelete = null;
    remove.classList.remove("armed");
    remove.title = "Delete conversation";
  }, 2500);
});
elements.expandChatButton.addEventListener("click", () => setPanelState({ chatExpanded: !appSettings.chatExpanded }));
elements.collapseChatButton.addEventListener("click", () => setPanelState({ chatCollapsed: true }));
elements.chatRail.addEventListener("click", () => {
  setPanelState({ chatCollapsed: false });
  elements.chatInput.focus();
});
elements.chatResizer.addEventListener("pointerdown", startChatResize);
elements.chatResizer.addEventListener("dblclick", () => setPanelState({ chatWidth: DEFAULT_CHAT_WIDTH, chatExpanded: false }));
elements.chatResizer.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const delta = event.key === "ArrowLeft" ? 24 : -24;
  setPanelState({ chatWidth: clampChatWidth(appSettings.chatWidth + delta), chatExpanded: false });
});
document.querySelectorAll<HTMLButtonElement>("[data-chat-mode]").forEach((button) => {
  button.addEventListener("click", () => setChatMode(button.dataset.chatMode === "agent" ? "agent" : "chat"));
});
elements.capabilitiesButton.addEventListener("click", () => toggleCapabilities());
document.addEventListener("pointerdown", (event) => {
  if (elements.agentCapabilities.hidden) return;
  const target = event.target as Node;
  if (!elements.agentCapabilities.contains(target) && !elements.capabilitiesButton.contains(target)) toggleCapabilities(false);
});
elements.chatContextChip.addEventListener("click", () => {
  contextEnabled = !contextEnabled;
  updateChatContextChip();
});
elements.contextPinButton.addEventListener("click", togglePinnedContext);
elements.contextPreviewButton.addEventListener("click", openContextDialog);
elements.closeContextDialogButton.addEventListener("click", closeContextDialog);
elements.contextDialog.addEventListener("click", (event) => {
  if (event.target === elements.contextDialog) closeContextDialog();
});
elements.cancelEditButton.addEventListener("click", () => {
  cancelEdit();
  clearComposer();
});

function handleSuggestionClick(event: Event) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-suggest-prompt]");
  if (!button?.dataset.suggestPrompt || activeChat) return false;
  const mode = button.dataset.suggestMode === "agent" ? "agent" : button.dataset.suggestMode === "chat" ? "chat" : chatMode;
  void sendMessage(button.dataset.suggestPrompt, mode);
  return true;
}
elements.chatSuggestions.addEventListener("click", handleSuggestionClick);
elements.chatMessages.addEventListener("click", (event) => {
  if (handleSuggestionClick(event)) return;
  const target = event.target as HTMLElement;
  const summary = target.closest<HTMLElement>(".steps-summary");
  if (summary) {
    const container = summary.closest<HTMLElement>(".agent-steps");
    if (container) toggleTimeline(container);
    return;
  }
  const record = target.closest<HTMLElement>("[data-open-record]");
  if (record?.dataset.openRecord) {
    openBatchRecord(Number(record.dataset.openRecord));
    return;
  }
  const kmer = target.closest<HTMLElement>("[data-open-kmer]");
  if (kmer?.dataset.openKmer) {
    openInInteractive(kmer.dataset.openKmer);
    return;
  }
  const dna = target.closest<HTMLElement>(".dna-link");
  if (dna?.dataset.dna) {
    openInInteractive(dna.dataset.dna);
    return;
  }
  const evidence = target.closest<HTMLElement>("[data-step-evidence]");
  if (evidence?.dataset.stepEvidence) {
    const pre = Array.from(evidence.closest(".step-main")?.querySelectorAll<HTMLElement>(".step-evidence") || [])
      .find((el) => el.dataset.callId === evidence.dataset.stepEvidence);
    if (pre) pre.hidden = !pre.hidden;
    return;
  }
  handleMarkdownCopyClick(event);
});
elements.chatMessages.addEventListener("keydown", (event) => {
  const dna = (event.target as HTMLElement).closest<HTMLElement>(".dna-link");
  if (dna?.dataset.dna && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openInInteractive(dna.dataset.dna);
  }
});
elements.slashMenu.addEventListener("mousedown", (event) => {
  // mousedown (not click) so the textarea keeps focus.
  const item = (event.target as HTMLElement).closest<HTMLElement>("[data-slash-index]");
  if (!item) return;
  event.preventDefault();
  pickSlash(Number(item.dataset.slashIndex), true);
});

// Live token stream: append each delta to the in-flight assistant bubble (or the
// report's narrative element) and re-render its Markdown on the next animation frame.
window.dstoreqc.onAiChatChunk((chunk) => {
  if (activeChat && chunk.id === activeChat.id) {
    if (!activeChat.text) activeChat.bubble.classList.remove("streaming");
    activeChat.text += chunk.delta;
    scheduleAssistantRender();
    return;
  }
  if (activeReportStream && chunk.id === activeReportStream.id) {
    activeReportStream.text += chunk.delta;
    scheduleReportStreamRender();
  }
});
window.dstoreqc.onAiTool(({ id, trace }) => {
  if (!activeChat || activeChat.id !== id) return;
  const pinned = isChatPinnedToBottom(120);
  const existing = activeChat.trace.findIndex((item) => item.callId === trace.callId);
  if (existing < 0) activeChat.trace.push(trace);
  else activeChat.trace[existing] = trace;
  renderTimeline(activeChat.bubble, timelineFromTrace(activeChat.trace), { running: true });
  updateRunbar();
  if (pinned) scrollChatToBottom();
});
window.dstoreqc.onAiProgress(({ id, progress }) => {
  if (!activeChat || activeChat.id !== id) return;
  activeChat.progress = progress;
  updateRunbar();
});
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
// The chat-header quick switcher writes through the same settings fields and
// re-renders everything, so it and the Settings modal never drift apart.
elements.chatProviderSelect.addEventListener("change", () => {
  appSettings.activeProvider = elements.chatProviderSelect.value as ProviderId;
  saveSettings();
  renderSettings();
});
elements.chatModelSelect.addEventListener("change", () => {
  appSettings.providers[appSettings.activeProvider].selectedModel = elements.chatModelSelect.value;
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
  appSettings.maxTokens = Math.max(128, Math.trunc(Number(elements.maxTokensInput.value) || 4096));
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
  if (event.isComposing) return;
  // Command menu navigation takes precedence while it is open.
  if (!elements.slashMenu.hidden && slashMatches.length) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : slashMatches.length - 1)) % slashMatches.length;
      renderSlashMenu();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pickSlash(slashIndex, event.key === "Enter");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSlashMenu();
      return;
    }
  }
  // Enter or Cmd/Ctrl+Enter sends; Shift+Enter inserts a newline.
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendChat();
    return;
  }
  if (event.key === "Escape") {
    // Esc stops a running generation, else leaves edit mode.
    if (activeChat) {
      event.preventDefault();
      void stopChat();
    } else if (editingIndex != null) {
      event.preventDefault();
      cancelEdit();
      clearComposer();
    }
  }
});

// Grow the composer with its content so a multi-line question is visible while
// being typed, up to a cap beyond which it scrolls internally.
function autoGrowChatInput() {
  const input = elements.chatInput;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}
elements.chatInput.addEventListener("input", () => {
  autoGrowChatInput();
  updateSlashMenu();
});

// App-wide shortcuts for the agent panel.
document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && !event.shiftKey && key === "j") {
    event.preventDefault();
    setPanelState({ chatCollapsed: !appSettings.chatCollapsed });
    if (!appSettings.chatCollapsed) elements.chatInput.focus();
  } else if (mod && !event.shiftKey && key === "k") {
    event.preventDefault();
    openChatPanel();
    elements.chatInput.focus();
  } else if (mod && event.shiftKey && key === "o") {
    event.preventDefault();
    newThread();
  } else if (event.key === "Escape") {
    if (!elements.contextDialog.hidden) closeContextDialog();
    else if (!elements.threadsDrawer.hidden) closeThreadsDrawer();
    else if (!elements.agentCapabilities.hidden) toggleCapabilities(false);
  }
});

window.dstoreqc.onAnalyzerEvent((event) => {
  const payload = event as { kind?: string; line?: string; code?: number | null; done?: number; total?: number };
  if (payload.kind === "stderr" && payload.line) appendLog(payload.line);
  if (payload.kind === "batchProgress" && batchRunning) {
    ui.batchProgress.textContent = `${formatNumber(payload.done || 0)} / ${formatNumber(payload.total || 0)} done`;
  }
  if (payload.kind === "exit") {
    setAnalyzerReady(false);
    elements.startButton.disabled = false;
    setStatus(`Kernel exited: ${payload.code ?? ""}`.trim());
  }
});

// ===========================================================================
// Multi-tool workbench: Cross-links, Seq-Filter, and the combined Report view.
// ===========================================================================
type ViewName = "interactive" | "batch" | "links" | "filter" | "report";
type LinksResult = Awaited<ReturnType<DStoreQCApi["runLinks"]>>;
type FilterResult = Awaited<ReturnType<DStoreQCApi["runFilter"]>>;
type ReportResult = Awaited<ReturnType<DStoreQCApi["runReport"]>>;
type InteractiveBatchResult = Awaited<ReturnType<DStoreQCApi["runInteractiveBatch"]>>;
type SmKdKnRow = NonNullable<ReportResult["analyzer"]>["rows"][number];
type Verdict = { level: "ok" | "warn" | "bad"; text: string };

const ui = {
  viewTabs: Array.from(document.querySelectorAll<HTMLButtonElement>(".view-tab")),
  batchSelectButton: $("batchSelectButton") as HTMLButtonElement,
  batchFile: $("batchFile"),
  batchPrimerFront: $("batchPrimerFront") as HTMLInputElement,
  batchPrimerBack: $("batchPrimerBack") as HTMLInputElement,
  batchRunButton: $("batchRunButton") as HTMLButtonElement,
  batchSaveButton: $("batchSaveButton") as HTMLButtonElement,
  batchProgress: $("batchProgress"),
  batchResult: $("batchResult"),
  batchDetail: $("batchDetail"),
  linksSelectButton: $("linksSelectButton") as HTMLButtonElement,
  linksFile: $("linksFile"),
  linksK: $("linksK") as HTMLInputElement,
  linksM: $("linksM") as HTMLInputElement,
  linksPrimer: $("linksPrimer") as HTMLInputElement,
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
let filterSaveOutput = "";
let filterSaveDefaultName = "passed.fa";
let reportRefFile = "";
let reportNgsFiles: string[] = [];
let latestReport: ReportResult | null = null;
let reportAiRequest: { id: string; report: ReportResult } | null = null;
let reportNarrative = "";

// Compact per-strand metrics kept separately from the full coverage profile so
// table rendering stays cheap even when the kernel returns every strand at once.
type SequenceSummary = {
  observed: number;
  kmerCount: number;
  complete: boolean;
  minCoverage: number;
  meanCoverage: number;
  maxCoverage: number;
  maxAdjacentRatio: number;
};

type BatchRow = {
  index: number;
  name: string;
  rawLength: number;
  analyzedLength: number;
  status: "ok" | "skipped" | "error";
  message?: string;
  summary?: SequenceSummary;
  detail?: SequenceResult;
};

let batchFile = "";
let batchRows: BatchRow[] = [];
let batchRunning = false;
let batchDetailIndex: number | null = null;
let batchPage = 0;
let batchHighlightIndex: number | null = null;
let batchPrimerFrontUsed = DEFAULT_PRIMER;
let batchPrimerBackUsed = DEFAULT_PRIMER;
const BATCH_PAGE_SIZE = 100;

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
  updateChatContextChip();
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
  const files = await window.dstoreqc.selectFiles();
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
    const result = await window.dstoreqc.runLinks({
      file: linksFile,
      k: Number(ui.linksK.value),
      m: Number(ui.linksM.value),
      primerLen: Number(ui.linksPrimer.value)
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
  latestLinks = result;
  updateChatContextChip();
  const cl = result.crossLinks;
  const primerNote = result.primerLen > 0 ? ` (primers trimmed: ${result.primerLen} bp each end)` : "";
  const note = cl === 0
    ? `No cross-links detected — strands appear well separated at this k${primerNote}.`
    : `Cross-links are k-mers shared by different strands (potential entanglement)${primerNote}.`;
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
    const result = await window.dstoreqc.runFilter({
      file: filterFile,
      k: Number(ui.filterK.value),
      m: Number(ui.filterM.value),
      primerLen: Number(ui.filterPrimer.value),
      listFiltered: ui.filterListFiltered.checked
    });
    renderFilterResult(result);
  } catch (error) {
    filterOutput = "";
    filterSaveOutput = "";
    filterSaveDefaultName = "passed.fa";
    ui.filterSaveButton.disabled = true;
    ui.filterResult.innerHTML = `<div class="error-card">${escapeHtml(errMessage(error))}</div>`;
  } finally {
    ui.filterRunButton.disabled = false;
    renderIcons();
  }
}

function renderFilterResult(result: FilterResult) {
  latestFilter = result;
  updateChatContextChip();
  filterOutput = result.stdout;
  filterSaveOutput = result.saveOutput;
  filterSaveDefaultName = result.saveDefaultName;
  ui.filterSaveButton.disabled = !filterSaveOutput.trim();
  const headline = result.listFiltered
    ? `<div class="metric-card"><span>Filtered (entangled)</span><strong>${formatNumber(result.filteredCount)}</strong></div>`
    : `<div class="metric-card"><span>Passed</span><strong>${formatNumber(result.passedCount)}</strong></div>`;
  const skippedMetric = result.skippedCount > 0
    ? `<div class="metric-card"><span>Skipped</span><strong>${formatNumber(result.skippedCount)}</strong></div>`
    : "";
  const note = result.listFiltered
    ? "Listing names of entangled strands that exceed the cross-link threshold."
    : "Emitting strands that passed the entanglement filter as FASTA.";
  ui.filterResult.classList.remove("empty-state");
  ui.filterResult.innerHTML = `
    <div class="report-metrics">
      ${headline}
      ${skippedMetric}
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
  if (!filterSaveOutput.trim()) return;
  try {
    const res = await window.dstoreqc.saveFile({ defaultName: filterSaveDefaultName, content: filterSaveOutput });
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
  const files = await window.dstoreqc.selectFiles();
  reportNgsFiles = files;
  renderPathChip(ui.reportNgsFiles, files, "No reads selected");
}

async function generateReport() {
  if (!reportRefFile) {
    await selectReportRef();
    if (!reportRefFile) return;
  }
  ui.reportRunButton.disabled = true;
  if (reportAiRequest) {
    void window.dstoreqc.cancelAiChat(reportAiRequest.id);
    reportAiRequest = null;
    activeReportStream = null;
  }
  latestReport = null;
  ui.reportAiButton.disabled = true;
  ui.reportExportHtmlButton.disabled = true;
  ui.reportExportMdButton.disabled = true;
  reportNarrative = "";
  ui.reportResult.classList.remove("empty-state");
  ui.reportResult.innerHTML = `<div class="tool-loading">Generating diagnostics report…</div>`;
  try {
    const result = await window.dstoreqc.runReport({
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
  const total = report.totalStrands - report.skipped;
  const entFrac = total ? report.entangled / total : 0;
  if (report.skipped > 0) {
    verdicts.push({ level: "warn", text: `${formatNumber(report.skipped)} reference strands were too short after primer trimming and were skipped for entanglement analysis.` });
  }
  if (total === 0) {
    verdicts.push({ level: "warn", text: "No reference strands could be scored for entanglement at these k and primer settings." });
  } else if (report.entangled === 0) {
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
    if (Number.isFinite(h.kd)) {
      verdicts.push({
        level: h.kd <= 0.05 ? "ok" : h.kd <= 0.2 ? "warn" : "bad",
        text: `k-mer dropout Kd = ${fmtPct(h.kd)}.`
      });
    } else {
      verdicts.push({ level: "warn", text: "Dropout Kd is unavailable because no reference k-mers could be scored." });
    }
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
  ui.reportAiButton.disabled = Boolean(reportAiRequest);
  ui.reportExportHtmlButton.disabled = false;
  ui.reportExportMdButton.disabled = false;
  const h = report.analyzer?.headline || null;
  const verdicts = reportVerdicts(report);
  const narrative = reportNarrative
    ? `<div class="narrative-body">${renderMarkdownToHtml(reportNarrative)}</div>`
    : `<p class="muted">Click "Interpret with AI" for a narrative diagnosis using the active provider.</p>`;
  ui.reportResult.innerHTML = `
    <div class="report">
      <div class="report-head">
        <h3>DStoreQC diagnostics report</h3>
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
        ? `<div class="report-section"><h4>Coverage metrics</h4>${smkdknTable(report.analyzer.rows)}</div>`
        : `<div class="report-section"><h4>Coverage metrics</h4><p class="muted">No NGS reads provided; Sm/Kd/Kn not computed.</p></div>`}
      <div class="report-section">
        <h4>Entanglement (m=${formatNumber(report.filterM)}, p=${formatNumber(report.primerLen)})</h4>
        <p>${formatNumber(report.passed)} passed · ${formatNumber(report.entangled)} entangled · ${formatNumber(report.skipped)} skipped${report.entangledTruncated ? " (list truncated to 1000)" : ""}</p>
        ${report.entangledNames.length ? `<details><summary>Entangled strand names (${formatNumber(report.entangledNames.length)})</summary><pre class="tool-log">${escapeHtml(report.entangledNames.join("\n"))}</pre></details>` : ""}
      </div>
      <div class="report-section">
        <h4>Cross-links (m=${formatNumber(report.linksM)})</h4>
        <p>${report.crossLinks == null ? "n/a" : formatNumber(report.crossLinks)} cross-link contributions across reference strands.</p>
      </div>
      <div class="report-section narrative">
        <h4>AI interpretation</h4>
        ${narrative}
      </div>
      <details><summary>Commands</summary><pre class="tool-log">${escapeHtml([...new Set([report.linksCommand, report.filterCommand, report.analyzer?.command].filter(Boolean))].join("\n"))}</pre></details>
    </div>`;
  renderIcons();
}

async function interpretReport() {
  if (!latestReport || reportAiRequest) return;
  const report = latestReport;
  const id = `report-${++chatStreamCounter}-${Date.now()}`;
  reportAiRequest = { id, report };
  ui.reportAiButton.disabled = true;
  reportNarrative = "Generating AI interpretation…";
  renderReport(report);
  // Stream into the narrative element renderReport just produced; it stays in
  // place until the authoritative re-render in `finally`.
  const narrativeEl = ui.reportResult.querySelector<HTMLElement>(".narrative-body");
  if (narrativeEl) {
    activeReportStream = { id, body: narrativeEl, text: "", stableEl: null, liveEl: null, stableLen: 0, raf: false };
  }
  try {
    const instruction =
      "You are given a DStoreQC DNA data-storage diagnostics report (JSON) combining strand recovery (Sm), " +
      "k-mer dropout (Kd), k-mer noise (Kn), cross-link counts, and entanglement filtering across a set of " +
      "reference strands. State measured facts with their denominators and tool scopes. Distinguish possible " +
      "explanations from established causes, acknowledge missing evidence, and propose discriminating manual checks. " +
      "Do not equate pooled k-mer support with decoding, distinct-key noise with a base-error rate, or sharing with physical chimeras.";
    const result = await window.dstoreqc.aiChat({
      id,
      messages: [{ role: "user", content: instruction }],
      context: reportContext(report),
      contextLabel: "Diagnostics report",
      settings: currentAiSettings()
    });
    if (reportAiRequest?.id === id && latestReport === report) {
      if (result.canceled) {
        // Like the chat's cancel path: keep whatever streamed in, marked stopped.
        const partial = activeReportStream?.id === id ? activeReportStream.text : "";
        reportNarrative = partial.trim() ? `${partial}\n\n_(stopped)_` : "_(stopped)_";
      } else {
        reportNarrative = result.content;
      }
    }
  } catch (error) {
    if (reportAiRequest?.id === id && latestReport === report) reportNarrative = `AI interpretation failed: ${errMessage(error)}`;
  } finally {
    if (reportAiRequest?.id === id) reportAiRequest = null;
    if (activeReportStream?.id === id) activeReportStream = null;
    if (latestReport === report) renderReport(report);
  }
}

function buildReportMarkdown(report: ReportResult, narrative: string) {
  const lines: string[] = [];
  lines.push("# DStoreQC Diagnostics Report", "");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Reference: ${report.referenceFile}`);
  lines.push(`- NGS reads: ${report.ngsFiles.length ? report.ngsFiles.join(", ") : "(none)"}`);
  lines.push(`- k-mer: ${report.k} · primer length: ${report.primerLen}`, "");
  lines.push("## Summary", "", "| Metric | Value |", "| --- | --- |");
  lines.push(`| Reference strands | ${report.totalStrands} |`);
  lines.push(`| Entangled strands | ${report.entangled} |`);
  lines.push(`| Passed strands | ${report.passed} |`);
  lines.push(`| Skipped strands | ${report.skipped} |`);
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
    lines.push("", "## Coverage metrics", "");
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
  lines.push("", "## Commands", "", "```", ...new Set([report.linksCommand, report.filterCommand, ...(report.analyzer ? [report.analyzer.command] : [])]), "```", "");
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
    ["Skipped strands", formatNumber(report.skipped)],
    ["Cross-links", report.crossLinks == null ? "n/a" : formatNumber(report.crossLinks)],
    ...(h ? [["Strand recovery Sm", fmtPct(h.sm)], ["k-mer dropout Kd", fmtPct(h.kd)], ["k-mer noise Kn", Number.isFinite(h.kn) ? fmtFloat(h.kn) : "n/a"]] : [])
  ].map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("");
  const css = "body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1c2530;line-height:1.5}h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #dde3ea;padding-bottom:4px}table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th,td{border:1px solid #dde3ea;padding:5px 8px;text-align:left}th{background:#f4f6f9}ul{padding-left:18px}.v-ok{color:#137a4b}.v-warn{color:#9a6700}.v-bad{color:#b42318}.muted{color:#667085}pre{background:#f4f6f9;border:1px solid #dde3ea;border-radius:6px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap}.narrative .md-h{font-size:15px;margin:14px 0 6px;border:0;padding:0}.narrative code{background:#f4f6f9;padding:1px 5px;border-radius:5px;font-size:12px}.narrative blockquote{margin:6px 0;padding:2px 0 2px 10px;border-left:3px solid #dde3ea;color:#667085}.md-table-wrap{overflow-x:auto;margin:8px 0}.md-al-right{text-align:right}.md-al-center{text-align:center}.md-al-left{text-align:left}";
  const narrativeHtml = narrative ? `<h2>AI interpretation</h2><div class="narrative">${renderMarkdownToHtml(narrative)}</div>` : "";
  const entangledHtml = report.entangledNames.length
    ? `<h2>Entangled strands (${report.entangledNames.length}${report.entangledTruncated ? ", truncated" : ""})</h2><pre>${escapeHtml(report.entangledNames.join("\n"))}</pre>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DStoreQC Diagnostics Report</title><style>${css}</style></head><body>` +
    `<h1>DStoreQC Diagnostics Report</h1>` +
    `<p class="muted">Generated ${escapeHtml(new Date(report.generatedAt).toLocaleString())} · k=${escapeHtml(String(report.k))} · primer ${escapeHtml(String(report.primerLen))}</p>` +
    `<p class="muted">Reference: ${escapeHtml(report.referenceFile)}<br/>NGS reads: ${escapeHtml(report.ngsFiles.length ? report.ngsFiles.join(", ") : "(none)")}</p>` +
    `<h2>Summary</h2><table>${summaryRows}</table>` +
    `<h2>Verdicts</h2><ul>${verdicts}</ul>` +
    `<h2>Coverage metrics</h2>${analyzerTable}` +
    `<h2>Cross-links (m=${escapeHtml(String(report.linksM))})</h2><p>${report.crossLinks == null ? "n/a" : formatNumber(report.crossLinks)} cross-link contributions across reference strands.</p>` +
    entangledHtml +
    narrativeHtml +
    `<h2>Commands</h2><pre>${escapeHtml([...new Set([report.linksCommand, report.filterCommand, report.analyzer?.command].filter(Boolean))].join("\n"))}</pre>` +
    `</body></html>`;
}

async function exportReport(format: "html" | "md") {
  if (!latestReport) return;
  const content = format === "html" ? buildReportHtml(latestReport, reportNarrative) : buildReportMarkdown(latestReport, reportNarrative);
  const stamp = latestReport.generatedAt.replace(/[:.]/g, "-");
  const name = `dstoreqc-report-${stamp}.${format === "html" ? "html" : "md"}`;
  try {
    const res = await window.dstoreqc.saveFile({ defaultName: name, content });
    if (res.saved) appendLog(`Report exported to ${res.path}`);
  } catch (error) {
    appendLog(`Export failed: ${errMessage(error)}`);
  }
}

// ---- Batch QC view: per-strand analysis of a reference file ----
function syncBatchPrimerInputs() {
  ui.batchPrimerFront.value = String(appSettings.primerFront);
  ui.batchPrimerBack.value = String(appSettings.primerBack);
}

async function selectBatchFile() {
  const file = await pickOneFile();
  if (file) {
    batchFile = file;
    renderPathChip(ui.batchFile, [file], "No reference selected");
  }
}

function batchCoverageClass(row: BatchRow) {
  if (row.status !== "ok" || !row.summary) return "warn";
  return row.summary.complete ? "ok" : "bad";
}

function renderBatchRow(row: BatchRow) {
  const expanded = batchDetailIndex === row.index;
  const hl = batchHighlightIndex === row.index ? " highlight" : "";
  if (row.status !== "ok" || !row.summary) {
    return `<tr class="batch-row ${row.status}${hl}" data-batch-index="${row.index}">
        <td>${formatNumber(row.index + 1)}</td>
        <td title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</td>
        <td>${formatNumber(row.rawLength)}</td>
        <td>${formatNumber(row.analyzedLength)}</td>
        <td colspan="5" class="batch-note">${escapeHtml(row.message || row.status)}</td>
        <td><span class="coverage zero">${escapeHtml(row.status)}</span></td>
      </tr>`;
  }
  const r = row.summary;
  return `<tr class="batch-row clickable ${batchCoverageClass(row)} ${expanded ? "expanded" : ""}${hl}" data-batch-index="${row.index}" aria-expanded="${expanded ? "true" : "false"}">
      <td>${formatNumber(row.index + 1)}</td>
      <td title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</td>
      <td>${formatNumber(row.rawLength)}</td>
      <td>${formatNumber(row.analyzedLength)}</td>
      <td>${formatNumber(r.observed)} / ${formatNumber(r.kmerCount)}</td>
      <td><span class="path-pill ${r.complete ? "ok" : "bad"}">${r.complete ? "complete" : "broken"}</span></td>
      <td><span class="coverage ${coverageClass(r.minCoverage)}">${formatNumber(r.minCoverage)}</span></td>
      <td>${formatNumber(Math.round(r.meanCoverage))}</td>
      <td>${formatNumber(r.maxCoverage)}</td>
      <td>
        <button type="button" class="batch-detail-toggle" data-batch-toggle="${row.index}" aria-expanded="${expanded ? "true" : "false"}" title="${expanded ? "Hide read details" : "Show read details"}">
          <i data-lucide="${expanded ? "chevron-up" : "chevron-down"}"></i>
          <span>${expanded ? "Hide" : "Details"}</span>
        </button>
      </td>
    </tr>`;
}

function renderBatchTable() {
  const analyzed = batchRows.filter((r) => r.status === "ok" && r.summary);
  const complete = analyzed.filter((r) => r.summary!.complete).length;
  const broken = analyzed.length - complete;
  const skipped = batchRows.filter((r) => r.status === "skipped").length;
  const errors = batchRows.filter((r) => r.status === "error").length;
  const totalPages = Math.max(1, Math.ceil(batchRows.length / BATCH_PAGE_SIZE));
  batchPage = Math.min(Math.max(0, batchPage), totalPages - 1);
  const pageStart = batchPage * BATCH_PAGE_SIZE;
  const pageRows = batchRows.slice(pageStart, pageStart + BATCH_PAGE_SIZE);
  const pageEnd = pageStart + pageRows.length;
  ui.batchSaveButton.disabled = batchRows.length === 0;

  const summary = `
    <div class="report-metrics">
      <div class="metric-card"><span>Strands</span><strong>${formatNumber(batchRows.length)}</strong></div>
      <div class="metric-card"><span>Complete path</span><strong>${formatNumber(complete)}</strong></div>
      <div class="metric-card"><span>Broken path</span><strong>${formatNumber(broken)}</strong></div>
      <div class="metric-card"><span>Skipped</span><strong>${formatNumber(skipped)}</strong></div>
      <div class="metric-card"><span>Errors</span><strong>${formatNumber(errors)}</strong></div>
    </div>` + (latestBatch?.indexScope === "reference"
      ? `<p class="index-scope">Reference scope: ${escapeHtml(latestBatch.referenceFile)}. Out-of-reference keys are errors, not dropout; global noise (Kn) and off-target coverage are unavailable.</p>`
      : "");

  if (batchRows.length === 0) {
    ui.batchResult.classList.remove("empty-state");
    ui.batchResult.innerHTML = summary + `<p class="muted">No records parsed from the reference file.</p>`;
    return;
  }

  const head = ["#", "Name", "Len", "Used", "Observed", "Path", "Min", "Mean", "Max", "Details"];
  const body = pageRows.map(renderBatchRow).join("");

  ui.batchResult.classList.remove("empty-state");
  ui.batchResult.innerHTML = summary +
    `<div class="batch-table-toolbar">
      <div class="batch-toolbar-left">
        <p class="muted">Showing ${formatNumber(pageStart + 1)}-${formatNumber(pageEnd)} of ${formatNumber(batchRows.length)}. Click a strand or Details to expand/collapse its coverage profile and path completeness.</p>
        <div class="batch-search">
          <label for="batch-idx-input" class="batch-search-label">Find #:</label>
          <input id="batch-idx-input" type="number" min="1" max="${batchRows.length}" placeholder="index" class="batch-search-input" value="${batchHighlightIndex != null ? batchHighlightIndex + 1 : ""}">
        </div>
      </div>
      <div class="batch-pager">
        <button type="button" class="secondary-button" data-batch-page="${batchPage - 1}" ${batchPage <= 0 ? "disabled" : ""}>Previous</button>
        <input type="number" min="1" max="${totalPages}" value="${batchPage + 1}" class="batch-page-input" title="Go to page" id="batch-page-input">
        <span> / ${formatNumber(totalPages)}</span>
        <button type="button" class="secondary-button" data-batch-page="${batchPage + 1}" ${batchPage + 1 >= totalPages ? "disabled" : ""}>Next</button>
      </div>
    </div>` +
    `<div class="table-wrap"><table class="data-table batch-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;

  if (batchHighlightIndex != null) {
    requestAnimationFrame(() => {
      const row = ui.batchResult.querySelector(`tr[data-batch-index="${batchHighlightIndex}"]`);
      if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }
}

function renderBatchDetail(row: BatchRow, result: SequenceResult) {
  latestResult = result;
  ui.batchDetail.innerHTML =
    `<div class="batch-detail-head">
      <button type="button" class="batch-back-button" data-batch-collapse title="Back to strand list" aria-label="Back to strand list">
        <i data-lucide="arrow-left"></i>
      </button>
      <div class="batch-detail-title">
        <h3>${escapeHtml(row.name)}</h3>
        <span class="muted">${formatNumber(row.analyzedLength)} bp analyzed (of ${formatNumber(row.rawLength)} bp)</span>
      </div>
    </div>` +
    sequenceResultHtml(result);
  renderIcons();
}

function collapseBatchDetail() {
  batchDetailIndex = null;
  ui.batchDetail.innerHTML = "";
  document.getElementById("view-batch")?.classList.remove("detail-open");
  renderBatchTable();
  renderIcons();
}

async function showBatchDetail(index: number) {
  const row = batchRows.find((r) => r.index === index);
  if (!row || row.status !== "ok" || !row.summary) {
    collapseBatchDetail();
    return;
  }
  batchDetailIndex = index;
  document.getElementById("view-batch")?.classList.add("detail-open");
  renderBatchTable();
  renderIcons();

  if (!row.detail) {
    ui.batchDetail.innerHTML = `<div class="tool-loading">Loading coverage profile…</div>`;
    try {
      const record = await window.dstoreqc.loadBatchSequence({
        file: batchFile,
        index,
        primerFront: batchPrimerFrontUsed,
        primerBack: batchPrimerBackUsed
      });
      const result = (await window.dstoreqc.queryAnalyzer(`sequence ${record.seq}`)) as AnalyzerResult;
      if (batchDetailIndex !== index) return;
      if (result.type !== "sequence") {
        ui.batchDetail.innerHTML = `<div class="error-card">${escapeHtml(result.type === "error" ? result.message : `unexpected ${result.type} response`)}</div>`;
        return;
      }
      row.detail = result;
    } catch (error) {
      if (batchDetailIndex === index) ui.batchDetail.innerHTML = `<div class="error-card">${escapeHtml(errMessage(error))}</div>`;
      return;
    }
  }

  renderBatchDetail(row, row.detail);
  ui.batchDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function toggleBatchDetail(index: number) {
  if (batchDetailIndex === index) {
    collapseBatchDetail();
    return;
  }
  void showBatchDetail(index);
}

async function runBatchAnalysis() {
  if (batchRunning) return;
  if (!batchFile) {
    await selectBatchFile();
    if (!batchFile) return;
  }
  if (!analyzerReady) {
    ui.batchResult.classList.remove("empty-state");
    ui.batchResult.innerHTML = `<div class="error-card">Start the kernel in the Interactive tab first (it loads the sequencing k-mer table used to score each strand).</div>`;
    return;
  }

  const front = normalizePrimer(ui.batchPrimerFront.value, appSettings.primerFront);
  const back = normalizePrimer(ui.batchPrimerBack.value, appSettings.primerBack);
  appSettings.primerFront = front;
  appSettings.primerBack = back;
  batchPrimerFrontUsed = front;
  batchPrimerBackUsed = back;
  saveSettings();

  batchRunning = true;
  batchRows = [];
  batchDetailIndex = null;
  batchHighlightIndex = null;
  batchPage = 0;
  document.getElementById("view-batch")?.classList.remove("detail-open");
  ui.batchDetail.innerHTML = "";
  ui.batchRunButton.disabled = true;
  ui.batchSaveButton.disabled = true;
  ui.batchResult.classList.remove("empty-state");
  ui.batchResult.innerHTML = `<div class="tool-loading">Running Batch QC in the C kernel…</div>`;
  ui.batchProgress.textContent = "C kernel running";

  try {
    const result: InteractiveBatchResult = await window.dstoreqc.runInteractiveBatch({
      file: batchFile,
      primerFront: front,
      primerBack: back
    });
    latestBatch = result;
    updateChatContextChip();
    batchRows = (result.rows || []).map((row) => {
      const summary = row.summary;
      return {
        index: row.index,
        name: row.name || `seq${row.index + 1}`,
        rawLength: row.rawLength,
        analyzedLength: row.analyzedLength,
        status: row.status,
        message: row.message,
        summary: summary ? {
          observed: summary.observed,
          kmerCount: summary.kmerCount,
          complete: summary.complete,
          minCoverage: summary.minCoverage,
          meanCoverage: summary.meanCoverage,
          maxCoverage: summary.maxCoverage,
          maxAdjacentRatio: summary.maxAdjacentRatio
        } : undefined,
        detail: undefined
      };
    });
    renderBatchTable();
    renderIcons();
    ui.batchProgress.textContent = `${formatNumber(batchRows.length)} / ${formatNumber(batchRows.length)} done`;
    appendLog(`Batch QC analyzed ${batchRows.length} reference strands from ${compactPath(batchFile)}.`);
  } catch (error) {
    ui.batchResult.innerHTML = `<div class="error-card">${escapeHtml(errMessage(error))}</div>`;
    ui.batchProgress.textContent = "failed";
  } finally {
    batchRunning = false;
    ui.batchRunButton.disabled = false;
  }
}

function buildBatchCsv() {
  const header = ["index", "name", "raw_length", "analyzed_length", "status", "observed_kmers", "total_kmers", "path_complete", "min_cov", "mean_cov", "max_cov", "max_adjacent_ratio"];
  const scope = latestBatch?.indexScope === "reference" ? latestBatch : null;
  if (scope) header.push("message", "index_scope", "reference_file", "target_kmers", "global_noise_available", "unrestricted_queries_available", "bloom_backend", "bloom_bytes", "bloom_bits_per_key", "bloom_hashes");
  const lines = [header.join(",")];
  for (const row of batchRows) {
    const r = row.summary;
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    lines.push([
      row.index + 1, row.name, row.rawLength, row.analyzedLength, row.status,
      r ? r.observed : "", r ? r.kmerCount : "", r ? (r.complete ? "yes" : "no") : "",
      r ? r.minCoverage : "", r ? r.meanCoverage : "", r ? r.maxCoverage : "",
      r ? r.maxAdjacentRatio : "",
      ...(scope ? [row.message, scope.indexScope, scope.referenceFile, scope.targetKmers, false, false,
        scope.bloom?.backend, scope.bloom?.bytes, scope.bloom?.bitsPerKey, scope.bloom?.hashes] : [])
    ].map(cell).join(","));
  }
  return lines.join("\n") + "\n";
}

async function saveBatchCsv() {
  if (!batchRows.length) return;
  try {
    const res = await window.dstoreqc.saveFile({ defaultName: "batch-qc.csv", content: buildBatchCsv() });
    if (res.saved) appendLog(`Saved Batch QC table to ${res.path}`);
  } catch (error) {
    appendLog(`Save failed: ${errMessage(error)}`);
  }
}

ui.viewTabs.forEach((tab) => tab.addEventListener("click", () => setView((tab.dataset.view as ViewName) || "interactive")));
ui.batchSelectButton.addEventListener("click", selectBatchFile);
ui.batchRunButton.addEventListener("click", runBatchAnalysis);
ui.batchSaveButton.addEventListener("click", saveBatchCsv);
ui.batchResult.addEventListener("click", (event) => {
  const pageButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-batch-page]");
  if (pageButton?.dataset.batchPage) {
    batchPage = Number(pageButton.dataset.batchPage) || 0;
    batchHighlightIndex = null;
    renderBatchTable();
    return;
  }
  const tr = (event.target as HTMLElement).closest<HTMLElement>(".batch-row.clickable");
  if (tr?.dataset.batchIndex) toggleBatchDetail(Number(tr.dataset.batchIndex));
});

// Page jump: Enter triggers page change
ui.batchResult.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "batch-page-input" && event.key === "Enter") {
    const input = target as HTMLInputElement;
    const totalPages = Math.max(1, Math.ceil(batchRows.length / BATCH_PAGE_SIZE));
    const page = Math.max(1, Math.min(totalPages, Number(input.value) || batchPage + 1));
    batchPage = page - 1;
    batchHighlightIndex = null;
    renderBatchTable();
  }
  if (target.id === "batch-idx-input" && event.key === "Enter") {
    const input = target as HTMLInputElement;
    const idx = Number(input.value);
    if (idx >= 1 && idx <= batchRows.length) {
      const targetIndex = idx - 1;
      batchPage = Math.floor(targetIndex / BATCH_PAGE_SIZE);
      batchHighlightIndex = targetIndex;
    } else {
      batchHighlightIndex = null;
    }
    renderBatchTable();
  }
});

// Index search blur: keep highlight but re-navigate on blur with valid value
ui.batchResult.addEventListener("change", (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "batch-idx-input") {
    const input = target as HTMLInputElement;
    const idx = Number(input.value);
    if (idx >= 1 && idx <= batchRows.length) {
      const targetIndex = idx - 1;
      batchPage = Math.floor(targetIndex / BATCH_PAGE_SIZE);
      batchHighlightIndex = targetIndex;
    } else {
      batchHighlightIndex = null;
    }
    renderBatchTable();
  }
});
ui.batchDetail.addEventListener("click", (event) => {
  const collapseButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-batch-collapse]");
  if (collapseButton) {
    collapseBatchDetail();
    return;
  }

  const seriesButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sequence-series]");
  const series = seriesButton?.dataset.sequenceSeries;
  if ((series === "coverage" || series === "ratio" || series === "both") && batchDetailIndex != null) {
    appSettings.sequenceChartSeries = series;
    saveSettings();
    showBatchDetail(batchDetailIndex);
    return;
  }

  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sequence-chart]");
  const chartType = button?.dataset.sequenceChart;
  if ((chartType === "bar" || chartType === "line") && batchDetailIndex != null) {
    appSettings.sequenceChartType = chartType;
    saveSettings();
    showBatchDetail(batchDetailIndex);
  }
});
ui.batchPrimerFront.addEventListener("change", () => {
  appSettings.primerFront = normalizePrimer(ui.batchPrimerFront.value, DEFAULT_PRIMER);
  syncBatchPrimerInputs();
  saveSettings();
});
ui.batchPrimerBack.addEventListener("change", () => {
  appSettings.primerBack = normalizePrimer(ui.batchPrimerBack.value, DEFAULT_PRIMER);
  syncBatchPrimerInputs();
  saveSettings();
});
ui.linksSelectButton.addEventListener("click", selectLinksFile);
ui.linksRunButton.addEventListener("click", runLinksTool);
ui.filterSelectButton.addEventListener("click", selectFilterFile);
ui.filterRunButton.addEventListener("click", runFilterTool);
ui.filterSaveButton.addEventListener("click", saveFilterOutput);
ui.reportRefButton.addEventListener("click", selectReportRef);
ui.reportNgsButton.addEventListener("click", selectReportNgs);
ui.reportRunButton.addEventListener("click", generateReport);
ui.reportAiButton.addEventListener("click", interpretReport);
ui.reportResult.addEventListener("click", handleMarkdownCopyClick);
ui.reportExportHtmlButton.addEventListener("click", () => exportReport("html"));
ui.reportExportMdButton.addEventListener("click", () => exportReport("md"));

loadSettings();
renderSettings();
setChatMode(appSettings.agentTools ? "agent" : "chat");
applyPanelLayout();
loadThreads();
updateChatContextChip();
syncBatchPrimerInputs();
updateQueryModeControls();
renderFileList();
renderIcons();
setView("interactive");
void loadSecrets();
