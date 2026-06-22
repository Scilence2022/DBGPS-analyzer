# Real YC10 Full FASTQ: Alignment Consensus vs DBGPS Analyzer

## Dataset

- Reference strands: 210,000
- Reference source: `/Users/song/Documents/123/6.5MB.DNAs.newids.tab`
- NGS source: `/Users/song/Documents/123/YC10_5_1_BDDP210000410-1A_1.fq.gz`
- Subsampling: none; full original FASTQ was used
- Primer-trimmed evaluation region: 18 bp front, 18 bp back

## Runtime

| Method | Real seconds | Peak RSS (GB) | Notes |
|:---|---:|---:|:---|
| minimap2 alignment | 69.82 | 1.349 | `-x sr -c --cs=short`, 16 threads |
| majority-vote PAF parsing | 321.188 | n/a | Python reference-guided consensus over trimmed region |
| alignment + majority-vote total | 391.008 | >= 1.349 | minimap2 plus parser runtime |
| DBGPS Analyzer Batch QC | 32.51 | 10.706 | k=31, 16 threads, includes counting + batch query |

## Strand-Level Results

| Class | Count | Fraction |
|:---|---:|---:|
| agreement_recovered | 209,072 | 99.5581% |
| agreement_missing_or_broken | 556 | 0.2648% |
| consensus_only | 87 | 0.0414% |
| dbgps_only | 285 | 0.1357% |

## Key Metrics

- Alignment consensus exact strands: 209,159 / 210,000 (99.5995%)
- DBGPS path-complete strands: 209,357 / 210,000 (99.6938%)
- DBGPS distinct k-mers: 713,687,359
- DBGPS total k-mer coverage: 4,738,228,211
- PAF alignments: 40,234,908 total, 40,234,908 primary, 39,673,113 used after filters

## Output Files

- `summary_stats.csv`: compact metrics and runtimes
- `joined_comparison.full.csv`: full per-strand comparison table
- `alignment_consensus.full.csv`: full per-strand consensus table
- `disagreements.top200.csv`: first 200 strands where the methods disagree

## Interpretation

DBGPS Analyzer measures k-mer path completeness and coverage in the primer-trimmed reference region. The alignment workflow reconstructs a reference-guided majority consensus over the same region using minimap2 primary alignments. `consensus_only` cases indicate strands where majority voting reconstructs the trimmed reference even though one or more DBGPS k-mers are missing. `dbgps_only` cases indicate complete k-mer paths where the majority consensus still contains mismatches or unresolved positions.
