// Syntax diagrams (BRAND.md, Documentation, rule 4): railroad diagrams drawn from a grammar written in EBNF, in the
// W3C notation of the XML specification. Keywords are rounded boxes, rules are square boxes that expand in place, and
// long rules wrap onto rows. Our own code, with no dependencies; colours come from smaltdb.css, so light and dark
// follow the theme.
//
// Three parts:
// - parseEbnf() and renderRule(): the grammar and the SVG of one rule, usable anywhere (the agent docs print the same
//   EBNF text the diagrams are drawn from).
// - railroadPlugin(): a markdown-it plugin for .vitepress/config.ts. An ```ebnf fence draws each rule it defines; a
//   ```railroad fence draws rules of the site's grammar by name, one name per line.
// - enableRailroad(): the click handler that expands a rule in place, for .vitepress/theme/index.ts.

// ---------------------------------------------------------------------------------------------------------------------
// The grammar

/** A grammar expression. */
export type Node =
  | { t: 'term'; text: string }
  | { t: 'ref'; name: string }
  | { t: 'seq'; items: Node[] }
  | { t: 'choice'; items: Node[] }
  | { t: 'opt'; item: Node }
  | { t: 'rep'; item: Node; sep?: Node } // one or more, with `sep` between repeats
  | { t: 'skip' }

/** A grammar: its rules in the order they were written, and each rule's EBNF text. */
export interface Grammar {
  rules: Map<string, Node>
  text: Map<string, string>
}

/**
 * Reads a grammar in W3C EBNF: `name ::= expression`, one rule after another. An expression is made of terminals in
 * quotes (`'SELECT'`, `","`), rule names (`expr`, `table-name`), sequences, alternatives with `|`, groups in
 * parentheses, and the suffixes `?` (optional), `*` (zero or more) and `+` (one or more). `/* … *\/` is a comment.
 * Throws an Error that names the line for anything else.
 */
export function parseEbnf(source: string, into?: Grammar): Grammar {
  const grammar: Grammar = into ?? { rules: new Map(), text: new Map() }
  const src = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  const starts = [...src.matchAll(/^[ \t]*([A-Za-z][\w-]*)\s*::=/gm)]
  if (starts.length === 0 && src.trim()) throw new Error(`EBNF: no rule found (rules are written name ::= …)`)
  const before = src.slice(0, starts[0]?.index ?? src.length)
  if (before.trim()) throw new Error(`EBNF line ${lineOf(src, before.search(/\S/))}: text before the first rule`)
  starts.forEach((m, i) => {
    const bodyStart = m.index! + m[0].length
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].index! : src.length
    const name = m[1]
    if (grammar.rules.has(name) && !into) throw new Error(`EBNF line ${lineOf(src, m.index!)}: ${name} is defined twice`)
    const p = new Parser(src, bodyStart, bodyEnd)
    const node = p.expression()
    p.end()
    grammar.rules.set(name, normalize(node))
    grammar.text.set(name, source.slice(m.index!, bodyEnd).trim())
  })
  return grammar
}

function lineOf(src: string, at: number): number {
  return src.slice(0, at).split('\n').length
}

class Parser {
  private src: string
  private at: number
  private stop: number

  constructor(src: string, at: number, stop: number) {
    this.src = src
    this.at = at
    this.stop = stop
  }

  private skipSpace(): void {
    while (this.at < this.stop && /\s/.test(this.src[this.at])) this.at++
  }

  private peek(): string {
    this.skipSpace()
    return this.at < this.stop ? this.src[this.at] : ''
  }

  private fail(what: string): never {
    throw new Error(`EBNF line ${lineOf(this.src, this.at)}: ${what}`)
  }

  end(): void {
    if (this.peek() !== '') this.fail(`unexpected ${JSON.stringify(this.src[this.at])}`)
  }

  expression(): Node {
    const items = [this.sequence()]
    while (this.peek() === '|') {
      this.at++
      items.push(this.sequence())
    }
    return items.length === 1 ? items[0] : { t: 'choice', items }
  }

