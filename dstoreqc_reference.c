/* Reference-library analysis. Counts are strand membership, not read abundance.
 * Keep this translation unit separate from the analyzer's 14-bit read counters. */
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#include <sys/stat.h>

#include "dstoreqc_cli.h"
#include "dstoreqc_report.h"
#include "ketopt.h"
#include "kseq.h"
KSEQ_INIT(gzFile, gzread)

#define DSTOREQC_KC_BITS 10
#include "dstoreqc_core.h"

enum reference_mode { REFERENCE_LINKS, REFERENCE_FILTER, REFERENCE_REPORT };

typedef struct {
    int k, primer_len, links_threshold, filter_max_links;
    int json, include_passed, list_filtered, threads, read_len;
    enum dstoreqc_report_format format;
    const char *output;
} reference_options_t;

typedef dstoreqc_reference_stats_t reference_stats_t;

static int copy_stream(FILE *out, FILE *in)
{
    char buffer[8192];
    size_t n;
    if (fflush(in) != 0 || fseek(in, 0, SEEK_SET) != 0) return -1;
    while ((n = fread(buffer, 1, sizeof(buffer), in)) > 0)
        if (fwrite(buffer, 1, n, out) != n) return -1;
    return ferror(in) || ferror(out) ? -1 : 0;
}

static int parse_integer(const char *arg, const char *option, int min, int max, int *out)
{
    char *end;
    errno = 0;
    long value = strtol(arg, &end, 10);
    if (errno || end == arg || *end || value < min || value > max) {
        if (strcmp(option, "-k") == 0)
            fprintf(stderr, "Error: -k must be between 1 and 31 (got %s)\n", arg);
        else if (min == 0)
            fprintf(stderr, "Error: %s must be non-negative and at most %d (got %s)\n", option, max, arg);
        else
            fprintf(stderr, "Error: %s must be between %d and %d (got %s)\n", option, min, max, arg);
        return -1;
    }
    *out = (int)value;
    return 0;
}

static void reference_usage(FILE *out, enum reference_mode mode)
{
    const char *command = mode == REFERENCE_LINKS ? "links" : mode == REFERENCE_FILTER ? "filter" : "report";
    fprintf(out, "Usage: dstoreqc %s [options] <reference.fa>%s\n", command,
            mode == REFERENCE_REPORT ? " [reads.fa/fq[.gz] ...]" : "");
    fprintf(out, "  -k INT     k-mer size [31], range 1-31\n");
    fprintf(out, "  -p INT     ignore this many primer bases at each end [%d]\n", mode == REFERENCE_LINKS ? 0 : 18);
    if (mode == REFERENCE_LINKS)
        fprintf(out, "  -m INT     only count k-mers occurring in more than this many strands [1]\n");
    else if (mode == REFERENCE_FILTER) {
        fprintf(out, "  -m INT     maximum allowed other strands sharing any one k-mer [0]\n");
        fprintf(out, "  -s         list filtered names instead of passed FASTA\n");
    } else {
        fprintf(out, "  --links-threshold INT   exclusive strand-count threshold for cross-links [1]\n");
        fprintf(out, "  --filter-max-links INT  maximum allowed other strands per k-mer [0]\n");
        fprintf(out, "  --include-passed        include original passed sequences in the report\n");
        fprintf(out, "  -t INT     threads for NGS counting [3]\n");
        fprintf(out, "  -L INT     maximum read length for NGS counting [200]\n");
        fprintf(out, "  --format FORMAT         json [default], markdown (md), or html\n");
        fprintf(out, "  -o, --output FILE       write report to a file [stdout]\n");
        fprintf(out, "Primer trimming applies to both reference analyses and Sm/Kn/Kd.\n");
    }
    fprintf(out, "  --json     structured output%s\n", mode == REFERENCE_FILTER ? "; includes filteredNames and passedFasta in one run" : "");
    fprintf(out, "  -h, --help show this help\n");
    fprintf(out, "FASTA/FASTQ and gzip inputs are supported. Strand counts saturate at %d.\n", KC_MAX);
}

static int input_error(gzFile fp, int status, const char *file)
{
    int zerr;
    const char *message = gzerror(fp, &zerr);
    if (status < -1 || (zerr != Z_OK && zerr != Z_STREAM_END)) {
        fprintf(stderr, "Error: could not read %s: %s\n", file,
                status < -1 ? "malformed FASTA/FASTQ record" : message);
        return 1;
    }
    return 0;
}

