/* Adapted from lh3/bfc, commit 69ab176e7aac4af482d7d8587e45bfe239d02c96.
 * Copyright (c) 2015 Broad Institute. MIT license; see LICENSE.txt.
 * Changes: checked allocation/parameters, memset, and removal of unused load().
 * Build before querying; simultaneous insertion and lookup is not supported.
 */
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include "bbf.h"

bfc_bf_t *bfc_bf_init(int n_shift, int n_hashes)
{
    bfc_bf_t *b;
    void *ptr = NULL;
    if (n_shift < BFC_BLK_SHIFT || n_shift > 64 - BFC_BLK_SHIFT ||
        n_shift - 3 >= (int)(sizeof(size_t) * CHAR_BIT) ||
        n_hashes < 1 || n_hashes > 32) return NULL;
    b = calloc(1, sizeof(*b));
    if (b == NULL) return NULL;
    size_t bytes = (size_t)1 << (n_shift - 3);
    if (posix_memalign(&ptr, 1 << (BFC_BLK_SHIFT - 3), bytes) != 0) {
        free(b);
        return NULL;
    }
    b->n_shift = n_shift;
    b->n_hashes = n_hashes;
    b->b = ptr;
    memset(b->b, 0, bytes);
    return b;
}

void bfc_bf_destroy(bfc_bf_t *b)
{
    if (b == NULL) return;
    free(b->b);
    free(b);
}

int bfc_bf_insert(bfc_bf_t *b, uint64_t hash)
{
    int x = b->n_shift - BFC_BLK_SHIFT;
    uint64_t y = hash & ((1ULL << x) - 1);
    int h1 = hash >> x & BFC_BLK_MASK;
    int h2 = hash >> b->n_shift & BFC_BLK_MASK;
    uint8_t *p = &b->b[y << (BFC_BLK_SHIFT - 3)];
    int i, z = h1, cnt = 0;
    if ((h2 & 31) == 0) h2 = (h2 + 1) & BFC_BLK_MASK;
    while (__sync_lock_test_and_set(p, 1)) {} /* first byte is a spin lock */
    for (i = 0; i < b->n_hashes; z = (z + h2) & BFC_BLK_MASK) {
        uint8_t *q = &p[z >> 3], u;
        if (p == q) continue;
        u = 1 << (z & 7);
        cnt += !!(*q & u);
        *q |= u;
        ++i;
    }
    __sync_lock_release(p);
    return cnt;
}

int bfc_bf_get(const bfc_bf_t *b, uint64_t hash)
{
    int x = b->n_shift - BFC_BLK_SHIFT;
    uint64_t y = hash & ((1ULL << x) - 1);
    int h1 = hash >> x & BFC_BLK_MASK;
    int h2 = hash >> b->n_shift & BFC_BLK_MASK;
    const uint8_t *p = &b->b[y << (BFC_BLK_SHIFT - 3)];
    int i, z = h1, cnt = 0;
    if ((h2 & 31) == 0) h2 = (h2 + 1) & BFC_BLK_MASK;
    for (i = 0; i < b->n_hashes; z = (z + h2) & BFC_BLK_MASK) {
        const uint8_t *q = &p[z >> 3];
        if (p == q) continue;
        cnt += !!(*q & (1 << (z & 7)));
        ++i;
    }
    return cnt;
}
