#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>

#include "dstoreqc_report.h"

static int rewind_stream(FILE *in)
{
    return fflush(in) != 0 || fseek(in, 0, SEEK_SET) != 0;
}

static void json_char(FILE *out, unsigned char c)
{
    if (c == '"' || c == '\\') fprintf(out, "\\%c", c);
    else if (c < 32) fprintf(out, "\\u%04x", c);
    else fputc(c, out);
}

static void json_string(FILE *out, const char *s)
{
    fputc('"', out);
    for (; *s; ++s) json_char(out, (unsigned char)*s);
    fputc('"', out);
}

static void html_char(FILE *out, unsigned char c)
{
    if (c == '&') fputs("&amp;", out);
    else if (c == '<') fputs("&lt;", out);
    else if (c == '>') fputs("&gt;", out);
    else if (c == '"') fputs("&quot;", out);
    else if (c == '\'') fputs("&#39;", out);
    else fputc(c < 32 && c != '\n' && c != '\t' ? '?' : c, out);
}

static void text(FILE *out, const char *s, int html)
{
    for (; *s; ++s) {
        unsigned char c = (unsigned char)*s;
        if (html) html_char(out, c);
        else if (c < 32) fputc(' ', out);
        else if (c == '&' || c == '<' || c == '>') html_char(out, c);
        else {
            if (strchr("\\`*_{}[]()#+-!|~", c)) fputc('\\', out);
            fputc(c, out);
        }
    }
}

static void number(FILE *out, double value, const char *missing)
{
    if (isfinite(value)) fprintf(out, "%.6f", value);
    else fputs(missing, out);
}

static int write_names(FILE *out, FILE *names, int format)
{
    if (!names) return 0;
    if (rewind_stream(names)) return 1;
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length;
    int first = 1;
    while ((length = getline(&line, &capacity, names)) >= 0) {
        if (length && line[length - 1] == '\n') line[--length] = 0;
        if (format == DSTOREQC_REPORT_JSON) {
            if (!first) fputc(',', out);
            json_string(out, line);
        } else {
            fputs(format == DSTOREQC_REPORT_HTML ? "<li><code>" : "- ", out);
            text(out, line, format == DSTOREQC_REPORT_HTML);
            fputs(format == DSTOREQC_REPORT_HTML ? "</code></li>\n" : "\n", out);
        }
        first = 0;
    }
    free(line);
    return ferror(names) || ferror(out);
}

static int write_fasta(FILE *out, FILE *fasta, int format)
{
    if (!fasta) return 0;
    if (rewind_stream(fasta)) return 1;
    int c, line_start = 1;
    while ((c = fgetc(fasta)) != EOF) {
        if (format == DSTOREQC_REPORT_JSON) json_char(out, c);
        else if (format == DSTOREQC_REPORT_HTML) html_char(out, c);
        /* Indented Markdown code preserves names containing backtick fences. */
        else {
            if (line_start) fputs("    ", out);
            fputc(c, out);
            line_start = c == '\n';
        }
    }
    return ferror(fasta) || ferror(out);
}

int dstoreqc_write_reference_json(FILE *out, const dstoreqc_report_t *r, int links_only)
{
    fprintf(out, "{\"type\":\"%s\",\"k\":%d,\"primerLen\":%d,\"linksThreshold\":%d,"
            "\"totalStrands\":%llu,\"skippedCount\":%llu,\"crossLinks\":%llu",
            links_only ? "links" : "reference", r->k, r->primer_len, r->links_threshold,
            r->stats.total, r->stats.skipped, r->stats.cross_links);
    if (!links_only) {
        fprintf(out, ",\"filterMaxLinks\":%d,\"passedCount\":%llu,\"filteredCount\":%llu,\"filteredNames\":[",
                r->filter_max_links, r->stats.passed, r->stats.filtered);
        if (write_names(out, r->filtered_names, DSTOREQC_REPORT_JSON)) return 1;
        fputc(']', out);
        if (r->passed_fasta) {
            fputs(",\"passedFasta\":\"", out);
            if (write_fasta(out, r->passed_fasta, DSTOREQC_REPORT_JSON)) return 1;
            fputc('"', out);
        }
    }
    fputc('}', out);
    return ferror(out);
}