  private sequence(): Node {
    const items: Node[] = []
    for (let c = this.peek(); c !== '' && c !== '|' && c !== ')'; c = this.peek()) items.push(this.postfix())
    return items.length === 0 ? { t: 'skip' } : items.length === 1 ? items[0] : { t: 'seq', items }
  }

  private postfix(): Node {
    let node = this.primary()
    for (;;) {
      const c = this.src[this.at] // a suffix follows its item directly
      if (c === '?') node = { t: 'opt', item: node }
      else if (c === '+') node = { t: 'rep', item: node }
      else if (c === '*') node = { t: 'opt', item: { t: 'rep', item: node } }
      else return node
      this.at++
    }
  }

  private primary(): Node {
    const c = this.peek()
    if (c === '(') {
      this.at++
      const node = this.expression()
      if (this.peek() !== ')') this.fail('expected )')
      this.at++
      return node
    }
    if (c === "'" || c === '"') {
      const close = this.src.indexOf(c, this.at + 1)
      if (close < 0 || close >= this.stop) this.fail('unclosed quote')
      const text = this.src.slice(this.at + 1, close)
      if (text === '') this.fail('empty terminal')
      this.at = close + 1
      return { t: 'term', text }
    }
    const m = /^[A-Za-z][\w-]*/.exec(this.src.slice(this.at, this.stop))
    if (!m) this.fail(c === '' ? 'expected an expression' : `unexpected ${JSON.stringify(c)}`)
    this.at += m[0].length
    return { t: 'ref', name: m[0] }
  }
}

const same = (a: Node, b: Node): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Shapes that draw better than they are written: `x (sep x)*` is one loop with `sep` on its way back, an alternative
 * that may be empty is an optional choice, and nested sequences are flattened.
 */
function normalize(node: Node): Node {
  switch (node.t) {
    case 'opt': {
      const item = normalize(node.item)
      return item.t === 'opt' || item.t === 'skip' ? item : { t: 'opt', item }
    }
    case 'rep':
      return { t: 'rep', item: normalize(node.item), ...(node.sep ? { sep: normalize(node.sep) } : {}) }
    case 'choice': {
      const items = node.items.map(normalize)
      const rest = items.filter((i) => i.t !== 'skip')
      if (rest.length === items.length) return { t: 'choice', items }
      const inner = rest.length === 1 ? rest[0] : { t: 'choice' as const, items: rest }
      return normalize({ t: 'opt', item: inner })
    }
    case 'seq': {
      const flat: Node[] = []
      for (const i of node.items.map(normalize)) flat.push(...(i.t === 'seq' ? i.items : i.t === 'skip' ? [] : [i]))
      const out: Node[] = []
      for (const i of flat) {
        // x (sep x)*  →  x repeated, with sep between
        const loop = i.t === 'opt' && i.item.t === 'rep' && !i.item.sep ? i.item.item : undefined
        if (loop && loop.t === 'seq' && loop.items.length >= 2) {
          const x = loop.items[loop.items.length - 1]
          const prev = out[out.length - 1]
          if (prev && same(prev, x)) {
            const sepItems = loop.items.slice(0, -1)
            out[out.length - 1] = { t: 'rep', item: x, sep: sepItems.length === 1 ? sepItems[0] : { t: 'seq', items: sepItems } }
            continue
          }
        }
        out.push(i)
      }
      return out.length === 0 ? { t: 'skip' } : out.length === 1 ? out[0] : { t: 'seq', items: out }
    }
    default:
      return node
  }
}

