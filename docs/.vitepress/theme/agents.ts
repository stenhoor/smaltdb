// Docs for agents (BRAND.md, Documentation, rule 9): Markdown for the AI agents that use the products, generated from
// the same sources as the pages people read, when VitePress finishes a build:
//
// - a Markdown twin of every page (`guide/queries.md` beside `guide/queries.html`): the page's source, with what only
//   a browser shows (Vue components, playground and diagram markers, VitePress containers) turned into plain Markdown,
//   and links to other pages pointing at their twins (headings keep their {#id}, so a link's #id can be found);
// - `/llms.txt`, an index of the twins in the llms.txt format (https://llmstxt.org/), grouped as the sidebar is;
// - `/agents.md`, the agent guide: complete rather than friendly. The site's own introduction (how to use the product,
//   its rules), then its grammar as EBNF, then every page it names, in order.
//
// Every file names the package's version. Node only: used from .vitepress/config.ts.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

export interface AgentDocsOptions {
  /** The product's name, as in "smaltql". */
  product: string
  /** The package's version, such as the "version" of its package.json. */
  version: string
  /** Further versions to name, such as `{ 'plan format': '1' }`. */
  versions?: Record<string, string>
  /** The site's address, with its base: 'https://stenhoor.github.io/smaltql/'. Links in the files are absolute. */
  url: string
  /** One line for llms.txt's summary (default: the site's description). */
  summary?: string
  /** The agent guide's introduction, a Markdown file in the source directory, written for agents. */
  intro?: string
  /** The grammar in EBNF (the text railroad.ts draws from), for the guide and for ```railroad fences in twins. */
  grammar?: string
  /** Pages for the guide after the introduction, in order: source paths or prefixes ('reference/sql/'). */
  guide?: string[]
}

interface SiteConfig {
  srcDir: string
  outDir: string
  pages: string[]
  cleanUrls?: boolean
  site: { title: string; description: string; themeConfig: { sidebar?: unknown } }
}

const MARKER = /^<!--\s*docs:(\S+)\s*([\s\S]*?)\s*-->\s*$/

/** Rules of an EBNF grammar by name, with their text (as railroad.ts reads them). */
export function grammarRules(grammar: string): Map<string, string> {
  const rules = new Map<string, string>()
  const src = grammar.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const starts = [...src.matchAll(/^[ \t]*([A-Za-z][\w-]*)\s*::=/gm)]
  starts.forEach((m, i) => rules.set(m[1], grammar.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : grammar.length).trim()))
  return rules
}

/** A page's address in the twin set: `reference/sql/index.md` for `reference/sql/`, `guide/x.md` for `guide/x`. */
function twinOf(target: string): string {
  const [p, hash = ''] = target.split('#')
  let out = p
  if (out === '' || out.endsWith('/')) out += 'index'
  out = out.replace(/\.(html|md)$/, '')
  return `${out}.md${hash ? `#${hash}` : ''}`
}

/**
 * A page's Markdown, made for agents. `page` is its source path ('guide/queries.md'); links to other pages become links
 * to their twins, absolute under `url`.
 */
