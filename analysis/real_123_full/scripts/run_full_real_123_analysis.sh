#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

REF_TAB="/Users/song/Documents/123/6.5MB.DNAs.newids.tab"
READS="/Users/song/Documents/123/YC10_5_1_BDDP210000410-1A_1.fq.gz"
OUT="analysis/real_123_full"
THREADS="${THREADS:-16}"
K="${K:-31}"
FRONT="${FRONT:-18}"
BACK="${BACK:-18}"

mkdir -p "$OUT"/{inputs,alignment,dbgps,summary}

awk -F '\t' 'NR>1 && NF>=2 {gsub(/[^ACGTNacgtn]/, "", $2); if (length($2)>0) {print ">"$1"\n"toupper($2)}}' \
  "$REF_TAB" > "$OUT/inputs/reference.fa"

/usr/bin/time -lp sh -c "gzip -cd '$READS' | awk 'END{print NR/4}' > '$OUT/inputs/read_count.txt'" \
  2> "$OUT/inputs/read_count_time.log"

minimap2 -x sr -t "$THREADS" -c --cs=short \
  "$OUT/inputs/reference.fa" \
  "$READS" \
  > "$OUT/alignment/minimap2_full.paf" \
  2> "$OUT/alignment/minimap2_full.log"

/usr/bin/time -lp sh -c "printf 'batch $FRONT $BACK $OUT/inputs/reference.fa\nexit\n' | ./DBGPS-analyzer -i -k $K -t $THREADS -L 200 '$READS' > '$OUT/dbgps/dbgps_batch_full.jsonl' 2> '$OUT/dbgps/dbgps_kernel_full.log'" \
  2> "$OUT/dbgps/dbgps_time_full.log"

python3 "$OUT/scripts/parse_minimap2_vs_dbgps.py" \
  --reference "$OUT/inputs/reference.fa" \
  --paf "$OUT/alignment/minimap2_full.paf" \
  --dbgps-jsonl "$OUT/dbgps/dbgps_batch_full.jsonl" \
  --minimap2-log "$OUT/alignment/minimap2_full.log" \
  --dbgps-log "$OUT/dbgps/dbgps_time_full.log" \
  --outdir "$OUT/summary" \
  --primer-front "$FRONT" \
  --primer-back "$BACK" \
  --min-identity 0.75 \
  --min-mapq 20
