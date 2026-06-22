#!/usr/bin/env python3
"""Insert parser wall-time/RSS measurements into analysis CSV and Markdown reports."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


def parse_time_log(path: Path) -> dict[str, float]:
    values: dict[str, float] = {}
    for line in path.read_text(errors="replace").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in {"real", "user", "sys"}:
            values[parts[0]] = float(parts[1])
        elif len(parts) >= 2 and parts[1] in {"real", "user", "sys"}:
            values[parts[1]] = float(parts[0])
        elif "maximum resident set size" in line:
            values["peak_rss_gb"] = round(float(parts[0]) / (1024 ** 3), 3)
    return values


def upsert_metric(rows: list[dict[str, str]], metric: str, value: object) -> None:
    text = str(value)
    for row in rows:
        if row["metric"] == metric:
            row["value"] = text
            return
    insert_at = len(rows)
    for index, row in enumerate(rows):
        if row["metric"] == "consensus_parse_seconds":
            insert_at = index + 1
            break
    rows.insert(insert_at, {"metric": metric, "value": text})


def update_summary_csv(path: Path, values: dict[str, float]) -> None:
    rows = list(csv.DictReader(path.open()))
    upsert_metric(rows, "consensus_parse_wall_seconds", values.get("real", ""))
    upsert_metric(rows, "consensus_parse_peak_rss_gb", values.get("peak_rss_gb", ""))
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["metric", "value"])
        writer.writeheader()
        writer.writerows(rows)


def update_report(path: Path, values: dict[str, float]) -> None:
    lines = path.read_text().splitlines()
    out = []
    for line in lines:
        if line.startswith("| majority-vote PAF parsing |"):
            parts = [part.strip() for part in line.strip().strip("|").split("|")]
            if len(parts) >= 4:
                parts[2] = str(values.get("peak_rss_gb", ""))
                note = parts[3].split("; `/usr/bin/time -lp`", 1)[0]
                parts[3] = f"{note}; `/usr/bin/time -lp` wall time {values.get('real', '')} s"
                line = "| " + " | ".join(parts) + " |"
        out.append(line)
    path.write_text("\n".join(out) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parser-log", type=Path, required=True)
    parser.add_argument("--summary-csv", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    values = parse_time_log(args.parser_log)
    update_summary_csv(args.summary_csv, values)
    update_report(args.report, values)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
