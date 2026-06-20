#include <stdio.h>
#include <stdint.h>
#include <zlib.h>
#include <stdlib.h>
#include <inttypes.h>
#include <time.h>
#include <string.h>
#include <ctype.h>
#include <sys/types.h>

#include "ketopt.h" // command-line argument parser
#include "kthread.h" // multi-threading models: pipeline and multi-threaded for loop


#include "kseq.h" // FASTA/Q parser
KSEQ_INIT(gzFile, gzread)

#include "khashl.h" // hash table
#define KC_BITS 14
#define KC_MAX ((1<<KC_BITS) - 1)
#define kc_c4_eq(a, b) ((a)>>KC_BITS == (b)>>KC_BITS) // lower 10 bits for counts; higher bits for k-mer
#define kc_c4_hash(a) ((a)>>KC_BITS)

#define Max_Path_Num 10000
#define Max_Path_Len 300
#define Max_Kmer_Tree_Depth 6
#define Max_Index_Start_Kmers 32
#define Max_Index_Enumerate_Bases 10
// Removed Max_Cov_Ratio define, now using a variable instead


KHASHL_SET_INIT(, kc_c4_t, kc_c4, uint64_t, kc_c4_hash, kc_c4_eq)

#define CALLOC(ptr, len) ((ptr) = (__typeof__(ptr))calloc((len), sizeof(*(ptr))))
#define MALLOC(ptr, len) ((ptr) = (__typeof__(ptr))malloc((len) * sizeof(*(ptr))))
#define REALLOC(ptr, len) ((ptr) = (__typeof__(ptr))realloc((ptr), (len) * sizeof(*(ptr))))

typedef struct {
    char base;
    char *kmer;
    int coverage;
} kmer_branch_t;

typedef struct {
    char *kmer;
    int coverage;
} start_kmer_t;

typedef struct {
    start_kmer_t items[Max_Index_Start_Kmers];
    int count;
    int max_coverage;
    int limited;
} start_kmer_list_t;

static int clamp_tree_depth(int depth);

const unsigned char seq_nt4_table[256] = { // translate ACGT to 0123
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
        4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4,  4, 4, 4, 4
};

const unsigned char nt4_seq_table[4] = { // translate 0123 to ACGT
        'A', 'C', 'G', 'T'};


static inline uint64_t hash64(uint64_t key, uint64_t mask) // invertible integer hash function
{
    key = (~key + (key << 21)) & mask; // key = (key << 21) - key - 1;
    key = key ^ key >> 24;
    key = ((key + (key << 3)) + (key << 8)) & mask; // key * 265
    key = key ^ key >> 14;
    key = ((key + (key << 2)) + (key << 4)) & mask; // key * 21
    key = key ^ key >> 28;
    key = (key + (key << 31)) & mask;
    return key;
}

// The inversion of hash64(). Modified from <https://naml.us/blog/tag/invertible>
static inline uint64_t hash64i(uint64_t key, uint64_t mask) //
{
    uint64_t tmp;
    // Invert key = key + (key << 31)
    tmp = (key - (key << 31)); 	key = (key - (tmp << 31)) & mask;
    // Invert key = key ^ (key >> 28)
    tmp = key ^ key >> 28; 	key = key ^ tmp >> 28;
    // Invert key *= 21
    key = (key * 14933078535860113213ull) & mask;
    // Invert key = key ^ (key >> 14)
    tmp = key ^ key >> 14; 	tmp = key ^ tmp >> 14; 	tmp = key ^ tmp >> 14; 	key = key ^ tmp >> 14;
    // Invert key *= 265
    key = (key * 15244667743933553977ull) & mask;
    // Invert key = key ^ (key >> 24)
    tmp = key ^ key >> 24; 	key = key ^ tmp >> 24;
    // Invert key = (~key) + (key << 21)
    tmp = ~key; 	tmp = ~(key - (tmp << 21)); tmp = ~(key - (tmp << 21)); key = ~(key - (tmp << 21)) & mask;
    return key;
}


unsigned char* uint64_acgt(uint64_t key, unsigned char* seq, unsigned char km_len){ //decode uint_64_t kmer  to actg
    int p = km_len-1;
    while (p >= 0){
        int n = key % 4;
        key = key >> 2;
        *(seq + p) = nt4_seq_table[n];
        p = p - 1;
    }
    return seq;
}

unsigned char* uint64_int8(uint64_t key, unsigned char* seq){
    //decode uint_64_t kmer  to  char

    uint64_t mask = (1ULL<<8)-1;
    int i =0;
    for(i =0; i< 8; i++){
        *(seq+7-i) = key & mask;
        mask = mask <<8;
    }
    return seq;
}



uint64_t comp_rev2(uint64_t x, unsigned char km_len){
    uint64_t a, b=0ULL, mask = (1ULL<<km_len*2) - 1;

    a = ~x; a = a & mask;
    while((a & mask) > 0 ){
        b = b<<2;
        b = b + (a & 3ULL);
        a = a>>2;
    }
//    b = ~b;
    b = b & mask;
    return b;
}


uint64_t comp_rev(uint64_t x, unsigned char km_len){
//    if (c < 4) { // not an "N" base
//        x[0] = (x[0] << 2 | c) & mask;                  // forward strand
//        x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;
//    uint64_t y=0;// mask = (1ULL << km_len * 2) - 1;
    uint64_t y=0;
    int i, c;
    for(i=0;i<km_len;i++){
        y = y << 2;
        c = x & 3ULL;
        y = y | (3-c);
        x = x >> 2;
    }
    return y;
}


uint64_t min_hash_key(uint64_t x, unsigned char km_len){
    uint64_t y = comp_rev(x, km_len);
    return (x < y) ? x:y;
}


uint64_t actgkmer_uint64(unsigned char* seq, unsigned char km_len){
//    Just for testing
//// Function verified 20210708 Lifu Song
    int i;
    uint64_t x, mask = (1ULL<<km_len*2) - 1; //shift = (km_len - 1) * 2
    for (i = 0, x = 0; i < km_len; ++i) {
        //fprintf(stdout, "%c ", seq[i]);
        int c = seq_nt4_table[(uint8_t)seq[i]];
        //fprintf(stdout, "%d ", c);
        if (c < 4) { // not an "N" base
            x = (x << 2 | c) & mask;                  // forward strand
//            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;  // reverse strand
        } else x = 0; // if there is an "N", restart
    }

    //fprintf(stdout, "y %ld\n", x);
    return x;
}


uint64_t actgkmer_hashkey(unsigned char* seq, unsigned char km_len){
//// Function verified 20210708 Lifu Song
    int i;
    uint64_t x[2], y,  shift = (km_len - 1) * 2, mask = (1ULL<<km_len*2) - 1;
    for (i = 0, x[0] = x[1] = 0; i < km_len; ++i) {
        //fprintf(stdout, "%c ", seq[i]);
        int c = seq_nt4_table[(uint8_t)seq[i]];
        //fprintf(stdout, "%d ", c);
        if (c < 4) { // not an "N" base
            x[0] = (x[0] << 2 | c) & mask;                  // forward strand
            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;  // reverse strand
        } else x[0] = x[1] = 0; // if there is an "N", restart
    }
    y = x[0] < x[1]? x[0] : x[1];
    //fprintf(stdout, "y %ld\n", y);
    return y;
}

unsigned long uint8_actg(unsigned char bts){
    unsigned int i=0;
    unsigned long four_base_seq=0;

    for(i =0 ; i < 4; ++i){
        int m = bts & 3;
        bts = bts >>2;
        four_base_seq =four_base_seq >>8;
        four_base_seq = four_base_seq + ((unsigned long)nt4_seq_table[m]<< 24);
    }
    return four_base_seq;
}


unsigned char actg_uint8(unsigned long actg_seq){
    unsigned int i=0;
    unsigned char uint8_value=0;

    for(i =0 ; i < 4; ++i){
        unsigned int m = actg_seq & 255;
        actg_seq = actg_seq >> 8;
        uint8_value = uint8_value >> 2;
        uint8_value = uint8_value + ((unsigned char)seq_nt4_table[m]<<6);
    }
    return uint8_value;
}

void actg_intseq(unsigned char* actg_seq, unsigned char* int_seq, int8_t actg_seq_len){

    int p = 0;
    unsigned long n, n1, n2, n3, n4;
    while(p < actg_seq_len-3){
        n1 = actg_seq[p];
        n2 = actg_seq[p+1];
        n3 = actg_seq[p+2];
        n4 = actg_seq[p+3];
        n = (n1<<24) + (n2<<16) + (n3<<8) + n4;
        int_seq[p>>2] = actg_uint8(n) ;
        p = p + 4;
    }
    int_seq[p + 1] = '\0';
}


void intseq_actg(unsigned char* int_seq, unsigned char* actg_seq, int8_t int_seq_len){
//// int seq to DNA seq
//// Function not tested yet
//// one char(byte) to four bases
    int p = 0;
    unsigned long n, mask;

    unsigned char n1, n2, n3, n4;
    while(p < int_seq_len){
        mask= (1<<8) - 1;
        n = uint8_actg(int_seq[p]) ;
        n4 = (n & mask);
        mask = mask <<8;
        n3 = (n & mask)>>8;
        mask = mask <<8;
        n2 = (n & mask)>>16;
        mask = mask <<8;
        n1 = (n & mask)>>24;

        actg_seq[p<<2] = n1;
        actg_seq[(p<<2) + 1] = n2;
        actg_seq[(p<<2) + 2] = n3;
        actg_seq[(p<<2) + 3] = n4;
        p = p + 1;
    }
}

typedef struct {
    int p; // suffix length; at least 8
    kc_c4_t **h; // 1<<p hash tables
} kc_c4x_t;

static kc_c4x_t *c4x_init(int p)
{
    int i;
    kc_c4x_t *h;
    CALLOC(h, 1);
    MALLOC(h->h, 1<<p);
    h->p = p;
    for (i = 0; i < 1<<p; ++i)
        h->h[i] = kc_c4_init();
    return h;
}

static void c4x_destroy(kc_c4x_t *h)
{
    if (h == 0) return;
    for (int i = 0; i < 1<<h->p; ++i) {
        kc_c4_destroy(h->h[i]);
    }
    free(h->h);
    free(h);
}

typedef struct {
    int n, m;
    uint64_t *a;
} buf_c4_t;


