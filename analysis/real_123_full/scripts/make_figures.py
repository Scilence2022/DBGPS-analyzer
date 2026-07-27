#!/usr/bin/env python3
"""Generate publication-quality, self-contained SVG figures for the DBGPS-analyzer
manuscript from the YC10 benchmark numbers.

Figures 1-3 are built from the published headline numbers (summary_stats.csv).
Figure 4 (the disagreement scatter) is built from a full joined_comparison CSV when
one is supplied via --joined; otherwise it is skipped.

Usage:
  python3 make_figures.py --outdir ../../../docs/figures [--joined /path/joined_comparison.full.csv]

The SVGs use hard-coded colors and a white background so they render identically in
GitHub, Word, and LaTeX (no theme CSS variables).
"""
from __future__ import annotations

import argparse
import csv
import html
import math
from pathlib import Path

# ---- palette ----
INK = "#1e293b"
MUTED = "#64748b"
GRID = "#e2e8f0"
BLUE = "#2563eb"        # DBGPS
SLATE = "#94a3b8"       # alignment step
AMBER = "#f59e0b"       # consensus parse / consensus_only
GREEN = "#16a34a"       # agreement_recovered
GRAY = "#9ca3af"        # missing_or_broken
FONT = "font-family='Helvetica,Arial,sans-serif'"

# ---- published YC10 numbers ----
ALIGN_S = 69.82
PARSE_S = 324.204
TOTAL_S = 394.024
DBGPS_S = 32.51
ALN_RSS = 5.755
DBGPS_RSS = 10.706
CLASSES = [
    ("agreement_recovered", 209072, GREEN),
    ("agreement_missing_or_broken", 556, GRAY),
    ("consensus_only", 87, AMBER),
    ("dbgps_only", 285, BLUE),
]
N = 210000


def esc(s: str) -> str:
    return html.escape(str(s))


def txt(x, y, s, size=13, fill=INK, anchor="start", weight="normal", style=""):
    return (f"<text x='{x:.1f}' y='{y:.1f}' {FONT} font-size='{size}' "
            f"fill='{fill}' text-anchor='{anchor}' font-weight='{weight}' {style}>{esc(s)}</text>")


def rect(x, y, w, h, fill, rx=2, extra=""):
    return f"<rect x='{x:.1f}' y='{y:.1f}' width='{w:.1f}' height='{h:.1f}' rx='{rx}' fill='{fill}' {extra}/>"


def line(x1, y1, x2, y2, stroke=GRID, w=1, dash=""):
    d = f"stroke-dasharray='{dash}'" if dash else ""
    return f"<line x1='{x1:.1f}' y1='{y1:.1f}' x2='{x2:.1f}' y2='{y2:.1f}' stroke='{stroke}' stroke-width='{w}' {d}/>"


def svg(vieww, viewh, body, title):
    return (f"<svg viewBox='0 0 {vieww} {viewh}' xmlns='http://www.w3.org/2000/svg' "
            f"role='img' aria-label='{esc(title)}'>"
            f"<rect x='0' y='0' width='{vieww}' height='{viewh}' fill='#ffffff'/>"
            f"{body}</svg>\n")


