export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

/** from から to へ、1回で maxStep までしか動かさず、lo〜hi に収める */
export const step = (from: number, to: number, maxStep: number, lo: number, hi: number) =>
  Math.round(clamp(clamp(to, from - maxStep, from + maxStep), lo, hi) * 1000) / 1000;

/** 文字列リストを、件数と1件の長さで制限する */
export const limitList = (xs: string[], max: number, maxLen = 120) =>
  xs
    .map((s) => s.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, max);