static inline void c4x_insert_buf(buf_c4_t *buf, int p, uint64_t y) // insert a k-mer $y to a linear buffer
{
    int pre = y & ((1<<p) - 1);
    buf_c4_t *b = &buf[pre];
    if (b->n == b->m) {
        b->m = b->m < 8? 8 : b->m + (b->m>>1);
        REALLOC(b->a, b->m);
    }
    b->a[b->n++] = y;
}

static void count_seq_buf(buf_c4_t *buf, int k, int p, int len, const char *seq) // insert k-mers in $seq to linear buffer $buf
{
    int i, l;
    uint64_t x[2], mask = (1ULL<<k*2) - 1, shift = (k - 1) * 2;
    for (i = l = 0, x[0] = x[1] = 0; i < len; ++i) {
        int c = seq_nt4_table[(uint8_t)seq[i]];
        if (c < 4) { // not an "N" base
            x[0] = (x[0] << 2 | c) & mask;                  // forward strand
            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;  // reverse strand
            if (++l >= k) { // we find a k-mer
                uint64_t y = x[0] < x[1]? x[0] : x[1];
                c4x_insert_buf(buf, p, hash64(y, mask));
            }
        } else l = 0, x[0] = x[1] = 0; // if there is an "N", restart
    }
}

typedef struct { // global data structure for kt_pipeline()
    int k, block_len, n_thread, read_len;
    kseq_t *ks;
    kc_c4x_t *h;
} pldat_t;

typedef struct { // data structure for each step in kt_pipeline()
    pldat_t *p;
    int n, m, sum_len, nk;
    int *len;
    char **seq;
    buf_c4_t *buf;
} stepdat_t;

static void worker_for(void *data, long i, int tid) // callback for kt_for()
{
    stepdat_t *s = (stepdat_t*)data;
    buf_c4_t *b = &s->buf[i];
    kc_c4_t *h = s->p->h->h[i];

    int j, p = s->p->h->p;
    for (j = 0; j < b->n; ++j) {
        khint_t k;
        int absent;
        k = kc_c4_put(h, b->a[j]>>p<<KC_BITS, &absent);
        if ((kh_key(h, k)&KC_MAX) < KC_MAX) ++kh_key(h, k);
    }
}

static void *worker_pipeline(void *data, int step, void *in) // callback for kt_pipeline()
{
    pldat_t *p = (pldat_t*)data;
    if (step == 0) { // step 1: read a block of sequences
        int ret;
        stepdat_t *s;
        CALLOC(s, 1);
        s->p = p;
        while ((ret = kseq_read(p->ks)) >= 0) {
            int l = p->ks->seq.l;
            if (l < p->k) continue;
            if (s->n == s->m) {
                s->m = s->m < 16? 16 : s->m + (s->n>>1);
                REALLOC(s->len, s->m);
                REALLOC(s->seq, s->m);
            }
            MALLOC(s->seq[s->n], l);
            memcpy(s->seq[s->n], p->ks->seq.s, l);
            s->len[s->n++] = l;
            s->sum_len += l;
            s->nk += l - p->k + 1;
            if (s->sum_len >= p->block_len)
                break;
        }
        if (s->sum_len == 0) free(s);
        else return s;
    } else if (step == 1) { // step 2: extract k-mers
        stepdat_t *s = (stepdat_t*)in;
        int i, n = 1<<p->h->p, m;
        CALLOC(s->buf, n);
        m = (int)(s->nk * 1.2 / n) + 1;
        for (i = 0; i < n; ++i) {
            s->buf[i].m = m;
            MALLOC(s->buf[i].a, m);
        }
        for (i = 0; i < s->n; ++i) {
            //read_len
            if(p->read_len > 0 && p->read_len < s->len[i]){
                count_seq_buf(s->buf, p->k, p->h->p, p->read_len, s->seq[i]);
            }else{
                count_seq_buf(s->buf, p->k, p->h->p, s->len[i], s->seq[i]);
            }
            free(s->seq[i]);
        }
        free(s->seq); free(s->len);
        return s;
    } else if (step == 2) { // step 3: insert k-mers to hash table
        stepdat_t *s = (stepdat_t*)in;
        int i, n = 1<<p->h->p;
        kt_for(p->n_thread, worker_for, s, n);
        for (i = 0; i < n; ++i) free(s->buf[i].a);
        free(s->buf); free(s);
    }
    return 0;
}



static kc_c4x_t *count_file(const char *fn, int k, int p, int block_size, int n_thread, int read_len)
{
    pldat_t pl;
    gzFile fp;
    if ((fp = gzopen(fn, "r")) == 0) return 0;
    pl.ks = kseq_init(fp);
    pl.k = k;
    if(read_len > k){
        pl.read_len = read_len;
    }else{
        pl.read_len = k;
    }

    pl.n_thread = n_thread;
    pl.h = c4x_init(p);
    pl.block_len = block_size;
    kt_pipeline(3, worker_pipeline, &pl, 3);
    kseq_destroy(pl.ks);
    gzclose(fp);
    return pl.h;
}

static kc_c4x_t *count_file2(const char *fn, void *hh, int k, int p, int block_size, int n_thread, int read_len)
{
    pldat_t pl;
    gzFile fp;
    if ((fp = gzopen(fn, "r")) == 0) return 0;
    pl.ks = kseq_init(fp);
    pl.k = k;
    if(read_len > k){
        pl.read_len = read_len;
    }else{
        pl.read_len = k;
    }

    pl.n_thread = n_thread;
    pl.h = (kc_c4x_t *)hh;
    pl.block_len = block_size;
    kt_pipeline(3, worker_pipeline, &pl, 3);
    kseq_destroy(pl.ks);
    gzclose(fp);
    return pl.h;
}

// Add a structure to store ratio range information
typedef struct {
    int max_positions;    // Maximum number of positions tracked
    int positions;        // Current number of positions tracked
    double *min_ratios;   // Array of minimum ratios for each position
    double *max_ratios;   // Array of maximum ratios for each position
    int initialized;      // Flag to indicate if min/max values are initialized
} ratio_range_t;

// Function to initialize ratio range data structure
ratio_range_t* init_ratio_range() {
    ratio_range_t *range;
    CALLOC(range, 1);
    range->max_positions = 1000; // Start with space for 1000 positions
    range->positions = 0;
    MALLOC(range->min_ratios, range->max_positions);
    MALLOC(range->max_ratios, range->max_positions);
    range->initialized = 0;
    return range;
}

// Function to update ratio range with a new set of ratios
void update_ratio_range(ratio_range_t *range, double *ratios, int count) {
    if (count <= 0) return;
    
    // Resize arrays if needed
    if (count > range->max_positions) {
        range->max_positions = count * 2; // Double the size
        REALLOC(range->min_ratios, range->max_positions);
        REALLOC(range->max_ratios, range->max_positions);
    }
    
    // Update positions count if this sequence has more positions
    if (count > range->positions) {
        range->positions = count;
    }
    
    // Initialize or update min/max values
    if (!range->initialized) {
        // First sequence, just copy the values
        for (int i = 0; i < count; i++) {
            range->min_ratios[i] = ratios[i];
            range->max_ratios[i] = ratios[i];
        }
        range->initialized = 1;
    } else {
        // Update min/max values
        for (int i = 0; i < count; i++) {
            if (i < range->positions) {
                if (ratios[i] < range->min_ratios[i]) {
                    range->min_ratios[i] = ratios[i];
                }
                if (ratios[i] > range->max_ratios[i]) {
                    range->max_ratios[i] = ratios[i];
                }
            }
        }
    }
}

// Function to write ratio range to file
void write_ratio_range(FILE *fp, ratio_range_t *range) {
    if (!range || !range->initialized) return;
    
    // Write min values
    for (int i = 0; i < range->positions; i++) {
        fprintf(fp, "%.3f ", range->min_ratios[i]);
    }
    fprintf(fp, "\n");
    
    // Write max values
    for (int i = 0; i < range->positions; i++) {
        fprintf(fp, "%.3f ", range->max_ratios[i]);
    }
    fprintf(fp, "\n");
}

// Function to free ratio range data
void free_ratio_range(ratio_range_t *range) {
    if (!range) return;
    free(range->min_ratios);
    free(range->max_ratios);
    free(range);
}

// Modify the evaluation_t structure to include skip_ratios
typedef struct { // data structure for file evaluation
    kc_c4x_t *h;
    int cov_cut;
    double max_cov_ratio; // Added to store the max coverage ratio
    int skip_ratios;      // Number of initial ratios to skip
    double kn, kd, sm;
    int strand_num, exist_strand_num;
    int lose_km_num, exist_km_num;
    int noise_km_num;
    ratio_range_t *ratio_range; // Added for ratio range tracking

} evaluation_t;

unsigned short kmer_cov(uint64_t kmer, uint64_t mask, kc_c4x_t *h){

    int j, x, cov=0;
    uint64_t hash_key = hash64(kmer, mask);
    j = hash_key & ((1<<KC_BITS) - 1);
    if(kh_size(h->h[j]) < 1){return 0;}

    hash_key = hash_key >> KC_BITS<< KC_BITS;

    x = kc_c4_get(h->h[j], hash_key);
    //if(x == 0){if(kh_size(h->h[j]) < 1){return 0;}} //To avoid of segment fault
    if(kh_exist(h->h[j], x)){
        cov = kh_key(h->h[j], x) & KC_MAX;
    }
    return cov;
}


static inline void add_kmer(uint64_t y, uint64_t mask, kc_c4x_t *h) //add k-mer to hash set
{
    int p = h->p;
    uint64_t y_hash = hash64(y, mask);
    int pre = y_hash & ((1<<p) - 1);

    khint_t k;
//        fprintf(stdout, "work for j %d\t", i);
    int absent;
    k = kc_c4_put(h->h[pre], y_hash>>p<<KC_BITS, &absent);
    ++kh_key(h->h[pre], k);
    //if ((kh_key(h[pre], k)&KC_MAX) < KC_MAX) ++kh_key(h[pre], k);

}

int insert_kms(uint64_t *kms, uint64_t y, int km_num) // insert a k-mer $y to a linear buffer
{
    int i;
    for(i=0; i< km_num; i++){
       if(y == *(kms + i)){
            return km_num;
       }
    }
    *(kms + km_num) = y;
    return km_num + 1;
}

