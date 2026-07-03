/* Unit tests for the shared k-mer / hash-table core (dbgps_core.h).
 *
 * Built and run by tests/run.sh. These exercise the pure primitives directly,
 * complementing the end-to-end CLI tests in tests/test_cli.py.
 */
#include <stdio.h>
#include <string.h>

#include "../dbgps_core.h"

static int failures = 0;
static int checks = 0;

#define CHECK(cond, msg) do {                                   \
    ++checks;                                                    \
    if (!(cond)) { ++failures; printf("  FAIL: %s\n", msg); }    \
} while (0)

static uint64_t encode_canonical(const char *s)
{
    return actgkmer_hashkey((unsigned char *)s, (unsigned char)strlen(s));
}

static void test_hash_roundtrip(void)
{
    printf("test_hash_roundtrip\n");
    /* hash64i must invert hash64 over the masked domain for several k sizes. */
    int ks[] = {4, 8, 16, 20, 31};
    for (unsigned t = 0; t < sizeof(ks) / sizeof(ks[0]); ++t) {
        int k = ks[t];
        uint64_t mask = (1ULL << (k * 2)) - 1;
        uint64_t samples[] = {0ULL, 1ULL, 2ULL, 12345ULL, mask, mask / 2, mask - 1, 0xABCDEFULL & mask};
        for (unsigned i = 0; i < sizeof(samples) / sizeof(samples[0]); ++i) {
            uint64_t x = samples[i] & mask;
            uint64_t back = hash64i(hash64(x, mask), mask);
            CHECK(back == x, "hash64i(hash64(x)) == x");
        }
    }
}

static void test_comp_rev(void)
{
    printf("test_comp_rev\n");
    /* AAAA <-> TTTT, ACGT is its own reverse complement. */
    uint64_t aaaa = 0;                 /* A=0 */
    uint64_t tttt = (1ULL << 8) - 1;   /* T=3, four of them = 0xFF */
    CHECK(comp_rev(aaaa, 4) == tttt, "comp_rev(AAAA) == TTTT");
    CHECK(comp_rev(tttt, 4) == aaaa, "comp_rev(TTTT) == AAAA");

    uint64_t acgt = (0 << 6) | (1 << 4) | (2 << 2) | 3; /* A C G T = 0x1B */
    CHECK(comp_rev(acgt, 4) == acgt, "ACGT is its own reverse complement");

    /* Involution over a range of values. */
    for (uint64_t x = 0; x < 256; ++x)
        CHECK(comp_rev(comp_rev(x, 4), 4) == x, "comp_rev is an involution");
}

static void test_canonical_encoding(void)
{
    printf("test_canonical_encoding\n");
    /* The canonical key is min(forward, reverse complement), so a k-mer and its
     * reverse complement encode identically. */
    CHECK(encode_canonical("AAAA") == encode_canonical("TTTT"),
          "AAAA and TTTT share a canonical key");
    CHECK(encode_canonical("ACGT") == encode_canonical("ACGT"),
          "ACGT canonical is stable");
    CHECK(encode_canonical("AACG") == encode_canonical("CGTT"),
          "AACG and its rev-comp CGTT share a canonical key");

    /* Decode round-trips for an already-canonical key. */
    uint64_t key = encode_canonical("AAAA");
    unsigned char buf[5];
    uint64_acgt(key, buf, 4);
    buf[4] = '\0';
    CHECK(strcmp((char *)buf, "AAAA") == 0, "decode(canonical AAAA) == AAAA");
}

static void test_insert_kms(void)
{
    printf("test_insert_kms\n");
    uint64_t buf[8];
    int n = 0;
    n = insert_kms(buf, 5, n);
    n = insert_kms(buf, 7, n);
    n = insert_kms(buf, 5, n); /* duplicate */
    n = insert_kms(buf, 9, n);
    CHECK(n == 3, "insert_kms deduplicates (5,7,5,9 -> 3)");
}

