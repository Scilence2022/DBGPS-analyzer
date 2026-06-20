/* DBGPS-links - count cross-links (k-mers shared between different strands)
 * in a DNA pool. A high cross-link count signals sequence entanglement /
 * chimera formation. Remove primers before counting to avoid false positives.
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

typedef struct {
    int k;
    kseq_t *ks;
    kc_c4x_t *h;
} pldat_t;

/* Count every distinct k-mer of every strand into the shared hash set. Because
 * k-mers are deduplicated within a strand (seq_kmers), the stored count of a
 * k-mer equals the number of distinct strands it appears in. */
static void count_strands(pldat_t *p)
{
    uint64_t mask = (1ULL << p->k * 2) - 1;
    while (kseq_read(p->ks) >= 0) {
        int l = p->ks->seq.l, km_num;
        if (l < p->k) continue;
        uint64_t *kms;
        MALLOC(kms, l - p->k + 1);
        km_num = seq_kmers(kms, p->k, l, p->ks->seq.s);
        for (int j = 0; j < km_num; j++)
            add_kmer(kms[j], mask, p->h);
        free(kms);
    }
}

static kc_c4x_t *count_file(const char *fn, int k, int p)
{
    pldat_t pl;
    gzFile fp;
    if ((fp = gzopen(fn, "r")) == 0) return 0;
    pl.ks = kseq_init(fp);
    pl.k = k;
    pl.h = c4x_init(p);

    count_strands(&pl);

    kseq_destroy(pl.ks);
    gzclose(fp);
    return pl.h;
}

int main(int argc, char *argv[])
{
    kc_c4x_t *h;
    int c, k = 31, p = KC_BITS, max_link_num = 1;

    ketopt_t o = KETOPT_INIT;
    while ((c = ketopt(&o, argc, argv, 1, "k:m:", 0)) >= 0) {
        if (c == 'k') k = atoi(o.arg);
        else if (c == 'm') max_link_num = atoi(o.arg);
    }

    if (argc - o.ind < 1) {
        fprintf(stderr, "Usage: DBGPS-links [options] <in.fa>\n");
        fprintf(stderr, "Author: Lifu Song lifu.song@outlook.com\n");
        fprintf(stderr, "Version 20220116\n");
        fprintf(stderr, "Options:\n");
        fprintf(stderr, "  -k INT     k-mer size [%d]\n", k);
        fprintf(stderr, "  -m INT     only count k-mers occurring in more than this many strands [%d]\n", max_link_num);
        return 1;
    }

    fprintf(stderr, "Please remove the primers before counting\nCounting strand links ......\n");

    h = count_file(argv[o.ind], k, p);
    if (h == 0) {
        fprintf(stderr, "Error: could not open %s\n", argv[o.ind]);
        return 1;
    }

    fprintf(stderr, "k-mer analysis finished ......\n");

    unsigned long long link_num = 0;
    for (int j = 0; j < 1 << h->p; ++j) {
        kc_c4_t *g = h->h[j];
        khint_t kk;
        if (kh_size(g) == 0) continue;
        for (kk = 0; kk < kh_end(g); ++kk) {
            if (kh_exist(g, kk)) {
                int count = kh_key(g, kk) & KC_MAX;
                if (count > max_link_num)
                    link_num += count - 1;
            }
        }
    }

    fprintf(stdout, "Total cross links %llu\n", link_num);

    c4x_destroy(h);
    return 0;
}
