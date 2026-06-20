/* dbgps_core.h - shared k-mer / hash-table core for the DBGPS tools.
 *
 * This header centralises the De Bruijn graph primitives that used to be
 * copy-pasted (and slowly diverging) across DBGPS-analyzer.c, DBGPS-links.c
 * and DBGPS-seq-filter.c: the 2-bit nucleotide tables, the invertible integer
 * hash, k-mer encode/decode, and the sharded saturating-count hash set
 * (kc_c4x_t) together with its coverage queries.
 *
 * The number of low "count" bits / hash shards is configurable per tool via
 * DBGPS_KC_BITS (define it before including this header). It defaults to 14.
 * The analyzer uses 14 (coverage can be high); the link/filter tools use 10.
 *
 * All functions are `static inline` so each tool only pays for what it calls
 * and unused helpers never trigger -Wunused-function under -Werror.
 */
#ifndef DBGPS_CORE_H
#define DBGPS_CORE_H

#include <stdint.h>
#include <stdlib.h>

#include "khashl.h" /* hash table */

#ifndef DBGPS_KC_BITS
#define DBGPS_KC_BITS 14
#endif

#define KC_BITS DBGPS_KC_BITS
#define KC_MAX ((1 << KC_BITS) - 1)
#define kc_c4_eq(a, b) ((a) >> KC_BITS == (b) >> KC_BITS) /* low KC_BITS bits = count; high bits = k-mer */
#define kc_c4_hash(a) ((a) >> KC_BITS)

KHASHL_SET_INIT(, kc_c4_t, kc_c4, uint64_t, kc_c4_hash, kc_c4_eq)

#define CALLOC(ptr, len) ((ptr) = (__typeof__(ptr))calloc((len), sizeof(*(ptr))))
#define MALLOC(ptr, len) ((ptr) = (__typeof__(ptr))malloc((len) * sizeof(*(ptr))))
#define REALLOC(ptr, len) ((ptr) = (__typeof__(ptr))realloc((ptr), (len) * sizeof(*(ptr))))

#if defined(__GNUC__) || defined(__clang__)
#define DBGPS_UNUSED __attribute__((unused))
#else
#define DBGPS_UNUSED
#endif

/* translate ACGT (any case) to 0123; everything else (incl. N) to 4 */
static const unsigned char seq_nt4_table[256] DBGPS_UNUSED = {
    0, 1, 2, 3,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 0, 4, 1,  4, 4, 4, 2,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  3, 3, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 0, 4, 1,  4, 4, 4, 2,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  3, 3, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,
    4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4
};

/* translate 0123 to ACGT */
static const unsigned char nt4_seq_table[4] DBGPS_UNUSED = {'A', 'C', 'G', 'T'};

/* invertible integer hash function */
static inline uint64_t hash64(uint64_t key, uint64_t mask)
{
    key = (~key + (key << 21)) & mask; /* key = (key << 21) - key - 1; */
    key = key ^ key >> 24;
    key = ((key + (key << 3)) + (key << 8)) & mask; /* key * 265 */
    key = key ^ key >> 14;
    key = ((key + (key << 2)) + (key << 4)) & mask; /* key * 21 */
    key = key ^ key >> 28;
    key = (key + (key << 31)) & mask;
    return key;
}

/* inverse of hash64(); modified from <https://naml.us/blog/tag/invertible> */
static inline uint64_t hash64i(uint64_t key, uint64_t mask)
{
    uint64_t tmp;
    tmp = (key - (key << 31));    key = (key - (tmp << 31)) & mask;
    tmp = key ^ key >> 28;        key = key ^ tmp >> 28;
    key = (key * 14933078535860113213ull) & mask;
    tmp = key ^ key >> 14; tmp = key ^ tmp >> 14; tmp = key ^ tmp >> 14; key = key ^ tmp >> 14;
    key = (key * 15244667743933553977ull) & mask;
    tmp = key ^ key >> 24;        key = key ^ tmp >> 24;
    tmp = ~key; tmp = ~(key - (tmp << 21)); tmp = ~(key - (tmp << 21)); key = ~(key - (tmp << 21)) & mask;
    return key;
}

/* decode a uint64_t k-mer to its ACGT string (no terminator added) */
static inline unsigned char *uint64_acgt(uint64_t key, unsigned char *seq, unsigned char km_len)
{
    int p = km_len - 1;
    while (p >= 0) {
        int n = key & 3ULL;
        key = key >> 2;
        seq[p] = nt4_seq_table[n];
        p = p - 1;
    }
    return seq;
}

/* reverse complement of a 2-bit packed k-mer */
static inline uint64_t comp_rev(uint64_t x, unsigned char km_len)
{
    uint64_t y = 0;
    int i, c;
    for (i = 0; i < km_len; i++) {
        y = y << 2;
        c = x & 3ULL;
        y = y | (3 - c);
        x = x >> 2;
    }
    return y;
}

