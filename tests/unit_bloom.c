/* Direct regressions for the vendored blocked Bloom filter.
 * Built by tests/run.sh; no analyzer implementation or thread wiring needed.
 */
#include <stdint.h>
#include <stdio.h>

#include "../dstoreqc_core.h"
#include "../vendor/bfc/bbf.h"

static int failures = 0;
static int checks = 0;

#define CHECK(cond, msg) do {                                  \
    ++checks;                                                 \
    if (!(cond)) { ++failures; printf("  FAIL: %s\n", msg); }   \
} while (0)

static void test_invalid_configurations(void)
{
    static const int invalid[][2] = {
        {-1, 4}, {0, 4}, {8, 4}, {56, 4}, {64, 4},
        {16, -1}, {16, 0}, {16, 33}, {16, 65}
    };
    printf("test_invalid_configurations\n");
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        bfc_bf_t *filter = bfc_bf_init(invalid[i][0], invalid[i][1]);
        CHECK(filter == NULL, "invalid size/hash configuration returns NULL");
        if (filter != NULL) bfc_bf_destroy(filter);
    }
}

static void test_insert_and_get_hits(void)
{
    static const uint64_t hashes[] = {
        UINT64_C(0), UINT64_C(1), UINT64_MAX,
        UINT64_C(0x8000000000000000), UINT64_C(0x0000000100000000),
        UINT64_C(0xaaaaaaaaaaaaaaaa), UINT64_C(0x5555555555555555),
        UINT64_C(0x0123456789abcdef), UINT64_C(0xfedcba9876543210)
    };
    static const int hash_counts[] = {1, 4, 7};
    printf("test_insert_and_get_hits\n");
    for (unsigned h = 0; h < sizeof(hash_counts) / sizeof(hash_counts[0]); ++h) {
        int n_hashes = hash_counts[h];
        bfc_bf_t *filter = bfc_bf_init(16, n_hashes);
        CHECK(filter != NULL, "valid blocked Bloom configuration initializes");
        if (filter == NULL) continue;
        for (unsigned i = 0; i < sizeof(hashes) / sizeof(hashes[0]); ++i)
            CHECK(bfc_bf_get(filter, hashes[i]) == 0, "empty filter has no hits, including hash zero");
        for (unsigned i = 0; i < sizeof(hashes) / sizeof(hashes[0]); ++i) {
            int before = bfc_bf_get(filter, hashes[i]);
            CHECK(bfc_bf_insert(filter, hashes[i]) == before, "insert returns the prior number of hits");
            CHECK(bfc_bf_get(filter, hashes[i]) == n_hashes, "inserted hash has all requested hits");
            CHECK(bfc_bf_insert(filter, hashes[i]) == n_hashes, "reinsertion reports all hits");
        }
        for (unsigned i = 0; i < sizeof(hashes) / sizeof(hashes[0]); ++i)
            CHECK(bfc_bf_get(filter, hashes[i]) == n_hashes, "later inserts never erase earlier membership");
        bfc_bf_destroy(filter);
    }
}

static uint64_t packed_hash(unsigned k, uint64_t value)
{
    uint64_t mask = (UINT64_C(1) << (2 * k)) - 1;
    return hash64(min_hash_key(value & mask, (unsigned char)k), mask);
}

static void test_no_false_negatives_for_packed_kmers(void)
{
    static const unsigned lengths[] = {1, 4, 8, 16, 31};
    static const int sizes[] = {9, 16, 20};
    uint64_t samples[5 * 512];
    unsigned count = 0;
    uint64_t state = UINT64_C(0x123456789abcdef);
    printf("test_no_false_negatives_for_packed_kmers\n");
    for (unsigned k = 0; k < sizeof(lengths) / sizeof(lengths[0]); ++k) {
        for (unsigned i = 0; i < 512; ++i) {
            state = state * UINT64_C(6364136223846793005) + UINT64_C(1442695040888963407);
            samples[count++] = packed_hash(lengths[k], state);
        }
    }
    for (unsigned s = 0; s < sizeof(sizes) / sizeof(sizes[0]); ++s) {
        bfc_bf_t *filter = bfc_bf_init(sizes[s], 4);
        CHECK(filter != NULL, "valid minimum, medium, and larger filters initialize");
        if (filter == NULL) continue;
        for (unsigned i = 0; i < count; ++i) {
            int hits = bfc_bf_insert(filter, samples[i]);
            CHECK(hits >= 0 && hits <= 4, "insert hit count stays in range");
        }
        /* Recheck after every key is inserted, including a deliberately full
         * single-block filter and hashes with only a few nonzero low bits. */
        for (unsigned i = 0; i < count; ++i)
            CHECK(bfc_bf_get(filter, samples[i]) == 4, "packed k-mer hash has no false negative");
        bfc_bf_destroy(filter);
    }
}

static uint64_t mixed_hash(uint64_t value)
{
    return hash64(value, UINT64_MAX);
}

static void test_absent_queries_empirical_sanity(void)
{
    enum { PRESENT = 4096, ABSENT = 16384, N_HASHES = 4 };
    int false_positives = 0;
    bfc_bf_t *filter = bfc_bf_init(18, N_HASHES);
    printf("test_absent_queries_empirical_sanity\n");
    CHECK(filter != NULL, "sparse filter initializes");
    if (filter == NULL) return;
    for (uint64_t i = 0; i < PRESENT; ++i)
        bfc_bf_insert(filter, mixed_hash(i));
    for (uint64_t i = PRESENT; i < PRESENT + ABSENT; ++i) {
        int hits = bfc_bf_get(filter, mixed_hash(i));
        CHECK(hits >= 0 && hits <= N_HASHES, "absent-query hit count stays in range");
        if (hits == N_HASHES) ++false_positives;
    }
    /* At 64 bits/key, this loose bound detects a constant-true or broken block
     * selector without assuming a collision-free probabilistic structure. */
    CHECK(false_positives < ABSENT / 20, "sparse filter has fewer than 5 percent false positives");
    for (uint64_t i = 0; i < PRESENT; ++i)
        CHECK(bfc_bf_get(filter, mixed_hash(i)) == N_HASHES, "absent queries preserve inserted membership");
    bfc_bf_destroy(filter);

    filter = bfc_bf_init(18, N_HASHES);
    CHECK(filter != NULL, "filter can be recreated after destruction");
    if (filter != NULL) {
        for (uint64_t i = 0; i < 128; ++i)
            CHECK(bfc_bf_get(filter, mixed_hash(i)) == 0, "new filter does not retain destroyed state");
        bfc_bf_destroy(filter);
    }
}

int main(void)
{
    test_invalid_configurations();
    test_insert_and_get_hits();
    test_no_false_negatives_for_packed_kmers();
    test_absent_queries_empirical_sanity();
    printf("\n");
    if (failures) {
        printf("FAILED: %d of %d checks failed.\n", failures, checks);
        return 1;
    }
    printf("OK: all %d checks passed.\n", checks);
    return 0;
}
