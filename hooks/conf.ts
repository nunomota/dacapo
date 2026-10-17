import type { Level } from '../types'

/** The values a run is configured with; see `dacapo.conf` at the plugin's root for what each means. */
export type Conf = {
  /** The level of a run whose prompt carries no level flag. */
  level: Level
  /** Whether QA and the engineering review run one after the other or side by side at level deep. */
  judges: 'sequential' | 'parallel'
  /** The models a worker may be given, strongest first; the first is the default. */
  workers: string[]
  /** The models QA may be given, strongest first; the first is the default. */
  qa: string[]
  /** The models the reviewer may be given, strongest first; the first is the default. */
  review: string[]
  /** The skill workers load for how to commit: titles, staging, what never to run. */
  'commits-skill': string
  /** The skill workers and the final pull request follow for the title and body. */
  'prs-skill': string
}

export type ConfKey = keyof Conf
export const CONF_KEYS: readonly ConfKey[] = ['level', 'judges', 'workers', 'qa', 'review', 'commits-skill', 'prs-skill']

/** The skills the plugin ships; while one is the configured skill, the mod checks the rules it states (commit titles, attribution lines) itself. */
export const SHIPPED_COMMITS = 'dacapo:rules-commits'
export const SHIPPED_PRS = 'dacapo:rules-prs'

/** What the plugin runs with when no file says otherwise: the same values `dacapo.conf` ships with. */
export const DEFAULT_CONF: Conf = {
  level: 'balanced',
  judges: 'sequential',
  workers: ['opus', 'sonnet'],
  qa: ['opus', 'sonnet'],
  review: ['opus', 'sonnet'],
  'commits-skill': SHIPPED_COMMITS,
  'prs-skill': SHIPPED_PRS,
}

const LEVELS = ['fast', 'balanced', 'deep']
const JUDGES = ['sequential', 'parallel']
const MODEL = /^[a-z][a-z0-9.-]*$/
/** A skill name as the Skill tool takes it, `name` or `plugin:name`, with or without the leading slash a person types. */
const SKILL = /^\/?([a-z0-9][a-z0-9_-]*:)?[a-z0-9][a-z0-9_-]*$/
const SKILL_KEYS: readonly ConfKey[] = ['commits-skill', 'prs-skill']

/** One `key = value` file, as read: the keys it set and what was wrong with the rest. */
export type Parsed = { values: Partial<Record<ConfKey, string[]>>; problems: string[] }

/** Reads a conf file: `key = value` lines, `#` comments, comma-separated lists; a later line for the same key wins. */
export function parseConf(text: string): Parsed {
  const values: Partial<Record<ConfKey, string[]>> = {}
  const problems: string[] = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) return
    const m = /^([a-z][a-z-]*)\s*=\s*(.*)$/.exec(line)
    if (!m) {
      problems.push(`line ${i + 1}: not "key = value": ${raw.trim()}`)
      return
    }
    const key = m[1] as ConfKey
    if (!CONF_KEYS.includes(key)) {
      problems.push(`line ${i + 1}: unknown key "${key}" (one of ${CONF_KEYS.join(', ')})`)
      return
    }
    const list = m[2]!
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
    const problem = check(key, list)
    if (problem) problems.push(`line ${i + 1}: ${problem}`)
    else values[key] = SKILL_KEYS.includes(key) ? [list[0]!.replace(/^\//, '')] : list
  })
  return { values, problems }
}

function check(key: ConfKey, list: string[]): string | null {
  if (list.length === 0) return `"${key}" has no value`
  if (key === 'level') return list.length === 1 && LEVELS.includes(list[0]!) ? null : `"level" must be one of ${LEVELS.join(', ')}`
  if (key === 'judges') return list.length === 1 && JUDGES.includes(list[0]!) ? null : `"judges" must be one of ${JUDGES.join(', ')}`
  if (SKILL_KEYS.includes(key)) return list.length === 1 && SKILL.test(list[0]!) ? null : `"${key}" must be one skill name, like ${DEFAULT_CONF[key]} or my-rules`
  const bad = list.find(v => !MODEL.test(v))
  return bad ? `"${key}" has a model name that is not one (${bad})` : null
}

/** A file in the order it is applied, with its text; a file that does not exist is passed with `text: null`. */
export type Layer = { path: string; text: string | null }

export type Loaded = {
  conf: Conf
  /** The file each key came from, or "default". */
  origin: Record<ConfKey, string>
  /** The problems found in every file, each prefixed with its path. */
  problems: string[]
  /** The files that were read. */
  read: string[]
}

/** Applies the files in order over the defaults, key by key; a value a file gets wrong keeps the earlier one. */
export function loadConf(layers: readonly Layer[]): Loaded {
  const conf: Conf = { ...DEFAULT_CONF, workers: [...DEFAULT_CONF.workers], qa: [...DEFAULT_CONF.qa], review: [...DEFAULT_CONF.review] }
  const origin = Object.fromEntries(CONF_KEYS.map(k => [k, 'default'])) as Record<ConfKey, string>
  const problems: string[] = []
  const read: string[] = []
  for (const layer of layers) {
    if (layer.text === null) continue
    read.push(layer.path)
    const parsed = parseConf(layer.text)
    problems.push(...parsed.problems.map(p => `${layer.path}: ${p}`))
    for (const key of CONF_KEYS) {
      const v = parsed.values[key]
      if (!v) continue
      if (key === 'level') conf.level = v[0] as Level
      else if (key === 'judges') conf.judges = v[0] as Conf['judges']
      else if (key === 'commits-skill' || key === 'prs-skill') conf[key] = v[0]!
      else conf[key] = v
      origin[key] = layer.path
    }
  }
  return { conf, origin, problems, read }
}

/** The values in force as text, one key per line with where it came from; for the config tool and the command. */
export function describeConf(loaded: Loaded): string {
  const { conf, origin } = loaded
  const value = (k: ConfKey) => (Array.isArray(conf[k]) ? (conf[k] as string[]).join(', ') : String(conf[k]))
  return [
    ...CONF_KEYS.map(k => `${k} = ${value(k)}  (${origin[k]})`),
    `Files read: ${loaded.read.length > 0 ? loaded.read.join(', ') : 'none; defaults'}.`,
    ...(loaded.problems.length > 0 ? ['Ignored:', ...loaded.problems.map(p => `- ${p}`)] : []),
  ].join('\n')
}