int kms_max_cov(uint64_t *kms, int km_num, uint64_t mask, kc_c4x_t *h){
    int i, max_cov=0;
    //fprintf(stdout, "func kms_max_cov\n");
    for(i=0; i<km_num; i++){
            //printf("");
            //fprintf(stdout, "uint64: %"PRIu64, *(kms+i));
            //fprintf(stdout, "\n");
            int cov = kmer_cov(*(kms+i), mask, h);
            if(cov > max_cov){max_cov=cov;}
    }
    //printf("km_num: %d\n", km_num);
    //printf("max cov: %d\n", max_cov);
    return max_cov;
}

int kms_min_cov(uint64_t *kms, int km_num, uint64_t mask, kc_c4x_t *h){
    int i, min_cov=100;
    //fprintf(stdout, "func kms_max_cov\n");
    for(i=0; i<km_num; i++){
            //printf("");
            //fprintf(stdout, "uint64: %"PRIu64, *(kms+i));
            //fprintf(stdout, "\n");
            int cov = kmer_cov(*(kms+i), mask, h);
            //fprintf(stderr, "cov: %d\n", cov);
            if(cov < min_cov){min_cov=cov;}
    }
    //printf("km_num: %d\n", km_num);
    //printf("max cov: %d\n", max_cov);
    return min_cov;
}

int seq_kmers(uint64_t *kms, int k, int len, const char *seq) // insert k-mers in $seq to linear buffer $buf
{
    int i, l, km_num=0;
    uint64_t x[2], mask = (1ULL<<k*2) - 1, shift = (k - 1) * 2;
    for (i = l = 0, x[0] = x[1] = 0; i < len; ++i) {
        int c = seq_nt4_table[(uint8_t)seq[i]];
        if (c < 4) { // not an "N" base
            x[0] = (x[0] << 2 | c) & mask;                  // forward strand
            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;  // reverse strand
            if (++l >= k) { // we find a k-mer
                uint64_t y = x[0] < x[1]? x[0] : x[1];
                km_num = insert_kms(kms, y, km_num);
                //c4x_insert_buf(buf, p, hash64(y, mask));
            }
        } else l = 0, x[0] = x[1] = 0; // if there is an "N", restart
    }
    return km_num;
}

// Add a function to output k-mer coverages for a sequence
void output_kmer_coverages(FILE *fp, char *seq_name, uint64_t *kms, int km_num, uint64_t mask, kc_c4x_t *h) {
    fprintf(fp, "%s\t", seq_name);
    for (int i = 0; i < km_num; i++) {
        int cov = kmer_cov(*(kms+i), mask, h);
        fprintf(fp, "%d ", cov);
    }
    fprintf(fp, "\n");
}

// Modify the output_coverage_ratios function to return the ratios
double* output_coverage_ratios(FILE *fp, char *seq_name, uint64_t *kms, int km_num, uint64_t mask, kc_c4x_t *h, int *ratio_count) {
    fprintf(fp, "%s\t", seq_name);
    
    if (km_num < 2) {
        fprintf(fp, "\n");
        *ratio_count = 0;
        return NULL;
    }
    
    int *coverages;
    MALLOC(coverages, km_num);
    
    // First get all coverage values
    for (int i = 0; i < km_num; i++) {
        coverages[i] = kmer_cov(*(kms+i), mask, h);
    }
    
    // Allocate memory for ratios
    double *ratios;
    *ratio_count = km_num - 1; // Number of ratios is km_num - 1
    MALLOC(ratios, *ratio_count);
    
    // Then calculate and output ratios
    for (int i = 0; i < *ratio_count; i++) {
        int a = coverages[i];
        int b = coverages[i+1];
        
        // Always larger number / smaller number
        if (a >= b && b > 0) {
            ratios[i] = (double)a / b;
        } else if (b > a && a > 0) {
            ratios[i] = (double)b / a;
        } else if (a == 0 && b == 0) {
            ratios[i] = 1.0; // Both zero, ratio is 1
        } else {
            ratios[i] = 0.0; // One is zero, can't calculate ratio
        }
        
        fprintf(fp, "%.3f ", ratios[i]);
    }
    
    fprintf(fp, "\n");
    free(coverages);
    
    return ratios;
}

// Update the function prototype for kms_max_ratio to include skip_ratios parameter
double kms_max_ratio(uint64_t *kms, int km_num, uint64_t mask, kc_c4x_t *h, int skip_ratios);

// Modify the kms_max_ratio function to skip initial ratio values
double kms_max_ratio(uint64_t *kms, int km_num, uint64_t mask, kc_c4x_t *h, int skip_ratios) {
    if (km_num < 2) return 0.0;
    
    double max_ratio = 0.0; // Start with a very low initial value
    int prev_cov = kmer_cov(kms[0], mask, h);
    int ratios_counted = 0;
    
    for (int i = 1; i < km_num; i++) {
        int curr_cov = kmer_cov(kms[i], mask, h);
        
        // Return 0.0 if either coverage is zero
        if (prev_cov == 0 || curr_cov == 0) {
            prev_cov = curr_cov;
            return 0.0;
        }
        
        // Calculate ratio (always larger / smaller)
        double ratio;
        if (prev_cov >= curr_cov) {
            ratio = (double)prev_cov / curr_cov;
        } else {
            ratio = (double)curr_cov / prev_cov;
        }
        
        // Skip the first skip_ratios valid ratios
        ratios_counted++;
        if (ratios_counted <= skip_ratios) {
            prev_cov = curr_cov;
            continue;
        }
        
        // Update maximum ratio if this one is larger
        if (ratio > max_ratio) {
            max_ratio = ratio;
        }
        
        prev_cov = curr_cov;
    }
    
    return max_ratio;
}

// Update the eva_pipeline function to fix the k-mer counting issue
static void eva_pipeline(void *data, evaluation_t *eva, FILE *cov_details_fp, FILE *cov_ratios_fp, kc_c4x_t *global_kmer_tracker) {
    pldat_t *p = (pldat_t*)data;
    uint64_t mask = (1ULL<<p->k*2) - 1;
    
    int ret;
    // Reuse coverage array to avoid repeated allocations
    int *coverages = NULL;
    int coverages_cap = 0;

    while ((ret = kseq_read(p->ks)) >= 0) {// Reading seqs
        eva->strand_num++;
        uint64_t *kms;
        int l = p->ks->seq.l, km_num = 0, strand_kms_min_cov=0;
        double strand_max_ratio = 0.0;
        
        if (l < p->k) continue;
        MALLOC(kms, l-p->k + 1); //
        km_num = seq_kmers(kms, p->k, l, p->ks->seq.s);
        
        // Ensure coverage array is large enough
        if (km_num > coverages_cap) {
            coverages_cap = km_num * 2;
            REALLOC(coverages, coverages_cap);
        }
        
        // Cache all k-mer coverages in one pass to avoid repeated lookups
        for (int i = 0; i < km_num; i++) {
            coverages[i] = kmer_cov(kms[i], mask, eva->h);
        }
        
        // Calculate min coverage from cached values
        strand_kms_min_cov = coverages[0];
        for (int i = 1; i < km_num; i++) {
            if (coverages[i] < strand_kms_min_cov) {
                strand_kms_min_cov = coverages[i];
            }
        }
        
        // Calculate max ratio from cached values
        if (km_num >= 2) {
            int ratios_counted = 0;
            strand_max_ratio = 0.0;
            for (int i = 1; i < km_num; i++) {
                // Return 0.0 if either coverage is zero
                if (coverages[i-1] == 0 || coverages[i] == 0) {
                    strand_max_ratio = 0.0;
                    break;
                }
                
                // Calculate ratio (always larger / smaller)
                double ratio = (coverages[i-1] >= coverages[i]) ? 
                    (double)coverages[i-1] / coverages[i] : 
                    (double)coverages[i] / coverages[i-1];
                
                // Skip the first skip_ratios valid ratios
                ratios_counted++;
                if (ratios_counted <= eva->skip_ratios) {
                    continue;
                }
                
                // Update maximum ratio if this one is larger
                if (ratio > strand_max_ratio) {
                    strand_max_ratio = ratio;
                }
            }
        }

        // Output coverage details if file pointer is provided
        if (cov_details_fp != NULL) {
            fprintf(cov_details_fp, "%s\t", p->ks->name.s);
            for (int i = 0; i < km_num; i++) {
                fprintf(cov_details_fp, "%d ", coverages[i]);
            }
            fprintf(cov_details_fp, "\n");
        }
        
        // Output coverage ratios if file pointer is provided
        if (cov_ratios_fp != NULL && km_num >= 2) {
            fprintf(cov_ratios_fp, "%s\t", p->ks->name.s);
            
            // Allocate memory for ratios
            double *ratios;
            int ratio_count = km_num - 1;
            MALLOC(ratios, ratio_count);
            
            // Calculate and output ratios
            for (int i = 0; i < ratio_count; i++) {
                int a = coverages[i];
                int b = coverages[i+1];
                
                // Always larger number / smaller number
                if (a >= b && b > 0) {
                    ratios[i] = (double)a / b;
                } else if (b > a && a > 0) {
                    ratios[i] = (double)b / a;
                } else if (a == 0 && b == 0) {
                    ratios[i] = 1.0; // Both zero, ratio is 1
                } else {
                    ratios[i] = 0.0; // One is zero, can't calculate ratio
                }
                
                fprintf(cov_ratios_fp, "%.3f ", ratios[i]);
            }
            fprintf(cov_ratios_fp, "\n");
            
            // Update ratio range if we have valid ratios
            if (ratios && ratio_count > 0 && eva->ratio_range) {
                update_ratio_range(eva->ratio_range, ratios, ratio_count);
            }
            free(ratios);
        }

        // Modified condition: Check both coverage and ratio for path existence
        // A path exists if minimum coverage is above cov_cut AND:
        // - If max_cov_ratio is 0, no ratio limitation is applied
        // - If max_cov_ratio > 0, the maximum ratio must be below max_cov_ratio
        if (strand_kms_min_cov > eva->cov_cut && (eva->max_cov_ratio <= 1.0 || (strand_max_ratio > 1.0 && strand_max_ratio <= eva->max_cov_ratio))) {
            eva->exist_strand_num++;
        }
        
        // Track k-mers using cached coverages
        for(int j=0;j<km_num;j++){
            // Use global_kmer_tracker to ensure each k-mer is only counted once across all sequences
            if(kmer_cov(kms[j], mask, global_kmer_tracker) < 1) {//New k-mer found globally
                add_kmer(kms[j], mask, global_kmer_tracker);
                if(coverages[j] > eva->cov_cut){
                    eva->exist_km_num++;
                }else{
                    eva->lose_km_num++;
                }
            }
        }
        
        free(kms);
    }
    
    free(coverages);
}

