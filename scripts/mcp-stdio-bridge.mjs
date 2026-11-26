#!/usr/bin/env node
import http from 'node:http'
import https from 'node:https'
import readline from 'node:readline'

const ENDPOINTS = (
  process.env.PAGEKIN_MCP_URLS
  || 'http://100.73.241.118:8095/mcp,http://10.7.235.2:8095/mcp,http://192.168.31.96:8095/mcp'
).split(',').map(s => s.trim()).filter(Boolean)

const TOKEN = process.env.PAGEKIN_MCP_TOKEN || ''
let activeUrl = null
let sessionId = null

function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
      },
      res => {
        const sid = res.headers['mcp-session-id']
        if (typeof sid === 'string' && sid) sessionId = sid
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')))
    req.on('error', reject)
    req.end(body)
  })
}

async function sendWithFallback(rawLine) {
  const candidates = activeUrl ? [activeUrl, ...ENDPOINTS.filter(u => u !== activeUrl)] : ENDPOINTS
  let lastErr = null
  for (const url of candidates) {
    try {
      const res = await postJson(url, rawLine)
      if (res.status >= 200 && res.status < 300) {
        activeUrl = url
        return res
      }
      lastErr = new Error(`HTTP_${res.status}: ${res.text}`)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error('ALL_ENDPOINTS_FAILED')
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return
  }
  try {
    const res = await sendWithFallback(trimmed)
    if (res.text && res.text.trim()) {
      process.stdout.write(`${res.text.trim()}\n`)
    }
  } catch (err) {
    if (parsed && parsed.id !== undefined && parsed.id !== null) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      })}\n`)
    }
  }
})