static int write_metrics(FILE *out, const dstoreqc_report_t *r, int format)
{
    if (!r->metrics) {
        fputs(format == DSTOREQC_REPORT_JSON ? "null" : format == DSTOREQC_REPORT_HTML
              ? "<p>No NGS reads supplied; Sm/Kd/Kn were not computed.</p>\n"
              : "No NGS reads supplied; Sm/Kd/Kn were not computed.\n", out);
        return ferror(out);
    }
    if (rewind_stream(r->metrics)) return 1;
    if (format == DSTOREQC_REPORT_JSON) fprintf(out, "{\"primerLen\":%d,\"rows\":[", r->primer_len);
    else if (format == DSTOREQC_REPORT_HTML)
        fputs("<div class=table-wrap><table><thead><tr><th>Ratio</th><th>Coverage</th><th>Total</th><th>Paths</th><th>Noise</th><th>Exist</th><th>Lost</th><th>Sm</th><th>Kd</th><th>Kn</th></tr></thead><tbody>\n", out);
    else fputs("| Ratio | Coverage | Total | Paths | Noise | Exist | Lost | Sm | Kd | Kn |\n"
               "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n", out);
    char line[4096];
    int first = 1;
    while (fgets(line, sizeof(line), r->metrics)) {
        double ratio, sm, kd, kn;
        long long cov, total, paths, noise, exist, lost;
        if (sscanf(line, "%lf\t%lld\t%lld\t%lld\t%lld\t%lld\t%lld\t%lf\t%lf\t%lf",
                   &ratio, &cov, &total, &paths, &noise, &exist, &lost, &sm, &kd, &kn) != 10) continue;
        if (format == DSTOREQC_REPORT_JSON) {
            if (!first) fputc(',', out);
            fputs("{\"ratio\":", out); number(out, ratio, "null");
            fprintf(out, ",\"coverage\":%lld,\"total\":%lld,\"paths\":%lld,\"noise\":%lld,\"exist\":%lld,\"lost\":%lld,\"sm\":",
                    cov, total, paths, noise, exist, lost);
            number(out, sm, "null"); fputs(",\"kd\":", out);
            number(out, kd, "null"); fputs(",\"kn\":", out);
            number(out, kn, "null"); fputc('}', out);
        } else {
            const char *separator = format == DSTOREQC_REPORT_HTML ? "</td><td>" : " | ";
            fputs(format == DSTOREQC_REPORT_HTML ? "<tr><td>" : "| ", out);
            number(out, ratio, "n/a");
            fprintf(out, "%s%lld%s%lld%s%lld%s%lld%s%lld%s%lld%s",
                    separator, cov, separator, total, separator, paths, separator, noise,
                    separator, exist, separator, lost, separator);
            number(out, sm, "n/a"); fputs(separator, out);
            number(out, kd, "n/a"); fputs(separator, out);
            number(out, kn, "n/a");
            fputs(format == DSTOREQC_REPORT_HTML ? "</td></tr>\n" : " |\n", out);
        }
        first = 0;
    }
    fputs(format == DSTOREQC_REPORT_JSON ? "]}" : format == DSTOREQC_REPORT_HTML ? "</tbody></table></div>\n" : "\n", out);
    return first || ferror(r->metrics) || ferror(out);
}

static void summary_row(FILE *out, const char *label, unsigned long long value, int html)
{
    fprintf(out, html ? "<tr><th>%s</th><td>%llu</td></tr>\n" : "| %s | %llu |\n", label, value);
}

