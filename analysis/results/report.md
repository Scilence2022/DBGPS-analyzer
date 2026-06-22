# Consensus Alignment vs DBGPS Analyzer Comparison

## Inputs

- Reference: `tests/data/strands.fa`
- Reads: `tests/data/ngs.fa`
- k-mer size: `5`
- Threads: `3`
- Primer trim: front `0`, back `0`
- Built-in consensus aligner: Needleman-Wunsch global alignment, minimum identity `0.75`

## Runtime

| Method | Runtime seconds | Notes |
|:---|---:|:---|
| Alignment + majority consensus | 0.000602 | Python reference implementation for workflow validation |
| DBGPS Analyzer Batch QC | 0.005957 | C backend including kernel startup, read counting, and batch query |

## Summary

| Metric | Value |
|:---|---:|
| Reference strands | 2 |
| Reads | 3 |
| Consensus exact strands | 1 |
| DBGPS path-complete strands | 1 |
| DBGPS distinct k-mers | 15 |
| DBGPS total k-mer coverage | 36 |

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