// Modify the evaluate_seq_file function to support coverage details output
static evaluation_t *evaluate_seq_file(evaluation_t *eva, const char *fn, int k, int p, int block_size, int n_thread, FILE *cov_details_fp, FILE *cov_ratios_fp, kc_c4x_t *global_kmer_tracker)
{
    pldat_t pl;

    gzFile fp; 
    if ((fp = gzopen(fn, "r")) == 0) return 0;
    pl.ks = kseq_init(fp);
    pl.k = k;
    pl.n_thread = n_thread; //multiple threads is not supported yet.
    pl.h = c4x_init(p);
    pl.block_len = block_size;

    eva_pipeline(&pl, eva, cov_details_fp, cov_ratios_fp, global_kmer_tracker);
    kseq_destroy(pl.ks);
    gzclose(fp);
    return eva;
}

void print_uint64_kmer(uint64_t km, int km_len){
    fprintf(stdout, "uint64: %"PRIu64, km);
   fprintf(stdout, " rev: %"PRIu64, comp_rev(km, km_len));
   fprintf(stdout, " minHash: %"PRIu64, min_hash_key(km,km_len));
    unsigned char seq[33];
    seq[32] = '\0';
    uint64_acgt(km, seq, km_len);
    fprintf(stdout, "\tkm: %s\n", seq);

}

void print_kmer_seq(unsigned char *seq, int k){ //Debugging function
    int i=0;
    for(i=0;i<k;i++){
            printf("%c", *(seq + i));
    }
}

void print_cov(unsigned char* seq, int k, kc_c4x_t *h){ //Debugging function
    uint64_t mask = (1ULL<<k*2) - 1;
    int test_cov=0;
    test_cov = kmer_cov( actgkmer_hashkey(seq, k), mask, h);
    print_kmer_seq(seq, k);
    printf("\t");
    printf("cov: %d\n", test_cov);
}

int kc_c4x_t_size(kc_c4x_t *h, int p){
    int total_size = 0, i;
    for(i = 0; i < 1<<p; ++i) {
        total_size = total_size + kh_size(h->h[i]);
    }
    return total_size;
}

int kc_c4x_t_kmers(kc_c4x_t *h, int p, int cov){
    int j, total_size = 0;
    if(cov < 1){return kc_c4x_t_size(h,p);}
    
    for (j=0; j < 1<<p; ++j){
        kc_c4_t *g = h->h[j];
        khint_t kk;
        for (kk = 0; kk < kh_end(g); ++kk)
            if (kh_exist(g, kk)){
                int c = kh_key(g, kk) & KC_MAX;
                //c = c < 255? c : 255;
                if (c > cov){ // delete kmers
                   total_size++;
                }
            }
    }
    
    return total_size;
}

static unsigned long long kc_c4x_total_abundance(kc_c4x_t *h)
{
    unsigned long long total = 0;
    if (h == 0) return total;

    for (int j = 0; j < 1<<h->p; ++j) {
        kc_c4_t *g = h->h[j];
        khint_t kk;
        for (kk = 0; kk < kh_end(g); ++kk) {
            if (kh_exist(g, kk)) {
                total += (unsigned long long)(kh_key(g, kk) & KC_MAX);
            }
        }
    }

    return total;
}

static void json_string(FILE *fp, const char *s)
{
    fputc('"', fp);
    for (const unsigned char *p = (const unsigned char*)s; *p; ++p) {
        if (*p == '"' || *p == '\\') {
            fputc('\\', fp);
            fputc(*p, fp);
        } else if (*p == '\n') {
            fputs("\\n", fp);
        } else if (*p == '\r') {
            fputs("\\r", fp);
        } else if (*p == '\t') {
            fputs("\\t", fp);
        } else if (*p < 32) {
            fprintf(fp, "\\u%04x", *p);
        } else {
            fputc(*p, fp);
        }
    }
    fputc('"', fp);
}

static void json_string_n(FILE *fp, const char *s, int n)
{
    fputc('"', fp);
    for (int i = 0; i < n; ++i) {
        unsigned char ch = (unsigned char)s[i];
        if (ch == '"' || ch == '\\') {
            fputc('\\', fp);
            fputc(ch, fp);
        } else if (ch == '\n') {
            fputs("\\n", fp);
        } else if (ch == '\r') {
            fputs("\\r", fp);
        } else if (ch == '\t') {
            fputs("\\t", fp);
        } else if (ch < 32) {
            fprintf(fp, "\\u%04x", ch);
        } else {
            fputc(ch, fp);
        }
    }
    fputc('"', fp);
}

static void emit_error_json(const char *message)
{
    fprintf(stdout, "{\"type\":\"error\",\"message\":");
    json_string(stdout, message);
    fprintf(stdout, "}\n");
    fflush(stdout);
}

static char *trim_left(char *s)
{
    while (*s && isspace((unsigned char)*s)) ++s;
    return s;
}

static void trim_right(char *s)
{
    size_t n = strlen(s);
    while (n > 0 && isspace((unsigned char)s[n - 1])) {
        s[--n] = '\0';
    }
}

static int command_equals(const char *a, const char *b)
{
    while (*a && *b) {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
        ++a;
        ++b;
    }
    return *a == '\0' && *b == '\0';
}

static int parse_nonnegative_int_token(char **arg, int fallback, int *out)
{
    char *s;
    char *end;
    long value;

    if (arg == 0 || *arg == 0 || **arg == '\0') {
        *out = fallback;
        return 1;
    }

    s = trim_left(*arg);
    if (*s == '\0') {
        *arg = s;
        *out = fallback;
        return 1;
    }

    value = strtol(s, &end, 10);
    if (end == s || value < 0) return 0;

    *out = clamp_tree_depth((int)value);
    *arg = trim_left(end);
    return 1;
}

static int parse_positive_int_token(char **arg, int fallback, int *out)
{
    char *s;
    char *end;
    long value;

    if (arg == 0 || *arg == 0 || **arg == '\0') {
        *out = fallback;
        return 1;
    }

    s = trim_left(*arg);
    if (*s == '\0') {
        *arg = s;
        *out = fallback;
        return 1;
    }

    value = strtol(s, &end, 10);
    if (end == s || value < 1 || value > Max_Path_Len) return 0;

    *out = (int)value;
    *arg = trim_left(end);
    return 1;
}

static char *normalize_dna_arg(const char *arg, int *out_len, char *err, size_t err_len)
{
    int n = 0;
    char *seq;

    if (arg == 0) {
        snprintf(err, err_len, "missing DNA sequence argument");
        return 0;
    }

    MALLOC(seq, strlen(arg) + 1);
    for (const unsigned char *p = (const unsigned char*)arg; *p; ++p) {
        if (isspace(*p)) continue;
        unsigned char b = (unsigned char)toupper(*p);
        if (b != 'A' && b != 'C' && b != 'G' && b != 'T') {
            snprintf(err, err_len, "invalid DNA base '%c'; only A/C/G/T are supported", *p);
            free(seq);
            return 0;
        }
        seq[n++] = (char)b;
    }

    if (n == 0) {
        snprintf(err, err_len, "empty DNA sequence argument");
        free(seq);
        return 0;
    }

    seq[n] = '\0';
    *out_len = n;
    return seq;
}

static char *copy_dna_slice(const char *seq, int start, int len)
{
    char *out;
    MALLOC(out, len + 1);
    memcpy(out, seq + start, len);
    out[len] = '\0';
    return out;
}

static void canonical_kmer_string(const char *seq, int k, char *canonical)
{
    uint64_t key = actgkmer_hashkey((unsigned char*)seq, (unsigned char)k);
    uint64_acgt(key, (unsigned char*)canonical, (unsigned char)k);
    canonical[k] = '\0';
}

static int kmer_string_coverage(const char *seq, int k, uint64_t mask, kc_c4x_t *h)
{
    uint64_t key = actgkmer_hashkey((unsigned char*)seq, (unsigned char)k);
    return kmer_cov(key, mask, h);
}

static char *index_token_to_dna(const char *token, int *out_len, char *err, size_t err_len)
{
    int digit_count = 0;
    int start = 0;
    int current_len;
    int rev_len = 0;
    int rev_cap;
    unsigned char *digits;
    char *reversed;
    char *seq;

    if (token == 0 || *token == '\0') {
        snprintf(err, err_len, "missing index argument");
        return 0;
    }

    MALLOC(digits, strlen(token) + 1);
    for (const unsigned char *p = (const unsigned char*)token; *p; ++p) {
        if (isspace(*p)) continue;
        if (!isdigit(*p)) {
            snprintf(err, err_len, "invalid decimal index digit '%c'; only 0-9 are supported", *p);
            free(digits);
            return 0;
        }
        digits[digit_count++] = (unsigned char)(*p - '0');
    }

    if (digit_count == 0) {
        snprintf(err, err_len, "empty index argument");
        free(digits);
        return 0;
    }

    while (start < digit_count && digits[start] == 0) ++start;
    if (start == digit_count) {
        MALLOC(seq, 2);
        seq[0] = (char)nt4_seq_table[0];
        seq[1] = '\0';
        *out_len = 1;
        free(digits);
        return seq;
    }

    current_len = digit_count - start;
    memmove(digits, digits + start, current_len);
    rev_cap = digit_count * 2 + 2;
    MALLOC(reversed, rev_cap);

    while (current_len > 0) {
        int carry = 0;
        int write = 0;
        int seen_nonzero = 0;

        for (int i = 0; i < current_len; ++i) {
            int value = carry * 10 + digits[i];
            int quotient = value / 4;
            carry = value % 4;
            if (quotient > 0 || seen_nonzero) {
                digits[write++] = (unsigned char)quotient;
                seen_nonzero = 1;
            }
        }

        if (rev_len + 1 >= rev_cap) {
            rev_cap *= 2;
            REALLOC(reversed, rev_cap);
        }
        reversed[rev_len++] = (char)nt4_seq_table[carry];
        current_len = write;
    }

    MALLOC(seq, rev_len + 1);
    for (int i = 0; i < rev_len; ++i) {
        seq[i] = reversed[rev_len - 1 - i];
    }
    seq[rev_len] = '\0';
    *out_len = rev_len;

    free(reversed);
    free(digits);
    return seq;
}