int dstoreqc_write_report(FILE *out, const dstoreqc_report_t *r, enum dstoreqc_report_format format)
{
    int html = format == DSTOREQC_REPORT_HTML;
    if (format == DSTOREQC_REPORT_JSON) {
        fputs("{\"type\":\"report\",\"referenceFile\":", out);
        json_string(out, r->reference_file);
        fputs(",\"ngsFiles\":[", out);
        for (int i = 0; i < r->read_count; ++i) {
            if (i) fputc(',', out);
            json_string(out, r->reads[i]);
        }
        fputs("],\"reference\":", out);
        if (dstoreqc_write_reference_json(out, r, 0)) return 1;
        fputs(",\"analyzer\":", out);
        if (write_metrics(out, r, format)) return 1;
        fputs("}\n", out);
        return ferror(out);
    }
    if (html) fputs("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
                   "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                   "<title>DStoreQC Quality Report</title><style>"
                   "body{font:15px/1.6 system-ui,sans-serif;color:#203044;background:#f4f7fb;margin:0;padding:32px 16px}"
                   "main{max-width:1060px;margin:auto;background:white;border:1px solid #dbe3ec;border-radius:12px;padding:28px}"
                   "h1{margin:0 0 4px;font-size:28px}h2{font-size:20px;margin-top:30px}"
                   "table{border-collapse:collapse;width:100%;margin:12px 0}th,td{padding:9px 12px;border:1px solid #dbe3ec;text-align:left}"
                   "th{background:#edf3f8}td{font-variant-numeric:tabular-nums}.table-wrap{overflow:auto}"
                   "code,pre{font-family:ui-monospace,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f4f7fb;padding:16px}"
                   ".subtitle{color:#56667b}ul{padding-left:24px}@media(max-width:600px){body{padding:12px}main{padding:16px}th,td{padding:6px}}"
                   "</style></head><body><main><h1>DStoreQC Quality Report</h1>"
                   "<p class=subtitle>DNA information storage quality analysis</p>\n<h2>Inputs and settings</h2>\n<p>Reference: <code>", out);
    else fputs("# DStoreQC Quality Report\n\nDNA information storage quality analysis\n\n## Inputs and settings\n\nReference: ", out);
    text(out, r->reference_file, html);
    fputs(html ? "</code></p>\n<p>NGS reads:</p><ul>\n" : "\n\nNGS reads:\n\n", out);
    if (!r->read_count) fputs(html ? "<li>None supplied</li>\n" : "- None supplied\n", out);
    for (int i = 0; i < r->read_count; ++i) {
        fputs(html ? "<li><code>" : "- ", out); text(out, r->reads[i], html);
        fputs(html ? "</code></li>\n" : "\n", out);
    }
    if (html) fputs("</ul>\n", out);
    fprintf(out, html ? "<p>k = %d; primer = %d bp per end; links threshold = %d; filter maximum = %d; threads = %d; read length = %d.</p>\n"
            : "\nk = %d; primer = %d bp per end; links threshold = %d; filter maximum = %d; threads = %d; read length = %d.\n",
            r->k, r->primer_len, r->links_threshold, r->filter_max_links, r->threads, r->read_len);
    fputs(html ? "<h2>Summary</h2><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>\n"
               : "\n## Summary\n\n| Metric | Value |\n| --- | --- |\n", out);
    summary_row(out, "Reference strands", r->stats.total, html);
    summary_row(out, "Passed strands", r->stats.passed, html);
    summary_row(out, "Entangled strands", r->stats.filtered, html);
    summary_row(out, "Skipped strands", r->stats.skipped, html);
    summary_row(out, "Cross-link contributions", r->stats.cross_links, html);
    if (html) fputs("</tbody></table>\n", out);
    fputs(html ? "<h2>Coverage metrics</h2>\n" : "\n## Coverage metrics\n\n", out);
    if (write_metrics(out, r, format)) return 1;
    fputs(html ? "<h2>Entangled strands</h2>\n" : "\n## Entangled strands\n\n", out);
    if (r->stats.filtered) {
        if (html) fputs("<ul>\n", out);
        if (write_names(out, r->filtered_names, format)) return 1;
        if (html) fputs("</ul>\n", out);
    } else fputs(html ? "<p>None detected.</p>\n" : "None detected.\n", out);
    fputs(html ? "<h2>Metric definitions</h2><p>" : "\n## Metric definitions\n\n", out);
    fputs("Sm is strand recovery, Kd is k-mer dropout, and Kn is the noise-to-valid k-mer ratio. "
          "Cross-links sum n-1 for k-mers with strand count n above the links threshold. "
          "Filtering uses the maximum n-1 of any k-mer in each strand. "
          "Strands too short after trimming are skipped for entanglement; Sm retains all reference records in its denominator. "
          "Undefined metrics are shown as n/a. Primer trimming affects scoring; passed FASTA retains original sequences.", out);
    fputs(html ? "</p>\n" : "\n", out);
    if (r->passed_fasta) {
        fputs(html ? "<h2>Passed FASTA</h2><pre>" : "\n## Passed FASTA\n\n", out);
        if (write_fasta(out, r->passed_fasta, format)) return 1;
        fputs(html ? "</pre>\n" : "\n", out);
    }
    if (html) fputs("</main></body></html>\n", out);
    return ferror(out);
}
