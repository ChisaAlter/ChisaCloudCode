/** Token counts for one or more messages. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

/** $ per million tokens: [input, output, cacheWrite, cacheRead]. */
type Price = [number, number, number, number];

// Order matters: first match wins. Cache write = 1.25x input (5m TTL),
// cache read = 0.1x input, per Anthropic pricing.
const PRICES: [RegExp, Price][] = [
  [/fable|mythos/, [10, 50, 12.5, 1]],
  [/opus-4-[01]\b|3-opus/, [15, 75, 18.75, 1.5]],
  [/opus/, [5, 25, 6.25, 0.5]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku-4/, [1, 5, 1.25, 0.1]],
  [/haiku-3-5|3-5-haiku/, [0.8, 4, 1, 0.08]],
  [/haiku/, [0.25, 1.25, 0.3, 0.03]],
];

const M = 1_000_000;

/** Estimated cost in dollars, or null when the model is not in the price table. */
export function estimateCost(model: string, t: TokenCounts): number | null {
  const price = PRICES.find(([re]) => re.test(model))?.[1];
  if (!price) return null;
  const [inp, out, cw, cr] = price;
  return (t.input * inp + t.output * out + t.cacheCreate * cw + t.cacheRead * cr) / M;
}