/** The rules a rule refers to, directly and through the rules it refers to, in first-use order. */
export function rulesUsed(grammar: Grammar, names: string[]): string[] {
  const seen = new Set<string>()
  const visit = (n: Node): void => {
    switch (n.t) {
      case 'ref':
        if (!seen.has(n.name) && grammar.rules.has(n.name)) {
          seen.add(n.name)
          visit(grammar.rules.get(n.name)!)
        }
        return
      case 'seq':
      case 'choice':
        n.items.forEach(visit)
        return
      case 'opt':
        visit(n.item)
        return
      case 'rep':
        visit(n.item)
        if (n.sep) visit(n.sep)
        return
      default:
    }
  }
  for (const name of names) {
    const rule = grammar.rules.get(name)
    if (rule) visit(rule)
  }
  for (const name of names) seen.delete(name)
  return [...seen]
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout. Each node lays itself out around a baseline at y = 0, from x = 0, and returns its width, how far it reaches
// above and below the baseline, and its SVG.

const R = 10 // curve radius
const H = 28 // box height
const GAP = 14 // line between items in a sequence
const ROW_GAP = 26 // space between wrapped rows
const CHAR = 9.1 // width of one character of Martian Mono at 13px (0.7em, measured)
const PAD = 20 // margin around a diagram

interface Box {
  w: number
  up: number // reach above the entry line
  down: number // reach below the entry line
  exit: number // where the line leaves, below the entry: 0, or the last row of a wrapped sequence
  svg: string
}

type Known = (name: string) => boolean

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const textWidth = (s: string): number => Math.ceil([...s].length * CHAR) + 26
const line = (x1: number, x2: number, y = 0): string => (x2 > x1 ? `<path class="sw-rr-line" d="M${x1} ${y}H${x2}"/>` : '')
const path = (d: string): string => `<path class="sw-rr-line" d="${d}"/>`
const at = (dx: number, dy: number, s: string): string => (dx || dy ? `<g transform="translate(${dx} ${dy})">${s}</g>` : s)

/** From (x, y) east, then down and back east into (to, 0) above it: how a lower line rejoins the entry line. */
const rise = (x: number, y: number, to: number): string =>
  y === 0
    ? line(x, to)
    : (x < to - 2 * R ? line(x, to - 2 * R, y) : '') +
      path(`M${to - 2 * R} ${y}a${R} ${R} 0 0 0 ${R} -${R}V${R}a${R} ${R} 0 0 1 ${R} -${R}`)

function box(text: string, kind: 'term' | 'ref', live: boolean, name = ''): Box {
  const w = textWidth(text) + (live ? 14 : 0)
  if (kind === 'term') {
    return {
      w, up: H / 2, down: H / 2, exit: 0,
      svg:
        `<g class="sw-rr-term"><rect x="0" y="${-H / 2}" width="${w}" height="${H}" rx="${H / 2}"/>` +
        `<text x="${w / 2}" y="4.5">${esc(text)}</text></g>`,
    }
  }
  const label = live ? `${esc(text)} <tspan class="sw-rr-mark">▸</tspan>` : esc(text)
  const attrs = live
    ? ` data-rule="${esc(name)}" tabindex="0" role="button" aria-expanded="false" aria-label="${esc(name)}: show the rule"`
    : ''
  return {
    w, up: H / 2, down: H / 2, exit: 0,
    svg:
      `<g class="sw-rr-ref${live ? '' : ' sw-rr-undefined'}"${attrs}><rect x="0" y="${-H / 2}" width="${w}" height="${H}" rx="3"/>` +
      `<text x="${w / 2}" y="4.5">${label}</text></g>`,
  }
}

/** Boxes one after another, each starting where the one before it leaves. */
function chain(boxes: Box[]): Box {
  let x = 0
  let y = 0
  let up = 0
  let down = 0
  let svg = ''
  boxes.forEach((b, i) => {
    if (i) {
      svg += line(x, x + GAP, y)
      x += GAP
    }
    svg += at(x, y, b.svg)
    up = Math.max(up, b.up - y)
    down = Math.max(down, y + b.down)
    x += b.w
    y += b.exit
  })
  return { w: x, up, down, exit: y, svg }
}

/** Boxes in rows no wider than `max`: each row runs left to right and joins the next along the left. */
function rows(boxes: Box[], max: number): Box {
  const groups: Box[][] = [[]]
  let width = 0
  for (const b of boxes) {
    const row = groups[groups.length - 1]
    const add = (row.length ? GAP : 0) + b.w
    // A row's width, plus the return lane on the right (R) and, after the first row, the indent on the left (2R).
    if (row.length && width + add > max - R - (groups.length > 1 ? 2 * R : 0)) {
      groups.push([b])
      width = b.w
    } else {
      row.push(b)
      width += add
    }
  }
  if (groups.length === 1) return chain(boxes)
  const laid = groups.map(chain)
  const indent = 2 * R
  const W = Math.max(...laid.map((r, i) => r.w + (i ? indent : 0))) + R
  let svg = ''
  let y = 0
  laid.forEach((r, i) => {
    if (i) {
      // Down from the end of the row above, back along the left, into this row.
      const prev = laid[i - 1]
      const from = y + prev.exit
      const mid = y + prev.down + ROW_GAP / 2
      y += prev.down + ROW_GAP + r.up
      svg +=
        line(prev.w + (i > 1 ? indent : 0), W - R, from) +
        path(
          `M${W - R} ${from}a${R} ${R} 0 0 1 ${R} ${R}V${mid - R}a${R} ${R} 0 0 1 -${R} ${R}` +
            `H${R}a${R} ${R} 0 0 0 -${R} ${R}V${y - R}a${R} ${R} 0 0 0 ${R} ${R}H${indent}`,
        )
    }
    svg += at(i ? indent : 0, y, r.svg)
  })
  const last = laid[laid.length - 1]
  svg += line(indent + last.w, W, y + last.exit)
  return { w: W, up: laid[0].up, down: y + last.down, exit: y + last.exit, svg }
}

/** Lays out a node no wider than `max` where its sequences can wrap. */
function layout(n: Node, known: Known, max: number): Box {
  switch (n.t) {
    case 'skip':
      return { w: 0, up: 0, down: 0, exit: 0, svg: '' }
    case 'term':
      return box(n.text, 'term', false)
    case 'ref':
      return box(n.name, 'ref', known(n.name), n.name)
    case 'seq': {
      const one = chain(n.items.map((i) => layout(i, known, max)))
      if (one.w <= max) return one
      // Wrapped, a row past the first has the indent on its left and every row the return lane on its right.
      return rows(n.items.map((i) => layout(i, known, max - 3 * R)), max)
    }
    case 'opt': {
      // The item on the entry line; a bypass above it, down to where the item leaves.
      const b = layout(n.item, known, max - 4 * R)
      const W = b.w + 4 * R
      const top = b.up + 10
      const svg =
        line(0, 2 * R) +
        at(2 * R, 0, b.svg) +
        line(2 * R + b.w, W, b.exit) +
        path(
          `M0 0a${R} ${R} 0 0 0 ${R} -${R}V${-top + R}a${R} ${R} 0 0 1 ${R} -${R}H${W - 2 * R}` +
            `a${R} ${R} 0 0 1 ${R} ${R}V${b.exit - R}a${R} ${R} 0 0 0 ${R} ${R}`,
        )
      return { w: W, up: top, down: b.down, exit: b.exit, svg }
    }
    case 'choice': {
      // The first item on the entry line, the others below it; every one rejoins the entry line.
      const boxes = n.items.map((i) => layout(i, known, max - 4 * R))
      const W = Math.max(...boxes.map((b) => b.w)) + 4 * R
      let svg = ''
      let y = 0
      let down = 0
      boxes.forEach((b, i) => {
        if (i) y += boxes[i - 1].down + b.up + 10
        svg += at(2 * R, y, b.svg)
        if (i === 0) svg += line(0, 2 * R)
        else svg += path(`M0 0a${R} ${R} 0 0 1 ${R} ${R}V${y - R}a${R} ${R} 0 0 0 ${R} ${R}`)
        svg += rise(2 * R + b.w, y + b.exit, W)
        down = y + b.down
      })
      return { w: W, up: boxes[0].up, down, exit: 0, svg }
    }
    case 'rep': {
      // The item on the entry line, and a loop back below it, through the separator if there is one. A loop doesn't
      // wrap: its line has to come back to where it started.
      const b = layout(n.item, known, Infinity)
      const s = n.sep ? layout(n.sep, known, Infinity) : undefined
      const inner = Math.max(b.w, s?.w ?? 0)
      const W = inner + 4 * R
      const dy = Math.max(b.down + 10 + (s ? s.up : 0), 2 * R)
      const ix = 2 * R + (inner - b.w) / 2
      let svg = line(0, ix) + at(ix, 0, b.svg) + line(ix + b.w, W)
      svg += path(`M${W - 2 * R} 0a${R} ${R} 0 0 1 ${R} ${R}V${dy - R}a${R} ${R} 0 0 1 -${R} ${R}`)
      svg += path(`M${2 * R} 0a${R} ${R} 0 0 0 -${R} ${R}V${dy - R}a${R} ${R} 0 0 0 ${R} ${R}`)
      if (s) {
        const sx = 2 * R + (inner - s.w) / 2
        svg += line(2 * R, sx, dy) + at(sx, dy, s.svg) + line(sx + s.w, W - 2 * R, dy)
      } else {
        svg += line(2 * R, W - 2 * R, dy)
      }
      return { w: W, up: b.up, down: dy + (s ? s.down : 0), exit: 0, svg }
    }
  }
}

export interface RenderOptions {
  /** Wrap a rule wider than this, in pixels, onto rows (default 600: VitePress's content column beside the outline). */
  maxWidth?: number
  /** Whether a rule name has a diagram to expand into (default: every rule of the grammar). */
  known?: (name: string) => boolean
}

/** The SVG of one rule of the grammar. */
export function renderRule(grammar: Grammar, name: string, opts: RenderOptions = {}): string {
  const node = grammar.rules.get(name)
  if (!node) throw new Error(`railroad: no rule ${name}`)
  const known = opts.known ?? ((n: string) => grammar.rules.has(n))
  const b = layout(node, known, (opts.maxWidth ?? 600) - 2 * PAD - 24)
  const W = Math.ceil(b.w + 2 * PAD + 24)
  const Hh = Math.ceil(b.up + b.down + 2 * PAD)
  const y0 = PAD + b.up
  const x0 = PAD + 12
  const label = grammar.text.get(name) ?? name
  return (
    `<svg class="sw-rr" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">` +
    `<circle class="sw-rr-end" cx="${PAD}" cy="${y0}" r="4"/>` +
    line(PAD, x0, y0) +
    at(x0, y0, b.svg) +
    line(x0 + b.w, x0 + b.w + 12, y0 + b.exit) +
    `<circle class="sw-rr-end" cx="${x0 + b.w + 12}" cy="${y0 + b.exit}" r="4"/></svg>`
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// The markdown-it plugin

export interface RailroadOptions extends RenderOptions {
  /** The site's grammar, as EBNF text: the rules ```railroad fences draw, and every rule a diagram can expand into. */
  grammar?: string
}

interface MarkdownIt {
  renderer: { rules: Record<string, ((tokens: any[], idx: number, options: any, env: any, self: any) => string) | undefined> }
}

/**
 * Draws ```ebnf and ```railroad fences as syntax diagrams. In .vitepress/config.ts:
 *
 *     import { railroadPlugin } from './theme/railroad'
 *     markdown: { config: (md) => md.use(railroadPlugin, { grammar: readFileSync('docs/grammar.ebnf', 'utf8') }) }
 */
export function railroadPlugin(md: MarkdownIt, options: RailroadOptions = {}): void {
  const site = options.grammar ? parseEbnf(options.grammar) : { rules: new Map(), text: new Map() }
  const fence = md.renderer.rules.fence!
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const token = tokens[idx]
    const lang = String(token.info).trim().split(/\s+/)[0]
    if (lang !== 'ebnf' && lang !== 'railroad') return fence(tokens, idx, opts, env, self)
    const where = env?.relativePath ? `${env.relativePath}: ` : ''
    let grammar: Grammar
    let names: string[]
    try {
      if (lang === 'ebnf') {
        const local = parseEbnf(token.content)
        names = [...local.rules.keys()]
        grammar = { rules: new Map([...site.rules, ...local.rules]), text: new Map([...site.text, ...local.text]) }
      } else {
        names = token.content.split('\n').map((s: string) => s.trim()).filter(Boolean)
        for (const n of names) if (!site.rules.has(n)) throw new Error(`no rule ${n} in the site's grammar`)
        grammar = site
      }
    } catch (e) {
      throw new Error(`${where}${(e as Error).message}`)
    }
    // Rules the page draws are drawn once; rules it only refers to travel with it, once per page, for expanding.
    const store = (env ?? {}) as { swRailroad?: { drawn: Set<string>; carried: Set<string> } }
    const page = (store.swRailroad ??= { drawn: new Set(), carried: new Set() })
    names.forEach((n) => page.drawn.add(n))
    const known = options.known ?? ((n: string) => grammar.rules.has(n))
    const render = (n: string) => renderRule(grammar, n, { ...options, known })
    let html = '<div class="sw-rr-figure" v-pre>'
    for (const n of names) {
      html +=
        `<div class="sw-rr-rule" id="syntax-${esc(n)}" data-rule="${esc(n)}">` +
        `<div class="sw-rr-name"><a href="#syntax-${esc(n)}">${esc(n)}</a></div>${render(n)}</div>`
    }
    const ebnf = names.map((n) => grammar.text.get(n)).join('\n')
    html += `<details class="sw-rr-ebnf"><summary>EBNF</summary><pre><code>${esc(ebnf)}</code></pre></details>`
    for (const n of rulesUsed(grammar, names)) {
      if (page.drawn.has(n) || page.carried.has(n)) continue
      page.carried.add(n)
      html += `<div class="sw-rr-carried" data-sw-rr="${esc(n)}" hidden>${render(n)}</div>`
    }
    return html + '</div>'
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// In the browser

/**
 * Expands a rule box in place when it's clicked (or Enter / Space when focused), and folds it again. In
 * .vitepress/theme/index.ts: `enhanceApp() { if (typeof document !== 'undefined') enableRailroad() }`.
 */
export function enableRailroad(doc: Document = document): void {
  const w = doc as Document & { swRailroad?: boolean }
  if (w.swRailroad) return
  w.swRailroad = true
  const toggle = (ref: Element): void => {
    const name = ref.getAttribute('data-rule')!
    const host = ref.closest('.sw-rr-rule, .sw-rr-expansion')
    if (!host) return
    const open = host.querySelector(`:scope > .sw-rr-expansion[data-rule="${CSS.escape(name)}"]`)
    const mark = ref.querySelector('.sw-rr-mark')
    if (open) {
      open.remove()
      ref.setAttribute('aria-expanded', 'false')
      if (mark) mark.textContent = '▸'
      return
    }
    const drawn = doc.querySelector(`.sw-rr-rule[data-rule="${CSS.escape(name)}"] > svg`)
    const carried = doc.querySelector(`.sw-rr-carried[data-sw-rr="${CSS.escape(name)}"] > svg`)
    const svg = (drawn ?? carried)?.cloneNode(true)
    if (!svg) return
    const box = doc.createElement('div')
    box.className = 'sw-rr-expansion'
    box.setAttribute('data-rule', name)
    const title = doc.createElement('div')
    title.className = 'sw-rr-name'
    title.textContent = name
    box.append(title, svg)
    box.querySelectorAll('.sw-rr-ref[aria-expanded="true"]').forEach((r) => {
      r.setAttribute('aria-expanded', 'false')
      const m = r.querySelector('.sw-rr-mark')
      if (m) m.textContent = '▸'
    })
    host.append(box)
    ref.setAttribute('aria-expanded', 'true')
    if (mark) mark.textContent = '▾'
  }
  doc.addEventListener('click', (e) => {
    const ref = (e.target as Element | null)?.closest?.('.sw-rr-ref[data-rule]')
    if (ref) toggle(ref)
  })
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const ref = (e.target as Element | null)?.closest?.('.sw-rr-ref[data-rule]')
    if (!ref) return
    e.preventDefault()
    toggle(ref)
  })
}