export function toTwin(source: string, page: string, options: Pick<AgentDocsOptions, 'product' | 'version' | 'versions' | 'url' | 'grammar'>): string {
  const rules = options.grammar ? grammarRules(options.grammar) : new Map<string, string>()
  const base = options.url.endsWith('/') ? options.url : `${options.url}/`
  let text = source.replace(/\r\n/g, '\n')
  // Front matter: kept only for its title.
  let title = ''
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (fm) {
    title = /^title:\s*['"]?(.*?)['"]?\s*$/m.exec(fm[1])?.[1] ?? ''
    text = text.slice(fm[0].length)
  }
  const out: string[] = []
  const lines = text.split('\n')
  let fence: string | null = null
  let container = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fence !== null) {
      out.push(line)
      if (line.trim() === fence) fence = null
      continue
    }
    const open = /^(\s*)(`{3,}|~{3,})\s*(\S*)(.*)$/.exec(line)
    if (open) {
      const [, indent, ticks, lang, rest] = open
      if (lang === 'railroad') {
        // The rules a diagram draws, as their EBNF.
        const names: string[] = []
        for (i++; i < lines.length && lines[i].trim() !== ticks; i++) if (lines[i].trim()) names.push(lines[i].trim())
        out.push(`${indent}${ticks}ebnf`, ...names.map((n) => rules.get(n) ?? `${n} ::= /* in the grammar */`), `${indent}${ticks}`)
        continue
      }
      const flags = rest.trim().split(/\s+/).filter((f) => f && f !== 'play' && f !== 'noplay')
      out.push(`${indent}${ticks}${lang}${flags.length ? ' ' + flags.join(' ') : ''}`)
      fence = ticks
      continue
    }
    // The examples test's markers say what an agent needs to know about the next example.
    const marker = MARKER.exec(line.trim())
    if (marker) {
      const [, kind, arg] = marker
      if (kind === 'error') out.push(`This example fails${arg ? ` with \`${arg.split(/\s+/)[0]}\`` : ''}:`, '')
      else if (kind === 'setup') out.push('Run first:', '', '```sql', arg.trim(), '```', '')
      else if (kind === 'plugin') out.push(`This example needs the \`${arg.trim()}\` plugin:`, '')
      else if (kind === 'unordered') out.push('The rows of this result can come in any order:', '')
      continue
    }
    // Other comments, scripts and styles are for the page.
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i++
      continue
    }
    if (/^\s*<(script|style)\b/.test(line)) {
      const tag = /^\s*<(script|style)\b/.exec(line)![1]
      while (i < lines.length && !lines[i].includes(`</${tag}>`)) i++
      continue
    }
    // A line that is only a component (<ProductCard … />, <Badge>…</Badge>) or a bare HTML block tag.
    if (/^\s*<([A-Z][\w-]*|\/?(div|span|p|img|br|figure|section)\b)[^>]*>(.*<\/[\w-]+>)?\s*$/.test(line)) continue
    // VitePress containers become quotes.
    const c = /^:::\s*(\w+)\s*(.*)$/.exec(line)
    if (c && !container) {
      const label = c[2] || c[1][0].toUpperCase() + c[1].slice(1)
      out.push(`> **${label}:**`)
      container = true
      continue
    }
    if (container && /^:::\s*$/.test(line)) {
      container = false
      continue
    }
    // Headings keep their {#id}: the anchor a link's #id names, which an agent can search for.
    let l = line
    if (container) l = l ? `> ${l}` : '>'
    out.push(l)
  }
  // Links to other pages point at their twins, absolute; text between fences is read whole, so a link may wrap.
  const href = (target: string): string | undefined => {
    if (/^[a-z]+:|^#/i.test(target)) return undefined
    const [p, hash] = target.split('#')
    let abs = p === '' ? page : p.startsWith('/') ? p.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(page), p))
    if (abs === '.') abs = ''
    if (p.endsWith('/') || p === '.' || p === '..') abs = abs === '' || abs.endsWith('/') ? abs : `${abs}/`
    if (abs.startsWith('../')) return undefined // outside the docs: left as written
    return `${base}${twinOf(hash === undefined ? abs : `${abs}#${hash}`)}`
  }
  const chunks: string[] = []
  let chunk: string[] = []
  let inFence: string | null = null
  for (const l of out) {
    const f = /^\s*(`{3,}|~{3,})/.exec(l)
    if (inFence === null && f) {
      chunks.push(relink(chunk.join('\n'), href), l)
      chunk = []
      inFence = f[1]
    } else if (inFence !== null) {
      chunks.push(l)
      if (l.trim() === inFence) inFence = null
    } else chunk.push(l)
  }
  chunks.push(relink(chunk.join('\n'), href))
  let body = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!/^# /.test(body)) body = `# ${title || page.replace(/\.md$/, '')}\n\n${body}`
  const people = `${base}${page.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`
  const versions = [`${options.product} ${options.version}`, ...Object.entries(options.versions ?? {}).map(([k, v]) => `${k} ${v}`)]
  const [h1, ...rest] = body.split('\n')
  return `${h1}\n\n> For agents: ${versions.join(', ')}. The page for people: ${people}\n${rest.join('\n')}\n`
}

/** Markdown text with each inline link's target passed through `to` (undefined leaves it); labels may nest brackets. */
export function relink(text: string, to: (target: string) => string | undefined): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '`') {
      // Code spans are copied as they are.
      const run = /^`+/.exec(text.slice(i))![0]
      const end = text.indexOf(run, i + run.length)
      const stop = end < 0 ? i + run.length : end + run.length
      out += text.slice(i, stop)
      i = stop
      continue
    }
    if (c !== '[' || text[i - 1] === '\\' || text[i - 1] === '!') {
      out += c
      i++
      continue
    }
    // The label: to the matching ], skipping code spans.
    let depth = 0
    let j = i
    for (; j < text.length; j++) {
      if (text[j] === '`') {
        const run = /^`+/.exec(text.slice(j))![0]
        const end = text.indexOf(run, j + run.length)
        if (end < 0) break
        j = end + run.length - 1
      } else if (text[j] === '[') depth++
      else if (text[j] === ']' && --depth === 0) break
    }
    const m = j < text.length ? /^\(([^)\s]+)((?:\s+"[^"]*")?)\)/.exec(text.slice(j + 1)) : null
    if (!m) {
      out += c
      i++
      continue
    }
    const target = to(m[1])
    out += `${relink(text.slice(i + 1, j), to).replace(/^/, '[')}](${target ?? m[1]}${m[2]})`
    i = j + 1 + m[0].length
  }
  return out
}

interface SidebarItem {
  text?: string
  link?: string
  items?: SidebarItem[]
}

/** The sidebar's groups and the pages in each, in order. */
function sidebarGroups(sidebar: unknown): { title: string; links: { text: string; link: string }[] }[] {
  const roots: SidebarItem[] = Array.isArray(sidebar)
    ? sidebar
    : sidebar && typeof sidebar === 'object'
      ? Object.values(sidebar as Record<string, SidebarItem[] | { items: SidebarItem[] }>).flatMap((v) => (Array.isArray(v) ? v : v.items))
      : []
  const groups: { title: string; links: { text: string; link: string }[] }[] = []
  const walk = (items: SidebarItem[], links: { text: string; link: string }[]) => {
    for (const it of items) {
      if (it.link) links.push({ text: it.text ?? it.link, link: it.link })
      if (it.items) walk(it.items, links)
    }
  }
  for (const root of roots) {
    const links: { text: string; link: string }[] = []
    if (root.link) links.push({ text: root.text ?? root.link, link: root.link })
    walk(root.items ?? [], links)
    if (links.length) groups.push({ title: root.text ?? 'Pages', links })
  }
  return groups
}

/** A page's one-line description: its front matter's, or its first paragraph's first sentence. */
export function describe(source: string): string {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(source)
  const d = fm && /^description:\s*['"]?(.*?)['"]?\s*$/m.exec(fm[1])
  if (d) return d[1]
  const body = fm ? source.slice(fm[0].length) : source
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim()
    if (!t || /^(#|```|\||<|:::|[-*] |\d+\. |>)/.test(t)) continue
    const plain = t.replace(/\s+/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    const sentence = /^(.*?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain
    return sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence
  }
  return ''
}

