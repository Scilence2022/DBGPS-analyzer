#ifndef DSTOREQC_CLI_H
#define DSTOREQC_CLI_H

#include <stdio.h>

int dstoreqc_analyze_command(int argc, char *argv[]);
int dstoreqc_kernel_command(int argc, char *argv[]);
int dstoreqc_links_command(int argc, char *argv[]);
int dstoreqc_filter_command(int argc, char *argv[]);
int dstoreqc_report_command(int argc, char *argv[]);

/* Shared batch analysis API. Report supplies typed inputs, not CLI tokens. */
typedef struct {
    const char *reference;
    int read_count;
    char **reads;
    int k, threads, read_length, primer_length;
} dstoreqc_analysis_options_t;

dstoreqc_analysis_options_t dstoreqc_analysis_defaults(void);
int dstoreqc_analyze_reference(const dstoreqc_analysis_options_t *options, FILE *out);

#endif
