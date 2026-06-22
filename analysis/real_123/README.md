# Real Data Analysis: YC10 10% Subsample

This folder contains the real-data comparison requested for:

- Reference: `/Users/song/Documents/123/6.5MB.DNAs.newids.tab`
- NGS reads: `/Users/song/Documents/123/YC10_5_1_BDDP210000410-1A_1.fq.gz`

The FASTQ input was deterministically subsampled by keeping one read from every
10 FASTQ records. The sampled file contains **3,961,259 reads** and is stored
locally under `analysis/real_123/inputs/` but is ignored by git because it is
large.

## Method

Reference sequences were regenerated from the tab-delimited file using column 1
as the strand identifier and column 2 as the DNA sequence. The reference contains
**210,000 strands**, all **200 bp**.

Two methods were compared on the same 10% read subset:

1. **Fast alignment + majority consensus**
   - Aligner: `minimap2 2.31-r1302`
   - Command shape: `minimap2 -x sr -t 16 -c --cs=short`
   - Consensus: reference-guided majority vote from the PAF `cs` tag
   - Evaluation region: 18 bp front primer and 18 bp back primer removed

2. **DBGPS Analyzer Batch QC**
   - Command: interactive kernel plus `batch 18 18 reference.fa`
   - k-mer size: `31`
   - Threads: `16`
   - Evaluation region: same 18/18 primer-trimmed region

## Key Results

| Metric | Value |
|:---|---:|
| Reference strands | 210,000 |
| Sampled reads | 3,961,259 |
| Alignment consensus exact strands | 198,792 |
| DBGPS path-complete strands | 201,029 |
| Agreement recovered | 197,108 |
| Agreement missing or broken | 7,287 |
| Consensus-only recovered | 1,684 |
| DBGPS-only recovered | 3,921 |

Runtime on this machine:

| Method | Real seconds | Peak RSS |
|:---|---:|---:|
| minimap2 alignment | 7.60 | 1.053 GB |
| majority-vote PAF parsing | 72.87 wall / 69.675 internal | 1.371 GB measured by `/usr/bin/time -lp` |
| alignment + majority-vote total | 77.275 | >=1.371 GB |
| DBGPS Analyzer Batch QC | 4.74 | 3.555 GB |

## Outputs

Small tracked outputs:

- `summary/real_data_report.md`
- `summary/summary_stats.csv`
- `summary/disagreements.top200.csv`

Large local outputs ignored by git:

- `inputs/reference.fa`
- `inputs/YC10_5_1_10pct.fq.gz`
- `alignment/minimap2_10pct.paf`
- `dbgps/dbgps_batch_10pct.jsonl`
- `summary/alignment_consensus.full.csv`
- `summary/joined_comparison.full.csv`

## Reproduction

From the repository root:

```bash
make DBGPS-analyzer
bash analysis/real_123/scripts/run_real_123_analysis.sh
```

The script expects the original files to remain available in
`/Users/song/Documents/123`.