static void test_seq_kmers(void)
{
    printf("test_seq_kmers\n");
    uint64_t buf[16];
    /* "ACGTACGT", k=4 -> distinct canonical k-mers {ACGT, CGTA(=TACG), GTAC} */
    int n = seq_kmers(buf, 4, 8, "ACGTACGT");
    CHECK(n == 3, "seq_kmers(ACGTACGT, k=4) == 3 distinct canonical k-mers");

    /* A homopolymer has a single distinct k-mer. */
    int m = seq_kmers(buf, 4, 8, "AAAAAAAA");
    CHECK(m == 1, "seq_kmers(AAAAAAAA, k=4) == 1");
}

static void test_count_set(void)
{
    printf("test_count_set\n");
    kc_c4x_t *h = c4x_init(KC_BITS);
    uint64_t mask = (1ULL << (8 * 2)) - 1; /* k = 8 */
    uint64_t present = encode_canonical("ACGTACGT");
    uint64_t absent = encode_canonical("GGGGGGGG");

    CHECK(kmer_cov(present, mask, h) == 0, "unseen k-mer has coverage 0");
    add_kmer(present, mask, h);
    CHECK(kmer_cov(present, mask, h) == 1, "coverage 1 after one add");
    add_kmer(present, mask, h);
    CHECK(kmer_cov(present, mask, h) == 2, "coverage 2 after two adds");
    CHECK(kmer_cov(absent, mask, h) == 0, "distinct k-mer stays at 0");

    /* A k-mer and its reverse complement are the same canonical entry. */
    add_kmer(encode_canonical("ACGTACGT"), mask, h);
    CHECK(kmer_cov(encode_canonical("ACGTACGT"), mask, h) == 3, "canonical add accumulates");

    c4x_destroy(h);
}

static void test_kmer_cov_absent_expanded_bucket(void)
{
    printf("test_kmer_cov_absent_expanded_bucket\n");
    kc_c4x_t *h = c4x_init(KC_BITS);
    uint64_t mask = (1ULL << (8 * 2)) - 1; /* k = 8 */
    uint64_t absent = encode_canonical("GGGGGGGG");
    uint64_t absent_hash = hash64(absent, mask);
    int shard = absent_hash & ((1 << h->p) - 1);
    uint64_t absent_stored_key = absent_hash >> h->p << KC_BITS;
    kc_c4_t *bucket = h->h[shard];
    int absent_flag = 0;

    for (uint64_t i = 1; kh_end(bucket) < 32 || kh_size(bucket) < 13; ++i) {
        uint64_t stored_key = i << KC_BITS;
        khint_t pos;
        if ((stored_key >> KC_BITS) == (absent_stored_key >> KC_BITS)) continue;
        pos = kc_c4_put(bucket, stored_key, &absent_flag);
        if (absent_flag > 0) kh_key(bucket, pos) |= 1;
    }

    CHECK(kh_end(bucket) >= 32, "test bucket expands past one used-flag word");
    CHECK(kc_c4_get(bucket, absent_stored_key) == kh_end(bucket),
          "absent k-mer lookup returns kh_end sentinel");
    CHECK(kmer_cov(absent, mask, h) == 0,
          "missing k-mer in expanded bucket has coverage 0");

    c4x_destroy(h);
}

static void test_kmer_set(void)
{
    printf("test_kmer_set\n");
    /* Order-preserving O(n) dedup set: first occurrence returns 1, repeats 0,
     * and the generation stamp makes a cleared table behave as empty again.
     * Key 0 (all-A k-mer) must be a valid, distinguishable entry. */
    kmer_set_t s = {0};
    kmer_set_reserve(&s, 4);
    kmer_set_clear(&s);
    CHECK(kmer_set_insert(&s, 0) == 1, "first insert of key 0 is new");
    CHECK(kmer_set_insert(&s, 0) == 0, "second insert of key 0 is a duplicate");
    CHECK(kmer_set_insert(&s, 42) == 1, "distinct key is new");
    CHECK(kmer_set_insert(&s, 42) == 0, "distinct key repeat is a duplicate");
    kmer_set_clear(&s); /* new strand: all slots invalidated in O(1) */
    CHECK(kmer_set_insert(&s, 0) == 1, "after clear, key 0 is new again");
    kmer_set_destroy(&s);
}

