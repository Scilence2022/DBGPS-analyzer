#!/usr/bin/env python3
"""Summarize real-data minimap2 consensus vs DBGPS Analyzer Batch QC."""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
from array import array
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path


BASES = "ACGT"
CS_RE = re.compile(r"(:\d+)|(\*[a-z][a-z])|([+-][a-z]+)|(~[a-z]{2}\d+[a-z]{2})")


@dataclass
class RefRecord:
    name: str
    seq: str


@dataclass
class ConsensusState:
    depth_diff: array
    read_count: int = 0
    alt_counts: dict[int, Counter[str]] = field(default_factory=dict)


def parse_fasta(path: Path) -> list[RefRecord]:
    records = []
    name = ""
    chunks = []
    with path.open() as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            if line.startswith(">"):
                if name:
                    records.append(RefRecord(name, "".join(chunks).upper()))
                name = line[1:].split()[0]
                chunks = []
            else:
                chunks.append(line)
    if name:
        records.append(RefRecord(name, "".join(chunks).upper()))
    return records


def add_depth(state: ConsensusState, start: int, end: int, eval_start: int, eval_end: int) -> None:
    a = max(start, eval_start)
    b = min(end, eval_end)
    if a >= b:
        return
    state.depth_diff[a - eval_start] += 1
    state.depth_diff[b - eval_start] -= 1


def parse_cs_into_state(cs: str, state: ConsensusState, target_start: int, eval_start: int, eval_end: int) -> None:
    tpos = target_start
    for match in CS_RE.finditer(cs):
        token = match.group(0)
        op = token[0]
        if op == ":":
            length = int(token[1:])
            add_depth(state, tpos, tpos + length, eval_start, eval_end)
            tpos += length
        elif op == "*":
            ref_base = token[1].upper()
            query_base = token[2].upper()
            del ref_base
            if eval_start <= tpos < eval_end and query_base in BASES:
                add_depth(state, tpos, tpos + 1, eval_start, eval_end)
                rel = tpos - eval_start
                if rel not in state.alt_counts:
                    state.alt_counts[rel] = Counter()
                state.alt_counts[rel][query_base] += 1
            tpos += 1
        elif op == "-":
            tpos += len(token) - 1
        elif op == "+":
            continue
        elif op == "~":
            intron_len = int(token[3:-2])
            tpos += intron_len