/* canonical key = min(forward, reverse complement) */
static inline uint64_t min_hash_key(uint64_t x, unsigned char km_len)
{
    uint64_t y = comp_rev(x, km_len);
    return (x < y) ? x : y;
}

/* encode an ACGT string into the canonical 2-bit k-mer key */
static inline uint64_t actgkmer_hashkey(unsigned char *seq, unsigned char km_len)
{
    int i;
    uint64_t x[2], y, shift = (km_len - 1) * 2, mask = (1ULL << km_len * 2) - 1;
    for (i = 0, x[0] = x[1] = 0; i < km_len; ++i) {
        int c = seq_nt4_table[(uint8_t)seq[i]];
        if (c < 4) { /* not an "N" base */
            x[0] = (x[0] << 2 | c) & mask;                 /* forward strand */
            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift; /* reverse strand */
        } else x[0] = x[1] = 0;                            /* restart on "N" */
    }
    y = x[0] < x[1] ? x[0] : x[1];
    return y;
}

/* sharded saturating-count hash set */
typedef struct {
    int p;        /* suffix length / number of shards = 1<<p */
    kc_c4_t **h;  /* 1<<p hash tables */
} kc_c4x_t;

static inline kc_c4x_t *c4x_init(int p)
{
    int i;
    kc_c4x_t *h;
    CALLOC(h, 1);
    MALLOC(h->h, 1 << p);
    h->p = p;
    for (i = 0; i < 1 << p; ++i)
        h->h[i] = kc_c4_init();
    return h;
}

static inline void c4x_destroy(kc_c4x_t *h)
{
    if (h == 0) return;
    for (int i = 0; i < 1 << h->p; ++i)
        kc_c4_destroy(h->h[i]);
    free(h->h);
    free(h);
}

/* coverage (saturating count) of a canonical k-mer key */
static inline unsigned short kmer_cov(uint64_t kmer, uint64_t mask, kc_c4x_t *h)
{
    int j, x, cov = 0;
    uint64_t hash_key = hash64(kmer, mask);
    j = hash_key & ((1 << KC_BITS) - 1);
    if (kh_size(h->h[j]) < 1) return 0;
    hash_key = hash_key >> KC_BITS << KC_BITS;
    x = kc_c4_get(h->h[j], hash_key);
    if (kh_exist(h->h[j], x))
        cov = kh_key(h->h[j], x) & KC_MAX;
    return cov;
}

/* increment the saturating count of a canonical k-mer key */
static inline void add_kmer(uint64_t y, uint64_t mask, kc_c4x_t *h)
{
    int p = h->p;
    uint64_t y_hash = hash64(y, mask);
    int pre = y_hash & ((1 << p) - 1);
    khint_t k;
    int absent;
    k = kc_c4_put(h->h[pre], y_hash >> p << KC_BITS, &absent);
    (void)absent;
    if ((kh_key(h->h[pre], k) & KC_MAX) < KC_MAX) ++kh_key(h->h[pre], k);
}

/* append k-mer key $y to a linear buffer, deduplicating against existing entries */
static inline int insert_kms(uint64_t *kms, uint64_t y, int km_num)
{
    int i;
    for (i = 0; i < km_num; i++)
        if (y == kms[i]) return km_num;
    kms[km_num] = y;
    return km_num + 1;
}

/* maximum coverage across a set of canonical k-mer keys */
static inline int kms_max_cov(uint64_t *kms, int km_num, uint64_t mask, kc_c4x_t *h)
{
    int i, max_cov = 0;
    for (i = 0; i < km_num; i++) {
        int cov = kmer_cov(kms[i], mask, h);
        if (cov > max_cov) max_cov = cov;
    }
    return max_cov;
}

/* collect the distinct canonical k-mers of $seq into $kms; returns the count */
static inline int seq_kmers(uint64_t *kms, int k, int len, const char *seq)
{
    int i, l, km_num = 0;
    uint64_t x[2], mask = (1ULL << k * 2) - 1, shift = (k - 1) * 2;
    for (i = l = 0, x[0] = x[1] = 0; i < len; ++i) {
        int c = seq_nt4_table[(uint8_t)seq[i]];
        if (c < 4) { /* not an "N" base */
            x[0] = (x[0] << 2 | c) & mask;                 /* forward strand */
            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift; /* reverse strand */
            if (++l >= k) {
                uint64_t y = x[0] < x[1] ? x[0] : x[1];
                km_num = insert_kms(kms, y, km_num);
            }
        } else l = 0, x[0] = x[1] = 0; /* restart on "N" */
    }
    return km_num;
}

#endif /* DBGPS_CORE_H */