static kc_c4x_t *build_reference(const char *file, const reference_options_t *o, reference_stats_t *stats)
{
    gzFile fp = gzopen(file, "r");
    if (!fp) { fprintf(stderr, "Error: could not open %s\n", file); return NULL; }
    kseq_t *ks = kseq_init(fp);
    kc_c4x_t *h = c4x_init(KC_BITS);
    kmer_set_t seen = {0};
    uint64_t mask = (1ULL << (o->k * 2)) - 1;
    int status, failed = 0;
    fprintf(stderr, "Counting reference strand k-mers (k=%d, primer=%d bp per end) ...\n", o->k, o->primer_len);
    while ((status = kseq_read(ks)) >= 0) {
        if (ks->seq.l > INT_MAX) { failed = 1; break; }
        stats->total++;
        uint64_t *kms;
        int n = collect_primer_kmers(&kms, &seen, ks->seq.l, ks->seq.s, o->k, o->primer_len);
        if (n < 0) {
            stats->skipped++;
            fprintf(stderr, "Skipping %s: %d bp remain after trimming %d bp from each end; need at least k=%d\n",
                    ks->name.s, trimmed_len_for(ks->seq.l, o->primer_len), o->primer_len, o->k);
            continue;
        }
        for (int i = 0; i < n; ++i) add_kmer(kms[i], mask, h);
        free(kms);
    }
    if (failed) fprintf(stderr, "Error: reference sequence exceeds %d bases\n", INT_MAX);
    failed |= input_error(fp, status, file);
    kmer_set_destroy(&seen);
    kseq_destroy(ks);
    if (gzclose(fp) != Z_OK) failed = 1;
    if (failed) { c4x_destroy(h); return NULL; }
    return h;
}

static unsigned long long count_links(kc_c4x_t *h, int threshold)
{
    unsigned long long links = 0;
    for (int j = 0; j < 1 << h->p; ++j) {
        kc_c4_t *g = h->h[j];
        for (khint_t i = 0; i < kh_end(g); ++i) {
            if (!kh_exist(g, i)) continue;
            int count = kh_key(g, i) & KC_MAX;
            if (count > threshold) links += count - 1;
        }
    }
    return links;
}

static int filter_reference(const char *file, kc_c4x_t *h, const reference_options_t *o,
                            reference_stats_t *stats, FILE *passed, FILE *names)
{
    gzFile fp = gzopen(file, "r");
    if (!fp) { fprintf(stderr, "Error: could not open %s\n", file); return 1; }
    kseq_t *ks = kseq_init(fp);
    kmer_set_t seen = {0};
    uint64_t mask = (1ULL << (o->k * 2)) - 1;
    int status, failed = 0;
    unsigned long long total = 0;
    while ((status = kseq_read(ks)) >= 0) {
        if (ks->seq.l > INT_MAX) { failed = 1; break; }
        total++;
        uint64_t *kms;
        int n = collect_primer_kmers(&kms, &seen, ks->seq.l, ks->seq.s, o->k, o->primer_len);
        if (n < 0) continue;
        int cov = kms_max_cov(kms, n, mask, h);
        free(kms);
        int links = cov > 0 ? cov - 1 : 0;
        if (links <= o->filter_max_links) {
            stats->passed++;
            if (passed) fprintf(passed, ">%s\n%s\n", ks->name.s, ks->seq.s);
        } else {
            if (names) fprintf(names, "%s\n", ks->name.s);
            stats->filtered++;
            if (!o->json) fprintf(stderr, "%llu/%llu * ", stats->filtered, total);
        }
    }
    failed |= input_error(fp, status, file);
    kmer_set_destroy(&seen);
    kseq_destroy(ks);
    if (gzclose(fp) != Z_OK) failed = 1;
    if ((passed && ferror(passed)) || (names && ferror(names))) failed = 1;
    return failed;
}