def consensus_from_paf(
    paf: Path,
    refs: list[RefRecord],
    primer_front: int,
    primer_back: int,
    min_identity: float,
    min_mapq: int,
    min_depth: int,
    min_majority: float,
) -> tuple[list[dict], dict[str, float]]:
    start = time.perf_counter()
    ref_by_name = {record.name: record for record in refs}
    eval_len = len(refs[0].seq) - primer_front - primer_back
    eval_start = primer_front
    eval_end = primer_front + eval_len
    states: dict[str, ConsensusState] = {}
    total_alignments = 0
    primary_alignments = 0
    used_alignments = 0
    secondary_alignments = 0
    low_quality_alignments = 0

    with paf.open() as handle:
        for raw in handle:
            total_alignments += 1
            fields = raw.rstrip("\n").split("\t")
            if len(fields) < 12:
                continue
            tags = {field[:5]: field[5:] for field in fields[12:] if len(field) >= 6 and field[2] == ":"}
            if tags.get("tp:A:") != "P":
                secondary_alignments += 1
                continue
            primary_alignments += 1
            matches = int(fields[9])
            block_len = int(fields[10])
            mapq = int(fields[11])
            ident = matches / block_len if block_len else 0.0
            cs = tags.get("cs:Z:")
            if mapq < min_mapq or ident < min_identity or not cs:
                low_quality_alignments += 1
                continue
            target = fields[5]
            target_start = int(fields[7])
            if target not in ref_by_name:
                continue
            state = states.get(target)
            if state is None:
                state = ConsensusState(array("i", [0]) * (eval_len + 1))
                states[target] = state
            state.read_count += 1
            used_alignments += 1
            parse_cs_into_state(cs, state, target_start, eval_start, eval_end)

    rows = []
    exact_count = 0
    for record in refs:
        trimmed = record.seq[eval_start:eval_end]
        state = states.get(record.name)
        if state is None:
            rows.append({
                "strand": record.name,
                "read_count": 0,
                "mean_depth": "0.000",
                "covered_bases": 0,
                "N_count": eval_len,
                "edit_distance": eval_len,
                "exact_match": False,
                "consensus": "N" * eval_len,
            })
            continue
        depth = 0
        depth_sum = 0
        covered = 0
        consensus = []
        for i, ref_base in enumerate(trimmed):
            depth += state.depth_diff[i]
            depth_sum += depth
            if depth > 0:
                covered += 1
            if depth < min_depth:
                consensus.append("N")
                continue
            alts = state.alt_counts.get(i, Counter())
            alt_total = sum(alts.values())
            counts = {base: 0 for base in BASES}
            counts[ref_base] = max(0, depth - alt_total)
            for base, count in alts.items():
                counts[base] += count
            base, count = max(counts.items(), key=lambda item: item[1])
            consensus.append(base if count / depth >= min_majority else "N")
        consensus_seq = "".join(consensus)
        edit_distance = sum(a != b for a, b in zip(consensus_seq, trimmed))
        exact = consensus_seq == trimmed
        exact_count += int(exact)
        rows.append({
            "strand": record.name,
            "read_count": state.read_count,
            "mean_depth": f"{depth_sum / eval_len:.3f}",
            "covered_bases": covered,
            "N_count": consensus_seq.count("N"),
            "edit_distance": edit_distance,
            "exact_match": exact,
            "consensus": consensus_seq,
        })
    metrics = {
        "runtime_seconds": time.perf_counter() - start,
        "total_alignments": total_alignments,
        "primary_alignments": primary_alignments,
        "secondary_alignments": secondary_alignments,
        "used_alignments": used_alignments,
        "low_quality_primary_alignments": low_quality_alignments,
        "consensus_exact": exact_count,
    }
    return rows, metrics


def load_dbgps(jsonl: Path) -> tuple[list[dict], dict]:
    ready = {}
    batch = {}
    with jsonl.open() as handle:
        for raw in handle:
            if not raw.startswith("{"):
                continue
            payload = json.loads(raw)
            if payload.get("type") == "ready":
                ready = payload
            elif payload.get("type") == "batch":
                batch = payload
    return batch["rows"], ready


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def bool_value(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).lower() == "true"


def classify(consensus_exact: bool, dbgps_complete: bool) -> str:
    if consensus_exact and dbgps_complete:
        return "agreement_recovered"
    if not consensus_exact and not dbgps_complete:
        return "agreement_missing_or_broken"
    if consensus_exact and not dbgps_complete:
        return "consensus_only"
    return "dbgps_only"


