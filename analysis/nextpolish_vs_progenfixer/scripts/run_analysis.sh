#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/song/Github-Repos/DBGPS-analyzer/analysis/nextpolish_vs_progenfixer"
DATA="/Users/song/Github-Repos/ProGenFixer/.local_data/simu_ngs"
PROGENFIXER="/Users/song/Github-Repos/ProGenFixer/ProGenFixer"

mkdir -p "$ROOT/outputs/nextpolish" "$ROOT/outputs/progenfixer"

/usr/bin/time -l \
  nextPolish -l "$ROOT/outputs/nextpolish/nextpolish.log" \
  "$ROOT/run_nextpolish.cfg" \
  > "$ROOT/outputs/nextpolish/run.stdout_stderr.log" 2>&1

/usr/bin/time -l \
  "$PROGENFIXER" \
  "$DATA/Ref.fasta" \
  "$DATA/Ref.fasta.dwgsim.bwa.read1.fastq.gz" \
  "$DATA/Ref.fasta.dwgsim.bwa.read2.fastq.gz" \
  -o "$ROOT/outputs/progenfixer/progenfixer" \
  -t 3 -n 3 --fix \
  > "$ROOT/outputs/progenfixer/run.stdout.log" \
  2> "$ROOT/outputs/progenfixer/run.stderr.log"

python3 "$ROOT/scripts/compare_results.py" \
  --reference "$DATA/Ref.fasta" \
  --nextpolish "$ROOT/outputs/nextpolish/work/genome.nextpolish.fasta" \
  --progenfixer "$ROOT/outputs/progenfixer/progenfixer.iter2.fasta" \
  --progenfixer-prefix "$ROOT/outputs/progenfixer/progenfixer" \
  --out-dir "$ROOT"
