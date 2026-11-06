import { inBrowser } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './smaltdb.css'

/**
 * The SQL guide and references moved to smaltql's site (ADR 0015). GitHub Pages can't redirect on the server, so old
 * links land on this site's 404 page and are sent on here to the same page on smaltql's site.
 */
const SMALTQL = 'https://stenhoor.github.io/smaltql'
const MOVED = /^\/(guide\/|reference\/sql(\/|$)|reference\/functions(\/|$)|reference\/api\/client(\.html)?$|examples\/)/

export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (inBrowser && MOVED.test(location.pathname)) {
      location.replace(SMALTQL + location.pathname + location.search + location.hash)
    }
  },
} satisfies Theme
