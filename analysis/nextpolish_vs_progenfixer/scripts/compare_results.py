#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


def read_fasta(path):
    records = []
    name = None
    chunks = []
    with open(path, "rt", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            if line.startswith(">"):
                if name is not None:
                    records.append((name, "".join(chunks).upper()))
                name = line[1:].split()[0]
                chunks = []
            else:
                chunks.append(line)
    if name is not None:
        records.append((name, "".join(chunks).upper()))
    return records


def digest(seq):
    return hashlib.sha256(seq.encode("ascii")).hexdigest()


def cigar_stats(reference_path, query_path):
    paf = subprocess.check_output(
        ["minimap2", "-cx", "asm5", "--eqx", reference_path, query_path],
        text=True,
        stderr=subprocess.DEVNULL,
    )
    best = None
    for line in paf.splitlines():
        fields = line.split("\t")
        if len(fields) < 12:
            continue
        tags = {tag[:2]: tag[5:] for tag in fields[12:] if len(tag) > 5 and tag[2:5] in {":Z:", ":i:"}}
        if "cg" not in tags:
            continue
        score = int(fields[3]) - int(fields[2])
        if best is None or score > best[0]:
            best = (score, fields, tags["cg"])
    if best is None:
        raise RuntimeError(f"minimap2 did not produce a CIGAR alignment for {query_path}")

    _, fields, cigar = best
    matches = substitutions = deletions = insertions = 0
    variant_blocks = 0
    for length, op in re.findall(r"(\d+)([=XID])", cigar):
        n = int(length)
        if op == "=":
            matches += n
        elif op == "X":
            substitutions += n
            variant_blocks += 1
        elif op == "I":
            insertions += n
            variant_blocks += 1
        elif op == "D":
            deletions += n
            variant_blocks += 1

    query_len = int(fields[1])
    query_aligned = int(fields[3]) - int(fields[2])
    target_len = int(fields[6])
    target_aligned = int(fields[8]) - int(fields[7])
    unaligned_query = query_len - query_aligned
    unaligned_target = target_len - target_aligned
    edit_distance = substitutions + insertions + deletions + unaligned_query + unaligned_target
    return {
        "matches": matches,
        "substitutions": substitutions,
        "deletions": deletions + unaligned_target,
        "insertions": insertions + unaligned_query,
        "edit_distance": edit_distance,
        "variant_blocks": variant_blocks + int(bool(unaligned_query)) + int(bool(unaligned_target)),
    }


def fasta_summary(label, path, reference_path, reference_seq):
    records = read_fasta(path)
    seq = "".join(seq for _, seq in records)
    stats = cigar_stats(reference_path, path)
    return {
        "tool": label,
        "path": os.path.abspath(path),
        "contigs": len(records),
        "length_bp": len(seq),
        "length_delta_bp": len(seq) - len(reference_seq),
        "sha256": digest(seq),
        **stats,
    }


def parse_vcf(path):
    counts = {"records": 0, "SUB": 0, "INS": 0, "DEL": 0, "OTHER": 0}
    if not os.path.exists(path):
        return counts
    with open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if not line or line.startswith("#"):
                continue
            counts["records"] += 1
            fields = line.rstrip("\n").split("\t")
            info = fields[7] if len(fields) > 7 else ""
            match = re.search(r"(?:^|;)VARTYPE=([^;]+)", info)
            variant_type = match.group(1) if match else "OTHER"
            counts[variant_type if variant_type in counts else "OTHER"] += 1
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", required=True)
    parser.add_argument("--nextpolish", required=True)
    parser.add_argument("--progenfixer", required=True)
    parser.add_argument("--progenfixer-prefix", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    reference_records = read_fasta(args.reference)
    reference_seq = "".join(seq for _, seq in reference_records)
    summaries = [
        fasta_summary("NextPolish", args.nextpolish, args.reference, reference_seq),
        fasta_summary("ProGenFixer", args.progenfixer, args.reference, reference_seq),
    ]
    nextpolish_records = read_fasta(args.nextpolish)
    nextpolish_seq = "".join(seq for _, seq in nextpolish_records)
    pairwise = fasta_summary("ProGenFixer_vs_NextPolish", args.progenfixer, args.nextpolish, nextpolish_seq)

    vcf_rows = []
    for i in range(1, 4):
        path = f"{args.progenfixer_prefix}.iter{i}.vcf"
        row = {"iteration": i, "path": os.path.abspath(path), **parse_vcf(path)}
        vcf_rows.append(row)

    with open(out_dir / "summary.tsv", "wt", encoding="utf-8", newline="") as handle:
        fieldnames = [
            "tool",
            "contigs",
            "length_bp",
            "length_delta_bp",
            "edit_distance",
            "substitutions",
            "insertions",
            "deletions",
            "variant_blocks",
            "sha256",
            "path",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames, delimiter="\t")
        writer.writeheader()
        for row in summaries:
            writer.writerow({key: row[key] for key in fieldnames})

    with open(out_dir / "progenfixer_vcf_summary.tsv", "wt", encoding="utf-8", newline="") as handle:
        fieldnames = ["iteration", "records", "SUB", "INS", "DEL", "OTHER", "path"]
        writer = csv.DictWriter(handle, fieldnames=fieldnames, delimiter="\t")
        writer.writeheader()
        for row in vcf_rows:
            writer.writerow({key: row[key] for key in fieldnames})

    with open(out_dir / "pairwise_summary.tsv", "wt", encoding="utf-8", newline="") as handle:
        fieldnames = [
            "tool",
            "contigs",
            "length_bp",
            "length_delta_bp",
            "edit_distance",
            "substitutions",
            "insertions",
            "deletions",
            "variant_blocks",
            "sha256",
            "path",
        ]
        writer = csv.DictWriter(handle, fieldnames=fieldnames, delimiter="\t")
        writer.writeheader()
        writer.writerow({key: pairwise[key] for key in fieldnames})

    with open(out_dir / "summary.json", "wt", encoding="utf-8") as handle:
        json.dump({"fasta": summaries, "pairwise": pairwise, "progenfixer_vcf": vcf_rows}, handle, indent=2)


if __name__ == "__main__":
    main()