# ---------------------------------------------------------------- Figure 2
def figure2() -> str:
    W, H = 860, 430
    b = []
    b.append(txt(W / 2, 30, "Figure 2  ·  DBGPS Batch QC vs alignment + consensus QC (YC10, 16 threads)",
                 size=15, fill=INK, anchor="middle", weight="bold"))

    # ---- Panel A: runtime ----
    ax0, ay0, aw, ah = 70, 70, 320, 290   # plot box (left,top,width,height)
    ymax = 420.0
    b.append(txt(ax0, ay0 - 12, "A   Wall-clock runtime (s)", size=13, fill=INK, weight="bold"))
    for t in range(0, int(ymax) + 1, 100):
        yy = ay0 + ah - (t / ymax) * ah
        b.append(line(ax0, yy, ax0 + aw, yy, GRID, 1))
        b.append(txt(ax0 - 8, yy + 4, str(t), size=11, fill=MUTED, anchor="end"))
    b.append(line(ax0, ay0, ax0, ay0 + ah, MUTED, 1.5))

    bw = 90
    cx1 = ax0 + 55          # alignment+consensus bar center-left
    cx2 = ax0 + 195         # DBGPS bar
    # stacked alignment+consensus
    h_align = (ALIGN_S / ymax) * ah
    h_parse = (PARSE_S / ymax) * ah
    yb = ay0 + ah
    b.append(rect(cx1, yb - h_align, bw, h_align, SLATE))
    b.append(rect(cx1, yb - h_align - h_parse, bw, h_parse, AMBER))
    b.append(txt(cx1 + bw / 2, yb - h_align + 16, f"align {ALIGN_S:.0f}s", size=10, fill="#ffffff", anchor="middle"))
    b.append(txt(cx1 + bw / 2, yb - h_align - h_parse + 18, f"consensus parse {PARSE_S:.0f}s",
                 size=10, fill="#ffffff", anchor="middle"))
    b.append(txt(cx1 + bw / 2, yb - h_align - h_parse - 8, f"{TOTAL_S:.0f}s total",
                 size=12, fill=INK, anchor="middle", weight="bold"))
    b.append(txt(cx1 + bw / 2, yb + 18, "Alignment +", size=11, fill=INK, anchor="middle"))
    b.append(txt(cx1 + bw / 2, yb + 32, "consensus", size=11, fill=INK, anchor="middle"))
    # DBGPS
    h_db = (DBGPS_S / ymax) * ah
    b.append(rect(cx2, yb - h_db, bw, h_db, BLUE))
    b.append(txt(cx2 + bw / 2, yb - h_db - 8, f"{DBGPS_S:.1f}s", size=12, fill=INK, anchor="middle", weight="bold"))
    b.append(txt(cx2 + bw / 2, yb + 18, "DBGPS", size=11, fill=INK, anchor="middle"))
    b.append(txt(cx2 + bw / 2, yb + 32, "Batch QC", size=11, fill=INK, anchor="middle"))
    # speedup annotations
    b.append(txt(ax0 + aw - 4, ay0 + 26, "~12x vs total", size=12, fill=BLUE, anchor="end", weight="bold"))
    b.append(txt(ax0 + aw - 4, ay0 + 44, "~2x vs align step", size=11, fill=MUTED, anchor="end"))

    # ---- Panel B: peak RAM ----
    bx0, by0, bwid, bh = 540, 70, 250, 290
    rmax = 12.0
    b.append(txt(bx0, by0 - 12, "B   Peak resident memory (GB)", size=13, fill=INK, weight="bold"))
    for t in range(0, int(rmax) + 1, 3):
        yy = by0 + bh - (t / rmax) * bh
        b.append(line(bx0, yy, bx0 + bwid, yy, GRID, 1))
        b.append(txt(bx0 - 8, yy + 4, str(t), size=11, fill=MUTED, anchor="end"))
    b.append(line(bx0, by0, bx0, by0 + bh, MUTED, 1.5))
    rbw = 80
    rx1 = bx0 + 35
    rx2 = bx0 + 145
    yb2 = by0 + bh
    h_ar = (ALN_RSS / rmax) * bh
    h_dr = (DBGPS_RSS / rmax) * bh
    b.append(rect(rx1, yb2 - h_ar, rbw, h_ar, AMBER))
    b.append(txt(rx1 + rbw / 2, yb2 - h_ar - 8, f"{ALN_RSS:.2f}", size=12, fill=INK, anchor="middle", weight="bold"))
    b.append(txt(rx1 + rbw / 2, yb2 + 18, "Align +", size=11, fill=INK, anchor="middle"))
    b.append(txt(rx1 + rbw / 2, yb2 + 32, "consensus", size=11, fill=INK, anchor="middle"))
    b.append(rect(rx2, yb2 - h_dr, rbw, h_dr, BLUE))
    b.append(txt(rx2 + rbw / 2, yb2 - h_dr - 8, f"{DBGPS_RSS:.2f}", size=12, fill=INK, anchor="middle", weight="bold"))
    b.append(txt(rx2 + rbw / 2, yb2 + 18, "DBGPS", size=11, fill=INK, anchor="middle"))
    b.append(txt(rx2 + rbw / 2, yb2 + 32, "Batch QC", size=11, fill=INK, anchor="middle"))
    b.append(txt(bx0 + bwid - 4, by0 + 26, "~1.9x more RAM", size=12, fill="#b45309", anchor="end", weight="bold"))

    b.append(txt(W / 2, H - 10,
                 "Speed gain comes with higher resident memory: DBGPS holds the full k-mer coverage table in RAM.",
                 size=11, fill=MUTED, anchor="middle", style="font-style='italic'"))
    return svg(W, H, "".join(b), "Runtime and memory comparison")


