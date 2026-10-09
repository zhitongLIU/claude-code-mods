// The page's local server, run by the mod as a child process (a mod cannot listen on a socket). It serves the
// page on 127.0.0.1 behind a random token and turns each POST into one JSON line on stdout, which the mod reads:
//   POST /<token>/send   { text }  → { send }    a prompt for this Claude session
//   POST /<token>/add    { text }  → { add }     keys, links or paths to put on the map
//   POST /<token>/remove { id }    → { remove }  a ticket to take off the map
//   POST /<token>/refresh { id }   → { refresh } "all" or one key, to read again from Obeya
//   POST /<token>/move   { text }  → { move }"KEY x y" where a box was dropped, "KEY reset" or "* reset"
// Usage: node server.mjs <page dir> <preferred port>
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const dir = process.argv[2]
let want = Number(process.argv[3]) || 0
const token = crypto.randomBytes(6).toString('hex')
const TYPES = { 'index.html': 'text/html; charset=utf-8', 'data.js': 'text/javascript; charset=utf-8' }
const MAX = 400000
const FIELDS = { send: 'text', add: 'text', remove: 'id', move: 'text', refresh: 'id' }

const out = o => process.stdout.write(JSON.stringify(o) + '\n')
process.stdout.on('error', () => process.exit(0))

const server = http.createServer((req, res) => {
  const parts = (req.url || '').split('?')[0].split('/')
  const port = server.address().port
  const local = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}` // a page under another name never gets in
  if (!local || parts.length !== 3 || parts[1] !== token) {
    res.writeHead(404)
    return res.end()
  }
  const name = parts[2] || 'index.html'
  if (req.method === 'POST' && FIELDS[name]) {
    let body = ''
    req.on('data', c => {
      body += c
      if (body.length > MAX) {
        res.writeHead(413)
        res.end()
        req.destroy()
      }
    })
    req.on('end', () => {
      let value
      try {
        value = JSON.parse(body)[FIELDS[name]]
      } catch {}
      if (typeof value !== 'string' || !value.trim()) {
        res.writeHead(400)
        return res.end()
      }
      out({ [name]: value })
      res.writeHead(204)
      res.end()
    })
    return
  }
  if (req.method === 'GET' && TYPES[name]) {
    fs.readFile(path.join(dir, name), (err, buf) => {
      if (err) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'content-type': TYPES[name], 'cache-control': 'no-store' })
      res.end(buf)
    })
    return
  }
  res.writeHead(404)
  res.end()
})

function ready() {
  out({ ready: true, port: server.address().port, token })
  setInterval(() => out({ beat: 1 }), 1000) // the mod stops the server by leaving its read loop
}
// The port the session had last time keeps the page's origin, so what the page keeps in localStorage survives.
server.on('error', err => {
  if (want && err.code === 'EADDRINUSE') {
    want = 0
    server.listen(0, '127.0.0.1', ready)
  } else {
    console.error(String(err))
    process.exit(1)
  }
})
server.listen(want, '127.0.0.1', ready)