static void test_kc_c4x_mark(void)
{
    printf("test_kc_c4x_mark\n");
    /* Membership mark folds add_kmer+kmer_cov into one probe: 1 the first time a
     * key is seen, 0 afterwards -- the analyzer's distinct-target dedup. */
    kc_c4x_t *h = c4x_init(KC_BITS);
    uint64_t mask = (1ULL << (8 * 2)) - 1; /* k = 8 */
    uint64_t a = encode_canonical("ACGTACGT");
    uint64_t b = encode_canonical("GGGGGGGG");
    CHECK(kc_c4x_mark(a, mask, h) == 1, "first mark of a key is new");
    CHECK(kc_c4x_mark(a, mask, h) == 0, "second mark of a key is present");
    CHECK(kc_c4x_mark(b, mask, h) == 1, "distinct key marks as new");
    c4x_destroy(h);
}

static void test_seq_kmers_dedup_equiv(void)
{
    printf("test_seq_kmers_dedup_equiv\n");
    /* The fast set-based dedup in seq_kmers must match the historical O(n^2)
     * insert_kms reference exactly -- same distinct count AND first-occurrence
     * order -- across many k sizes and pseudo-random strands. This is what keeps
     * the analyzer's max-adjacent-ratio (which depends on kms order) unchanged. */
    static const char bases[4] = {'A', 'C', 'G', 'T'};
    unsigned int st = 0x1234567u;
    for (int k = 1; k <= 20; k += (k < 8 ? 1 : 3)) {
        for (int trial = 0; trial < 40; ++trial) {
            int len = k + (int)(st % 400u);
            char *seq = (char *)malloc(len + 1);
            for (int i = 0; i < len; ++i) {
                st = st * 1103515245u + 12345u;
                seq[i] = bases[(st >> 16) & 3u];
            }
            seq[len] = '\0';

            int cap = len - k + 1 > 0 ? len - k + 1 : 1;
            uint64_t *ref = (uint64_t *)malloc(sizeof(uint64_t) * cap);
            int rn = 0;
            uint64_t x[2] = {0, 0}, mask = (1ULL << (k * 2)) - 1, shift = (k - 1) * 2;
            int l = 0;
            for (int i = 0; i < len; ++i) {
                int c = seq_nt4_table[(unsigned char)seq[i]];
                if (c < 4) {
                    x[0] = (x[0] << 2 | c) & mask;
                    x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;
                    if (++l >= k) {
                        uint64_t y = x[0] < x[1] ? x[0] : x[1];
                        rn = insert_kms(ref, y, rn);
                    }
                } else { l = 0; x[0] = x[1] = 0; }
            }

            uint64_t *got = (uint64_t *)malloc(sizeof(uint64_t) * cap);
            int gn = seq_kmers(got, k, len, seq);
            int eq = (gn == rn);
            for (int i = 0; eq && i < gn; ++i)
                if (got[i] != ref[i]) eq = 0;
            CHECK(eq, "seq_kmers matches insert_kms reference (count + order)");

            free(got);
            free(ref);
            free(seq);
        }
    }
}

int main(void)
{
    test_hash_roundtrip();
    test_comp_rev();
    test_canonical_encoding();
    test_insert_kms();
    test_seq_kmers();
    test_kmer_set();
    test_kc_c4x_mark();
    test_seq_kmers_dedup_equiv();
    test_count_set();
    test_kmer_cov_absent_expanded_bucket();

    printf("\n");
    if (failures) {
        printf("FAILED: %d of %d checks failed.\n", failures, checks);
        return 1;
    }
    printf("OK: all %d checks passed.\n", checks);
    return 0;
}
