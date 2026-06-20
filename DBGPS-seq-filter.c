/* DBGPS-seq-filter (a.k.a. DBGPS-ft) - De Bruijn graph based filter that
 * screens out entangled strands from a DNA pool. A strand is filtered when any
 * of its (primer-trimmed) k-mers has already been seen in an earlier strand
 * more than the allowed cross-link threshold.
 *
 * Author: Lifu Song lifu.song@outlook.com
 */
#include <stdio.h>
#include <stdint.h>
#include <zlib.h>
#include <stdlib.h>

#include "ketopt.h"  /* command-line argument parser */
#include "kthread.h" /* multi-threading models */

#include "kseq.h"    /* FASTA/Q parser */
KSEQ_INIT(gzFile, gzread)

#define DBGPS_KC_BITS 10
#include "dbgps_core.h" /* shared k-mer / hash-table core */

/* Like seq_kmers(), but ignores $primer_len bases at both ends of the strand
 * so shared primer regions are not mistaken for cross-links. */
static int seq_kmers_primer(uint64_t *kms, int k, int len, const char *seq, int primer_len)
{
    int i, l = 0, km_num = 0;
    uint64_t x[2], mask = (1ULL << k * 2) - 1, shift = (k - 1) * 2;
    for (i = primer_len, x[0] = x[1] = 0; i < len - primer_len; ++i) {
        int c = seq_nt4_table[(uint8_t)seq[i]];
        if (c < 4) { /* not an "N" base */
            x[0] = (x[0] << 2 | c) & mask;
            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;
            if (++l >= k) {
                uint64_t y = x[0] < x[1] ? x[0] : x[1];
                km_num = insert_kms(kms, y, km_num);
            }
        } else l = 0, x[0] = x[1] = 0;
    }
    return km_num;
}

typedef struct {
    int k, max_cov, output, primer_len;
    kseq_t *ks;
    kc_c4x_t *h;
} pldat_t;

static void filter_strands(pldat_t *p)
{
    uint64_t mask = (1ULL << p->k * 2) - 1;
    int filter_num = 0, total = 0;

    while (kseq_read(p->ks) >= 0) {
        total++;
        int l = p->ks->seq.l, km_num, kms_cov;
        if (l < p->k) continue;
        uint64_t *kms;
        MALLOC(kms, l - p->k + 1);
        km_num = seq_kmers_primer(kms, p->k, l, p->ks->seq.s, p->primer_len);
        kms_cov = kms_max_cov(kms, km_num, mask, p->h);

        if (kms_cov <= p->max_cov) { /* strand passes: record its k-mers */
            for (int j = 0; j < km_num; j++)
                add_kmer(kms[j], mask, p->h);
            if (p->output > 0) {
                printf(">%s\n", p->ks->name.s);
                printf("%s\n", p->ks->seq.s);
            }
        } else { /* strand is entangled: filter it out */
            filter_num++;
            if (p->output < 1) printf("%s\n", p->ks->name.s);
            fprintf(stderr, "%d/%d * ", filter_num, total);
        }
        free(kms);
    }
}

static kc_c4x_t *filter_file(const char *fn, int k, int p, int max_cov, int primer_len, int output)
{
    pldat_t pl;
    gzFile fp;
    if ((fp = gzopen(fn, "r")) == 0) return 0;
    pl.ks = kseq_init(fp);
    pl.k = k;
    pl.max_cov = max_cov;
    pl.output = output;
    pl.primer_len = primer_len;
    pl.h = c4x_init(p);

    filter_strands(&pl);
    kseq_destroy(pl.ks);
    gzclose(fp);
    return pl.h;
}

int main(int argc, char *argv[])
{
    kc_c4x_t *h;
    int c, k = 31, p = KC_BITS, max_links = 0, output = 1, primer_len = 18;

    ketopt_t o = KETOPT_INIT;
    while ((c = ketopt(&o, argc, argv, 1, "k:m:sp:", 0)) >= 0) {
        if (c == 'k') k = atoi(o.arg);
        else if (c == 'm') max_links = atoi(o.arg);
        else if (c == 's') output = 0; /* list filtered names instead of passed FASTA */
        else if (c == 'p') primer_len = atoi(o.arg);
    }
    if (argc - o.ind < 1) {
        fprintf(stderr, "\n***************************************************************************************\n");
        fprintf(stderr,   "**                                                                                   **\n");
        fprintf(stderr,   "**   DBGPS-ft -  De Bruijn Graph based filter to screen out the entangled strands    **\n");
        fprintf(stderr,   "**             Version 20220116  Author: Lifu Song lifu.song@outlook.com             **\n");
        fprintf(stderr,   "**                                                                                   **\n");
        fprintf(stderr,   "***************************************************************************************\n\n");
        fprintf(stderr,   "Usage: DBGPS-ft [options] <in.fa>\n");
        fprintf(stderr,   "Options:\n");
        fprintf(stderr,   "  -k INT     k-mer size for entanglement analysis [%d]\n", k);
        fprintf(stderr,   "  -m INT     maximum allowed cross-links per strand [%d]\n", max_links);
        fprintf(stderr,   "  -p INT     length of primers to ignore at both ends [%d]\n", primer_len);
        fprintf(stderr,   "  -s         output names of filtered (entangled) strands instead of passed FASTA\n");
        return 1;
    }

    fprintf(stderr, "Picking out strands with cross-links more than %d using k-mer size %d\n", max_links, k);

    h = filter_file(argv[o.ind], k, p, max_links, primer_len, output);
    if (h == 0) {
        fprintf(stderr, "Error: could not open %s\n", argv[o.ind]);
        return 1;
    }

    fprintf(stderr, "\nTask done!\n");

    c4x_destroy(h);
    return 0;
}