static char *left_pad_dna_with_a(char *seq, int *len, int target_len)
{
    int pad_len;
    char *padded;

    if (target_len <= *len) return seq;

    pad_len = target_len - *len;
    MALLOC(padded, target_len + 1);
    memset(padded, 'A', pad_len);
    memcpy(padded + pad_len, seq, *len + 1);
    free(seq);
    *len = target_len;
    return padded;
}

static void clear_start_kmer_list(start_kmer_list_t *list)
{
    for (int i = 0; i < list->count; ++i) {
        free(list->items[i].kmer);
        list->items[i].kmer = 0;
    }
    list->count = 0;
    list->max_coverage = 0;
    list->limited = 0;
}

static int start_kmer_exists(start_kmer_list_t *list, const char *kmer)
{
    for (int i = 0; i < list->count; ++i) {
        if (strcmp(list->items[i].kmer, kmer) == 0) return 1;
    }
    return 0;
}

static void add_start_kmer_candidate(start_kmer_list_t *list, const char *kmer, int coverage)
{
    if (coverage <= 0) return;
    if (start_kmer_exists(list, kmer)) return;
    if (list->count >= Max_Index_Start_Kmers) {
        list->limited = 1;
        return;
    }

    list->items[list->count].kmer = copy_dna_slice(kmer, 0, (int)strlen(kmer));
    list->items[list->count].coverage = coverage;
    if (coverage > list->max_coverage) list->max_coverage = coverage;
    ++list->count;
}

static void collect_index_completions_recursive(start_kmer_list_t *list, char *candidate, int pos, int k, uint64_t mask, kc_c4x_t *h)
{
    static const char bases[4] = {'A', 'C', 'G', 'T'};

    if (list->count >= Max_Index_Start_Kmers) {
        list->limited = 1;
        return;
    }

    if (pos == k) {
        candidate[k] = '\0';
        add_start_kmer_candidate(list, candidate, kmer_string_coverage(candidate, k, mask, h));
        return;
    }

    for (int i = 0; i < 4; ++i) {
        candidate[pos] = bases[i];
        collect_index_completions_recursive(list, candidate, pos + 1, k, mask, h);
    }
}

static uint64_t dna_prefix_code(const char *prefix, int prefix_len)
{
    uint64_t code = 0;
    for (int i = 0; i < prefix_len; ++i) {
        code = (code << 2) | (uint64_t)seq_nt4_table[(uint8_t)prefix[i]];
    }
    return code;
}

static int kmer_has_prefix(uint64_t kmer, int k, uint64_t prefix_code, int prefix_len)
{
    int shift = (k - prefix_len) * 2;
    return (kmer >> shift) == prefix_code;
}

static void collect_index_starts_by_scan(start_kmer_list_t *list, kc_c4x_t *h, int k, const char *prefix, int prefix_len, uint64_t mask)
{
    uint64_t prefix_code = dna_prefix_code(prefix, prefix_len);
    char *seq;

    MALLOC(seq, k + 1);

    for (int j = 0; j < 1<<h->p; ++j) {
        kc_c4_t *g = h->h[j];
        khint_t kk;
        for (kk = 0; kk < kh_end(g); ++kk) {
            if (kh_exist(g, kk)) {
                uint64_t stored = kh_key(g, kk);
                int cov = (int)(stored & KC_MAX);
                uint64_t hash_key = ((stored >> KC_BITS) << h->p) | (uint64_t)j;
                uint64_t kmer = hash64i(hash_key, mask);

                if (cov <= 0) continue;

                if (kmer_has_prefix(kmer, k, prefix_code, prefix_len)) {
                    uint64_acgt(kmer, (unsigned char*)seq, (unsigned char)k);
                    seq[k] = '\0';
                    add_start_kmer_candidate(list, seq, cov);
                    if (list->count >= Max_Index_Start_Kmers) {
                        list->limited = 1;
                        goto done;
                    }
                }

                uint64_t rc_kmer = comp_rev(kmer, (unsigned char)k);
                if (rc_kmer != kmer && kmer_has_prefix(rc_kmer, k, prefix_code, prefix_len)) {
                    uint64_acgt(rc_kmer, (unsigned char*)seq, (unsigned char)k);
                    seq[k] = '\0';
                    add_start_kmer_candidate(list, seq, cov);
                    if (list->count >= Max_Index_Start_Kmers) {
                        list->limited = 1;
                        goto done;
                    }
                }
            }
        }
    }

done:
    free(seq);
}

static void collect_index_start_kmers(start_kmer_list_t *list, kc_c4x_t *h, int k, const char *prefix, int prefix_len, uint64_t mask)
{
    int missing = k - prefix_len;

    list->count = 0;
    list->max_coverage = 0;
    list->limited = 0;

    if (missing <= Max_Index_Enumerate_Bases) {
        char *candidate;
        MALLOC(candidate, k + 1);
        memcpy(candidate, prefix, prefix_len);
        collect_index_completions_recursive(list, candidate, prefix_len, k, mask, h);
        free(candidate);
    } else {
        collect_index_starts_by_scan(list, h, k, prefix, prefix_len, mask);
    }
}

static int seq_path_kmers(uint64_t *kms, int k, int len, const char *seq)
{
    int i, l, km_num = 0;
    uint64_t x[2], mask = (1ULL<<k*2) - 1, shift = (k - 1) * 2;
    for (i = l = 0, x[0] = x[1] = 0; i < len; ++i) {
        int c = seq_nt4_table[(uint8_t)seq[i]];
        if (c < 4) {
            x[0] = (x[0] << 2 | c) & mask;
            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;
            if (++l >= k) {
                kms[km_num++] = x[0] < x[1]? x[0] : x[1];
            }
        } else {
            l = 0;
            x[0] = x[1] = 0;
        }
    }
    return km_num;
}

static void emit_summary_json(kc_c4x_t *h, int k, int n_thread, int read_len)
{
    fprintf(stdout, "{\"type\":\"summary\",\"k\":%d,\"threads\":%d,\"readLength\":%d,", k, n_thread, read_len);
    fprintf(stdout, "\"distinctKmers\":%d,", kc_c4x_t_size(h, h->p));
    fprintf(stdout, "\"totalKmerCoverage\":%llu}\n", kc_c4x_total_abundance(h));
    fflush(stdout);
}

static void emit_ready_json(kc_c4x_t *h, int k, int n_thread, int read_len, int file_count, char **files)
{
    fprintf(stdout, "{\"type\":\"ready\",\"mode\":\"interactive\",\"k\":%d,\"threads\":%d,\"readLength\":%d,", k, n_thread, read_len);
    fprintf(stdout, "\"distinctKmers\":%d,\"totalKmerCoverage\":%llu,\"files\":[", kc_c4x_t_size(h, h->p), kc_c4x_total_abundance(h));
    for (int i = 0; i < file_count; ++i) {
        if (i) fputc(',', stdout);
        json_string(stdout, files[i]);
    }
    fprintf(stdout, "]}\n");
    fflush(stdout);
}

static void emit_help_json(void)
{
    fprintf(stdout, "{\"type\":\"help\",\"commands\":[");
    json_string(stdout, "summary");
    fprintf(stdout, ",");
    json_string(stdout, "kmer <ACGT...> [upstreamDepth] [downstreamDepth]");
    fprintf(stdout, ",");
    json_string(stdout, "index <decimalInteger> <baseLength> [upstreamDepth] [downstreamDepth]");
    fprintf(stdout, ",");
    json_string(stdout, "sequence <ACGT...>");
    fprintf(stdout, ",");
    json_string(stdout, "exit");
    fprintf(stdout, "]}\n");
    fflush(stdout);
}

static void emit_neighbor_array(const char *label, const char *query, int k, uint64_t mask, kc_c4x_t *h, int upstream, int *degree)
{
    static const char bases[4] = {'A', 'C', 'G', 'T'};
    char *neighbor;

    MALLOC(neighbor, k + 1);
    fprintf(stdout, "\"%s\":[", label);
    *degree = 0;
    for (int i = 0; i < 4; ++i) {
        if (upstream) {
            neighbor[0] = bases[i];
            memcpy(neighbor + 1, query, k - 1);
        } else {
            memcpy(neighbor, query + 1, k - 1);
            neighbor[k - 1] = bases[i];
        }
        neighbor[k] = '\0';

        uint64_t key = actgkmer_hashkey((unsigned char*)neighbor, (unsigned char)k);
        int cov = kmer_cov(key, mask, h);
        if (cov > 0) ++(*degree);

        if (i) fputc(',', stdout);
        fprintf(stdout, "{\"base\":\"%c\",\"kmer\":", bases[i]);
        json_string(stdout, neighbor);
        fprintf(stdout, ",\"coverage\":%d,\"present\":%s}", cov, cov > 0 ? "true" : "false");
    }
    fprintf(stdout, "]");
    free(neighbor);
}

static void build_neighbor_kmer(char *neighbor, const char *query, int k, char base, int upstream)
{
    if (upstream) {
        neighbor[0] = base;
        memcpy(neighbor + 1, query, k - 1);
    } else {
        memcpy(neighbor, query + 1, k - 1);
        neighbor[k - 1] = base;
    }
    neighbor[k] = '\0';
}

static int compare_branch_coverage(const void *a, const void *b)
{
    const kmer_branch_t *pa = (const kmer_branch_t*)a;
    const kmer_branch_t *pb = (const kmer_branch_t*)b;
    if (pa->coverage != pb->coverage) return pb->coverage - pa->coverage;
    return (int)pa->base - (int)pb->base;
}

static void load_neighbor_branches(kmer_branch_t branches[4], const char *query, int k, uint64_t mask, kc_c4x_t *h, int upstream)
{
    static const char bases[4] = {'A', 'C', 'G', 'T'};
    for (int i = 0; i < 4; ++i) {
        branches[i].base = bases[i];
        MALLOC(branches[i].kmer, k + 1);
        build_neighbor_kmer(branches[i].kmer, query, k, bases[i], upstream);
        uint64_t key = actgkmer_hashkey((unsigned char*)branches[i].kmer, (unsigned char)k);
        branches[i].coverage = kmer_cov(key, mask, h);
    }
    qsort(branches, 4, sizeof(kmer_branch_t), compare_branch_coverage);
}

