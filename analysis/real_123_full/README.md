# Full YC10 Analysis: Original FASTQ

This folder contains the full-data comparison requested for:

- Reference: `/Users/song/Documents/123/6.5MB.DNAs.newids.tab`
- NGS reads: `/Users/song/Documents/123/YC10_5_1_BDDP210000410-1A_1.fq.gz`

No read subsampling was performed. The original FASTQ contains
**39,612,583 reads**. All generated analysis data are retained locally under
`analysis/real_123_full/`; large intermediates are ignored by git but were not
deleted.

## Method

Reference sequences were regenerated from the tab-delimited file using column 1
as the strand identifier and column 2 as the DNA sequence. The reference contains
**210,000 strands**, all **200 bp**.

Two methods were compared on the full original read file:

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
| Original reads | 39,612,583 |
| Alignment consensus exact strands | 209,159 |
| DBGPS path-complete strands | 209,357 |
| Agreement recovered | 209,072 |
| Agreement missing or broken | 556 |
| Consensus-only recovered | 87 |
| DBGPS-only recovered | 285 |

Runtime on this machine:

| Method | Real seconds | Peak RSS |
|:---|---:|---:|
| minimap2 alignment | 69.82 | 1.349 GB |
| majority-vote PAF parsing | 321.188 | ~5.79 GB measured by `/usr/bin/time` |
| alignment + majority-vote total | 391.008 | >=1.349 GB |
| DBGPS Analyzer Batch QC | 32.51 | 10.706 GB |

## Outputs

Small tracked outputs:

- `summary/real_data_report.md`
- `summary/summary_stats.csv`
- `summary/disagreements.top200.csv`

Large local outputs ignored by git but retained on disk:

- `inputs/reference.fa`
- `inputs/read_count.txt`
- `alignment/minimap2_full.paf` (~7.1 GB)
- `alignment/minimap2_full.log`
- `dbgps/dbgps_batch_full.jsonl` (~57 MB)
- `dbgps/dbgps_time_full.log`
- `summary/alignment_consensus.full.csv` (~40 MB)
- `summary/joined_comparison.full.csv` (~16 MB)

## Reproduction

From the repository root:

```bash
make DBGPS-analyzer
bash analysis/real_123_full/scripts/run_full_real_123_analysis.sh
```

The script expects the original files to remain available in
`/Users/song/Documents/123`.