/** Writes the twins, llms.txt and agents.md into the build. In .vitepress/config.ts: `buildEnd: (c) => agentDocs(c, {…})`. */
export function agentDocs(config: SiteConfig, options: AgentDocsOptions): { files: number } {
  const base = options.url.endsWith('/') ? options.url : `${options.url}/`
  const read = (page: string) => readFileSync(path.join(config.srcDir, page), 'utf8')
  const write = (file: string, text: string) => {
    const to = path.join(config.outDir, file)
    mkdirSync(path.dirname(to), { recursive: true })
    writeFileSync(to, text)
  }
  const twins = new Map<string, string>()
  for (const page of config.pages) {
    const twin = toTwin(read(page), page, options)
    twins.set(page, twin)
    write(page, twin)
  }
  const versions = [`${options.product} ${options.version}`, ...Object.entries(options.versions ?? {}).map(([k, v]) => `${k} ${v}`)].join(', ')

  // llms.txt: the sidebar's groups, then the pages it leaves out.
  const pageOf = (link: string) => {
    const p = link.replace(/^\//, '').split('#')[0]
    const cands = [p.endsWith('/') || p === '' ? `${p}index.md` : `${p.replace(/\.(html|md)$/, '')}.md`, `${p}/index.md`]
    return cands.find((c) => twins.has(c))
  }
  const listed = new Set<string>()
  let llms = `# ${options.product}\n\n> ${options.summary ?? config.site.description}\n\n`
  llms += `Version: ${versions}. Every page is Markdown at the address below. The agent guide is all of it in one file, with the grammar: [agents.md](${base}agents.md).\n`
  for (const g of sidebarGroups(config.site.themeConfig.sidebar)) {
    const rows: string[] = []
    for (const { text, link } of g.links) {
      const page = pageOf(link)
      if (!page || listed.has(page)) continue
      listed.add(page)
      const d = describe(read(page))
      rows.push(`- [${text}](${base}${page})${d ? `: ${d}` : ''}`)
    }
    if (rows.length) llms += `\n## ${g.title}\n\n${rows.join('\n')}\n`
  }
  const rest = config.pages.filter((p) => !listed.has(p)).sort()
  if (rest.length) {
    llms += `\n## Optional\n\n${rest.map((p) => `- [${twins.get(p)!.split('\n')[0].replace(/^# /, '')}](${base}${p})`).join('\n')}\n`
  }
  write('llms.txt', llms)

  // agents.md: the introduction, the grammar, then the pages it names, each a section.
  let guide = `# ${options.product}: the guide for agents\n\n> ${versions}. Generated from the documentation at ${base}; every example in it is tested.\n\n`
  if (options.intro) {
    const intro = toTwin(read(options.intro), options.intro, options).split('\n')
    guide += `${intro.slice(3).join('\n').trim()}\n\n` // without its title and version line
  }
  if (options.grammar) guide += `## Grammar\n\nIn W3C EBNF: quoted text is written as it is; names are other rules.\n\n\`\`\`ebnf\n${options.grammar.trim()}\n\`\`\`\n\n`
  const order: string[] = []
  for (const want of options.guide ?? []) {
    const hits = config.pages.filter((p) => (want.endsWith('/') ? p.startsWith(want) : p === want || p === `${want}.md`))
    // A section's own index first, then its pages in sidebar order where the sidebar has them.
    const sidebarOrder = sidebarGroups(config.site.themeConfig.sidebar).flatMap((g) => g.links.map((l) => pageOf(l.link)))
    const rank = (p: string) => (p === 'index.md' || p.endsWith('/index.md') ? -1 : sidebarOrder.indexOf(p) < 0 ? 1e9 : sidebarOrder.indexOf(p))
    hits.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    for (const h of hits) if (!order.includes(h) && h !== options.intro) order.push(h)
  }
  for (const page of order) {
    const [h1, , , ...body] = twins.get(page)!.split('\n')
    // Each page's headings move down a level under its own section.
    let inFence = false
    const shifted = body.map((l) => {
      if (/^\s*(`{3,}|~{3,})/.test(l)) inFence = !inFence
      return !inFence && /^#{1,5} /.test(l) ? `#${l}` : l
    })
    guide += `## ${h1.replace(/^# /, '')}\n\nFrom ${base}${page}\n\n${shifted.join('\n').trim()}\n\n`
  }
  write('agents.md', guide.replace(/\n{3,}/g, '\n\n'))
  return { files: twins.size + 2 }
}

/** The version in a package.json, for `version`. */
export function packageVersion(file: string): string {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version : '0.0.0'
}