static void free_neighbor_branches(kmer_branch_t branches[4])
{
    for (int i = 0; i < 4; ++i) {
        free(branches[i].kmer);
    }
}

static int clamp_tree_depth(int depth)
{
    if (depth < 0) return 0;
    if (depth > Max_Kmer_Tree_Depth) return Max_Kmer_Tree_Depth;
    return depth;
}

static void emit_kmer_branch_tree(const char *query, int k, uint64_t mask, kc_c4x_t *h, int upstream, int remaining_depth, int step)
{
    kmer_branch_t branches[4];
    int emitted = 0;

    fprintf(stdout, "[");
    if (remaining_depth <= 0) {
        fprintf(stdout, "]");
        return;
    }

    load_neighbor_branches(branches, query, k, mask, h, upstream);
    for (int i = 0; i < 4; ++i) {
        if (branches[i].coverage <= 0) continue;
        if (emitted++) fputc(',', stdout);
        fprintf(stdout, "{\"base\":\"%c\",\"kmer\":", branches[i].base);
        json_string(stdout, branches[i].kmer);
        fprintf(stdout, ",\"coverage\":%d,\"present\":true,\"step\":%d,\"children\":", branches[i].coverage, step);
        emit_kmer_branch_tree(branches[i].kmer, k, mask, h, upstream, remaining_depth - 1, step + 1);
        fprintf(stdout, "}");
    }
    free_neighbor_branches(branches);
    fprintf(stdout, "]");
}

static void emit_greedy_path_array(const char *label, const char *start, int k, uint64_t mask, kc_c4x_t *h, int upstream, int depth)
{
    char *current;
    char *canonical;
    int emitted = 0;

    MALLOC(current, k + 1);
    MALLOC(canonical, k + 1);
    memcpy(current, start, k);
    current[k] = '\0';

    fprintf(stdout, "\"%s\":[", label);
    for (int step = 1; step <= depth; ++step) {
        kmer_branch_t branches[4];
        load_neighbor_branches(branches, current, k, mask, h, upstream);
        if (branches[0].coverage <= 0) {
            free_neighbor_branches(branches);
            break;
        }

        canonical_kmer_string(branches[0].kmer, k, canonical);
        if (emitted++) fputc(',', stdout);
        fprintf(stdout, "{\"step\":%d,\"base\":\"%c\",\"kmer\":", step, branches[0].base);
        json_string(stdout, branches[0].kmer);
        fprintf(stdout, ",\"canonical\":");
        json_string(stdout, canonical);
        fprintf(stdout, ",\"coverage\":%d}", branches[0].coverage);

        memcpy(current, branches[0].kmer, k + 1);
        free_neighbor_branches(branches);
    }
    fprintf(stdout, "]");

    free(canonical);
    free(current);
}

static void emit_kmer_query_json(kc_c4x_t *h, int k, const char *query, int query_len, int upstream_depth, int downstream_depth)
{
    uint64_t mask = (1ULL<<k*2) - 1;
    char *left_anchor = copy_dna_slice(query, 0, k);
    char *right_anchor = copy_dna_slice(query, query_len - k, k);
    uint64_t left_key = actgkmer_hashkey((unsigned char*)left_anchor, (unsigned char)k);
    uint64_t right_key = actgkmer_hashkey((unsigned char*)right_anchor, (unsigned char)k);
    char *canonical;
    char *right_canonical;
    int in_degree = 0, out_degree = 0;
    int up_depth = clamp_tree_depth(upstream_depth);
    int down_depth = clamp_tree_depth(downstream_depth);
    int left_cov = kmer_cov(left_key, mask, h);
    int right_cov = kmer_cov(right_key, mask, h);
    int query_cov = left_cov;
    if (strcmp(left_anchor, right_anchor) != 0 && right_cov < query_cov) query_cov = right_cov;

    MALLOC(canonical, k + 1);
    MALLOC(right_canonical, k + 1);
    uint64_acgt(left_key, (unsigned char*)canonical, (unsigned char)k);
    canonical[k] = '\0';
    uint64_acgt(right_key, (unsigned char*)right_canonical, (unsigned char)k);
    right_canonical[k] = '\0';

    fprintf(stdout, "{\"type\":\"kmer\",\"query\":");
    json_string(stdout, query);
    fprintf(stdout, ",\"queryLength\":%d,\"truncated\":%s,\"leftAnchor\":", query_len, query_len > k ? "true" : "false");
    json_string(stdout, left_anchor);
    fprintf(stdout, ",\"rightAnchor\":");
    json_string(stdout, right_anchor);
    fprintf(stdout, ",\"canonical\":");
    json_string(stdout, canonical);
    fprintf(stdout, ",\"leftCanonical\":");
    json_string(stdout, canonical);
    fprintf(stdout, ",\"rightCanonical\":");
    json_string(stdout, right_canonical);
    fprintf(stdout, ",\"coverage\":%d,\"leftCoverage\":%d,\"rightCoverage\":%d,", query_cov, left_cov, right_cov);
    emit_neighbor_array("upstream", left_anchor, k, mask, h, 1, &in_degree);
    fprintf(stdout, ",");
    emit_neighbor_array("downstream", right_anchor, k, mask, h, 0, &out_degree);
    fprintf(stdout, ",\"inDegree\":%d,\"outDegree\":%d", in_degree, out_degree);
    fprintf(stdout, ",\"upstreamDepth\":%d,\"downstreamDepth\":%d,\"maxTreeDepth\":%d", up_depth, down_depth, Max_Kmer_Tree_Depth);
    fprintf(stdout, ",\"upstreamTree\":");
    emit_kmer_branch_tree(left_anchor, k, mask, h, 1, up_depth, 1);
    fprintf(stdout, ",\"downstreamTree\":");
    emit_kmer_branch_tree(right_anchor, k, mask, h, 0, down_depth, 1);
    fprintf(stdout, "}\n");
    fflush(stdout);

    free(right_canonical);
    free(canonical);
    free(right_anchor);
    free(left_anchor);
}

static void emit_index_start_json(kc_c4x_t *h, int k, uint64_t mask, const char *seed, int seed_len, const char *left_anchor, const char *right_anchor, int upstream_depth, int downstream_depth)
{
    char *left_canonical;
    char *right_canonical;
    int left_cov = kmer_string_coverage(left_anchor, k, mask, h);
    int right_cov = kmer_string_coverage(right_anchor, k, mask, h);
    int seed_cov = left_cov;

    if (strcmp(left_anchor, right_anchor) != 0 && right_cov < seed_cov) seed_cov = right_cov;

    MALLOC(left_canonical, k + 1);
    MALLOC(right_canonical, k + 1);
    canonical_kmer_string(left_anchor, k, left_canonical);
    canonical_kmer_string(right_anchor, k, right_canonical);

    fprintf(stdout, "{\"seed\":");
    json_string(stdout, seed);
    fprintf(stdout, ",\"seedLength\":%d,\"leftAnchor\":", seed_len);
    json_string(stdout, left_anchor);
    fprintf(stdout, ",\"rightAnchor\":");
    json_string(stdout, right_anchor);
    fprintf(stdout, ",\"canonical\":");
    json_string(stdout, left_canonical);
    fprintf(stdout, ",\"leftCanonical\":");
    json_string(stdout, left_canonical);
    fprintf(stdout, ",\"rightCanonical\":");
    json_string(stdout, right_canonical);
    fprintf(stdout, ",\"coverage\":%d,\"leftCoverage\":%d,\"rightCoverage\":%d,", seed_cov, left_cov, right_cov);
    emit_greedy_path_array("upstream", left_anchor, k, mask, h, 1, upstream_depth);
    fprintf(stdout, ",");
    emit_greedy_path_array("downstream", right_anchor, k, mask, h, 0, downstream_depth);
    fprintf(stdout, "}");

    free(right_canonical);
    free(left_canonical);
}

static void emit_index_query_json(kc_c4x_t *h, int k, const char *index_token, int base_length, int upstream_depth, int downstream_depth)
{
    uint64_t mask = (1ULL<<k*2) - 1;
    int decoded_len = 0;
    int encoded_len = 0;
    int padded = 0;
    char err[160];
    char *decoded = index_token_to_dna(index_token, &decoded_len, err, sizeof(err));
    int up_depth = clamp_tree_depth(upstream_depth);
    int down_depth = clamp_tree_depth(downstream_depth);

    if (decoded == 0) {
        emit_error_json(err);
        return;
    }

    encoded_len = decoded_len;
    if (decoded_len < base_length) {
        decoded = left_pad_dna_with_a(decoded, &decoded_len, base_length);
        padded = 1;
    }

    fprintf(stdout, "{\"type\":\"index\",\"index\":");
    json_string(stdout, index_token);
    fprintf(stdout, ",\"decoded\":");
    json_string(stdout, decoded);
    fprintf(stdout, ",\"encodedLength\":%d,\"targetLength\":%d,\"decodedLength\":%d,\"padded\":%s,\"k\":%d,\"completed\":%s,\"truncated\":%s", encoded_len, base_length, decoded_len, padded ? "true" : "false", k, decoded_len < k ? "true" : "false", decoded_len > k ? "true" : "false");
    fprintf(stdout, ",\"upstreamDepth\":%d,\"downstreamDepth\":%d,\"maxStartKmers\":%d", up_depth, down_depth, Max_Index_Start_Kmers);

    if (decoded_len >= k) {
        char *left_anchor = copy_dna_slice(decoded, 0, k);
        char *right_anchor = copy_dna_slice(decoded, decoded_len - k, k);
        fprintf(stdout, ",\"startCount\":1,\"reportedStarts\":1,\"startLimitReached\":false,\"starts\":[");
        emit_index_start_json(h, k, mask, decoded, decoded_len, left_anchor, right_anchor, up_depth, down_depth);
        fprintf(stdout, "]}\n");
        free(right_anchor);
        free(left_anchor);
    } else {
        start_kmer_list_t starts;
        collect_index_start_kmers(&starts, h, k, decoded, decoded_len, mask);
        fprintf(stdout, ",\"startCount\":%d,\"reportedStarts\":%d,\"maxStartCoverage\":%d,\"startLimitReached\":%s,\"starts\":[", starts.count, starts.count, starts.max_coverage, starts.limited ? "true" : "false");
        for (int i = 0; i < starts.count; ++i) {
            if (i) fputc(',', stdout);
            emit_index_start_json(h, k, mask, starts.items[i].kmer, k, starts.items[i].kmer, starts.items[i].kmer, up_depth, down_depth);
        }
        fprintf(stdout, "]");
        if (starts.count == 0) {
            fprintf(stdout, ",\"message\":");
            json_string(stdout, "No covered k-mer starts match the decoded index prefix");
        }
        fprintf(stdout, "}\n");
        clear_start_kmer_list(&starts);
    }

    fflush(stdout);
    free(decoded);
}