def parse_time_log(path: Path) -> dict[str, float]:
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(errors="replace").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in {"real", "user", "sys"}:
            values[parts[0]] = float(parts[1])
        elif len(parts) >= 2 and parts[1] in {"real", "user", "sys"}:
            values[parts[1]] = float(parts[0])
        elif len(parts) >= 2 and "maximum resident set size" in line:
            values["max_rss_bytes"] = float(parts[0])
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--paf", type=Path, required=True)
    parser.add_argument("--dbgps-jsonl", type=Path, required=True)
    parser.add_argument("--minimap2-log", type=Path, required=True)
    parser.add_argument("--dbgps-log", type=Path, required=True)
    parser.add_argument("--outdir", type=Path, required=True)
    parser.add_argument("--primer-front", type=int, default=18)
    parser.add_argument("--primer-back", type=int, default=18)
    parser.add_argument("--min-identity", type=float, default=0.75)
    parser.add_argument("--min-mapq", type=int, default=20)
    parser.add_argument("--min-depth", type=int, default=1)
    parser.add_argument("--min-majority", type=float, default=0.6)
    args = parser.parse_args()

    args.outdir.mkdir(parents=True, exist_ok=True)
    refs = parse_fasta(args.reference)
    consensus_rows, consensus_metrics = consensus_from_paf(
        args.paf,
        refs,
        args.primer_front,
        args.primer_back,
        args.min_identity,
        args.min_mapq,
        args.min_depth,
        args.min_majority,
    )
    dbgps_rows, ready = load_dbgps(args.dbgps_jsonl)

    dbgps_by_name = {row["name"]: row for row in dbgps_rows}
    joined = []
    classes = Counter()
    for c in consensus_rows:
        d = dbgps_by_name.get(c["strand"], {})
        s = d.get("summary") or {}
        d_complete = bool_value(s.get("complete", False))
        c_exact = bool_value(c["exact_match"])
        cls = classify(c_exact, d_complete)
        classes[cls] += 1
        joined.append({
            "strand": c["strand"],
            "consensus_exact": c_exact,
            "consensus_edit_distance": c["edit_distance"],
            "consensus_N_count": c["N_count"],
            "consensus_read_count": c["read_count"],
            "consensus_mean_depth": c["mean_depth"],
            "dbgps_status": d.get("status", "missing"),
            "dbgps_observed": s.get("observed", ""),
            "dbgps_total_kmers": s.get("kmerCount", ""),
            "dbgps_path_complete": d_complete,
            "dbgps_min_coverage": s.get("minCoverage", ""),
            "dbgps_mean_coverage": s.get("meanCoverage", ""),
            "dbgps_max_coverage": s.get("maxCoverage", ""),
            "classification": cls,
        })

    write_csv(args.outdir / "alignment_consensus.full.csv", consensus_rows, [
        "strand", "read_count", "mean_depth", "covered_bases", "N_count",
        "edit_distance", "exact_match", "consensus"
    ])
    write_csv(args.outdir / "joined_comparison.full.csv", joined, [
        "strand", "consensus_exact", "consensus_edit_distance", "consensus_N_count",
        "consensus_read_count", "consensus_mean_depth", "dbgps_status",
        "dbgps_observed", "dbgps_total_kmers", "dbgps_path_complete",
        "dbgps_min_coverage", "dbgps_mean_coverage", "dbgps_max_coverage",
        "classification"
    ])
    disagreement = [row for row in joined if row["classification"] in {"consensus_only", "dbgps_only"}]
    write_csv(args.outdir / "disagreements.top200.csv", disagreement[:200], [
        "strand", "consensus_exact", "consensus_edit_distance", "consensus_N_count",
        "consensus_read_count", "consensus_mean_depth", "dbgps_status",
        "dbgps_observed", "dbgps_total_kmers", "dbgps_path_complete",
        "dbgps_min_coverage", "dbgps_mean_coverage", "dbgps_max_coverage",
        "classification"
    ])

    minimap_time = parse_time_log(args.minimap2_log)
    dbgps_time = parse_time_log(args.dbgps_log)
    alignment_total = float(minimap_time.get("real", 0) or 0) + consensus_metrics["runtime_seconds"]
    total = len(joined)
    complete = sum(1 for row in joined if row["dbgps_path_complete"])
    exact = sum(1 for row in joined if row["consensus_exact"])
    summary_rows = [
        {"metric": "reference_strands", "value": total},
        {"metric": "consensus_exact", "value": exact},
        {"metric": "dbgps_path_complete", "value": complete},
        {"metric": "agreement_recovered", "value": classes["agreement_recovered"]},
        {"metric": "agreement_missing_or_broken", "value": classes["agreement_missing_or_broken"]},
        {"metric": "consensus_only", "value": classes["consensus_only"]},
        {"metric": "dbgps_only", "value": classes["dbgps_only"]},
        {"metric": "minimap2_real_seconds", "value": minimap_time.get("real", "")},
        {"metric": "minimap2_peak_rss_gb", "value": round(minimap_time.get("max_rss_bytes", 0) / 1024**3, 3)},
        {"metric": "consensus_parse_seconds", "value": round(consensus_metrics["runtime_seconds"], 3)},
        {"metric": "alignment_consensus_total_seconds", "value": round(alignment_total, 3)},
        {"metric": "dbgps_real_seconds", "value": dbgps_time.get("real", "")},
        {"metric": "dbgps_peak_rss_gb", "value": round(dbgps_time.get("max_rss_bytes", 0) / 1024**3, 3)},
        {"metric": "dbgps_distinct_kmers", "value": ready.get("distinctKmers", "")},
        {"metric": "dbgps_total_kmer_coverage", "value": ready.get("totalKmerCoverage", "")},
        {"metric": "paf_total_alignments", "value": consensus_metrics["total_alignments"]},
        {"metric": "paf_primary_alignments", "value": consensus_metrics["primary_alignments"]},
        {"metric": "paf_used_alignments", "value": consensus_metrics["used_alignments"]},
    ]
    write_csv(args.outdir / "summary_stats.csv", summary_rows, ["metric", "value"])
    report = [
        "# Real YC10 10% Subsample: Alignment Consensus vs DBGPS Analyzer",
        "",
        "## Dataset",
        "",
        f"- Reference strands: {total:,}",
        "- Reference source: `/Users/song/Documents/123/6.5MB.DNAs.newids.tab`",
        "- NGS source: `/Users/song/Documents/123/YC10_5_1_BDDP210000410-1A_1.fq.gz`",
        "- Subsampling: deterministic 1 read kept from every 10 FASTQ records",
        f"- Primer-trimmed evaluation region: {args.primer_front} bp front, {args.primer_back} bp back",
        "",
        "## Runtime",
        "",
        "| Method | Real seconds | Peak RSS (GB) | Notes |",
        "|:---|---:|---:|:---|",
        f"| minimap2 alignment | {minimap_time.get('real', '')} | {round(minimap_time.get('max_rss_bytes', 0) / 1024**3, 3)} | `-x sr -c --cs=short`, 16 threads |",
        f"| majority-vote PAF parsing | {consensus_metrics['runtime_seconds']:.3f} | n/a | Python reference-guided consensus over trimmed region |",
        f"| alignment + majority-vote total | {alignment_total:.3f} | >= {round(minimap_time.get('max_rss_bytes', 0) / 1024**3, 3)} | minimap2 plus parser runtime |",
        f"| DBGPS Analyzer Batch QC | {dbgps_time.get('real', '')} | {round(dbgps_time.get('max_rss_bytes', 0) / 1024**3, 3)} | k=31, 16 threads, includes counting + batch query |",
        "",
        "## Strand-Level Results",
        "",
        "| Class | Count | Fraction |",
        "|:---|---:|---:|",
    ]
    for key in ["agreement_recovered", "agreement_missing_or_broken", "consensus_only", "dbgps_only"]:
        count = classes[key]
        report.append(f"| {key} | {count:,} | {count / total:.4%} |")
    report.extend([
        "",
        "## Key Metrics",
        "",
        f"- Alignment consensus exact strands: {exact:,} / {total:,} ({exact / total:.4%})",
        f"- DBGPS path-complete strands: {complete:,} / {total:,} ({complete / total:.4%})",
        f"- DBGPS distinct k-mers: {ready.get('distinctKmers', 'n/a'):,}",
        f"- DBGPS total k-mer coverage: {ready.get('totalKmerCoverage', 'n/a'):,}",
        f"- PAF alignments: {consensus_metrics['total_alignments']:,} total, {consensus_metrics['primary_alignments']:,} primary, {consensus_metrics['used_alignments']:,} used after filters",
        "",
        "## Output Files",
        "",
        "- `summary_stats.csv`: compact metrics and runtimes",
        "- `joined_comparison.full.csv`: full per-strand comparison table",
        "- `alignment_consensus.full.csv`: full per-strand consensus table",
        "- `disagreements.top200.csv`: first 200 strands where the methods disagree",
        "",
        "## Interpretation",
        "",
        "DBGPS Analyzer measures k-mer path completeness and coverage in the primer-trimmed reference region. The alignment workflow reconstructs a reference-guided majority consensus over the same region using minimap2 primary alignments. `consensus_only` cases indicate strands where majority voting reconstructs the trimmed reference even though one or more DBGPS k-mers are missing. `dbgps_only` cases indicate complete k-mer paths where the majority consensus still contains mismatches or unresolved positions.",
        "",
    ])
    (args.outdir / "real_data_report.md").write_text("\n".join(report))
    print(f"Wrote summaries to {args.outdir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