# ---------------------------------------------------------------- Figure 3
def figure3() -> str:
    W, H = 760, 430
    b = []
    b.append(txt(W / 2, 30, "Figure 3  ·  Strand-level agreement, DBGPS vs alignment-consensus (n = 210,000)",
                 size=15, fill=INK, anchor="middle", weight="bold"))
    ax0, ay0, aw, ah = 230, 70, 430, 300
    # log scale 1 .. 1e6
    lo, hi = 1, 1_000_000
    def yx(v):  # value -> y
        v = max(v, 1)
        f = (math.log10(v) - math.log10(lo)) / (math.log10(hi) - math.log10(lo))
        return ay0 + ah - f * ah
    for p in range(0, 7):
        v = 10 ** p
        yy = yx(v)
        b.append(line(ax0, yy, ax0 + aw, yy, GRID, 1))
        b.append(txt(ax0 - 8, yy + 4, f"{v:,}", size=10, fill=MUTED, anchor="end"))
    b.append(line(ax0, ay0, ax0, ay0 + ah, MUTED, 1.5))
    b.append(txt(ax0 - 8, ay0 - 12, "strands (log scale)", size=10, fill=MUTED, anchor="end"))

    n = len(CLASSES)
    slot = aw / n
    bw = slot * 0.5
    pct = lambda c: f"{100*c/N:.4f}%"
    for i, (name, count, color) in enumerate(CLASSES):
        cx = ax0 + slot * i + (slot - bw) / 2
        yy = yx(count)
        b.append(rect(cx, yy, bw, (ay0 + ah) - yy, color))
        b.append(txt(cx + bw / 2, yy - 18, f"{count:,}", size=12, fill=INK, anchor="middle", weight="bold"))
        b.append(txt(cx + bw / 2, yy - 5, pct(count), size=10, fill=MUTED, anchor="middle"))
        # wrapped label
        label = name.replace("agreement_", "agree:\n").replace("_", " ")
        lines = label.split("\n")
        for j, lt in enumerate(lines):
            b.append(txt(cx + bw / 2, ay0 + ah + 18 + j * 13, lt, size=10, fill=INK, anchor="middle"))

    # callout
    b.append(txt(ax0 + aw, ay0 + 10, "99.56% concordant", size=12, fill=GREEN, anchor="end", weight="bold"))
    b.append(txt(W / 2, H - 12,
                 "Both agreement classes total 209,628 (99.82%); the 372-strand disagreement tail (0.17%) is dissected in Fig. 4.",
                 size=11, fill=MUTED, anchor="middle", style="font-style='italic'"))
    return svg(W, H, "".join(b), "Agreement classes")


