/** The values a run is configured with; see `dacapo.conf` at the plugin's root for what each means. */
export type Conf = {
  /** The loop a run walks when neither its prompt nor `start` names one. */
  loop: string
  /** Models a worker node may list, strongest first; with `qa` and `review`, the models any node of a loop may name. */
  workers: string[]
  /** Models a QA node may list, strongest first. */
  qa: string[]
  /** Models a reviewer node may list, strongest first. */
  review: string[]
  /** The skill workers load for how to commit: titles, staging, what never to run. */
  'commits-skill': string
  /** The skill workers and the final pull request follow for the title and body. */
  'prs-skill': string
  /** The branch a run is cut from and merged into when `start` names none. */
  'base-branch': string
  /** How many evidence collectors a judge may run at once when its node sets no `collectors`; 0 means it collects every piece of evidence itself. */
  'qa-collectors': number
}

export type ConfKey = keyof Conf
export const CONF_KEYS: readonly ConfKey[] = ['loop', 'workers', 'qa', 'review', 'commits-skill', 'prs-skill', 'base-branch', 'qa-collectors']
/** Keys a conf file may still carry from before loops; each is named as removed, never applied. */
const REMOVED_KEYS = ['level', 'judges']
/** The loops the plugin ships, shallowest first: what a removed key is told to choose from when no loops are known. */
export const SHIPPED_LOOPS: readonly string[] = ['core-fast', 'core', 'core-deep']
/** The words that name the loops to choose from, in a removed key's problem. */
const loopChoice = (names: readonly string[]) => `(loop = ${names.join(' | ')})`

/** The skills the plugin ships; while one is the configured skill, the mod checks the rules it states (commit titles, attribution lines) itself. */
export const SHIPPED_COMMITS = 'dacapo:rules-commits'
export const SHIPPED_PRS = 'dacapo:rules-prs'

/** What the plugin runs with when no file says otherwise: the same values `dacapo.conf` ships with. */
export const DEFAULT_CONF: Conf = {
  loop: 'core',
  workers: ['opus', 'sonnet'],
  qa: ['opus', 'sonnet'],
  review: ['opus', 'sonnet'],
  'commits-skill': SHIPPED_COMMITS,
  'prs-skill': SHIPPED_PRS,
  'base-branch': 'main',
  'qa-collectors': 3,
}

/** A loop name, as hooks/loops.ts takes an id. */
const LOOP_NAME = /^[a-z0-9][a-z0-9-]*$/
const MODEL = /^[a-z][a-z0-9.-]*$/
/** A git branch name as dacapo accepts it, for the base branch and the run branch alike. */
export const BRANCH_NAME = /^[a-z0-9][a-z0-9._/-]*$/
/** A skill name as the Skill tool takes it, `name` or `plugin:name`, with or without the leading slash a person types. */
const SKILL = /^\/?([a-z0-9][a-z0-9_-]*:)?[a-z0-9][a-z0-9_-]*$/
const SKILL_KEYS: readonly ConfKey[] = ['commits-skill', 'prs-skill']
/** The most collectors a conf may allow QA at once: enough to split a rubric, few enough for one machine's product. */
export const MAX_COLLECTORS = 8
const COUNT = /^[0-9]+$/

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
    if (REMOVED_KEYS.includes(key)) {
      problems.push(`line ${i + 1}: "${key}" was removed in 0.22; depth is a loop now ${loopChoice(SHIPPED_LOOPS)}`)
      return
    }
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
  if (key === 'loop') return list.length === 1 && LOOP_NAME.test(list[0]!) ? null : '"loop" must be one loop name, like core or core-deep'
  if (SKILL_KEYS.includes(key)) return list.length === 1 && SKILL.test(list[0]!) ? null : `"${key}" must be one skill name, like ${DEFAULT_CONF[key]} or my-rules`
  if (key === 'base-branch') return list.length === 1 && BRANCH_NAME.test(list[0]!) ? null : `"base-branch" must be one git branch name, like main or develop`
  if (key === 'qa-collectors') return list.length === 1 && COUNT.test(list[0]!) && Number(list[0]) <= MAX_COLLECTORS ? null : `"qa-collectors" must be a whole number from 0 to ${MAX_COLLECTORS}`
  const bad = list.find(v => !MODEL.test(v))
  return bad ? `"${key}" has a model name that is not one (${bad})` : null
}