static int run_reference(const char *file, const reference_options_t *o,
                         enum reference_mode mode, FILE *out, dstoreqc_report_t *report)
{
    reference_stats_t stats = {0};
    kc_c4x_t *h = build_reference(file, o, &stats);
    if (!h) return 1;
    if (mode == REFERENCE_LINKS || o->json)
        stats.cross_links = count_links(h, o->links_threshold);
    FILE *passed = NULL, *names = NULL;
    int result = 1;
    if (mode != REFERENCE_LINKS) {
        if (o->json) {
            names = tmpfile();
            if (o->include_passed) passed = tmpfile();
            if (!names || (o->include_passed && !passed)) { perror("reference output"); goto done; }
        } else {
            passed = o->list_filtered ? NULL : out;
            names = o->list_filtered ? out : NULL;
        }
        if (filter_reference(file, h, o, &stats, passed, names)) goto done;
    }
    dstoreqc_report_t data = {0};
    data.k = o->k;
    data.primer_len = o->primer_len;
    data.links_threshold = o->links_threshold;
    data.filter_max_links = o->filter_max_links;
    data.stats = stats;
    data.filtered_names = names;
    data.passed_fasta = passed;
    if (report) {
        *report = data;
        names = passed = NULL;  /* Transfer stream ownership to the report. */
        result = 0;
        goto done;
    }
    if (o->json) {
        if (dstoreqc_write_reference_json(out, &data, mode == REFERENCE_LINKS)) goto done;
        fputc('\n', out);
    } else if (mode == REFERENCE_LINKS) fprintf(out, "Total cross links %llu\n", stats.cross_links);
    else fprintf(stderr, "\nTask done!\n");
    result = ferror(out) ? 1 : 0;
done:
    if (o->json && passed) fclose(passed);
    if (o->json && names) fclose(names);
    c4x_destroy(h);
    return result;
}

static int output_is_input(const char *output, int file_count, char **files)
{
    struct stat destination, input;
    if (stat(output, &destination) != 0) return 0;
    for (int i = 0; i < file_count; ++i) {
        if (stat(files[i], &input) == 0 && input.st_dev == destination.st_dev && input.st_ino == destination.st_ino) {
            fprintf(stderr, "Error: report output must not overwrite input file %s\n", files[i]);
            return 1;
        }
    }
    return 0;
}

static int run_report(int file_count, char **files, const reference_options_t *o)
{
    dstoreqc_report_t report = {0};
    FILE *rendered = NULL, *output = NULL;
    int result = 1;
    if (o->output && output_is_input(o->output, file_count, files)) return 1;
    if (run_reference(files[0], o, REFERENCE_REPORT, NULL, &report)) goto done;
    report.reference_file = files[0];
    report.read_count = file_count - 1;
    report.reads = files + 1;
    report.threads = o->threads;
    report.read_len = o->read_len;
    if (file_count > 1) {
        report.metrics = tmpfile();
        if (!report.metrics) { perror("metrics output"); goto done; }
        dstoreqc_analysis_options_t analysis = dstoreqc_analysis_defaults();
        analysis.reference = files[0];
        analysis.read_count = file_count - 1;
        analysis.reads = files + 1;
        analysis.k = o->k;
        analysis.threads = o->threads;
        analysis.read_length = o->read_len;
        analysis.primer_length = o->primer_len;
        if (dstoreqc_analyze_reference(&analysis, report.metrics)) goto done;
    }
    rendered = tmpfile();
    if (!rendered) { perror("report output"); goto done; }
    if (dstoreqc_write_report(rendered, &report, o->format)) {
        fprintf(stderr, "Error: could not render report\n");
        goto done;
    }
    /* Open the destination only after analysis and rendering have succeeded. */
    output = o->output ? fopen(o->output, "wb") : stdout;
    if (!output) { perror("report output"); goto done; }
    if (copy_stream(output, rendered) || fflush(output) != 0) {
        fprintf(stderr, "Error: could not write report\n");
        goto done;
    }
    result = 0;
done:
    if (output && output != stdout && fclose(output) != 0) result = 1;
    if (rendered) fclose(rendered);
    if (report.metrics) fclose(report.metrics);
    if (report.filtered_names) fclose(report.filtered_names);
    if (report.passed_fasta) fclose(report.passed_fasta);
    return result;
}