# ---------------------------------------------------------------- Figure 1
def figure1() -> str:
    W, H = 820, 470
    b = []
    b.append(txt(W / 2, 30, "Figure 1  ·  DBGPS-analyzer architecture", size=15, fill=INK, anchor="middle", weight="bold"))

    def layer(y, h, fill, label):
        b.append(rect(40, y, W - 80, h, fill, rx=8, extra="stroke='#cbd5e1' stroke-width='1'"))
        b.append(txt(54, y + 20, label, size=12, fill=MUTED, weight="bold"))

    def box(x, y, w, h, fill, title, sub=""):
        b.append(rect(x, y, w, h, fill, rx=6, extra="stroke='#cbd5e1' stroke-width='1'"))
        b.append(txt(x + w / 2, y + (h / 2 if not sub else h / 2 - 5), title, size=12, fill=INK, anchor="middle", weight="bold"))
        if sub:
            b.append(txt(x + w / 2, y + h / 2 + 12, sub, size=10, fill=MUTED, anchor="middle"))

    # GUI layer
    layer(55, 120, "#eff6ff", "Electron renderer (GUI views)")
    views = ["Interactive", "Batch QC", "Cross-links", "Seq-Filter", "Report", "Settings"]
    vx, vw, gap = 60, 116, 8
    for i, v in enumerate(views):
        box(vx + i * (vw + gap), 90, vw, 70, "#dbeafe", v)

    # bridge layer
    layer(205, 110, "#f1f5f9", "Electron main process (bridge)")
    box(70, 235, 200, 60, "#e2e8f0", "JSON-Lines kernel", "single resident table")
    box(290, 235, 210, 60, "#e2e8f0", "tab-delimited -> FASTA", "transparent temp bridge")
    box(520, 235, 230, 60, "#e2e8f0", "Keychain key store", "safeStorage, 0o600")

    # C backend layer
    layer(345, 110, "#f0fdf4", "C backend (shared dbgps_core.h)")
    box(70, 375, 200, 60, "#dcfce7", "DBGPS-analyzer", "Sm/Kd/Kn + kernel (MT)")
    box(290, 375, 210, 60, "#dcfce7", "DBGPS-links", "cross-links (1 thread)")
    box(520, 375, 230, 60, "#dcfce7", "DBGPS-seq-filter", "entanglement filter (1 thread)")

    # arrows between layers
    for x in (170, 410, 635):
        b.append(line(x, 160, x, 235, MUTED, 1.4, dash="4 3"))
        b.append(line(x, 295, x, 375, MUTED, 1.4, dash="4 3"))
    return svg(W, H, "".join(b), "Architecture")


