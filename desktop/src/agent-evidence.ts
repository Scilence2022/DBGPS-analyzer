import { randomUUID } from "node:crypto";
import { AGENT_LIMITS, compactAgentContext, type AgentBackend } from "./agent";
import type { AgentEvidenceStatus, AgentSnapshot } from "./agent-types";
import { analyzerScope, type AnalyzerScope } from "./analyzer-config";

export const EVIDENCE_LIMITS = Object.freeze({ batchRows: 250000, cachedSequenceBases: 40000000 });

export type EvidenceRow = {
  index: number;
  name: string;
  rawLength: number;
  analyzedLength: number;
  status: "ok" | "skipped" | "error";
  message?: string;
  summary?: {
    type: string; length: number; k: number; kmerCount: number; observed: number; missing: number;
    complete: boolean; minCoverage: number; maxCoverage: number; meanCoverage: number; maxAdjacentRatio: number;
  };
};

type DatasetConfig = AnalyzerScope & { k: number; threads: number; readLength: number };
type Dataset = DatasetConfig & { id: string };
type Batch = {
  id: string;
  datasetVersion: string;
  primerFront: number;
  primerBack: number;
  rows: EvidenceRow[];
  sequences: Map<number, string>;
  aggregates: { total: number; complete: number; incomplete: number; skipped: number; errors: number };
};

