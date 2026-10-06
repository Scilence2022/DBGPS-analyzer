export type AgentApiStyle = "openai-responses" | "openai-compatible" | "anthropic-messages" | "google-gemini";

export type AgentProviderSettings = {
  apiStyle: AgentApiStyle;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
};

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AgentToolCall = { id: string; name: string; arguments: unknown };
export type AgentToolOutput = { callId: string; output: string };
export type AgentProviderReply = { text: string; calls: AgentToolCall[]; continuation: unknown };

export type AgentProviderTurn = {
  reply: AgentProviderReply;
  outputs: AgentToolOutput[];
};

export type AgentProviderRequest = {
  settings: AgentProviderSettings;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: AgentToolDefinition[];
  previous: AgentProviderTurn[];
  signal: AbortSignal;
};

export type AgentProvider = (request: AgentProviderRequest) => Promise<AgentProviderReply>;

export type AgentSnapshot = {
  id: string;
  datasetVersion: string | null;
  batchVersion: string | null;
  createdAt: string;
  context: unknown;
};

export type AgentToolTrace = {
  callId: string;
  name: string;
  arguments: unknown;
  snapshotId: string;
  status: "running" | "ok" | "error";
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
};

export type AgentRun = {
  snapshot: AgentSnapshot;
  trace: AgentToolTrace[];
  modelTurns: number;
  stopReason: "completed" | "canceled" | "deadline" | "dataset_changed" | "budget" | "error";
  content: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  generation: {
    apiStyle: AgentApiStyle;
    model: string;
    endpointOrigin: string;
    temperature: number;
    maxTokensPerTurn: number;
    promptVersion: string;
  };
};

export type AgentTraceEvent = { id: string; trace: AgentToolTrace };
