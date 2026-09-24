/** Terminal formatting. ANSI codes directly: no dependency, and it is 20 lines. */

const ESC = '\u001b[';

const enabled = (): boolean =>
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== '0' &&
  process.stdout.isTTY === true;

const wrap =
  (code: string) =>
  (text: string): string =>
    enabled() ? `${ESC}${code}m${text}${ESC}0m` : text;

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');

export const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Colour a confidence by how much weight it can bear. */
export function confidenceColor(value: number, threshold: number): string {
  const text = percent(value);
  if (value >= threshold) return green(text);
  if (value >= threshold * 0.75) return yellow(text);
  return red(text);
}

/** A small horizontal bar, for probability distributions. */
export function bar(value: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(value * width)));
  return dim('#'.repeat(filled) + '.'.repeat(width - filled));
}

/** Render a left-aligned table with a header row. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => (cell ?? '').padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    bold(line(headers)),
    dim(widths.map((w) => '-'.repeat(w)).join('  ')),
    ...rows.map(line),
  ].join('\n');
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