/** Which layer a conf file is: the plugin's shipped defaults, the user's file for every repository, or one repository's. */
export type ConfRole = 'plugin' | 'user' | 'project'

/** A file in the order it is applied, with its text and its layer; a file that does not exist is passed with `text: null`. */
export type Layer = { path: string; text: string | null; role?: ConfRole }

/** The user's conf file, for every repository: `$DACAPO_HOME/dacapo.conf` when DACAPO_HOME is set, else `~/.claude/dacapo.conf`. */
export function userConfPath(env: { home: string; dacapoHome: string | null }): string {
  return env.dacapoHome ? `${env.dacapoHome.replace(/\/+$/, '')}/dacapo.conf` : `${env.home.replace(/\/+$/, '')}/.claude/dacapo.conf`
}

export type Loaded = {
  conf: Conf
  /** The file each key came from, or "default". */
  origin: Record<ConfKey, string>
  /** The problems found in every file, each prefixed with its path. */
  problems: string[]
  /** The files that were read. */
  read: string[]
  /** The file of each layer the loader was given, read or not: where a value is changed. */
  paths: Partial<Record<ConfRole, string>>
}

/** Applies the files in order over the defaults, key by key; a value a file gets wrong keeps the earlier one. */
export function loadConf(layers: readonly Layer[]): Loaded {
  const conf: Conf = { ...DEFAULT_CONF, workers: [...DEFAULT_CONF.workers], qa: [...DEFAULT_CONF.qa], review: [...DEFAULT_CONF.review] }
  const origin = Object.fromEntries(CONF_KEYS.map(k => [k, 'default'])) as Record<ConfKey, string>
  const problems: string[] = []
  const read: string[] = []
  const paths: Partial<Record<ConfRole, string>> = {}
  for (const layer of layers) {
    if (layer.role) paths[layer.role] = layer.path
    if (layer.text === null) continue
    read.push(layer.path)
    const parsed = parseConf(layer.text)
    problems.push(...parsed.problems.map(p => `${layer.path}: ${p}`))
    for (const key of CONF_KEYS) {
      const v = parsed.values[key]
      if (!v) continue
      if (key === 'loop' || key === 'commits-skill' || key === 'prs-skill' || key === 'base-branch') conf[key] = v[0]!
      else if (key === 'qa-collectors') conf[key] = Number(v[0])
      else conf[key] = v
      origin[key] = layer.path
    }
  }
  return { conf, origin, problems, read, paths }
}

/**
 * The values in force as text, one key per line with where it came from; for the config tool and the command. With
 * `loops` (the loops the session found), a removed key names those to choose from, else the shipped ones. With
 * `runLoop`, the loop a live run walks: when it is not the configured one, the loop line says so.
 */
export function describeConf(loaded: Loaded, o: { loops?: readonly string[]; runLoop?: string } = {}): string {
  const { conf, origin } = loaded
  const value = (k: ConfKey) => (Array.isArray(conf[k]) ? (conf[k] as string[]).join(', ') : String(conf[k]))
  const line = (k: ConfKey) =>
    k === 'loop' && o.runLoop && o.runLoop !== conf.loop ? `loop = ${conf.loop} (conf: ${origin.loop}); this run walks ${o.runLoop} (--loop)` : `${k} = ${value(k)}  (${origin[k]})`
  const shipped = loopChoice(SHIPPED_LOOPS)
  const problems = o.loops && o.loops.length > 0 ? loaded.problems.map(p => p.replace(shipped, loopChoice(o.loops!))) : loaded.problems
  return [
    ...CONF_KEYS.map(line),
    `Files read: ${loaded.read.length > 0 ? loaded.read.join(', ') : 'none; defaults'}.`,
    ...(loaded.paths.user || loaded.paths.project ? [`To change a value, edit ${[loaded.paths.user ? `${loaded.paths.user} for every repository` : '', loaded.paths.project ? `${loaded.paths.project} for this one` : ''].filter(Boolean).join(', or ')}; a later file wins key by key.`] : []),
    ...(problems.length > 0 ? ['Ignored:', ...problems.map(p => `- ${p}`)] : []),
  ].join('\n')
}