static double coverage_ratio(int a, int b)
{
    if (a >= b && b > 0) return (double)a / b;
    if (b > a && a > 0) return (double)b / a;
    if (a == 0 && b == 0) return 1.0;
    return 0.0;
}

static void emit_sequence_query_json(kc_c4x_t *h, int k, const char *seq, int len)
{
    uint64_t mask = (1ULL<<k*2) - 1;
    int km_num = len - k + 1;
    uint64_t *kms;
    int *coverages;
    int observed = 0, missing = 0, min_cov = 0, max_cov = 0;
    long long cov_sum = 0;
    double max_ratio = 0.0;
    char *canonical;

    if (km_num <= 0) {
        emit_error_json("sequence length must be at least k");
        return;
    }

    MALLOC(kms, km_num);
    MALLOC(coverages, km_num);
    MALLOC(canonical, k + 1);

    km_num = seq_path_kmers(kms, k, len, seq);
    for (int i = 0; i < km_num; ++i) {
        coverages[i] = kmer_cov(kms[i], mask, h);
        if (i == 0 || coverages[i] < min_cov) min_cov = coverages[i];
        if (i == 0 || coverages[i] > max_cov) max_cov = coverages[i];
        if (coverages[i] > 0) ++observed;
        else ++missing;
        cov_sum += coverages[i];
    }

    for (int i = 0; i + 1 < km_num; ++i) {
        double ratio = coverage_ratio(coverages[i], coverages[i + 1]);
        if (ratio > max_ratio) max_ratio = ratio;
    }

    fprintf(stdout, "{\"type\":\"sequence\",\"length\":%d,\"k\":%d,\"kmerCount\":%d,", len, k, km_num);
    fprintf(stdout, "\"observed\":%d,\"missing\":%d,\"complete\":%s,", observed, missing, missing == 0 ? "true" : "false");
    fprintf(stdout, "\"minCoverage\":%d,\"maxCoverage\":%d,\"meanCoverage\":%.3f,\"maxAdjacentRatio\":%.3f,", min_cov, max_cov, km_num > 0 ? (double)cov_sum / km_num : 0.0, max_ratio);
    fprintf(stdout, "\"coverages\":[");
    for (int i = 0; i < km_num; ++i) {
        if (i) fputc(',', stdout);
        uint64_acgt(kms[i], (unsigned char*)canonical, (unsigned char)k);
        canonical[k] = '\0';
        fprintf(stdout, "{\"position\":%d,\"kmer\":", i);
        json_string_n(stdout, seq + i, k);
        fprintf(stdout, ",\"canonical\":");
        json_string(stdout, canonical);
        fprintf(stdout, ",\"coverage\":%d}", coverages[i]);
    }
    fprintf(stdout, "],\"ratios\":[");
    for (int i = 0; i + 1 < km_num; ++i) {
        if (i) fputc(',', stdout);
        fprintf(stdout, "{\"position\":%d,\"ratio\":%.3f}", i, coverage_ratio(coverages[i], coverages[i + 1]));
    }
    fprintf(stdout, "]}\n");
    fflush(stdout);

    free(canonical);
    free(coverages);
    free(kms);
}

static int run_interactive_kernel(int argc, char *argv[], int first_file, int k, int p, int block_size, int n_thread, int read_len)
{
    kc_c4x_t *h;
    char *line = 0;
    size_t line_cap = 0;
    ssize_t line_len;
    int file_count = argc - first_file;

    if (file_count < 1) {
        fprintf(stderr, "Error: interactive mode requires at least one NGS FASTA/FASTQ file\n");
        return 1;
    }
    if (k < 1 || k > 31) {
        fprintf(stderr, "Error: k-mer size must be in [1, 31] for the uint64_t k-mer index\n");
        return 1;
    }

    fprintf(stderr, "Counting NGS file 1 ......\n");
    h = count_file(argv[first_file], k, p, block_size, n_thread, read_len);
    if (h == 0) {
        fprintf(stderr, "Error: could not open NGS file %s\n", argv[first_file]);
        return 1;
    }

    for (int i = first_file + 1; i < argc; ++i) {
        kc_c4x_t *next;
        fprintf(stderr, "Counting NGS file %d ......\n", i - first_file + 1);
        next = count_file2(argv[i], h, k, p, block_size, n_thread, read_len);
        if (next == 0) {
            fprintf(stderr, "Error: could not open NGS file %s\n", argv[i]);
            c4x_destroy(h);
            return 1;
        }
        h = next;
    }

    emit_ready_json(h, k, n_thread, read_len, file_count, argv + first_file);

    while ((line_len = getline(&line, &line_cap, stdin)) >= 0) {
        char *cmd;
        char *arg;
        char err[160];
        int seq_len = 0;
        char *seq = 0;

        (void)line_len;
        trim_right(line);
        cmd = trim_left(line);
        if (*cmd == '\0') continue;

        arg = cmd;
        while (*arg && !isspace((unsigned char)*arg)) ++arg;
        if (*arg) {
            *arg++ = '\0';
            arg = trim_left(arg);
        }

        if (command_equals(cmd, "exit") || command_equals(cmd, "quit")) {
            fprintf(stdout, "{\"type\":\"bye\"}\n");
            fflush(stdout);
            break;
        } else if (command_equals(cmd, "help")) {
            emit_help_json();
        } else if (command_equals(cmd, "summary")) {
            emit_summary_json(h, k, n_thread, read_len);
        } else if (command_equals(cmd, "kmer")) {
            char *depth_arg = arg;
            int upstream_depth = 1;
            int downstream_depth = 1;
            while (*depth_arg && !isspace((unsigned char)*depth_arg)) ++depth_arg;
            if (*depth_arg) {
                *depth_arg++ = '\0';
                depth_arg = trim_left(depth_arg);
            }
            seq = normalize_dna_arg(arg, &seq_len, err, sizeof(err));
            if (seq == 0) {
                emit_error_json(err);
            } else if (seq_len < k) {
                snprintf(err, sizeof(err), "kmer query length is %d, but k is %d", seq_len, k);
                emit_error_json(err);
            } else if (!parse_nonnegative_int_token(&depth_arg, 1, &upstream_depth)) {
                emit_error_json("upstream depth must be a non-negative integer");
            } else if (!parse_nonnegative_int_token(&depth_arg, upstream_depth, &downstream_depth)) {
                emit_error_json("downstream depth must be a non-negative integer");
            } else {
                emit_kmer_query_json(h, k, seq, seq_len, upstream_depth, downstream_depth);
            }
            free(seq);
        } else if (command_equals(cmd, "index")) {
            char *depth_arg = arg;
            char *index_token = arg;
            int base_length = k;
            int upstream_depth = 1;
            int downstream_depth = 1;
            while (*depth_arg && !isspace((unsigned char)*depth_arg)) ++depth_arg;
            if (*depth_arg) {
                *depth_arg++ = '\0';
                depth_arg = trim_left(depth_arg);
            }
            if (!parse_positive_int_token(&depth_arg, k, &base_length)) {
                emit_error_json("index base length must be a positive integer no greater than 300");
            } else if (!parse_nonnegative_int_token(&depth_arg, 1, &upstream_depth)) {
                emit_error_json("upstream depth must be a non-negative integer");
            } else if (!parse_nonnegative_int_token(&depth_arg, upstream_depth, &downstream_depth)) {
                emit_error_json("downstream depth must be a non-negative integer");
            } else {
                emit_index_query_json(h, k, index_token, base_length, upstream_depth, downstream_depth);
            }
        } else if (command_equals(cmd, "sequence") || command_equals(cmd, "seq") || command_equals(cmd, "path")) {
            seq = normalize_dna_arg(arg, &seq_len, err, sizeof(err));
            if (seq == 0) {
                emit_error_json(err);
            } else if (seq_len < k) {
                snprintf(err, sizeof(err), "sequence length is %d, but k is %d", seq_len, k);
                emit_error_json(err);
            } else {
                emit_sequence_query_json(h, k, seq, seq_len);
            }
            free(seq);
        } else {
            snprintf(err, sizeof(err), "unknown command '%s'; use help for supported commands", cmd);
            emit_error_json(err);
        }
    }

    free(line);
    c4x_destroy(h);
    return 0;
}

