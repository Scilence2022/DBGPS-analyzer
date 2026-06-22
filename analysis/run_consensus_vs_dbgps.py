#!/usr/bin/env python3
"""Compare alignment-majority consensus against DBGPS Analyzer Batch QC.

This script is intentionally dependency-light so it can run on the repository's
small deterministic FASTA fixtures. For production-scale benchmarking, replace
the built-in Needleman-Wunsch assignment with minimap2/bowtie2 alignment and
feed the resulting read-to-strand groups into the same consensus/report logic.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import subprocess
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


BASES = "ACGT"


@dataclass
class Record:
    name: str
    seq: str


@dataclass
class AlignmentHit:
    ref_name: str
    score: int
    identity: float
    aligned_ref: str
    aligned_read: str


@dataclass
class ConsensusResult:
    name: str
    read_count: int
    mean_depth: float
    covered_bases: int
    consensus: str
    n_count: int
    edit_distance: int
    exact_match: bool
    ambiguous: bool
    best_identity: float


def open_text(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt")
    return path.open("rt")


def parse_sequences(path: Path) -> list[Record]:
    """Parse FASTA, FASTQ, or Head-Index<TAB>DNA tables."""
    with open_text(path) as handle:
        first = handle.readline()
        rest = handle.read()
    text = first + rest
    if not text.strip():
        return []

    if first.startswith(">"):
        records: list[Record] = []
        name = ""
        chunks: list[str] = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if name:
                    records.append(Record(name, "".join(chunks).upper()))
                name = line[1:].split()[0] or f"seq{len(records) + 1}"
                chunks = []
            else:
                chunks.append(line)
        if name:
            records.append(Record(name, "".join(chunks).upper()))
        return records

    if first.startswith("@"):
        records = []
        lines = [line.rstrip("\n") for line in text.splitlines()]
        for i in range(0, len(lines), 4):
            if i + 1 >= len(lines):
                break
            name = lines[i][1:].split()[0] or f"read{len(records) + 1}"
            records.append(Record(name, lines[i + 1].strip().upper()))
        return records

    records = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        if parts[0].lower() in {"head-index", "name", "id"}:
            continue
        records.append(Record(parts[0], parts[1].upper()))
    return records


def trim_record(record: Record, front: int, back: int) -> Record:
    end = len(record.seq) - max(0, back)
    seq = record.seq[max(0, front):end if end >= max(0, front) else max(0, front)]
    return Record(record.name, seq)


def nw_align(ref: str, read: str) -> tuple[int, str, str]:
    """Small global aligner for reproducible smoke tests."""
    match = 2
    mismatch = -1
    gap = -2
    n = len(ref)
    m = len(read)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    trace = [[""] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] + gap
        trace[i][0] = "U"
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] + gap
        trace[0][j] = "L"
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            diag = dp[i - 1][j - 1] + (match if ref[i - 1] == read[j - 1] else mismatch)
            up = dp[i - 1][j] + gap
            left = dp[i][j - 1] + gap
            best = max(diag, up, left)
            dp[i][j] = best
            trace[i][j] = "D" if best == diag else "U" if best == up else "L"
    i, j = n, m
    aligned_ref: list[str] = []
    aligned_read: list[str] = []
    while i > 0 or j > 0:
        step = trace[i][j]
        if step == "D":
            aligned_ref.append(ref[i - 1])
            aligned_read.append(read[j - 1])
            i -= 1
            j -= 1
        elif step == "U":
            aligned_ref.append(ref[i - 1])
            aligned_read.append("-")
            i -= 1
        else:
            aligned_ref.append("-")
            aligned_read.append(read[j - 1])
            j -= 1
    return dp[n][m], "".join(reversed(aligned_ref)), "".join(reversed(aligned_read))


def identity(aligned_ref: str, aligned_read: str) -> float:
    aligned = [(a, b) for a, b in zip(aligned_ref, aligned_read) if a != "-" and b != "-"]
    if not aligned:
        return 0.0
    matches = sum(1 for a, b in aligned if a == b)
    return matches / len(aligned)


def best_hit(read: Record, references: list[Record]) -> AlignmentHit:
    hits = []
    for ref in references:
        score, aligned_ref, aligned_read = nw_align(ref.seq, read.seq)
        hits.append(AlignmentHit(ref.name, score, identity(aligned_ref, aligned_read), aligned_ref, aligned_read))
    hits.sort(key=lambda hit: (hit.score, hit.identity), reverse=True)
    return hits[0]


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i]
        for j, cb in enumerate(b, start=1):
            curr.append(min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = curr
    return prev[-1]


def build_consensus(
    references: list[Record],
    reads: list[Record],
    min_identity: float,
    ambiguity_delta: int,
    min_depth: int,
    min_majority: float,
) -> tuple[list[ConsensusResult], dict[str, list[AlignmentHit]], float]:
    start = time.perf_counter()
    groups: dict[str, list[AlignmentHit]] = defaultdict(list)
    ambiguous_by_ref: set[str] = set()

    for read in reads:
        ranked = []
        for ref in references:
            score, aligned_ref, aligned_read = nw_align(ref.seq, read.seq)
            ranked.append(AlignmentHit(ref.name, score, identity(aligned_ref, aligned_read), aligned_ref, aligned_read))
        ranked.sort(key=lambda hit: (hit.score, hit.identity), reverse=True)
        hit = ranked[0]
        if hit.identity < min_identity:
            continue
        if len(ranked) > 1 and hit.score - ranked[1].score <= ambiguity_delta:
            ambiguous_by_ref.add(hit.ref_name)
        groups[hit.ref_name].append(hit)

    results = []
    refs_by_name = {ref.name: ref for ref in references}
    for ref in references:
        hits = groups.get(ref.name, [])
        columns = [Counter() for _ in ref.seq]
        for hit in hits:
            pos = -1
            for rbase, qbase in zip(hit.aligned_ref, hit.aligned_read):
                if rbase != "-":
                    pos += 1
                    if qbase in BASES:
                        columns[pos][qbase] += 1
                    elif qbase == "-":
                        columns[pos]["-"] += 1
        consensus_chars = []
        depths = []
        for counts in columns:
            depth = sum(counts[base] for base in BASES)
            depths.append(depth)
            if depth < min_depth:
                consensus_chars.append("N")
                continue
            base, count = max(((base, counts[base]) for base in BASES), key=lambda item: item[1])
            consensus_chars.append(base if count / depth >= min_majority else "N")
        consensus = "".join(consensus_chars)
        distance = edit_distance(consensus, refs_by_name[ref.name].seq)
        results.append(
            ConsensusResult(
                name=ref.name,
                read_count=len(hits),
                mean_depth=sum(depths) / len(depths) if depths else 0.0,
                covered_bases=sum(1 for depth in depths if depth > 0),
                consensus=consensus,
                n_count=consensus.count("N"),
                edit_distance=distance,
                exact_match=consensus == refs_by_name[ref.name].seq,
                ambiguous=ref.name in ambiguous_by_ref,
                best_identity=max((hit.identity for hit in hits), default=0.0),
            )
        )
    return results, groups, time.perf_counter() - start


def run_dbgps(
    analyzer: Path,
    reference: Path,
    reads: Path,
    k: int,
    threads: int,
    read_length: int,
    primer_front: int,
    primer_back: int,
) -> tuple[list[dict], dict, float, str]:
    command = [str(analyzer.resolve()), "-i", "-k", str(k), "-t", str(threads), "-L", str(read_length), str(reads)]
    stdin = f"batch {primer_front} {primer_back} {reference}\nexit\n"
    start = time.perf_counter()
    proc = subprocess.run(command, input=stdin, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    runtime = time.perf_counter() - start
    payloads = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        payloads.append(json.loads(line))
    ready = next((p for p in payloads if p.get("type") == "ready"), {})
    batch = next((p for p in payloads if p.get("type") == "batch"), {})
    if proc.returncode != 0 or not batch:
        raise RuntimeError(f"DBGPS Analyzer failed\nSTDERR:\n{proc.stderr}\nSTDOUT:\n{proc.stdout}")
    return batch.get("rows", []), ready, runtime, proc.stderr


def write_csv(path: Path, rows: Iterable[dict], fieldnames: list[str]) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, default=Path("tests/data/strands.fa"))
    parser.add_argument("--reads", type=Path, default=Path("tests/data/ngs.fa"))
    parser.add_argument("--analyzer", type=Path, default=Path("./DBGPS-analyzer"))
    parser.add_argument("--outdir", type=Path, default=Path("analysis/results"))
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--threads", type=int, default=3)
    parser.add_argument("--read-length", type=int, default=200)
    parser.add_argument("--primer-front", type=int, default=0)
    parser.add_argument("--primer-back", type=int, default=0)
    parser.add_argument("--min-identity", type=float, default=0.75)
    parser.add_argument("--ambiguity-delta", type=int, default=2)
    parser.add_argument("--min-depth", type=int, default=1)
    parser.add_argument("--min-majority", type=float, default=0.6)
    args = parser.parse_args()

    args.outdir.mkdir(parents=True, exist_ok=True)
    references = [trim_record(record, args.primer_front, args.primer_back) for record in parse_sequences(args.reference)]
    reads = [trim_record(record, args.primer_front, args.primer_back) for record in parse_sequences(args.reads)]
    if not references:
        raise SystemExit(f"No reference sequences parsed from {args.reference}")
    if not reads:
        raise SystemExit(f"No reads parsed from {args.reads}")

    consensus, _groups, consensus_runtime = build_consensus(
        references,
        reads,
        args.min_identity,
        args.ambiguity_delta,
        args.min_depth,
        args.min_majority,
    )
    dbgps_rows, ready, dbgps_runtime, dbgps_log = run_dbgps(
        args.analyzer,
        args.reference,
        args.reads,
        args.k,
        args.threads,
        args.read_length,
        args.primer_front,
        args.primer_back,
    )

    consensus_by_name = {row.name: row for row in consensus}
    dbgps_by_name = {row.get("name"): row for row in dbgps_rows}
    joined = []
    for ref in references:
        c = consensus_by_name[ref.name]
        d = dbgps_by_name.get(ref.name, {})
        summary = d.get("summary") or {}
        joined.append(
            {
                "strand": ref.name,
                "consensus_exact": c.exact_match,
                "consensus_edit_distance": c.edit_distance,
                "consensus_N_count": c.n_count,
                "consensus_read_count": c.read_count,
                "consensus_mean_depth": f"{c.mean_depth:.3f}",
                "consensus_ambiguous": c.ambiguous,
                "dbgps_status": d.get("status", "missing"),
                "dbgps_observed": summary.get("observed", ""),
                "dbgps_total_kmers": summary.get("kmerCount", ""),
                "dbgps_path_complete": summary.get("complete", ""),
                "dbgps_min_coverage": summary.get("minCoverage", ""),
                "dbgps_mean_coverage": summary.get("meanCoverage", ""),
                "dbgps_max_coverage": summary.get("maxCoverage", ""),
                "classification": classify(c, summary),
            }
        )

    write_csv(
        args.outdir / "consensus_table.csv",
        [
            {
                "strand": row.name,
                "read_count": row.read_count,
                "mean_depth": f"{row.mean_depth:.3f}",
                "covered_bases": row.covered_bases,
                "N_count": row.n_count,
                "edit_distance": row.edit_distance,
                "exact_match": row.exact_match,
                "ambiguous": row.ambiguous,
                "best_identity": f"{row.best_identity:.3f}",
            }
            for row in consensus
        ],
        ["strand", "read_count", "mean_depth", "covered_bases", "N_count", "edit_distance", "exact_match", "ambiguous", "best_identity"],
    )
    write_csv(
        args.outdir / "dbgps_batch_table.csv",
        [
            {
                "strand": row.get("name"),
                "status": row.get("status"),
                "observed": (row.get("summary") or {}).get("observed", ""),
                "total_kmers": (row.get("summary") or {}).get("kmerCount", ""),
                "path_complete": (row.get("summary") or {}).get("complete", ""),
                "min_coverage": (row.get("summary") or {}).get("minCoverage", ""),
                "mean_coverage": (row.get("summary") or {}).get("meanCoverage", ""),
                "max_coverage": (row.get("summary") or {}).get("maxCoverage", ""),
                "max_adjacent_ratio": (row.get("summary") or {}).get("maxAdjacentRatio", ""),
            }
            for row in dbgps_rows
        ],
        ["strand", "status", "observed", "total_kmers", "path_complete", "min_coverage", "mean_coverage", "max_coverage", "max_adjacent_ratio"],
    )
    write_csv(
        args.outdir / "joined_comparison.csv",
        joined,
        [
            "strand",
            "consensus_exact",
            "consensus_edit_distance",
            "consensus_N_count",
            "consensus_read_count",
            "consensus_mean_depth",
            "consensus_ambiguous",
            "dbgps_status",
            "dbgps_observed",
            "dbgps_total_kmers",
            "dbgps_path_complete",
            "dbgps_min_coverage",
            "dbgps_mean_coverage",
            "dbgps_max_coverage",
            "classification",
        ],
    )
    with (args.outdir / "consensus.fa").open("w") as handle:
        for row in consensus:
            handle.write(f">{row.name}\n{row.consensus}\n")
    with (args.outdir / "dbgps_kernel.log").open("w") as handle:
        handle.write(dbgps_log)

    exact_count = sum(1 for row in consensus if row.exact_match)
    complete_count = sum(1 for row in dbgps_rows if (row.get("summary") or {}).get("complete"))
    report = f"""# Consensus Alignment vs DBGPS Analyzer Comparison

