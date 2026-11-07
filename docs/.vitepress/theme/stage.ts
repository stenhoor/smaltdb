// The badges every smalt product site shows (BRAND.md, "Sites and READMEs"): the stage badge under the hero's text on
// the home page and at the top of every other page, linked to smaltworks.dev/stability; and "A smaltworks project" at
// the foot of every page with a sidebar, where VitePress hides its own footer. Used from .vitepress/theme/index.ts.
import { h } from 'vue'
import { withBase } from 'vitepress'

const STAGES = {
  wip: { file: 'work-in-progress', alt: 'Work in progress. Come build with us.' },
  release: { file: 'release-1x', alt: 'Release 1.x. Come build with us.' },
} as const

const WORKS = 'https://smaltworks.dev'

/** The site's Layout, with the smalt badges in place. Switch `stage` to 'release' when the product reaches 1.0. */
export function withSmaltworks(DefaultTheme: { Layout: any }, stage: keyof typeof STAGES = 'wip') {
  const { file, alt } = STAGES[stage]
  const badge = () =>
    h('div', { class: 'sw-stage' }, [
      h('a', { href: `${WORKS}/stability` }, [
        h('img', { class: 'sw-light', src: withBase(`/${file}.svg`), alt, height: 56 }),
        h('img', { class: 'sw-dark', src: withBase(`/${file}-on-dark.svg`), alt, height: 56 }),
      ]),
    ])
  const project = () =>
    h('div', { class: 'sw-project' }, [
      h('a', { href: `${WORKS}/` }, [
        h('img', { class: 'sw-light', src: withBase('/a-smaltworks-project.svg'), alt: 'A smaltworks project', height: 28 }),
        h('img', { class: 'sw-dark', src: withBase('/a-smaltworks-project-on-dark.svg'), alt: 'A smaltworks project', height: 28 }),
      ]),
      h('span', null, 'MIT License'),
    ])
  return () =>
    h(DefaultTheme.Layout, null, { 'home-hero-info-after': badge, 'doc-before': badge, 'doc-footer-before': project })
}
