# NextPolish vs ProGenFixer on `simu_ngs`

## Inputs

- Reference: `/Users/song/Github-Repos/ProGenFixer/.local_data/simu_ngs/Ref.fasta`
- Reads:
  - `/Users/song/Github-Repos/ProGenFixer/.local_data/simu_ngs/Ref.fasta.dwgsim.bwa.read1.fastq.gz`
  - `/Users/song/Github-Repos/ProGenFixer/.local_data/simu_ngs/Ref.fasta.dwgsim.bwa.read2.fastq.gz`

## Commands

NextPolish was run with `run_nextpolish.cfg`:

```bash
nextPolish -l analysis/nextpolish_vs_progenfixer/outputs/nextpolish/nextpolish.log \
  analysis/nextpolish_vs_progenfixer/run_nextpolish.cfg
```

The config used `task = 121212`, `multithread_jobs = 3`, `polish_options = -p 3`, and `sgs_options = unpaired -max_depth 120`.

ProGenFixer was run as:

```bash
/Users/song/Github-Repos/ProGenFixer/ProGenFixer \
  /Users/song/Github-Repos/ProGenFixer/.local_data/simu_ngs/Ref.fasta \
  /Users/song/Github-Repos/ProGenFixer/.local_data/simu_ngs/Ref.fasta.dwgsim.bwa.read1.fastq.gz \
  /Users/song/Github-Repos/ProGenFixer/.local_data/simu_ngs/Ref.fasta.dwgsim.bwa.read2.fastq.gz \
  -o analysis/nextpolish_vs_progenfixer/outputs/progenfixer/progenfixer \
  -t 3 -n 3 --fix
```

## Result Summary

| Tool | Final FASTA | Length (bp) | Delta vs Ref | Edit distance vs Ref | Substitutions | Insertions | Deletions |
|---|---:|---:|---:|---:|---:|---:|---:|
| NextPolish | `outputs/nextpolish/work/genome.nextpolish.fasta` | 4,625,147 | +1 | 4,631 | 4,032 | 300 | 299 |
| ProGenFixer | `outputs/progenfixer/progenfixer.iter2.fasta` | 4,625,361 | +215 | 5,878 | 3,975 | 1,059 | 844 |

ProGenFixer did not emit a new FASTA in iteration 3 because no variants were found in that iteration, so `progenfixer.iter2.fasta` is the final corrected sequence.

## Direct Difference Between Final Outputs

Using NextPolish as the reference and ProGenFixer as the query:

| Comparison | Length Delta | Edit Distance | Substitutions | Insertions | Deletions | Variant Blocks |
|---|---:|---:|---:|---:|---:|---:|
| ProGenFixer vs NextPolish | +214 | 1,405 | 75 | 772 | 558 | 89 |

This means the two tools agree on most corrected bases, but ProGenFixer produces a longer final assembly and differs mainly by indels.

## ProGenFixer Iterations

| Iteration | VCF Records | SUB | INS | DEL |
|---:|---:|---:|---:|---:|
| 1 | 4,261 | 3,837 | 203 | 221 |
| 2 | 24 | 2 | 0 | 22 |
| 3 | 0 | 0 | 0 | 0 |

Most ProGenFixer corrections occurred in the first iteration. The second iteration made 24 additional calls, and the third iteration converged with no emitted variants.

## Runtime and Memory

| Tool | Wall Time | Max Resident Set Size |
|---|---:|---:|
| NextPolish | 635.78 s | 1,316,093,952 bytes |
| ProGenFixer | 29.47 s | 3,979,411,456 bytes |

In this run, ProGenFixer was much faster but used more peak resident memory. NextPolish was slower because it repeatedly maps reads and polishes across the configured six task steps.

## Interpretation

- NextPolish made a slightly smaller net length change and fewer total edits relative to the input reference.
- ProGenFixer converged in three iterations and produced more indel edits, especially insertions, resulting in a sequence 214 bp longer than the NextPolish output.
- The direct final-output edit distance is 1,405 bp, concentrated in 89 variant blocks, so the practical disagreement is localized rather than spread uniformly across the genome.
- If the benchmark truth is the original `Ref.fasta`, NextPolish is closer by edit distance. If the reads encode simulated variants relative to `Ref.fasta`, the comparison should be judged against the simulation truth VCF or known mutated genome rather than against `Ref.fasta` alone.

Machine-readable outputs:

- `summary.tsv`
- `pairwise_summary.tsv`
- `progenfixer_vcf_summary.tsv`
- `summary.json`