## Inputs

- Reference: `{args.reference}`
- Reads: `{args.reads}`
- k-mer size: `{args.k}`
- Threads: `{args.threads}`
- Primer trim: front `{args.primer_front}`, back `{args.primer_back}`
- Built-in consensus aligner: Needleman-Wunsch global alignment, minimum identity `{args.min_identity}`

## Runtime

| Method | Runtime seconds | Notes |
|:---|---:|:---|
| Alignment + majority consensus | {consensus_runtime:.6f} | Python reference implementation for workflow validation |
| DBGPS Analyzer Batch QC | {dbgps_runtime:.6f} | C backend including kernel startup, read counting, and batch query |

## Summary

| Metric | Value |
|:---|---:|
| Reference strands | {len(references)} |
| Reads | {len(reads)} |
| Consensus exact strands | {exact_count} |
| DBGPS path-complete strands | {complete_count} |
| DBGPS distinct k-mers | {ready.get("distinctKmers", "n/a")} |
| DBGPS total k-mer coverage | {ready.get("totalKmerCoverage", "n/a")} |

## Outputs

- `consensus_table.csv`: per-strand majority-vote consensus metrics
- `dbgps_batch_table.csv`: per-strand DBGPS Batch QC metrics
- `joined_comparison.csv`: side-by-side result comparison and disagreement classification
- `consensus.fa`: reconstructed consensus sequences
- `dbgps_kernel.log`: stderr emitted by the DBGPS kernel

## Interpretation Guide

- `agreement_recovered`: consensus is exact and DBGPS reports a complete path.
- `agreement_missing_or_broken`: consensus is not exact and DBGPS reports an incomplete path.
- `consensus_only`: consensus is exact but DBGPS reports incomplete path; inspect k, primer trimming, and low-coverage k-mers.
- `dbgps_only`: DBGPS path is complete but consensus is not exact; inspect alignment ambiguity, indels, and majority-vote thresholds.
"""
    (args.outdir / "report.md").write_text(report)
    print(f"Wrote analysis results to {args.outdir}")
    return 0


def classify(consensus: ConsensusResult, dbgps_summary: dict) -> str:
    complete = bool(dbgps_summary.get("complete"))
    if consensus.exact_match and complete:
        return "agreement_recovered"
    if not consensus.exact_match and not complete:
        return "agreement_missing_or_broken"
    if consensus.exact_match and not complete:
        return "consensus_only"
    return "dbgps_only"


if __name__ == "__main__":
    raise SystemExit(main())
