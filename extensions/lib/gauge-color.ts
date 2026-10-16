/**
 * ANSI truecolor palette for the usage-style gauge thresholds, shared by the
 * /usage-subs table, the /status Budget line, and the budget footer widget.
 * Sent only when the caller opts in ({color: true}): the chat notify path
 * renders embedded SGR runs over a dim wrapper and pi-tui measures width
 * stripping ANSI (footer statuses are ANSI-aware truncation too). Plain
 * output stays byte-identical when the option is omitted (test fixtures,
 * tool surfaces without ANSI guarantees).
 */
export const GAUGE_COLORS = {
  green: "38;2;34;197;94",
  yellow: "38;2;234;179;8",
  orange: "38;2;249;115;22",
  red: "38;2;239;68;68",
} as const;

/** Thresholds over used%: <=50 green, 51-75 yellow, 76-90 orange, >90 red. */
export function gaugeColorAnsi(usedPercent: number): string {
  const color = usedPercent <= 50 ? GAUGE_COLORS.green
    : usedPercent <= 75 ? GAUGE_COLORS.yellow
    : usedPercent <= 90 ? GAUGE_COLORS.orange
    : GAUGE_COLORS.red;
  return `\x1b[${color}m`;
}

/**
 * End-of-run reset restoring dim + default fg: the notify path wraps messages
 * in a dim run, so colored runs must not end with a bare reset that would
 * clear that wrapper.
 */
export const GAUGE_ANSI_RESET_DIM = "\x1b[2;39m";

/** End-of-run reset for surfaces without a dim wrapper (footer status line). */
export const GAUGE_ANSI_RESET_FG = "\x1b[39m";