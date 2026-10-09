// Language adapters: how the code map links files in each language.
// An adapter says, for one family of file extensions,
//   links   · what a file's text points at: relative file imports (resolved to paths, extension
//             stripped) and the names it mentions (classes, modules)
//   defines · the names a file is known to define, from its path alone
// map.ts turns imports into arrows between the files, and a mentioned name that another touched
// file defines into one more arrow. To support a language, add an adapter to ADAPTERS.

export type Links = { imports: string[]; names: string[] }

export type Lang = {
  name: string
  ext: RegExp
  links(path: string, text: string): Links
  defines(path: string): string[]
}

export const stripExt = (p: string) => p.replace(/\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|vue|svelte)$/, '').replace(/\/index$/, '')

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

function join(dir: string, rel: string) {
  const parts = dir.split('/')
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

const NONE: string[] = []
const MAX_NAMES = 400

const javascript: Lang = {
  name: 'js',
  ext: /\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/i,
  links(path, text) {
    const found = new Set<string>()
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g
    for (const m of text.matchAll(re)) found.add(stripExt(join(dirOf(path), m[1] as string)))
    return { imports: [...found], names: NONE }
  },
  defines: () => NONE,
}

const python: Lang = {
  name: 'py',
  ext: /\.py$/i,
  links(path, text) {
    const found = new Set<string>()
    const re = /^\s*from\s+(\.+)([\w.]*)\s+import/gm
    for (const m of text.matchAll(re)) {
      let base = dirOf(path)
      for (let i = 0; i < (m[1] as string).length - 1; i++) base = base.slice(0, base.lastIndexOf('/'))
      if (m[2]) found.add(`${base}/${(m[2] as string).replace(/\./g, '/')}`)
    }
    return { imports: [...found], names: NONE }
  },
  defines: () => NONE,
}

// Rails loads code by constant name, not by import: a file links to another when it mentions
// the class or module that the other one is named after (request_chorus_otp.rb: RequestChorusOtp).
const RUBY_TOO_COMMON = new Set(['Base', 'Error', 'Config', 'Test', 'Spec', 'Main', 'Helper', 'Concern', 'Module', 'Class', 'Object', 'Result', 'Struct'])
const camelize = (s: string) => s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')

const ruby: Lang = {
  name: 'rb',
  ext: /\.rb$/i,
  links(path, text) {
    const code = text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    const imports = new Set<string>()
    for (const m of code.matchAll(/\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g)) imports.add(stripExt(join(dirOf(path), m[1] as string)))
    for (const m of code.matchAll(/\brequire\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) imports.add(stripExt(join(dirOf(path), m[1] as string)))
    const names = new Set<string>()
    for (const m of code.matchAll(/\b[A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*/g)) {
      for (const seg of m[0].split('::')) names.add(seg)
      if (names.size >= MAX_NAMES) break
    }
    return { imports: [...imports], names: [...names] }
  },
  defines(path) {
    const name = camelize((path.split('/').pop() ?? '').replace(/\.rb$/i, ''))
    return name.length < 4 || RUBY_TOO_COMMON.has(name) ? NONE : [name]
  },
}

export const ADAPTERS: Lang[] = [javascript, python, ruby]

export const langFor = (path: string) => ADAPTERS.find(l => l.ext.test(path))

export function linksOf(path: string, text: string): Links {
  return langFor(path)?.links(path, text) ?? { imports: NONE, names: NONE }
}
