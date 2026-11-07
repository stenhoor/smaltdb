// The smaltworks menu and footer every smalt product site shares (BRAND.md, "Sites and READMEs"). Used from
// .vitepress/config.ts; the stage badge is in stage.ts. Copy both files unchanged: see README.md.
const WORKS = 'https://smaltworks.dev'

/** The family's sites, in the order and wording smaltworks.dev uses. */
export const FAMILY = [
  { text: 'smaltdb · the engine', link: 'https://smaltdb.dev/' },
  { text: 'smaltql · SQL', link: 'https://stenhoor.github.io/smaltql/' },
  { text: 'smaltdf · dataframes', link: 'https://stenhoor.github.io/smaltdf/' },
  { text: 'smaltts · typed API', link: `${WORKS}/products/smaltts` },
  { text: 'smaltui · SQL console', link: 'https://stenhoor.github.io/smaltui/' },
  { text: 'smaltbi · reports', link: 'https://stenhoor.github.io/smaltbi/' },
  { text: 'smaltnb · notebooks', link: 'https://stenhoor.github.io/smaltnb/' },
]

/** The last item of every product site's top nav. */
export function smaltworksMenu() {
  return {
    text: 'smaltworks',
    items: [
      { text: 'The family', link: `${WORKS}/` },
      ...FAMILY,
      { text: 'Work in progress', link: `${WORKS}/stability` },
    ],
  }
}

/** The footer of every product site. `base` is the site's VitePress base ('/' or '/smaltql/'). */
export function smaltworksFooter(base = '/') {
  const img = (file: string, cls: string) =>
    `<img class="${cls}" src="${base}${file}" alt="A smaltworks project" height="28">`
  return {
    message: `<a href="${WORKS}/">${img('a-smaltworks-project.svg', 'sw-light')}${img('a-smaltworks-project-on-dark.svg', 'sw-dark')}</a>`,
    copyright: 'MIT License',
  }
}
