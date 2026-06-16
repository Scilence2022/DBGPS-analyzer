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

uint64_t actgkmer_uint64(unsigned char* seq, unsigned char km_len){
//    Just for testing
//// Function verified 20210708 Lifu Song
    int i;
    uint64_t x, mask = (1ULL<<km_len*2) - 1; //shift = (km_len - 1) * 2
    for (i = 0, x = 0; i < km_len; ++i) {
        fprintf(stdout, "%c ", seq[i]);
        int c = seq_nt4_table[(uint8_t)seq[i]];
        fprintf(stdout, "%d ", c);
        if (c < 4) { // not an "N" base
            x = (x << 2 | c) & mask;                  // forward strand
//            x[1] = x[1] >> 2 | (uint64_t)(3 - c) << shift;  // reverse strand
        } else x = 0; // if there is an "N", restart
    }

    fprintf(stdout, "y %ld\n", x);
    return x;
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

unsigned long uint8_actg(unsigned char bts){
    unsigned int i=0;
    unsigned long four_base_seq=0;

    for(i =0 ; i < 4; ++i){
        int m = bts & 3;
        bts = bts >>2;
        four_base_seq =four_base_seq >>8;
        four_base_seq = four_base_seq + ((unsigned long)nt4_seq_table[m]<< 24);

//        fprintf(stdout, " bts %d\t m %d\t %ld\n", bts, m, four_base_seq);
    }
    return four_base_seq;
}


unsigned char actg_uint8(unsigned long actg_seq){
    unsigned int i=0;
    unsigned char uint8_value=0;

//    fprintf(stdout, " actg_seq %ld\n", actg_seq);
    for(i =0 ; i < 4; ++i){
        unsigned int m = actg_seq & 255;
        actg_seq = actg_seq >> 8;
        uint8_value = uint8_value >> 2;
        uint8_value = uint8_value + ((unsigned char)seq_nt4_table[m]<<6);

//        fprintf(stdout, " actg_seq %ld\t m %d\t uint8_value %ld\n", actg_seq, m, uint8_value);
    }
    return uint8_value;
}

unsigned char* actg_intseq(char* actg_seq, unsigned char* int_seq, int8_t actg_seq_len){

    int p = 0;
    unsigned long n, n1, n2, n3, n4;
    while(p < actg_seq_len-3){


        n1 = actg_seq[p];
        n2 = actg_seq[p+1];
        n3 = actg_seq[p+2];
        n4 = actg_seq[p+3];


        n = (n1<<24) + (n2<<16) + (n3<<8) + n4;

//        fprintf(stdout, " %ld \n", n);

        int_seq[p>>2] = actg_uint8(n) ;
        p = p + 4;
    }
    int_seq[p + 1] = '\0';
    return int_seq;
}



char* intseq_actg(char* int_seq, char* actg_seq, int8_t int_seq_len){
//// int seq to DNA seq
//// Function not tested yet
//// one char(byte) to four bases

    int p = 0;
    unsigned long n, mask;

//    fprintf(stdout, "mask: %ld\n", mask);

    unsigned char n1, n2, n3, n4;
    while(p < int_seq_len){
        mask= (1<<8) - 1;
//        fprintf(stdout, "mask: %ld\n", mask);
        n = uint8_actg(int_seq[p]) ;
//        fprintf(stdout, "n: %d\n", n);
        n4 = (n & mask);
//        fprintf(stdout, "n4: %d\n", n4);

        mask = mask <<8;
//        fprintf(stdout, "mask: %ld\n", mask);

        n3 = (n & mask)>>8;
//        fprintf(stdout, "n3: %d\n", n3);

        mask = mask <<8;
//        fprintf(stdout, "mask: %ld\n", mask);
        n2 = (n & mask)>>16;
//        fprintf(stdout, "n2: %d\n", n2);

        mask = mask <<8;
//        fprintf(stdout, "mask: %ld\n", mask);
        n1 = (n & mask)>>24;
//        fprintf(stdout, "n1: %d\n", n1);


        actg_seq[p<<2] = n1;
        actg_seq[(p<<2) + 1] = n2;
        actg_seq[(p<<2) + 2] = n3;
        actg_seq[(p<<2) + 3] = n4;
        p = p + 1;
    }
   // actg_seq[((p-1)<<2)+1] = "\0";
    return actg_seq;
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

    //if(x >0){
    if(kh_exist(h->h[j], x)){
        cov = kh_key(h->h[j], x) & KC_MAX;
    }
   // }else{cov = 0;}
    return cov;
}


//        c4x_insert_buf(buf, p, hash64(y, mask));
/*
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
*/

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

    for(i=0; i<km_num; i++){

            int cov = kmer_cov(*(kms+i), mask, h);
            if(cov > max_cov){max_cov=cov;}
    }
    return max_cov;
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

typedef struct { // global data structure for kt_pipeline()
    int k, block_len;
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


//static void worker_pipeline(void *data, int step, void *in) // callback for kt_pipeline()
static void worker_pipeline(void *data) // callback for kt_pipeline()
{
    pldat_t *p = (pldat_t*)data;
    uint64_t mask = (1ULL<<p->k*2) - 1;
    //if (step == 0) { // step 1: read a block of sequences
    int ret;
    stepdat_t *s;
    CALLOC(s, 1);
    s->p = p;
    int i = 0;

    while ((ret = kseq_read(p->ks)) >= 0) {// Reading seqs

        i = i + 1;
        uint64_t *kms;
        int l = p->ks->seq.l, km_num = 0;
        if (l < p->k) continue;
        MALLOC(kms, l-p->k + 1); //
        km_num = seq_kmers(kms, p->k, l, p->ks->seq.s);

        int j;
        for(j=0;j<km_num;j++){
            add_kmer(*(kms+j), mask, p->h);
        }
        //printf("%d\t",i);
        //printf("%s\n",p->ks->seq.s);
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

    worker_pipeline(&pl);

    kseq_destroy(pl.ks);
    gzclose(fp);
    return pl.h;
}


/*

void print_uint64_kmer(uint64_t km, int km_len){
    fprintf(stdout, "uint64: %"PRIu64, km);
   fprintf(stdout, " rev: %"PRIu64, comp_rev(km, km_len));
   fprintf(stdout, " minHash: %"PRIu64, min_hash_key(km,km_len));
    char seq[31];
    seq[31] = '\0';
    uint64_acgt(km, seq, km_len);
    fprintf(stdout, "\tkm: %s\n", seq);

}



void print_cov(char* seq, int k, kc_c4x_t *h){ //Debugging function
    uint64_t mask = (1ULL<<k*2) - 1;
    int test_cov=0;
    test_cov = kmer_cov( actgkmer_hashkey(seq, k), mask, h);
    print_kmer_seq(seq, k);
    printf("\t");
    printf("cov: %d\n", test_cov);
}

void print_kmer_seq(char *seq, int k){ //Debugging function
    int i=0;
    for(i=0;i<k;i++){
            printf("%c", *(seq + i));
    }
}
*/


int main(int argc, char *argv[])
{
    kc_c4x_t *h;
    int i, c, k = 31, p = KC_BITS, max_link_num = 1;

    ketopt_t o = KETOPT_INIT;
    while ((c = ketopt(&o, argc, argv, 1, "k:p:m:", 0)) >= 0) {
        if (c == 'k') k = atoi(o.arg);
        else if (c == 'm') max_link_num = atoi(o.arg);
    }

    if (argc - o.ind < 1) {
        fprintf(stderr, "Usage: DBGPS-links [options] <in.fa>\n");
        fprintf(stderr, "Author: Lifu Song lifu.song@outlook.com\n");
        fprintf(stderr, "Version 20220116\n");
        fprintf(stderr, "Options:\n");
        fprintf(stderr, "  -k INT     k-mer size [%d]\n", k);
        //fprintf(stderr, "  -m INT     max k-mer coverage [%d]\n", max_link_num);
        return 1;
    }

    fprintf(stderr, "Please Remove the primers before counting\nCounting strand links ......\n");

    h = count_file(argv[o.ind], k, p);

    fprintf(stderr, "k-mer analysis finished ......\n");

    unsigned int link_num1=0;
    unsigned int link_num2=0;

    int j;
    for (j=0; j < 1<<KC_BITS; ++j){
          //  fprintf(stderr, "%d\t", j);
        kc_c4_t *g = h->h[j];
        khint_t kk;
        if(kh_size(h->h[j]) > 0){
            for (kk = kh_end(g); kk > 0; --kk){
                if (kh_exist(g, kk)){
                    int c = kh_key(g, kk) & KC_MAX;
                    if(c > max_link_num){
                        link_num1 = link_num1 + c -1;
                    }
                    if(c > 2){
                        link_num2 = link_num2 + c -1;
                    }
                }
            }
        }

    }

    fprintf(stdout, "Total cross links %d\n", link_num1);
    //fprintf(stdout, "Total strand cross links 2 %d\n", link_num2);


    for (i = 0; i < 1<<p; ++i) kc_c4_destroy(h->h[i]);
    free(h->h); free(h);
    return 0;
}



