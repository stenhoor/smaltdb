import { defineConfig } from 'vitepress'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { smaltLight, smaltDark } from './theme/shiki'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'https://github.com/stenhoor/smaltdb'

export default defineConfig({
  title: 'smaltdb',
  description: 'A fast alternative database for the browser, written in TypeScript.',
  base: '/smaltdb/',
  cleanUrls: true,
  srcExclude: ['brand/**'],
  // adr/README.md is the folder's landing page on GitHub; publish it at /adr/ too.
  rewrites: { 'adr/README.md': 'adr/index.md' },
  lastUpdated: false,
  // docs/brand holds the logo files; serve them from the site root.
  vite: { publicDir: path.resolve(here, '../brand') },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/smaltdb/favicon-32.svg' }],
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
      { text: 'Guide', link: '/API' },
      { text: 'Decisions', link: '/adr/' },
      { text: 'Research', link: '/research/benchmark-methodology' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Public API', link: '/API' },
          { text: 'SQL dialect', link: '/SQL_DIALECT' },
          { text: 'Architecture', link: '/ARCHITECTURE' },
          { text: 'Storage format', link: '/STORAGE_FORMAT' },
          { text: 'Query engine', link: '/QUERY_ENGINE' },
          { text: 'Workers & concurrency', link: '/WORKER_MODEL' },
          { text: 'Performance', link: '/PERFORMANCE' },
          { text: 'Testing', link: '/TESTING' },
          { text: 'Roadmap', link: '/ROADMAP' },
          { text: 'Open questions', link: '/OPEN_QUESTIONS' },
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
        ],
      },
      {
        text: 'Research',
        collapsed: true,
        items: [
          { text: 'Benchmark methodology', link: '/research/benchmark-methodology' },
          { text: 'M0 baseline', link: '/research/m0-baseline' },
          { text: 'M1 baseline', link: '/research/m1-baseline' },
          { text: 'M3 optimizer', link: '/research/m3-optimizer' },
          { text: 'M4 performance', link: '/research/m4-performance' },
          { text: 'Index engine work', link: '/research/index-engine-work' },
          { text: 'M5 materialized views', link: '/research/m5-materialized-views' },
          { text: 'Result row shape', link: '/research/result-shape-benchmark' },
          { text: 'Columnar vs. MVs', link: '/research/columnar-mv-assessment' },
          { text: 'Vectorization review', link: '/research/vectorization-review' },
          { text: 'sqllogictest', link: '/research/sqllogictest' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    footer: { message: 'MIT License', copyright: 'smaltdb' },
  },
})
