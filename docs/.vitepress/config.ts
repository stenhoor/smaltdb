import { defineConfig } from 'vitepress'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { smaltLight, smaltDark } from './theme/shiki'
import { smaltworksMenu, smaltworksFooter } from './theme/smaltworks'
import { railroadPlugin } from './theme/railroad'
import { agentDocs, packageVersion } from './theme/agents'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'https://github.com/stenhoor/smaltdb'
// The plan language's grammar, written from the plan types and tested against them (test/plan-grammar.test.ts): the
// syntax diagrams and the agent guide read it.
const GRAMMAR = readFileSync(path.resolve(here, '../grammar.ebnf'), 'utf8')

// A group of the reference in the sidebar: its page, then a page per member, in the order of the group page's list
// (`- [`name`](./page): summary`), so the sidebar and the group page cannot disagree. As smaltql's site does.
function group(text: string, dir: string) {
  const md = readFileSync(path.resolve(here, `../reference/${dir}/index.md`), 'utf8')
  const items = [...md.matchAll(/^- \[`(.+?)`\]\(\.\/([\w-]+)\): /gm)].map(([, label, page]) => ({
    text: label.replace(/`/g, ''),
    link: `/reference/${dir}/${page}`,
  }))
  return { text, link: `/reference/${dir}/`, collapsed: true, items }
}

// The function groups, in the order of the functions overview.
const FUNCTION_GROUPS: [string, string][] = [
  ['Comparison and logic', 'comparison'],
  ['Arithmetic', 'arithmetic'],
  ['Math', 'math'],
  ['Conversion', 'conversion'],
  ['Text', 'text'],
  ['Dates and times', 'temporal'],
  ['Date and time text', 'datetime'],
  ['Lists and structs', 'list'],
  ['Maps', 'map'],
  ['Values under any', 'any'],
  ['General', 'general'],
  ['Database state', 'database'],
  ['Aggregate', 'aggregate'],
  ['Window', 'window'],
]

export default defineConfig({
  title: 'smaltdb',
  description: 'A fast alternative database for the browser, written in TypeScript.',
  base: '/',
  cleanUrls: true,
  srcExclude: ['brand/**'],
  // adr/README.md is the folder's landing page on GitHub; publish it at /adr/ too.
  rewrites: { 'adr/README.md': 'adr/index.md' },
  lastUpdated: false,
  // docs/brand holds the logo files; serve them from the site root.
  vite: { publicDir: path.resolve(here, '../brand') },
  // Markdown for AI agents beside the pages: a twin of each page, /llms.txt and /agents.md (BRAND.md, Documentation).
  buildEnd: (config) => {
    agentDocs(config, {
      product: 'smaltdb',
      version: packageVersion(path.resolve(here, '../../package.json')),
      versions: { 'plan format': '1' },
      url: 'https://smaltdb.dev/',
      intro: 'reference/plan/agents.md',
      grammar: GRAMMAR,
      guide: [
        'reference/plan/',
        'reference/plan/sample-data',
        'reference/plan/statements',
        'reference/plan/types',
        'reference/plan/collations',
        'reference/plan/conversions',
        'reference/plan/values',
        'reference/plan/meaning-fields',
        'reference/plan/order',
        'reference/plan/shapes',
        'reference/plan/graph-writes',
        'reference/plan/builders',
        'reference/plan/operations/',
        'reference/plan/expressions/',
        'reference/plan/functions/',
        'reference/engine/running',
        'reference/engine/schema',
        'reference/api/errors',
      ],
    })
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon-32.svg' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;700&family=Geist+Mono:wght@400;500&family=Martian+Mono:wght@400;600&display=swap' }],
  ],
  markdown: {
    theme: { light: smaltLight, dark: smaltDark },
    config(md) {
      // Links that leave docs/ (benchmark results, test sources) point at the file on GitHub.
      const fallback = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o))
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const href = tokens[idx].attrGet('href')
        if (href && !/^[a-z]+:|^#|^\//i.test(href) && env?.relativePath) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(env.relativePath), href))
          if (target.startsWith('../')) {
            tokens[idx].attrSet('href', `${REPO}/blob/HEAD/${target.slice(3)}`)
            tokens[idx].attrSet('target', '_blank')
            tokens[idx].attrSet('rel', 'noreferrer')
          }
        }
        return fallback(tokens, idx, options, env, self)
      }
      // ```railroad and ```ebnf fences draw rules of the plan grammar as syntax diagrams (BRAND.md, Documentation, rule 4).
      md.use(railroadPlugin, { grammar: GRAMMAR })
    },
  },
  themeConfig: {
    logo: { light: '/lockup.svg', dark: '/lockup-on-dark.svg', alt: 'smaltdb' },
    siteTitle: false,
    nav: [
      { text: 'Engine', link: '/reference/engine/' },
      { text: 'Plan language', link: '/reference/plan/' },
      { text: 'Functions', link: '/reference/plan/functions/' },
      { text: 'API', link: '/reference/api/engine' },
      { text: 'smaltql · SQL', link: 'https://stenhoor.github.io/smaltql/' },
      {
        text: 'Internals',
        items: [
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Decisions', link: '/adr/' },
          { text: 'Benchmarks', link: '/research/benchmark-methodology' },
          { text: 'Research', link: '/research/m7-code-review' },
        ],
      },
      smaltworksMenu(),
    ],
    sidebar: [
      {
        text: 'Engine',
        items: [
          { text: 'Overview', link: '/reference/engine/' },
          { text: 'Running plans', link: '/reference/engine/running' },
          { text: 'Schema definitions', link: '/reference/engine/schema' },
          { text: 'The catalog', link: '/reference/engine/catalog' },
          { text: 'Writing a language', link: '/reference/engine/languages' },
        ],
      },
      {
        text: 'Plan language',
        items: [
          { text: 'Overview', link: '/reference/plan/' },
          { text: 'Sample data', link: '/reference/plan/sample-data' },
          { text: 'Statements', link: '/reference/plan/statements' },
          { text: 'Types', link: '/reference/plan/types' },
          { text: 'Collations', link: '/reference/plan/collations' },
          { text: 'Conversions', link: '/reference/plan/conversions' },
          { text: 'Values in JSON', link: '/reference/plan/values' },
          { text: 'Meaning fields', link: '/reference/plan/meaning-fields' },
          { text: 'Order', link: '/reference/plan/order' },
          { text: 'Plan shapes', link: '/reference/plan/shapes' },
          { text: 'Writing a property graph', link: '/reference/plan/graph-writes' },
          { text: 'Builders', link: '/reference/plan/builders' },
          { text: 'For AI agents', link: '/reference/plan/agents' },
          group('Operations', 'plan/operations'),
          group('Expressions', 'plan/expressions'),
        ],
      },
      {
        text: 'Functions',
        items: [{ text: 'Overview', link: '/reference/plan/functions/' }, ...FUNCTION_GROUPS.map(([text, dir]) => group(text, `plan/functions/${dir}`))],
      },
      {
        text: 'API reference',
        items: [
          { text: 'Engine (smaltdb/engine)', link: '/reference/api/engine' },
          { text: 'Writing plugins', link: '/reference/api/plugins' },
          { text: 'Error codes', link: '/reference/api/errors' },
          { text: 'Client · smaltql', link: 'https://stenhoor.github.io/smaltql/reference/api/client' },
        ],
      },
      {
        text: 'smaltql · SQL',
        items: [
          { text: 'Getting started', link: 'https://stenhoor.github.io/smaltql/guide/getting-started' },
          { text: 'SQL reference', link: 'https://stenhoor.github.io/smaltql/reference/sql/' },
          { text: 'Functions', link: 'https://stenhoor.github.io/smaltql/reference/functions/' },
        ],
      },
      {
        text: 'Internals',
        collapsed: true,
        items: [
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Storage format', link: '/STORAGE_FORMAT' },
          { text: 'Query engine', link: '/QUERY_ENGINE' },
          { text: 'Workers & concurrency', link: '/WORKER_MODEL' },
          { text: 'Performance', link: '/PERFORMANCE' },
          { text: 'Testing', link: '/TESTING' },
          { text: 'Roadmap', link: '/ROADMAP' },
          { text: 'Open questions', link: '/OPEN_QUESTIONS' },
          { text: 'Design notes: API', link: '/API' },
          { text: 'Design notes: SQL dialect', link: '/SQL_DIALECT' },
        ],
      },
      {
        text: 'Decisions',
        collapsed: true,
        items: [
          { text: 'All ADRs', link: '/adr/' },
          { text: '0001 Initial design', link: '/adr/0001-initial-design-decisions' },
          { text: '0002 Second round', link: '/adr/0002-second-round-decisions' },
          { text: '0003 Executor & transactions', link: '/adr/0003-m1-executor-and-transactions' },
          { text: '0004 WAL & crash safety', link: '/adr/0004-wal-and-crash-safety' },
          { text: '0005 Cost-based optimizer', link: '/adr/0005-cost-based-optimizer' },
          { text: '0006 Compact index keys', link: '/adr/0006-compact-index-keys-and-in-memory-mode' },
          { text: '0007 Compact cells', link: '/adr/0007-compact-cells-and-free-blocks' },
          { text: '0008 Materialized views & columnar', link: '/adr/0008-materialized-views-and-columnar-segments' },
          { text: '0009 Concurrency', link: '/adr/0009-concurrency' },
          { text: '0010 Analytics & mixed storage', link: '/adr/0010-analytics-and-mixed-storage' },
          { text: '0011 External tables', link: '/adr/0011-external-tables' },
          { text: '0012 Plugins', link: '/adr/0012-plugins' },
          { text: '0013 Plugin API v1', link: '/adr/0013-plugin-api-v1' },
          { text: '0014 Shared plan layer (proposed)', link: '/adr/0014-shared-plan-layer' },
          { text: '0015 smaltql and the language API', link: '/adr/0015-smaltql' },
          { text: '0016 Plan API for every language', link: '/adr/0016-plan-api-for-every-language' },
          { text: '0017 Remaining SQL dependencies', link: '/adr/0017-remaining-sql-dependencies' },
          { text: '0018 bool and NaN', link: '/adr/0018-bool-and-nan' },
          { text: '0019 Dates and times', link: '/adr/0019-dates-and-times' },
          { text: '0020 Lists and structs', link: '/adr/0020-lists-and-structs' },
          { text: '0021 Parallel readers everywhere', link: '/adr/0021-parallel-readers-everywhere' },
          { text: '0022 SQL for the new engine features', link: '/adr/0022-sql-for-the-new-engine-features' },
          { text: '0028 Pluggable storage engines (deferred)', link: '/adr/0028-pluggable-storage-engines' },
          { text: '0033 Property graphs and history', link: '/adr/0033-property-graphs-and-history' },
          { text: '0036 User-defined functions', link: '/adr/0036-user-defined-functions' },
          { text: '0038 A map type', link: '/adr/0038-map-type' },
          { text: '0039 Typed values under any', link: '/adr/0039-typed-values-under-any' },
          { text: '0040 A graph index and relationships', link: '/adr/0040-graph-index-and-relationships' },
          { text: '0041 Properties in the graph index', link: '/adr/0041-properties-in-the-graph-index' },
          { text: '0042 A graph\'s writes (proposed)', link: '/adr/0042-graph-writes' },
        ],
      },
      {
        text: 'Benchmarks',
        collapsed: true,
        items: [
          { text: 'Benchmark methodology', link: '/research/benchmark-methodology' },
          { text: 'Engine timings (2026-11)', link: '/research/benchmark-2026-11-04' },
          { text: 'M0 baseline', link: '/research/m0-baseline' },
          { text: 'M1 baseline', link: '/research/m1-baseline' },
          { text: 'M3 optimizer', link: '/research/m3-optimizer' },
          { text: 'M4 performance', link: '/research/m4-performance' },
          { text: 'Index engine work', link: '/research/index-engine-work' },
          { text: 'M5 materialized views', link: '/research/m5-materialized-views' },
          { text: 'Result row shape', link: '/research/result-shape-benchmark' },
          { text: 'M9 parallel readers', link: '/research/m9-parallel-readers' },
        ],
      },
      {
        text: 'Research',
        collapsed: true,
        items: [
          { text: 'M7 code review', link: '/research/m7-code-review' },
          { text: 'M8 external tables', link: '/research/m8-external-tables' },
          { text: 'Columnar vs. MVs', link: '/research/columnar-mv-assessment' },
          { text: 'Vectorization review', link: '/research/vectorization-review' },
          { text: 'sqllogictest', link: '/research/sqllogictest' },
          { text: 'Plan layer implementation', link: '/research/plan-layer-implementation' },
          { text: 'Graphs on the plan API', link: '/research/graph-on-plans' },
          { text: 'Pluggable storage engines', link: '/research/pluggable-engines' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: smaltworksFooter('/'),
  },
})
