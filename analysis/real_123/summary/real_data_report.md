# Real YC10 10% Subsample: Alignment Consensus vs DBGPS Analyzer

## Dataset

- Reference strands: 210,000
- Reference source: `/Users/song/Documents/123/6.5MB.DNAs.newids.tab`
- NGS source: `/Users/song/Documents/123/YC10_5_1_BDDP210000410-1A_1.fq.gz`
- Subsampling: deterministic 1 read kept from every 10 FASTQ records
- Primer-trimmed evaluation region: 18 bp front, 18 bp back

## Runtime

| Method | Real seconds | Peak RSS (GB) | Notes |
|:---|---:|---:|:---|
| minimap2 alignment | 7.6 | 1.053 | `-x sr -c --cs=short`, 16 threads |
| majority-vote PAF parsing | 68.834 | n/a | Python reference-guided consensus over trimmed region |
| alignment + majority-vote total | 76.434 | >= 1.053 | minimap2 plus parser runtime |
| DBGPS Analyzer Batch QC | 4.74 | 3.555 | k=31, 16 threads, includes counting + batch query |

## Strand-Level Results

| Class | Count | Fraction |
|:---|---:|---:|
| agreement_recovered | 197,108 | 93.8610% |
| agreement_missing_or_broken | 7,287 | 3.4700% |
| consensus_only | 1,684 | 0.8019% |
| dbgps_only | 3,921 | 1.8671% |

## Key Metrics

- Alignment consensus exact strands: 198,792 / 210,000 (94.6629%)
- DBGPS path-complete strands: 201,029 / 210,000 (95.7281%)
- DBGPS distinct k-mers: 124,950,624
- DBGPS total k-mer coverage: 474,963,390
- PAF alignments: 4,023,577 total, 4,023,577 primary, 3,967,391 used after filters

## Output Files

- `summary_stats.csv`: compact metrics and runtimes
- `joined_comparison.full.csv`: full per-strand comparison table
- `alignment_consensus.full.csv`: full per-strand consensus table
- `disagreements.top200.csv`: first 200 strands where the methods disagree

## Interpretation

DBGPS Analyzer measures k-mer path completeness and coverage in the primer-trimmed reference region. The alignment workflow reconstructs a reference-guided majority consensus over the same region using minimap2 primary alignments. `consensus_only` cases indicate strands where majority voting reconstructs the trimmed reference even though one or more DBGPS k-mers are missing. `dbgps_only` cases indicate complete k-mer paths where the majority consensus still contains mismatches or unresolved positions.
