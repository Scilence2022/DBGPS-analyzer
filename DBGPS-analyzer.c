#include <stdio.h>
#include <stdint.h>
#include <zlib.h>
#include <stdlib.h>
#include <inttypes.h>
#include <time.h>

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
// Removed Max_Cov_Ratio define, now using a variable instead


KHASHL_SET_INIT(, kc_c4_t, kc_c4, uint64_t, kc_c4_hash, kc_c4_eq)

#define CALLOC(ptr, len) ((ptr) = (__typeof__(ptr))calloc((len), sizeof(*(ptr))))
#define MALLOC(ptr, len) ((ptr) = (__typeof__(ptr))malloc((len) * sizeof(*(ptr))))
#define REALLOC(ptr, len) ((ptr) = (__typeof__(ptr))realloc((ptr), (len) * sizeof(*(ptr))))

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

int main(int argc, char *argv[])
{

    int i, c, k = 31, p = KC_BITS, block_size = 10000000, n_thread = 3, min_cov_cut = 0, max_cov_cut=0;
    int read_len = 200;
    double max_cov_ratio = 0.0; // No limitation on ratio by default
    double max_R = 0.0; // Upper bound for ratio range iteration
    double step_size = 0.20; // Default step size for ratio iteration
    int skip_ratios = 0; // Default: skip the first N ratio values
    char *output_prefix = NULL;

    ketopt_t o = KETOPT_INIT;
    while ((c = ketopt(&o, argc, argv, 1, "k:c:C:L:o:r:s:R:I:", 0)) >= 0) {
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
    if (argc - o.ind < 1) {
        fprintf(stderr, "\n************************************************************************\n");
        fprintf(stderr, "**                                                                    **\n");
        fprintf(stderr, "**                   Sm Kn Kd Caculator for DBGPS                     **\n");
        fprintf(stderr, "**     Version 20260123  Author: Lifu Song lifu.song@outlook.com      **\n");
        //fprintf(stderr, "**  DBGPS - De Bruijn Graph based inner decoder for DNA data storage  **\n");
        fprintf(stderr, "**                                                                    **\n");
        fprintf(stderr, "************************************************************************\n\n");
        fprintf(stderr, "Usage: DBGPS-analyzer [options] <Strand seq file> <NGS files> \n");
        fprintf(stderr, "                       [Supporting formats: *fq, *fa, *fq.gz, *fa.gz]\n");
        fprintf(stderr, "Options:\n");
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


