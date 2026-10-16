#ifndef DSTOREQC_REPORT_H
#define DSTOREQC_REPORT_H

#include <stdio.h>

enum dstoreqc_report_format { DSTOREQC_REPORT_JSON, DSTOREQC_REPORT_MARKDOWN, DSTOREQC_REPORT_HTML };

typedef struct {
    unsigned long long total, skipped, passed, filtered, cross_links;
} dstoreqc_reference_stats_t;

typedef struct {
    const char *reference_file;
    int read_count;
    char **reads;
    int k, primer_len, links_threshold, filter_max_links, threads, read_len;
    dstoreqc_reference_stats_t stats;
    FILE *filtered_names, *passed_fasta, *metrics;
} dstoreqc_report_t;

int dstoreqc_write_reference_json(FILE *out, const dstoreqc_report_t *report, int links_only);
int dstoreqc_write_report(FILE *out, const dstoreqc_report_t *report, enum dstoreqc_report_format format);

#endif