# ---------------------------------------------------------------- Figure 4
def figure4(joined: Path) -> str | None:
    pts = []  # (read_count, observed, cls)
    with joined.open() as fh:
        r = csv.DictReader(fh)
        for row in r:
            cls = row.get("classification", "")
            if cls not in ("consensus_only", "dbgps_only"):
                continue
            try:
                rc = int(float(row["consensus_read_count"]))
                obs = int(float(row["dbgps_observed"]))
            except (ValueError, KeyError):
                continue
            pts.append((rc, obs, cls))
    if not pts:
        return None
    W, H = 760, 460
    b = []
    b.append(txt(W / 2, 28, "Figure 4  ·  Anatomy of the 372 disagreeing strands",
                 size=15, fill=INK, anchor="middle", weight="bold"))
    ax0, ay0, aw, ah = 80, 60, 600, 320
    # x: log read count 1..1000 ; y: observed kmers 100..134
    xmin, xmax = 1, 1000
    ymin, ymax = 100, 135
    def X(v):
        v = min(max(v, xmin), xmax)
        f = (math.log10(v) - math.log10(xmin)) / (math.log10(xmax) - math.log10(xmin))
        return ax0 + f * aw
    def Y(v):
        v = min(max(v, ymin), ymax)
        return ay0 + ah - (v - ymin) / (ymax - ymin) * ah
    # grid
    for p in range(0, 4):
        xv = 10 ** p
        xx = X(xv)
        b.append(line(xx, ay0, xx, ay0 + ah, GRID, 1))
        b.append(txt(xx, ay0 + ah + 16, f"{xv:,}", size=10, fill=MUTED, anchor="middle"))
    for yv in range(100, 136, 5):
        yy = Y(yv)
        b.append(line(ax0, yy, ax0 + aw, yy, GRID, 1))
        b.append(txt(ax0 - 8, yy + 4, str(yv), size=10, fill=MUTED, anchor="end"))
    b.append(line(ax0, ay0, ax0, ay0 + ah, MUTED, 1.5))
    b.append(line(ax0, ay0 + ah, ax0 + aw, ay0 + ah, MUTED, 1.5))
    b.append(txt(ax0 + aw / 2, ay0 + ah + 38, "consensus read count (log scale)", size=12, fill=INK, anchor="middle"))
    b.append(f"<text x='28' y='{ay0 + ah/2:.1f}' {FONT} font-size='12' fill='{INK}' text-anchor='middle' transform='rotate(-90 28 {ay0 + ah/2:.1f})'>DBGPS observed k-mers (of 134)</text>")
    # complete line at 134
    yc = Y(134)
    b.append(line(ax0, yc, ax0 + aw, yc, BLUE, 1, dash="5 4"))
    b.append(txt(ax0 + aw - 4, yc - 6, "path-complete (134/134)", size=10, fill=BLUE, anchor="end"))
    # jitter helper (deterministic, index-based) so overlapping points are visible
    n_co = n_db = 0
    for i, (rc, obs, cls) in enumerate(pts):
        color = AMBER if cls == "consensus_only" else BLUE
        jy = ((i * 7) % 5 - 2) * 0.6 if obs == 134 else 0
        jx = ((i * 13) % 5 - 2) * 0.8
        b.append(f"<circle cx='{X(rc)+jx:.1f}' cy='{Y(obs)+jy:.1f}' r='2.4' fill='{color}' fill-opacity='0.55'/>")
        if cls == "consensus_only":
            n_co += 1
        else:
            n_db += 1
    # legend (white backing so it stays readable over points)
    b.append(rect(ax0 + 6, ay0 + 6, 446, 42, "#ffffff", rx=4,
                  extra="fill-opacity='0.85' stroke='#e2e8f0' stroke-width='1'"))
    b.append(rect(ax0 + 12, ay0 + 10, 12, 12, AMBER, rx=2))
    b.append(txt(ax0 + 30, ay0 + 20, f"consensus_only  (n={n_co})  exact base consensus, broken k-mer path", size=11, fill=INK))
    b.append(rect(ax0 + 12, ay0 + 30, 12, 12, BLUE, rx=2))
    b.append(txt(ax0 + 30, ay0 + 40, f"dbgps_only  (n={n_db})  complete path, low-frequency consensus variant", size=11, fill=INK))
    b.append(txt(W / 2, H - 12,
                 "consensus_only strands sit at low depth with observed < 134; dbgps_only strands lie on the complete line across all depths.",
                 size=11, fill=MUTED, anchor="middle", style="font-style='italic'"))
    return svg(W, H, "".join(b), "Disagreement scatter")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", type=Path, required=True)
    ap.add_argument("--joined", type=Path, default=None, help="full joined_comparison CSV for Figure 4")
    args = ap.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)
    (args.outdir / "figure1_architecture.svg").write_text(figure1())
    (args.outdir / "figure2_runtime_memory.svg").write_text(figure2())
    (args.outdir / "figure3_agreement_classes.svg").write_text(figure3())
    made = ["figure1_architecture.svg", "figure2_runtime_memory.svg", "figure3_agreement_classes.svg"]
    if args.joined and args.joined.exists():
        f4 = figure4(args.joined)
        if f4:
            (args.outdir / "figure4_disagreement_scatter.svg").write_text(f4)
            made.append("figure4_disagreement_scatter.svg")
    print("wrote:", ", ".join(made))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
