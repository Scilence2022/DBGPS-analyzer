/* Decodability predicate for de Bruijn graph strand decoders (DBGPS family).
 *
 * The decoder seeds a walk at the k-mer ending at the last index base, then
 * extends base by base. A successor of coverage x after a node of coverage y is
 * admitted when
 *
 *     max(trunc(y / r), c + 1) <= x <= min(trunc(y * r), KC_MAX)
 *
 * and a strand is emitted when exactly one complete path passes the CRC. Whether
 * the designed path survives that walk is therefore a function of its coverage
 * alone, so it can be evaluated for every strand without any path search.
 *
 * Two walk variants are modelled. With the extra step, as DBGPS2 implements it,
 * the walk takes one more extension than the strand needs: no admissible
 * successor loses the strand, and two make the identical 164-nt candidate appear
 * twice so the CRC cannot pick one. The other variant stops at the path end.
 * Waived k-mers keep the cutoff but skip the ratio test when entered, for known
 * coverage steps such as read-length boundaries.
 *
 * Pure functions only: no hash table, so tests/unit_core.c exercises the rule
 * directly. Include after dstoreqc_core.h, which defines KC_MAX. */
#ifndef DSTOREQC_DECODABILITY_H
#define DSTOREQC_DECODABILITY_H

#define DQ_MAX_WAIVE 16

typedef enum {
    DQ_OK = 0,
    DQ_SEED_MISSING,        /* seed k-mer never observed */
    DQ_MISSING,             /* designed k-mer never observed */
    DQ_BELOW_CUTOFF,        /* observed, but not above the cutoff */
    DQ_RATIO_DROP,          /* coverage fell by more than the ratio window */
    DQ_RATIO_RISE,          /* coverage rose by more than the ratio window */
    DQ_EXTRA_STEP_NONE,     /* extra step found no admissible successor */
    DQ_EXTRA_STEP_AMBIGUOUS,/* extra step found several, duplicating the path */
    DQ_TOO_SHORT,           /* strand cannot hold the walk */
    DQ_INVALID_BASE,        /* non-ACGT base inside the walk */
    DQ_FAILURE_KINDS
} dq_failure_t;

static const char *const dq_failure_names[DQ_FAILURE_KINDS] DSTOREQC_UNUSED = {
    "ok", "seed_missing", "missing", "below_cutoff", "ratio_drop", "ratio_rise",
    "extra_step_none", "extra_step_ambiguous", "too_short", "invalid_base"
};

typedef struct {
    int cutoff;                 /* c: coverage must exceed this */
    double ratio;               /* r: adjacent coverage window, >= 1 */
    int extra_step;             /* model the walk's superfluous final extension */
    int n_waive;
    int waive[DQ_MAX_WAIVE];    /* strand k-mer indices entered without ratio test */
} dq_config_t;

typedef struct {
    dq_failure_t kind;
    int position;               /* strand k-mer index of the failure; -1 when none */
} dq_verdict_t;

/* Identical arithmetic to the decoder, including truncation toward zero. */
static inline int dq_admits(int prev, int next, int cutoff, double ratio, int waived)
{
    if (waived) return next >= cutoff + 1;
    int low = (int)(prev / ratio);
    if (low < cutoff + 1) low = cutoff + 1;
    double upper = prev * ratio;
    int high = upper > KC_MAX ? KC_MAX : (int)upper;
    return next >= low && next <= high;
}

static inline int dq_is_waived(const dq_config_t *c, int kmer_index)
{
    for (int i = 0; i < c->n_waive; ++i)
        if (c->waive[i] == kmer_index) return 1;
    return 0;
}

/* Why the step from coverage prev to next is refused; call only when it is. */
static inline dq_failure_t dq_step_failure(int prev, int next, int cutoff, double ratio)
{
    if (next == 0) return DQ_MISSING;
    if (next < cutoff + 1) return DQ_BELOW_CUTOFF;
    return next < (int)(prev / ratio) ? DQ_RATIO_DROP : DQ_RATIO_RISE;
}

/* cov[0..n-1]: designed path from the seed; seed_kmer: its strand k-mer index;
 * successors[0..3]: coverage of all four extensions of the last path k-mer,
 * read only when config->extra_step is set. */
static inline dq_verdict_t dq_evaluate(const int *cov, int n, int seed_kmer,
                                       const int *successors, const dq_config_t *config)
{
    dq_verdict_t verdict = {DQ_OK, -1};
    if (cov[0] == 0) {
        verdict.kind = DQ_SEED_MISSING;
        verdict.position = seed_kmer;
        return verdict;
    }
    for (int i = 1; i < n; ++i) {
        int waived = dq_is_waived(config, seed_kmer + i);
        if (dq_admits(cov[i - 1], cov[i], config->cutoff, config->ratio, waived)) continue;
        verdict.kind = dq_step_failure(cov[i - 1], cov[i], config->cutoff, config->ratio);
        verdict.position = seed_kmer + i;
        return verdict;
    }
    if (config->extra_step) {
        int admitted = 0;
        for (int b = 0; b < 4; ++b)
            admitted += dq_admits(cov[n - 1], successors[b], config->cutoff, config->ratio, 0);
        if (admitted != 1) {
            verdict.kind = admitted == 0 ? DQ_EXTRA_STEP_NONE : DQ_EXTRA_STEP_AMBIGUOUS;
            verdict.position = seed_kmer + n;
        }
    }
    return verdict;
}

#endif
