import { defineConfig } from 'vitepress'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { smaltLight, smaltDark } from './theme/shiki'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'https://github.com/stenhoor/smaltdb'

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
    },
  },
  themeConfig: {
    logo: { light: '/lockup.svg', dark: '/lockup-on-dark.svg', alt: 'smaltdb' },
    siteTitle: false,
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'SQL', link: '/reference/sql/' },
      { text: 'Functions', link: '/reference/functions/' },
      { text: 'API', link: '/reference/api/client' },
      { text: 'FAQ', link: '/guide/faq' },
      {
        text: 'Internals',
        items: [
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Decisions', link: '/adr/' },
          { text: 'Research', link: '/research/benchmark-methodology' },
        ],
      },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Installation', link: '/guide/getting-started' },
          { text: 'Quick start', link: '/guide/quick-start' },
          { text: 'FAQ', link: '/guide/faq' },
        ],
      },
      {
        text: 'User guide',
        items: [
          { text: 'Databases', link: '/guide/databases' },
          { text: 'Queries', link: '/guide/queries' },
          { text: 'Transactions', link: '/guide/transactions' },
          { text: 'Tables and schema', link: '/guide/schema' },
          { text: 'Indexes and performance', link: '/guide/indexes-and-performance' },
          { text: 'Views and materialized views', link: '/guide/views-and-materialized-views' },
          { text: 'Analytics', link: '/guide/analytics' },
          { text: 'Import and export', link: '/guide/import-export' },
          { text: 'External data', link: '/guide/external-data' },
          { text: 'Plugins', link: '/guide/plugins' },
          { text: 'Introspection', link: '/guide/introspection' },
          { text: 'Errors', link: '/guide/errors' },
          { text: 'Differences from SQLite', link: '/guide/sqlite-differences' },
        ],
      },
      {
        text: 'SQL reference',
        collapsed: true,
        items: [
          { text: 'Overview', link: '/reference/sql/' },
          { text: 'SELECT', link: '/reference/sql/select' },
          { text: 'INSERT', link: '/reference/sql/insert' },
          { text: 'UPDATE', link: '/reference/sql/update' },
          { text: 'DELETE', link: '/reference/sql/delete' },
          { text: 'CREATE TABLE', link: '/reference/sql/create-table' },
          { text: 'ALTER TABLE', link: '/reference/sql/alter-table' },
          { text: 'DROP', link: '/reference/sql/drop' },
          { text: 'CREATE INDEX', link: '/reference/sql/create-index' },
          { text: 'Views', link: '/reference/sql/views' },
          { text: 'External tables', link: '/reference/sql/external' },
          { text: 'Transactions', link: '/reference/sql/transactions' },
          { text: 'EXPLAIN and ANALYZE', link: '/reference/sql/explain' },
          { text: 'PRAGMA', link: '/reference/sql/pragmas' },
          { text: 'Expressions', link: '/reference/sql/expressions' },
          { text: 'Data types', link: '/reference/sql/types' },
          { text: 'information_schema', link: '/reference/sql/information-schema' },
        ],
      },
      {
        text: 'Functions',
        collapsed: true,
        items: [
          { text: 'All functions', link: '/reference/functions/' },
          { text: 'Scalar', link: '/reference/functions/scalar' },
          { text: 'String', link: '/reference/functions/string' },
          { text: 'Math', link: '/reference/functions/math' },
          { text: 'Date and time', link: '/reference/functions/datetime' },
          { text: 'Aggregate', link: '/reference/functions/aggregate' },
          { text: 'Window', link: '/reference/functions/window' },
          { text: 'Table-valued', link: '/reference/functions/table-valued' },
        ],
      },
      {
        text: 'API reference',
        collapsed: true,
        items: [
          { text: 'Client (smaltdb)', link: '/reference/api/client' },
          { text: 'Engine (smaltdb/engine)', link: '/reference/api/engine' },
          { text: 'Writing plugins', link: '/reference/api/plugins' },
          { text: 'Error codes', link: '/reference/api/errors' },
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
        ],
      },
      {
        text: 'Research',
        collapsed: true,
        items: [
          { text: 'Benchmark methodology', link: '/research/benchmark-methodology' },
          { text: 'Against SQLite WASM and native (2026-11)', link: '/research/benchmark-2026-11-04' },
          { text: 'M0 baseline', link: '/research/m0-baseline' },
          { text: 'M1 baseline', link: '/research/m1-baseline' },
          { text: 'M3 optimizer', link: '/research/m3-optimizer' },
          { text: 'M4 performance', link: '/research/m4-performance' },
          { text: 'Index engine work', link: '/research/index-engine-work' },
          { text: 'M5 materialized views', link: '/research/m5-materialized-views' },
          { text: 'M8 external tables', link: '/research/m8-external-tables' },
          { text: 'M7 code review', link: '/research/m7-code-review' },
          { text: 'Result row shape', link: '/research/result-shape-benchmark' },
          { text: 'Columnar vs. MVs', link: '/research/columnar-mv-assessment' },
          { text: 'Vectorization review', link: '/research/vectorization-review' },
          { text: 'sqllogictest', link: '/research/sqllogictest' },
          { text: 'Plan layer implementation', link: '/research/plan-layer-implementation' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: { message: 'MIT License', copyright: 'smaltdb' },
  },
})
