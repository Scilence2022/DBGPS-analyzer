export type ReferenceResult = {
  type: "reference"; k: number; primerLen: number;
  linksThreshold: number; filterMaxLinks: number; crossLinks: number;
  totalStrands: number; passedCount: number; filteredCount: number; skippedCount: number;
  filteredNames: string[]; passedFasta?: string;
};

type MetricRow = {
  ratio: number; coverage: number; total: number; paths: number; noise: number;
  exist: number; lost: number; sm: number; kd: number; kn: number;
};

export type CombinedReport = {
  type: "report"; referenceFile: string; ngsFiles: string[]; reference: ReferenceResult;
  analyzer: { primerLen: number; rows: MetricRow[] } | null;
};

function validateReference(result: ReferenceResult): ReferenceResult {
  if (result?.type !== "reference" || !Array.isArray(result.filteredNames)
      || result.filteredNames.some((name) => typeof name !== "string")
      || ![result.totalStrands, result.passedCount, result.filteredCount, result.skippedCount, result.crossLinks]
        .every((value) => Number.isSafeInteger(value) && value >= 0)
      || result.passedCount + result.filteredCount + result.skippedCount !== result.totalStrands
      || result.filteredNames.length !== result.filteredCount) {
    throw new Error("Invalid reference analysis result from dstoreqc.");
  }
  return result;
}

export function parseReferenceResult(stdout: string): ReferenceResult {
  return validateReference(JSON.parse(stdout));
}

export function parseCombinedReport(stdout: string): CombinedReport {
  const result: CombinedReport = JSON.parse(stdout);
  if (result?.type !== "report") throw new Error("Invalid combined report from dstoreqc.");
  validateReference(result.reference);
  if (result.analyzer) {
    // JSON represents undefined ratios as null; the desktop's metric formatters
    // use NaN to display n/a rather than interpreting null as zero.
    for (const row of result.analyzer.rows) {
      for (const key of ["ratio", "sm", "kd", "kn"] as const) {
        if (row[key] === null) row[key] = NaN;
      }
    }
  }
  return result;
}

export function filterOutput(result: ReferenceResult, listFiltered: boolean) {
  if (typeof result.passedFasta !== "string") throw new Error("Missing passed FASTA in dstoreqc filter result.");
  return {
    stdout: listFiltered ? result.filteredNames.map((name) => `${name}\n`).join("") : result.passedFasta,
    passedCount: result.passedCount,
    filteredCount: result.filteredCount,
    skippedCount: result.skippedCount,
    saveOutput: result.passedFasta,
    saveDefaultName: "passed.fa"
  };
}
