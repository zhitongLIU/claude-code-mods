// Syntax colours for the diff drawer. Runs in the page too (template.ts splices the source in), so it stands alone.
// One line at a time and one broad keyword list for every language: a rough tint, not a parser.

// A line cut into [class, text] pieces: kw, str, com, num or type, '' for the rest.
export function highlight(text: string, ext: string): [string, string][] {
  const e = ext.toLowerCase()
  const hash = ' py rb sh bash zsh yml yaml toml ex exs '.includes(` ${e} `)
  const dash = ' sql lua '.includes(` ${e} `)
  const html = ' html vue svelte xml '.includes(` ${e} `)
  if (' md mdx txt lock '.includes(` ${e} `)) return [['', text]]
  const com = hash ? '#.*' : dash ? '--.*' : html ? '<!--.*?-->' : '\\/\\/.*|\\/\\*.*?\\*\\/'
  // A line inside a /* block (its stars lead the line) is a comment whole.
  if (!hash && !dash && /^\s*(\*|\/\*)/.test(text)) return [['com', text]]
  const re = new RegExp(`(${com})|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b\\d[\\d_.]*\\b)|([A-Za-z_$][\\w$]*)`, 'g')
  const words =
    ' const let var function return if else for while do class import export from default new this async await try catch finally throw switch case break continue typeof instanceof interface type extends implements public private protected static readonly enum def end then elsif elif unless module require fn pub use mut impl struct match func package go defer range yield lambda pass raise except with as in not and or is select where from join on group order by limit insert update delete create table null undefined true false nil self void None True False '
  const out: [string, string][] = []
  let at = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m[0] === '') {
      re.lastIndex++
      continue
    }
    if (m.index > at) out.push(['', text.slice(at, m.index)])
    const cls = m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'num' : words.includes(` ${m[4]} `) ? 'kw' : /^[A-Z]/.test(m[4] as string) ? 'type' : ''
    out.push([cls, m[0]])
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(['', text.slice(at)])
  return out
}
