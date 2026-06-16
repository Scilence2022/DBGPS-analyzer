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
#define KC_BITS 10
#define KC_MAX ((1<<KC_BITS) - 1)
#define kc_c4_eq(a, b) ((a)>>KC_BITS == (b)>>KC_BITS) // lower 10 bits for counts; higher bits for k-mer
#define kc_c4_hash(a) ((a)>>KC_BITS)


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
//    uint64_t mask = 1;
//    uint64_t key_i = hash64i(key, mask);
//    int
// Function works 0707
//    char* aseq = seq;
//    *aseq = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\0";
//    char *ss = seq + km_len + 1;
//    *ss
    //*(seq + km_len + 1) = '\0';
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


uint64_t actgkmer_hashkey(unsigned char* seq, unsigned char km_len){
//    Just for testing
//// Function verified 20210708 Lifu Song
    int i;
    uint64_t x[2], y,  shift = (km_len - 1) * 2, mask = (1ULL<<km_len*2) - 1;
    for (i = 0, x[0] = x[1] = 0; i < km_len; ++i) {
        fprintf(stdout, "%c ", seq[i]);
        int c = seq_nt4_table[(uint8_t)seq[i]];
        fprintf(stdout, "%d ", c);
        if (c < 4) { // not an "N" base
            x[0] = (x[0] << 2 | c) & mask;                  // forward strand
            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;  // reverse strand
        } else x[0] = x[1] = 0; // if there is an "N", restart
    }
    y = x[0] < x[1]? x[0] : x[1];
    fprintf(stdout, "y %ld\n", y);
    return y;
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


unsigned short kmer_cov(uint64_t kmer, uint64_t mask, kc_c4x_t *h){

    int j, x, cov=0;
    uint64_t hash_key = hash64(kmer, mask);

    j = hash_key & ((1<<KC_BITS) - 1);
    if(kh_size(h->h[j]) < 1){return 0;}

    hash_key = hash_key >> KC_BITS<< KC_BITS;

    x = kc_c4_get(h->h[j], hash_key);

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
    int absent;
    k = kc_c4_put(h->h[pre], y_hash>>p<<KC_BITS, &absent);
    ++kh_key(h->h[pre], k);
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
    for(i=0; i<km_num; i++){
            int cov = kmer_cov(*(kms+i), mask, h);
            if(cov > max_cov){max_cov=cov;}
    }
    return max_cov;
}


int seq_kmers(uint64_t *kms, int k, int len, const char *seq, int primer_len) // insert k-mers in $seq to linear buffer $buf
{
    int i, l=0, km_num=0;
    uint64_t x[2], mask = (1ULL<<k*2) - 1, shift = (k - 1) * 2;
    for (i = primer_len, x[0] = x[1] = 0; i < len - primer_len; ++i) {
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

typedef struct { // global data structure for kt_pipeline()
    int k, block_len, max_cov, output, primer_len;
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


static void worker_pipeline(void *data, int max_cov) // callback for kt_pipeline()
{
    pldat_t *p = (pldat_t*)data;
    uint64_t mask = (1ULL<<p->k*2) - 1;
    int ret, filter_num=0;
    stepdat_t *s;
    CALLOC(s, 1);
    s->p = p;
    int i = 0;

    while ((ret = kseq_read(p->ks)) >= 0) {// Reading seqs

        i = i + 1;
        uint64_t *kms;
        int l = p->ks->seq.l, km_num = 0, kms_cov=0;
        if (l < p->k) continue;
        MALLOC(kms, l-p->k + 1); //
        km_num = seq_kmers(kms, p->k, l, p->ks->seq.s, p->primer_len);
        kms_cov = kms_max_cov(kms, km_num, mask, p->h);

        if(kms_cov <= max_cov){

            int j;
            for(j=0;j<km_num;j++){
                add_kmer(*(kms+j), mask, p->h);
            }
            if(p->output > 0){
                printf(">%s\n",p->ks->name.s);
                printf("%s\n",p->ks->seq.s);

            }

        }else{
            filter_num++;
            if(p->output < 1){ printf("%s\n",p->ks->name.s);}
            fprintf(stderr,"%d/", filter_num);
            fprintf(stderr,"%d * ", i);
        }

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

    worker_pipeline(&pl, max_cov);
    kseq_destroy(pl.ks);
    gzclose(fp);
    return pl.h;
}


int main(int argc, char *argv[])
{
    kc_c4x_t *h;
    int i, c, k = 31, p = KC_BITS, max_links = 0, output=1, primer_len=18;


    ketopt_t o = KETOPT_INIT;
    while ((c = ketopt(&o, argc, argv, 1, "k:m:s:p:", 0)) >= 0) {
        if (c == 'k') k = atoi(o.arg);
        else if (c == 'm') max_links = atoi(o.arg);
        else if (c == 's') output = 1;
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
        fprintf(stderr,   "  -k INT     k-mer size for entangle analysis [%d]\n", k);
        fprintf(stderr,   "  -m INT     Maximal strand cross-links [%d]\n", max_links);
        fprintf(stderr,   "  -p INT     Length of primers [%d]\n", primer_len);
        fprintf(stderr,   "  -s         Output passed seqs [%d]\n", output);

        return 1;
    }



    fprintf(stderr, "Picking out strands with cross-links more than ");
    fprintf(stderr, "%d ", max_links);
    fprintf(stderr, "using k-mer size %d\n", k);

    h = filter_file(argv[o.ind], k, p, max_links, primer_len, output);

    fprintf(stderr, "\nTask done!\n");


    for (i = 0; i < 1<<p; ++i) kc_c4_destroy(h->h[i]);
    free(h->h); free(h);
    return 0;
}