int main(int argc, char *argv[])
{

    int i, c, k = 31, p = KC_BITS, block_size = 10000000, n_thread = 3, min_cov_cut = 0, max_cov_cut=0;
    int read_len = 200;
    int interactive = 0;
    double max_cov_ratio = 0.0; // No limitation on ratio by default
    double max_R = 0.0; // Upper bound for ratio range iteration
    double step_size = 0.20; // Default step size for ratio iteration
    int skip_ratios = 0; // Default: skip the first N ratio values
    char *output_prefix = NULL;

    ketopt_t o = KETOPT_INIT;
    while ((c = ketopt(&o, argc, argv, 1, "ik:t:c:C:L:o:r:s:R:I:", 0)) >= 0) {
        if (c == 'i') interactive = 1;
        if (c == 'k') k = atoi(o.arg);
        //else if (c == 'p') p = atoi(o.arg);
        else if (c == 't') n_thread = atoi(o.arg);
        else if (c == 'c') min_cov_cut = atoi(o.arg);
        else if (c == 'C') max_cov_cut = atoi(o.arg);
        else if (c == 'L') read_len = atoi(o.arg);
        else if (c == 'o') output_prefix = o.arg;
        else if (c == 'r') max_cov_ratio = atof(o.arg);
        else if (c == 's') skip_ratios = atoi(o.arg);
        else if (c == 'R') max_R = atof(o.arg);
        else if (c == 'I') step_size = atof(o.arg);
    }
    if ((interactive && argc - o.ind < 1) || (!interactive && argc - o.ind < 2)) {
        fprintf(stderr, "\n************************************************************************\n");
        fprintf(stderr, "**                                                                    **\n");
        fprintf(stderr, "**                   Sm Kn Kd Caculator for DBGPS                     **\n");
        fprintf(stderr, "**     Version 20260123  Author: Lifu Song lifu.song@outlook.com      **\n");
        //fprintf(stderr, "**  DBGPS - De Bruijn Graph based inner decoder for DNA data storage  **\n");
        fprintf(stderr, "**                                                                    **\n");
        fprintf(stderr, "************************************************************************\n\n");
        fprintf(stderr, "Usage: DBGPS-analyzer [options] <Strand seq file> <NGS files> \n");
        fprintf(stderr, "       DBGPS-analyzer -i [options] <NGS files>\n");
        fprintf(stderr, "                       [Supporting formats: *fq, *fa, *fq.gz, *fa.gz]\n");
        fprintf(stderr, "Options:\n");
        fprintf(stderr, "  -i         interactive JSON Lines diagnostics kernel mode\n");
        fprintf(stderr, "  -k INT     k-mer size [%d]\n", k);
        fprintf(stderr, "  -t INT     number of threads [%d]\n", n_thread);
        fprintf(stderr, "  -L INT     Maximal read length for k-mer counting [%d]\n", read_len);
        fprintf(stderr, "  -r FLOAT   Maximum coverage ratio [%.1f] (0 = no limitation)\n", max_cov_ratio);
        fprintf(stderr, "  -R FLOAT   Upper bound for ratio range iteration [%.1f]\n", max_R);
        fprintf(stderr, "  -I FLOAT   Step size for ratio iteration [%.2f]\n", step_size);
        fprintf(stderr, "  -c INT     min_cov_cut [%d]\n", min_cov_cut);
        fprintf(stderr, "  -C INT     max_cov_cut [%d]\n", max_cov_cut);
        fprintf(stderr, "  -o STR     output prefix for additional files [none]\n");
        fprintf(stderr, "  -s INT     Number of initial ratio values to ignore [%d]\n", skip_ratios);
        
        fprintf(stderr, "\n");
        return 1;
    }

    if (interactive) {
        return run_interactive_kernel(argc, argv, o.ind, k, p, block_size, n_thread, read_len);
    }

    if(max_cov_cut < min_cov_cut){max_cov_cut = min_cov_cut;}

    kc_c4x_t *h;
    fprintf(stdout, ">> Settings:\nk-mer size = %d\n", k);
    fprintf(stdout, "Read length = %d\n", read_len);
    fprintf(stdout, "Maximum coverage ratio = %.1f\n", max_cov_ratio);
    fprintf(stdout, "Ignore initial ratios = %d\n", skip_ratios);
    fprintf(stdout, "Upper bound for ratio range iteration = %.1f\n", max_R);
   
    fprintf(stderr, "Counting NGS file 1 ......\n");
    h = count_file(argv[o.ind + 1], k, p, block_size, n_thread, read_len);

    int f_num = argc - o.ind, c_f_n = 3;
    while(c_f_n <= f_num) {
        fprintf(stderr, "Counting NGS file %d ......\n", c_f_n-1);
        h = count_file2(argv[o.ind + c_f_n - 1], h, k, p, block_size, n_thread, read_len);  
        c_f_n = c_f_n + 1;
    }

    // Open coverage details file if output prefix is provided
    FILE *cov_details_fp = NULL;
    FILE *cov_ratios_fp = NULL;
    FILE *ratio_ranges_fp = NULL;
    FILE *smkdkn_fp = NULL;
    if (output_prefix != NULL) {
        size_t prefix_len = strlen(output_prefix);
        size_t max_ext_len = 12; // Longest extension is ".cov_details"
        
        // Open coverage details file
        char *filename;
        MALLOC(filename, prefix_len + max_ext_len + 1);
        
        snprintf(filename, prefix_len + max_ext_len + 1, "%s.cov_details", output_prefix);
        cov_details_fp = fopen(filename, "w");
        if (cov_details_fp == NULL) {
            fprintf(stderr, "Error: Could not open file %s for writing\n", filename);
        } else {
            fprintf(stderr, "Writing coverage details to %s\n", filename);
        }
        
        // Open coverage ratios file
        snprintf(filename, prefix_len + max_ext_len + 1, "%s.cov_ratios", output_prefix);
        cov_ratios_fp = fopen(filename, "w");
        if (cov_ratios_fp == NULL) {
            fprintf(stderr, "Error: Could not open file %s for writing\n", filename);
        } else {
            fprintf(stderr, "Writing coverage ratios to %s\n", filename);
        }
        
        // Open ratio ranges file
        snprintf(filename, prefix_len + max_ext_len + 1, "%s.ratio_ranges", output_prefix);
        ratio_ranges_fp = fopen(filename, "w");
        if (ratio_ranges_fp == NULL) {
            fprintf(stderr, "Error: Could not open file %s for writing\n", filename);
        } else {
            fprintf(stderr, "Writing ratio ranges to %s\n", filename);
        }
        
        // Open SmKdKn values file
        snprintf(filename, prefix_len + max_ext_len + 1, "%s.SmKdKn", output_prefix);
        smkdkn_fp = fopen(filename, "w");
        if (smkdkn_fp == NULL) {
            fprintf(stderr, "Error: Could not open file %s for writing\n", filename);
        } else {
            fprintf(stderr, "Writing SmKdKn values to %s\n", filename);
        }
        
        free(filename);
    }

    evaluation_t eva;
    eva.h = h;
    eva.max_cov_ratio = max_cov_ratio;
    eva.skip_ratios = skip_ratios;
    
    // Initialize ratio range tracker
    if (output_prefix != NULL) {
        eva.ratio_range = init_ratio_range();
    } else {
        eva.ratio_range = NULL;
    }

    fprintf(stderr, "Estimating Sm Kn Kd values ...\n");
    
    // If max_R is not specified or less than max_cov_ratio, only use max_cov_ratio
    if (max_R <= 0 || max_R < max_cov_ratio) {
        max_R = max_cov_ratio;
    }
    
    // Output header line to both stdout and file
    fprintf(stdout, "Ratio\tCoverage\tTotal\tPaths\tNoise\tExist\tLost\tSm\tKd\tKn\n");
    if (smkdkn_fp != NULL) {
        fprintf(smkdkn_fp, "Ratio\tCoverage\tTotal\tPaths\tNoise\tExist\tLost\tSm\tKd\tKn\n");
    }

    // Iterate through different coverage ratio values
    double ratio;
    for (ratio = max_cov_ratio; ratio <= max_R + 0.001; ratio += step_size) { // Add small epsilon to include max_R
        // For each ratio, iterate through different coverage cutoffs
        int cov;
        for (cov = min_cov_cut; cov <= max_cov_cut; cov++) {
            eva.strand_num = 0;
            eva.exist_strand_num = 0;
            eva.noise_km_num = 0;
            eva.lose_km_num = 0;
            eva.exist_km_num = 0;
            eva.cov_cut = cov;
            eva.max_cov_ratio = ratio; // Set current ratio
            
            fprintf(stdout, "%.2f\t%d\t", ratio, cov);
            if (smkdkn_fp != NULL) {
                fprintf(smkdkn_fp, "%.2f\t%d\t", ratio, cov);
            }
            
            // Create a fresh global k-mer tracker for this evaluation run
            kc_c4x_t *global_kmer_tracker = c4x_init(p);
            
            evaluate_seq_file(&eva, argv[o.ind], k, p, block_size, n_thread, 
                             (cov == min_cov_cut && ratio == max_cov_ratio) ? cov_details_fp : NULL, 
                             (cov == min_cov_cut && ratio == max_cov_ratio) ? cov_ratios_fp : NULL,
                             global_kmer_tracker);
            
            // Clean up the global k-mer tracker
            for(int tracker_i = 0; tracker_i < 1<<p; ++tracker_i) {
                kc_c4_destroy(global_kmer_tracker->h[tracker_i]);
            }
            free(global_kmer_tracker->h); 
            free(global_kmer_tracker);
            
            fprintf(stdout, "%d\t", eva.strand_num);
            if (smkdkn_fp != NULL) fprintf(smkdkn_fp, "%d\t", eva.strand_num);
            
            fprintf(stdout, "%d\t", eva.exist_strand_num);
            if (smkdkn_fp != NULL) fprintf(smkdkn_fp, "%d\t", eva.exist_strand_num);
            
            eva.noise_km_num = kc_c4x_t_kmers(h, p, cov) - eva.exist_km_num;
            eva.sm = (double)eva.exist_strand_num / eva.strand_num;
            eva.kd = (double)eva.lose_km_num / (eva.lose_km_num + eva.exist_km_num);
            eva.kn = (double)eva.noise_km_num / eva.exist_km_num;
            
            fprintf(stdout, "%d\t", eva.noise_km_num);
            if (smkdkn_fp != NULL) fprintf(smkdkn_fp, "%d\t", eva.noise_km_num);
            
            fprintf(stdout, "%d\t", eva.exist_km_num);
            if (smkdkn_fp != NULL) fprintf(smkdkn_fp, "%d\t", eva.exist_km_num);
            
            fprintf(stdout, "%d\t", eva.lose_km_num);
            if (smkdkn_fp != NULL) fprintf(smkdkn_fp, "%d\t", eva.lose_km_num);
            
            fprintf(stdout, "%f\t", eva.sm);
            if (smkdkn_fp != NULL) fprintf(smkdkn_fp, "%f\t", eva.sm);
            
            fprintf(stdout, "%f\t", eva.kd);
            if (smkdkn_fp != NULL) fprintf(smkdkn_fp, "%f\t", eva.kd);
            
            fprintf(stdout, "%f\n", eva.kn);
            if (smkdkn_fp != NULL) fprintf(smkdkn_fp, "%f\n", eva.kn);
        }
    }

    // Write ratio ranges to file and close files
    if (eva.ratio_range && ratio_ranges_fp) {
        write_ratio_range(ratio_ranges_fp, eva.ratio_range);
        free_ratio_range(eva.ratio_range);
    }

    // Close files if they were opened
    if (cov_details_fp != NULL) {
        fclose(cov_details_fp);
    }
    if (cov_ratios_fp != NULL) {
        fclose(cov_ratios_fp);
    }
    if (ratio_ranges_fp != NULL) {
        fclose(ratio_ranges_fp);
    }
    if (smkdkn_fp != NULL) {
        fclose(smkdkn_fp);
    }

    for(i = 0; i < 1<<p; ++i) {
        kc_c4_destroy(h->h[i]);
    }

    free(h->h); free(h);
    return 0;
}
