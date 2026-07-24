// Fractional ranking: base-36 strings ordered lexicographically. Inserting
// between two ranks never renumbers neighbors. "" means unbounded on that
// side, so rankBetween("", "") seeds the first rank.

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

export function rankBetween(a: string, b: string): string {
  let result = "";
  let low = a;
  let high = b;
  let i = 0;
  for (;;) {
    const da = i < low.length ? DIGITS.indexOf(low[i]) : 0;
    const db = i < high.length ? DIGITS.indexOf(high[i]) : DIGITS.length;
    if (da === db) {
      result += DIGITS[da];
      i++;
      continue;
    }
    const mid = Math.floor((da + db) / 2);
    if (mid > da) {
      return result + DIGITS[mid];
    }
    // adjacent digits: take the low digit; from here only the low tail
    // constrains us (prefix is already strictly below the high bound)
    result += DIGITS[da];
    high = "";
    i++;
  }
}