static int reference_command(int argc, char *argv[], enum reference_mode mode)
{
    reference_options_t opts = { .k = 31, .primer_len = mode == REFERENCE_LINKS ? 0 : 18,
        .links_threshold = 1, .json = mode == REFERENCE_REPORT, .threads = 3, .read_len = 200,
        .format = DSTOREQC_REPORT_JSON };
    int c, help = 0, json_requested = 0;
    static const ko_longopt_t long_options[] = {
        {"help", 0, 'h'}, {"json", 0, 300},
        {"links-threshold", 1, 301}, {"filter-max-links", 1, 302},
        {"include-passed", 0, 303}, {"format", 1, 304}, {"output", 1, 'o'}, {0, 0, 0}
    };
    ketopt_t opt = KETOPT_INIT;
    while ((c = ketopt(&opt, argc, argv, 1, "hk:m:p:st:L:o:", long_options)) >= 0) {
        if (c == '?' || c == ':') {
            fprintf(stderr, "Error: unknown option or missing option argument\n"); return 1;
        }
        if (c == 'h') { help = 1; continue; }
        if (c == 300 && !opt.arg) { opts.json = 1; json_requested = 1; continue; }
        if (c == 'k' && !parse_integer(opt.arg, "-k", 1, 31, &opts.k)) continue;
        if (c == 'p' && !parse_integer(opt.arg, "-p", 0, INT_MAX / 2, &opts.primer_len)) continue;
        if (mode != REFERENCE_REPORT && c == 'm') {
            int *value = mode == REFERENCE_LINKS ? &opts.links_threshold : &opts.filter_max_links;
            if (!parse_integer(opt.arg, "-m", 0, INT_MAX, value)) continue;
        }
        if (mode == REFERENCE_FILTER && c == 's') { opts.list_filtered = 1; continue; }
        if (mode == REFERENCE_REPORT) {
            if (c == 'o') { opts.output = opt.arg; continue; }
            if (c == 304) {
                if (strcmp(opt.arg, "json") == 0) opts.format = DSTOREQC_REPORT_JSON;
                else if (strcmp(opt.arg, "markdown") == 0 || strcmp(opt.arg, "md") == 0) opts.format = DSTOREQC_REPORT_MARKDOWN;
                else if (strcmp(opt.arg, "html") == 0) opts.format = DSTOREQC_REPORT_HTML;
                else { fprintf(stderr, "Error: --format must be json, markdown (md), or html\n"); return 1; }
                continue;
            }
            if (c == 301 && !parse_integer(opt.arg, "--links-threshold", 0, INT_MAX, &opts.links_threshold)) continue;
            if (c == 302 && !parse_integer(opt.arg, "--filter-max-links", 0, INT_MAX, &opts.filter_max_links)) continue;
            if (c == 303 && !opt.arg) { opts.include_passed = 1; continue; }
            if (c == 't' && !parse_integer(opt.arg, "-t", 1, INT_MAX, &opts.threads)) continue;
            if (c == 'L' && !parse_integer(opt.arg, "-L", 1, INT_MAX, &opts.read_len)) continue;
        }
        fprintf(stderr, "Error: invalid option or value for this command\n");
        return 1;
    }
    int file_count = argc - opt.ind;
    if (help || file_count < 1) {
        reference_usage(help ? stdout : stderr, mode);
        return help ? 0 : 1;
    }
    if (mode != REFERENCE_REPORT && file_count != 1) {
        fprintf(stderr, "Error: expected exactly one reference file\n"); return 1;
    }
    if (json_requested && opts.format != DSTOREQC_REPORT_JSON) {
        fprintf(stderr, "Error: --json conflicts with the selected --format\n"); return 1;
    }
    if (opts.json && opts.list_filtered) {
        fprintf(stderr, "Error: --json already includes filteredNames; omit -s\n"); return 1;
    }
    if (mode == REFERENCE_FILTER && opts.json) opts.include_passed = 1;
    if (mode == REFERENCE_REPORT) return run_report(file_count, argv + opt.ind, &opts);
    return run_reference(argv[opt.ind], &opts, mode, stdout, NULL);
}

int dstoreqc_links_command(int argc, char *argv[])
{
    return reference_command(argc, argv, REFERENCE_LINKS);
}

int dstoreqc_filter_command(int argc, char *argv[])
{
    return reference_command(argc, argv, REFERENCE_FILTER);
}

int dstoreqc_report_command(int argc, char *argv[])
{
    return reference_command(argc, argv, REFERENCE_REPORT);
}
