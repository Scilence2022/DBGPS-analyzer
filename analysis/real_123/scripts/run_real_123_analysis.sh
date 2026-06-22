#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

REF_TAB="/Users/song/Documents/123/6.5MB.DNAs.newids.tab"
READS="/Users/song/Documents/123/YC10_5_1_BDDP210000410-1A_1.fq.gz"
OUT="analysis/real_123"
THREADS="${THREADS:-16}"
K="${K:-31}"
FRONT="${FRONT:-18}"
BACK="${BACK:-18}"

mkdir -p "$OUT"/{inputs,alignment,dbgps,summary}

awk -F '\t' 'NR>1 && NF>=2 {gsub(/[^ACGTNacgtn]/, "", $2); if (length($2)>0) {print ">"$1"\n"toupper($2)}}' \
  "$REF_TAB" > "$OUT/inputs/reference.fa"

/usr/bin/time -lp sh -c "gzip -cd '$READS' | awk 'BEGIN{rec=0} NR%4==1{keep=(rec%10==0); rec++} keep{print}' | gzip -c > '$OUT/inputs/YC10_5_1_10pct.fq.gz'" \
  2> "$OUT/inputs/subsample_time.log"

minimap2 -x sr -t "$THREADS" -c --cs=short \
  "$OUT/inputs/reference.fa" \
  "$OUT/inputs/YC10_5_1_10pct.fq.gz" \
  > "$OUT/alignment/minimap2_10pct.paf" \
  2> "$OUT/alignment/minimap2_10pct.log"

/usr/bin/time -lp sh -c "printf 'batch $FRONT $BACK $OUT/inputs/reference.fa\nexit\n' | ./DBGPS-analyzer -i -k $K -t $THREADS -L 200 '$OUT/inputs/YC10_5_1_10pct.fq.gz' > '$OUT/dbgps/dbgps_batch_10pct.jsonl' 2> '$OUT/dbgps/dbgps_kernel_10pct.log'" \
  2> "$OUT/dbgps/dbgps_time_10pct.log"

/usr/bin/time -lp python3 "$OUT/scripts/parse_minimap2_vs_dbgps.py" \
  --reference "$OUT/inputs/reference.fa" \
  --paf "$OUT/alignment/minimap2_10pct.paf" \
  --dbgps-jsonl "$OUT/dbgps/dbgps_batch_10pct.jsonl" \
  --minimap2-log "$OUT/alignment/minimap2_10pct.log" \
  --dbgps-log "$OUT/dbgps/dbgps_time_10pct.log" \
  --outdir "$OUT/summary" \
  --primer-front "$FRONT" \
  --primer-back "$BACK" \
  --min-identity 0.75 \
  --min-mapq 20 \
  2> "$OUT/summary/parser_time_10pct.log"

python3 analysis/record_parser_memory.py \
  --parser-log "$OUT/summary/parser_time_10pct.log" \
  --summary-csv "$OUT/summary/summary_stats.csv" \
  --report "$OUT/summary/real_data_report.md"
