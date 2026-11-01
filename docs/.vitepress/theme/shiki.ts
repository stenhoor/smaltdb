// Kiln code colours from the smaltdb design system. Every token is >= 5:1 on its code background.
type Colors = { bg: string; fg: string; kw: string; str: string; num: string; fn: string; comment: string; punct: string }

function theme(name: string, type: 'light' | 'dark', c: Colors) {
  return {
    name,
    type,
    colors: { 'editor.background': c.bg, 'editor.foreground': c.fg },
    tokenColors: [
      { settings: { foreground: c.fg } },
      { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.other'], settings: { foreground: c.kw } },
      { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'], settings: { foreground: c.str } },
      { scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'], settings: { foreground: c.num } },
      { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'entity.name.type', 'support.type'], settings: { foreground: c.fn } },
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.comment, fontStyle: 'italic' } },
      { scope: ['punctuation', 'keyword.operator', 'meta.brace'], settings: { foreground: c.punct } },
    ],
  }
}

export const smaltLight = theme('smaltdb-kiln-light', 'light', {
  bg: '#EEF1F6', fg: '#151922', kw: '#003399', str: '#A33A12', num: '#5B3FA8', fn: '#1F5F8B', comment: '#5C6375', punct: '#3F4656',
})

export const smaltDark = theme('smaltdb-kiln-dark', 'dark', {
  bg: '#11141B', fg: '#E9EBF0', kw: '#9DB4F5', str: '#FF8A5C', num: '#D3A6FF', fn: '#7FD1E8', comment: '#9096A3', punct: '#B9BEC9',
})
