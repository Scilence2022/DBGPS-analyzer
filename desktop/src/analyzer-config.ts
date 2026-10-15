export type AnalyzerConfig = {
  files: string[];
  k: number;
  threads: number;
  readLength: number;
  bloom?: boolean;
  bloomReference?: string;
  bloomBits?: number;
};

export type AnalyzerScope = {
  indexScope?: "reference";
  referenceFile?: string;
  targetKmers?: number;
  bloom?: { backend: "bfc-blocked"; bytes: number; bitsPerKey: number; hashes: number };
  globalNoiseAvailable?: false;
  unrestrictedQueriesAvailable?: false;
};

export type AnalyzerSummaryResult = AnalyzerScope & {
  type: "ready" | "summary";
  k: number;
  threads: number;
  readLength: number;
  distinctKmers: number;
  totalKmerCoverage: number;
  files?: string[];
};

export type SequenceSummaryResult = AnalyzerScope & {
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

export type NormalizedReference = { path: string; cleanup: () => void };

export function prepareBloomReference(config: AnalyzerConfig, normalize: (file: string) => NormalizedReference) {
  if (config.bloom !== true) return { args: [] as string[], cleanup: () => {}, referenceFile: undefined };
  if (typeof config.bloomReference !== "string" || !config.bloomReference.trim()) {
    throw new Error("Select a reference FASTA or tab-delimited file for Bloom reference mode.");
  }
  const bits = config.bloomBits === undefined ? 16 : config.bloomBits;
  if (!Number.isSafeInteger(bits) || bits < 4 || bits > 64) {
    throw new Error("Bloom bits per key must be an integer from 4 to 64.");
  }
  // Index the full reference, independent of subsequent query primer trimming.
  const normalized = normalize(config.bloomReference);
  return {
    args: ["--bloom", "--bloom-reference", normalized.path, "--bloom-bits", String(bits)],
    cleanup: normalized.cleanup,
    referenceFile: config.bloomReference
  };
}

export function analyzerScope(value: AnalyzerScope): AnalyzerScope {
  if (value.indexScope !== "reference") return {};
  return {
    indexScope: "reference",
    referenceFile: value.referenceFile,
    targetKmers: value.targetKmers,
    bloom: value.bloom ? { ...value.bloom } : undefined,
    globalNoiseAvailable: false,
    unrestrictedQueriesAvailable: false
  };
}

export function adoptSequenceSummary(payload: unknown):
  { status: "ok"; summary: SequenceSummaryResult } | { status: "error"; message: string } {
  if (payload && typeof payload === "object") {
    const result = payload as Partial<SequenceSummaryResult> & { message?: unknown };
    if (result.type === "sequenceSummary" && Number.isFinite(Number(result.kmerCount))) {
      return { status: "ok", summary: result as SequenceSummaryResult };
    }
    return { status: "error", message: String(result.message || "sequence summary failed") };
  }
  return { status: "error", message: "sequence summary failed" };
}
