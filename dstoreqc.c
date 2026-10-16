#include <stdio.h>
#include <string.h>

#include "dstoreqc_cli.h"

static const struct {
    const char *name;
    int (*run)(int argc, char *argv[]);
    const char *description;
} commands[] = {
    {"analyze", dstoreqc_analyze_command, "compute Sm/Kn/Kd from reference strands and reads"},
    {"kernel", dstoreqc_kernel_command, "start interactive JSON Lines diagnostics"},
    {"links", dstoreqc_links_command, "count cross-links in a reference library"},
    {"filter", dstoreqc_filter_command, "filter entangled reference strands"},
    {"report", dstoreqc_report_command, "JSON, Markdown or HTML report, with optional reads"}
};

static void usage(FILE *out)
{
    fprintf(out, "Usage: dstoreqc <command> [options] <files>\nCommands:\n");
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); ++i)
        fprintf(out, "  %-9s %s\n", commands[i].name, commands[i].description);
    fprintf(out, "Use dstoreqc <command> --help for command options.\n");
}

int main(int argc, char *argv[])
{
    if (argc < 2) { usage(stderr); return 1; }
    if (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0) {
        usage(stdout);
        return 0;
    }
    for (size_t i = 0; i < sizeof(commands) / sizeof(commands[0]); ++i)
        if (strcmp(argv[1], commands[i].name) == 0)
            return commands[i].run(argc - 1, argv + 1);
    fprintf(stderr, "Error: unknown command '%s'\n", argv[1]);
    usage(stderr);
    return 1;
}
