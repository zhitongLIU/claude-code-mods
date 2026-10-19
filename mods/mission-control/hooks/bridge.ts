// The way back from the page to the session. The mod cannot listen on a socket, so it runs this small Node
// server as a child process (`$.process.spawn`). It serves the page on 127.0.0.1 and turns each POST /<token>/send
// into one JSON line on stdout, which register.tsx reads and submits as a prompt. Where Node is missing or the
// server fails, the page is opened from disk and keeps its clipboard buttons.
// Keep SERVER free of backticks, dollar-brace sequences and backslashes: it is one template literal.

export const SERVER = `import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

var dir = process.argv[2]
var want = Number(process.argv[3]) || 0
var token = crypto.randomBytes(16).toString('hex')
var NL = String.fromCharCode(10)
var TYPES = { 'index.html': 'text/html; charset=utf-8', 'data.js': 'text/javascript; charset=utf-8', 'diffs.js': 'text/javascript; charset=utf-8', 'hljs.js': 'text/javascript; charset=utf-8' }
var MAX = 400000

function out(o) { process.stdout.write(JSON.stringify(o) + NL) }
process.stdout.on('error', function () { process.exit(0) })

var server = http.createServer(function (req, res) {
  var parts = (req.url || '').split('?')[0].split('/')
  var local = req.headers.host === '127.0.0.1:' + server.address().port
  if (!local || parts.length !== 3 || parts[1] !== token) { res.writeHead(404); return res.end() }
  var name = parts[2]
  if (req.method === 'POST' && name === 'send') {
    var body = ''
    req.on('data', function (c) { body += c; if (body.length > MAX) { res.writeHead(413); res.end(); req.destroy() } })
    req.on('end', function () {
      var text
      try { text = JSON.parse(body).text } catch (err) {}
      if (typeof text !== 'string' || !text.trim()) { res.writeHead(400); return res.end() }
      out({ send: text })
      res.writeHead(204); res.end()
    })
    return
  }
  if (req.method === 'GET' && TYPES[name]) {
    fs.readFile(path.join(dir, name), function (err, buf) {
      if (err) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': TYPES[name], 'cache-control': 'no-store' })
      res.end(buf)
    })
    return
  }
  res.writeHead(404); res.end()
})

function ready() {
  out({ ready: true, port: server.address().port, token: token })
  setInterval(function () { out({ beat: 1 }) }, 1000) // the mod stops a server by leaving its read loop
}
// The port a session had last time keeps the page's origin, so the comments saved in its localStorage survive.
server.on('error', function (err) { if (want && err.code === 'EADDRINUSE') { want = 0; server.listen(0, '127.0.0.1', ready) } else { console.error(String(err)); process.exit(1) } })
server.listen(want, '127.0.0.1', ready)
`

export type BridgeLine = { ready: true; port: number; token: string } | { send: string } | { beat: true }

// What a line of the server's stdout says, or undefined for anything else.
export function parseLine(line: string): BridgeLine | undefined {
  try {
    const v = JSON.parse(line) as Record<string, unknown>
    if (v.ready === true && typeof v.port === 'number' && typeof v.token === 'string' && /^\w+$/.test(v.token)) return { ready: true, port: v.port, token: v.token }
    if (typeof v.send === 'string') return { send: v.send }
    if (v.beat === 1) return { beat: true }
  } catch {
    // not ours: ignore
  }
  return undefined
}

// Pieces of stdout arrive cut anywhere; the whole lines so far, and what is left of the last one.
export function splitLines(rest: string, text: string): { done: string[]; rest: string } {
  const parts = (rest + text).split('\n')
  return { done: parts.slice(0, -1).filter(l => l.trim() !== ''), rest: parts[parts.length - 1] ?? '' }
}

// A port in 20000-59999 taken from the session id, the same every time.
export function portFor(sid: string): number {
  let h = 7
  for (const c of sid) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0
  return 20000 + (h % 40000)
}
