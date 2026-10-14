import type { Usage } from '../types'

/** Dollars per million tokens: input, output, cache read, cache write; matched by the longest model-id prefix. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Anthropic API list prices as of 2026-10; cache writes at 1.25x input where not published. Overridable from the plugin's `prices` option. */
export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

export const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const addUsage = (a: Usage, b: Partial<Usage>): Usage => ({
  input: a.input + (b.input ?? 0),
  output: a.output + (b.output ?? 0),
  cacheRead: a.cacheRead + (b.cacheRead ?? 0),
  cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
})

export const totalTokens = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite

/** The price for a model id or alias: the longest key the id starts with or contains. */
export function priceFor(modelId: string | undefined, table: Record<string, Price> = PRICES): Price | undefined {
  if (!modelId) return undefined
  const id = modelId.toLowerCase()
  let best: { key: string; price: Price } | undefined
  for (const [key, price] of Object.entries(table)) {
    if ((id.startsWith(key) || id.includes(key)) && (!best || key.length > best.key.length)) best = { key, price }
  }
  return best?.price
}

export function costOf(modelId: string | undefined, u: Usage, table?: Record<string, Price>): number | undefined {
  const p = priceFor(modelId, table)
  if (!p) return undefined
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000
}

export function fmtTokens(n: number): string {
  if (n < 1_000) return `${n}`
  if (n < 100_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`
  return `${(n / 1_000_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`
}

export function fmtCost(d: number | undefined): string {
  if (d === undefined) return ''
  if (d < 0.01) return d === 0 ? '$0' : '<$0.01'
  return `$${d.toFixed(2)}`
}

/** Parses the `prices` option: JSON `{ "<model prefix>": [input, output, cacheRead, cacheWrite] }` per million tokens; bad input is ignored. */
export function parsePrices(text: unknown): Record<string, Price> {
  if (typeof text !== 'string' || !text.trim()) return PRICES
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    const out: Record<string, Price> = { ...PRICES }
    for (const [key, v] of Object.entries(raw)) {
      if (Array.isArray(v) && v.length === 4 && v.every(x => typeof x === 'number')) {
        const [input, output, cacheRead, cacheWrite] = v as [number, number, number, number]
        out[key.toLowerCase()] = { input, output, cacheRead, cacheWrite }
      }
    }
    return out
  } catch {
    return PRICES
  }
}