export type EvidenceKernel = { query(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> };

export type DecoderLayout = { primerFront: number; indexLength: number; pathLength: number };
export type DecoderSetting = { cutoff: number; ratio: number; waive: number[]; extraStep: boolean };
export type DecodabilityConfig = DecoderSetting & { decodable: number; failures: Record<string, number> };
export type DecodabilityHotspot = { kmer: number; count: number; fraction: number };
export type DecodabilityRow = { name: string; failure: string; position: number };
export type DecodabilityResult = DecoderLayout & {
  type: "decodability";
  k: number;
  seedKmer: number;
  pathKmers: number;
  total: number;
  configs: DecodabilityConfig[];
  ratioFailures: number;
  ratioHotspots: DecodabilityHotspot[];
  rows: DecodabilityRow[];
};
type CachedDecodability = { result: DecodabilityResult; file: string };

const DECODABILITY_TIMEOUT_MS = 600000;

function settingSpec(setting: DecoderSetting) {
  const waive = setting.waive.length ? setting.waive.join("+") : "-";
  return `${setting.cutoff}:${setting.ratio}:${waive}:${setting.extraStep ? "extra" : "noextra"}`;
}

// The kernel takes the reference as the rest of the line, so a path may hold spaces.
export function decodabilityCommand(layout: DecoderLayout, settings: DecoderSetting[], file: string) {
  return `decodability ${layout.primerFront} ${layout.indexLength} ${layout.pathLength} ${settings.map(settingSpec).join(",")} ${file}`;
}

export function adoptDecodability(payload: unknown): DecodabilityResult {
  const result = payload as DecodabilityResult | null;
  if (!result || result.type !== "decodability" || !Array.isArray(result.configs) || !Array.isArray(result.rows)) {
    throw new Error("Analyzer did not return a decodability result.");
  }
  return result;
}

export class AgentEvidenceStore {
  private dataset: Dataset | null = null;
  private batch: Batch | null = null;
  private decodability: CachedDecodability | null = null;
  private activeSequence: string | null = null;

  invalidate() {
    this.dataset = null;
    this.batch = null;
    this.decodability = null;
    this.activeSequence = null;
  }

  activate(config: DatasetConfig) {
    this.invalidate();
    this.dataset = { id: randomUUID(), k: config.k, threads: config.threads, readLength: config.readLength, ...analyzerScope(config) };
    return this.dataset.id;
  }

  getDatasetVersion() { return this.dataset?.id || null; }

  // What evidence exists right now, without opening a snapshot. Counts only:
  // no names, sequences, or paths leave the main process through this call.
  status(): AgentEvidenceStatus {
    const batch = this.batch;
    return {
      datasetVersion: this.dataset?.id || null,
      k: this.dataset?.k ?? null,
      indexScope: this.dataset?.indexScope === "reference" ? "reference" : null,
      batch: batch ? { ...batch.aggregates, cachedProfiles: batch.sequences.size, primerFront: batch.primerFront, primerBack: batch.primerBack } : null,
      decodability: this.decodability ? { total: this.decodability.result.total, decodable: this.decodability.result.configs[0]?.decodable ?? 0 } : null,
      selectedSequence: Boolean(this.activeSequence)
    };
  }

  clearBatch() { this.batch = null; }

  cacheDecodability(datasetVersion: string, result: DecodabilityResult, file: string) {
    if (!this.dataset || this.dataset.id !== datasetVersion) throw new Error("Dataset changed during the decodability query; result not cached.");
    this.decodability = { result, file };
  }

  selectSequence(sequence: string) {
    this.activeSequence = /^[ACGT]+$/.test(sequence) && sequence.length <= AGENT_LIMITS.sequenceBases ? sequence : null;
  }

  cacheBatch(datasetVersion: string, primerFront: number, primerBack: number, rows: EvidenceRow[], sequences: Map<number, string>) {
    if (!this.dataset || this.dataset.id !== datasetVersion) throw new Error("Dataset changed during Batch QC; result not cached.");
    this.batch = null;
    if (rows.length > EVIDENCE_LIMITS.batchRows) return false;
    let bases = 0;
    const eligible = new Map<number, string>();
    for (const [index, sequence] of sequences) {
      if (sequence.length > AGENT_LIMITS.sequenceBases || bases + sequence.length > EVIDENCE_LIMITS.cachedSequenceBases) continue;
      eligible.set(index, sequence);
      bases += sequence.length;
    }
    const saved = rows.map((row) => ({ ...row, summary: row.summary ? { ...row.summary } : undefined }));
    const complete = saved.filter((row) => row.status === "ok" && row.summary?.complete).length;
    const incomplete = saved.filter((row) => row.status === "ok" && row.summary && !row.summary.complete).length;
    const skipped = saved.filter((row) => row.status === "skipped").length;
    this.batch = {
      id: randomUUID(), datasetVersion, primerFront, primerBack, rows: saved, sequences: eligible,
      aggregates: { total: saved.length, complete, incomplete, skipped, errors: saved.length - complete - incomplete - skipped }
    };
    return true;
  }

  open(context: unknown, kernel: EvidenceKernel | null): { snapshot: AgentSnapshot; backend: AgentBackend } {
    const dataset = this.dataset;
    const batch = this.batch;
    const decodability = this.decodability;
    const sequence = this.activeSequence;
    const scope = dataset ? analyzerScope(dataset) : {};
    const input = context && typeof context === "object" ? context as Record<string, unknown> : {};
    const active = input.activeView && typeof input.activeView === "object" ? input.activeView as Record<string, unknown> : null;
    const stale = typeof active?.datasetVersion === "string" && active.datasetVersion !== dataset?.id;
    const accepted = stale ? { ...input, activeView: { unavailable: true, reason: "Active-view result belongs to an older index version." } } : context;
    const snapshot: AgentSnapshot = {
      ...scope,
      id: randomUUID(), datasetVersion: dataset?.id || null, batchVersion: batch?.id || null,
      createdAt: new Date().toISOString(), context: compactAgentContext(accepted)
    };
    const assertCurrent = () => {
      if (this.dataset?.id !== dataset?.id || this.batch?.id !== batch?.id || this.decodability !== decodability) throw new Error("Evidence snapshot is stale; ask again against the current dataset.");
    };
    const query = async (command: string, signal: AbortSignal, timeoutMs = 60000) => {
      signal.throwIfAborted();
      assertCurrent();
      if (!dataset || !kernel) throw new Error("No loaded read index is available. Start it manually before requesting analyzer tools.");
      const result = await kernel.query(command, timeoutMs, signal);
      signal.throwIfAborted();
      assertCurrent();
      if (!result || typeof result !== "object" || (result as { type?: string }).type === "error") throw new Error("Analyzer query failed; no measurement adopted.");
      return result as Record<string, unknown>;
    };
    const rowView = (row: EvidenceRow) => ({ ...row, name: row.name.slice(0, 200), message: row.message?.slice(0, 200), profileCached: Boolean(batch?.sequences.has(row.index)) });
    const cachedDecoder = () => {
      assertCurrent();
      if (!decodability) throw new Error("No decoder readiness result is available. Run Predict decoding in Batch QC first.");
      return decodability;
    };
    const decoderView = (result: DecodabilityResult, selection: Record<string, unknown>, selected: DecodabilityRow[]) => {
      const { rows, ...summary } = result;
      return {
        ...summary, ...scope,
        positionConvention: "failure positions are zero-based k-mer indices on the full strand, including the primer",
        selection,
        rows: selected.map((row) => ({ ...row, name: row.name.slice(0, 200) }))
      };
    };
    const backend: AgentBackend = {
      assertCurrent,
      getK: () => dataset?.k || 0,
      getSummary: async (signal) => {
        const result = await query("summary", signal);
        if (result.type !== "summary") throw new Error("Unexpected analyzer summary response.");
        return {
          ...analyzerScope(result), ...scope,
          type: result.type, k: result.k, distinctKmers: result.distinctKmers,
          totalKmerCoverage: result.totalKmerCoverage,
          threads: dataset?.threads, readLength: dataset?.readLength,
          countSaturation: 16383,
          exactness: scope.indexScope === "reference"
            ? "exact canonical membership and saturated counts within the immutable full-reference key set; totals count only observed reference keys, not off-target keys"
            : "exact canonical membership and saturated counts",
          batch: batch ? { id: batch.id, primerFront: batch.primerFront, primerBack: batch.primerBack, ...batch.aggregates, cachedProfiles: batch.sequences.size } : null,
          selectedSequenceAvailable: Boolean(sequence)
        };
      },
      getSequence: async (recordIndex, signal) => {
        const row = recordIndex == null ? null : batch?.rows.find((item) => item.index === recordIndex);
        const selected = recordIndex == null ? sequence : batch?.sequences.get(recordIndex);
        if (recordIndex != null && (!row || row.status !== "ok" || !row.summary)) throw new Error("Batch record is unavailable, invalid, or skipped in this snapshot.");
        if (!selected) throw new Error("Sequence is not in the bounded main-process snapshot cache. Select it manually in Interactive and ask again.");
        const result = await query(`sequence ${selected}`, signal);
        return {
          reference: row ? { index: row.index, name: row.name.slice(0, 200), batchVersion: batch?.id, primerFront: batch?.primerFront, primerBack: batch?.primerBack } : { source: "user-selected Interactive sequence", primerScope: "as queried by user" },
          result: { ...result, ...scope }
        };
      },
      queryKmer: async (kmer, depth, signal) => {
        assertCurrent();
        if (scope.indexScope === "reference") throw new Error("Graph k-mer queries are unavailable in Bloom encoded sequence mode; use a cached encoded sequence profile.");
        const result = await query(`kmer ${kmer} ${depth} ${depth}`, signal);
        if (result.type !== "kmer") throw new Error("Unexpected k-mer response.");
        return { ...result, graphSemantics: "membership-derived overlaps, not read-supported transitions" };
      },
      getBatchRows: (status, offset, limit) => {
        assertCurrent();
        if (!batch) throw new Error("No completed Batch QC snapshot is available in the bounded cache.");
        const matching = batch.rows.filter((row) => status === "all" || (status === "incomplete" ? row.status === "ok" && row.summary && !row.summary.complete : row.status === status));
        return {
          ...scope,
          batchVersion: batch.id, k: dataset?.k, primerFront: batch.primerFront, primerBack: batch.primerBack,
          aggregates: batch.aggregates, selection: { status, order: "processing order", offset, limit, matchedTotal: matching.length, truncated: offset > 0 || offset + limit < matching.length },
          rows: matching.slice(offset, offset + limit).map(rowView)
        };
      },
      findBatchRecords: (names) => {
        assertCurrent();
        if (!batch) throw new Error("No completed Batch QC snapshot is available in the bounded cache.");
        const wanted = new Set(names);
        const rows = batch.rows.filter((row) => wanted.has(row.name));
        const found = new Set(rows.map((row) => row.name));
        return {
          ...scope,
          batchVersion: batch.id, k: dataset?.k, primerFront: batch.primerFront, primerBack: batch.primerBack,
          selection: { requested: wanted.size, matchedRows: rows.length, truncated: rows.length > AGENT_LIMITS.batchRows },
          rows: rows.slice(0, AGENT_LIMITS.batchRows).map(rowView),
          unmatched: [...wanted].filter((name) => !found.has(name))
        };
      },
      getDecodability: (failure, offset, limit) => {
        const { result } = cachedDecoder();
        const wanted = new Set(failure === "not_decodable" ? [] : [failure]);
        const matching = result.rows.filter((row) => failure === "not_decodable" ? row.failure !== "ok" : failure === "all" || wanted.has(row.failure));
        return decoderView(result,
          { failure, order: "file order", offset, limit, matchedTotal: matching.length, truncated: offset > 0 || offset + limit < matching.length },
          matching.slice(offset, offset + limit));
      },
      findDecodability: (name) => {
        const { result } = cachedDecoder();
        const matching = result.rows.filter((row) => row.name === name);
        return {
          ...decoderView(result, { name, matchedTotal: matching.length, truncated: matching.length > AGENT_LIMITS.batchRows }, matching.slice(0, AGENT_LIMITS.batchRows)),
          unmatched: matching.length ? [] : [name]
        };
      },
      evaluateDecoderSettings: async (settings, signal) => {
        const { result: { primerFront, indexLength, pathLength }, file } = cachedDecoder();
        const command = decodabilityCommand({ primerFront, indexLength, pathLength }, settings, file);
        const result = adoptDecodability(await query(command, signal, DECODABILITY_TIMEOUT_MS));
        return {
          ...scope,
          total: result.total, seedKmer: result.seedKmer, pathKmers: result.pathKmers,
          configs: result.configs, hotspotsOfFirstSetting: result.ratioHotspots, ratioFailuresOfFirstSetting: result.ratioFailures,
          limits: "An upper bound once the decoder's path budget is exhausted at wide ratios. Relaxing the cutoff also admits rare CRC collisions, which are not modelled."
        };
      }
    };
    return { snapshot, backend };
  }
}
