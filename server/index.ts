import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installElectronShim, shimRuntime } from './electron-shim'
import { upgradeWebSocket, type LiteWebSocket } from './ws-lite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PAGEKIN_PORT || 8095)
const HOST = process.env.PAGEKIN_HOST || '0.0.0.0'
const DATA_DIR = path.resolve(process.env.PAGEKIN_DATA_DIR || '/data/app-data')
const NOVELS_DIR = path.resolve(process.env.PAGEKIN_NOVELS_DIR || '/data/novels')
const UPLOADS_DIR = path.resolve(process.env.PAGEKIN_UPLOADS_DIR || path.join(DATA_DIR, 'uploads'))
const DIST_WEB_DIR = path.resolve(process.env.PAGEKIN_DIST_WEB || path.join(APP_ROOT, 'dist-web'))
const AUTH_PASSWORD = process.env.PAGEKIN_AUTH_PASSWORD ?? ''
const MCP_TOKEN = process.env.PAGEKIN_MCP_TOKEN ?? ''
const RENDERER_URL = `http://127.0.0.1:${PORT}/index.html`

const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }

// 必须在任何 electron/** 模块加载前安装 Electron Shim
installElectronShim({
  dataDir: DATA_DIR,
  novelsDir: NOVELS_DIR,
  uploadsDir: UPLOADS_DIR,
  rendererUrl: RENDERER_URL,
  appVersion: pkg.version,
  appRoot: APP_ROOT,
})

const COOKIE_NAME = 'pagekin_session'
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
}

function safeEqualText(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function getSessionSecret(): Buffer {
  const file = path.join(DATA_DIR, '.session.key')
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  }
  const key = randomBytes(32)
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 })
  return key
}

function issueAuthCookieValue(): string {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000
  const payload = `${exp}.${randomBytes(8).toString('hex')}`
  const sig = createHmac('sha256', getSessionSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function verifyAuthCookie(req: http.IncomingMessage): boolean {
  if (!AUTH_PASSWORD) return true
  const cookieHeader = req.headers.cookie || ''
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k !== COOKIE_NAME) continue
    const val = decodeURIComponent(rest.join('='))
    const segments = val.split('.')
    if (segments.length !== 3) continue
    const [expStr, nonce, sig] = segments
    const exp = Number(expStr)
    if (!Number.isFinite(exp) || exp < Date.now()) continue
    const expected = createHmac('sha256', getSessionSecret()).update(`${expStr}.${nonce}`).digest('hex')
    if (safeEqualText(sig!, expected)) return true
  }
  return false
}

function verifyMcpAuth(req: http.IncomingMessage, url: URL): boolean {
  if (!MCP_TOKEN) return true
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim()
    if (safeEqualText(token, MCP_TOKEN)) return true
  }
  const queryToken = url.searchParams.get('token')
  if (queryToken && safeEqualText(queryToken, MCP_TOKEN)) return true
  return false
}

function readRequestBody(req: http.IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        req.destroy()
        reject(new Error('PAYLOAD_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

function resolveSafeBrowsePath(inputPath?: string): string {
  const allowedRoots = [NOVELS_DIR, UPLOADS_DIR]
  if (!inputPath) return NOVELS_DIR
  const resolved = path.resolve(inputPath)
  for (const root of allowedRoots) {
    const rel = path.relative(root, resolved)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return resolved
  }
  throw new Error('PATH_OUTSIDE_ALLOWED_ROOTS')
}

async function bootstrapBackend(): Promise<void> {
  const [
    { ipcMain },
    { registerIPCHandlers },
    { registerMCPHandlers },
    { registerStartupController },
    { installIpcSlowCallLog },
    { runGlobalDataMigration, activateGlobalData },
    { ensureVelaHome },
    { applySavedNetworkProxy },
    { registerWebPendingAndProjectHelpers },
    { handleMcpHttpRequest },
  ] = await Promise.all([
    import('electron'),
    import('../electron/ipc-handlers'),
    import('../electron/mcp/mcp-ipc-bridge'),
    import('../electron/controllers/startup-controller'),
    import('../electron/services/ipc-slow-call-log'),
    import('../electron/services/global-data-migration'),
    import('../electron/utils/config-utils'),
    import('../electron/network-proxy'),
    import('./pending-annotations'),
    import('./mcp-server'),
  ])

  const migrated = runGlobalDataMigration({
    userData: shimRuntime.paths.get('userData')!,
    canonicalTarget: path.join(DATA_DIR, 'canonical'),
    legacySource: path.join(DATA_DIR, 'legacy-unused'),
    exclusiveAccess: true,
  })
  if (migrated.state !== 'ready') {
    throw new Error(`Global data migration blocked: ${migrated.state} (${migrated.code})`)
  }
  activateGlobalData(migrated)
  ensureVelaHome()

  installIpcSlowCallLog(ipcMain)
  registerStartupController({
    ipc: ipcMain,
    getTrustedSender: () => shimRuntime.virtualWebContents as never,
    rendererUrl: RENDERER_URL,
    getGlobalGeneration: () => migrated.globalGeneration,
    getBlockedCode: () => undefined,
    getMigrationNotice: () => ({
      legacySourceIgnored: migrated.legacySourceIgnored,
      preservedUnknownCount: migrated.preservedUnknownCount,
    }),
  })

  applySavedNetworkProxy()
  registerIPCHandlers()
  registerMCPHandlers()
  registerWebPendingAndProjectHelpers()

  // 启动时自动把 /data/novels 下已有书童作品加入最近项目列表，打开网页书房即可一键进入
  try {
    const { discoverProjectsInNovelsDir } = await import('./pending-annotations')
    const { registerRecentProject } = await import('../electron/controllers/project-controller')
    for (const item of discoverProjectsInNovelsDir(NOVELS_DIR)) {
      registerRecentProject({
        name: item.name,
        path: item.path,
        projectId: item.projectId,
        updatedAt: item.updatedAt,
      })
    }
  } catch (err) {
    console.warn('[Pagekin Web] 自动发现小说目录失败:', err)
  }

  // 为桌面更新模块提供 Web 模式安全占位，避免前端查询报错
  const idleUpdateState = {
    status: 'idle',
    currentVersion: pkg.version,
    action: 'open-release',
    canRetry: false,
  }
  ipcMain.handle('update:get-state', () => idleUpdateState)
  ipcMain.handle('update:check', () => ({ ok: true, state: idleUpdateState }))
  ipcMain.handle('update:download', () => ({ ok: false }))
  ipcMain.handle('update:open-release', () => ({ ok: false }))
  ipcMain.handle('update:defer-reminder', () => ({ ok: true }))
  ipcMain.handle('update:quit-and-install', () => ({ ok: false }))

  const wsClients = new Set<LiteWebSocket>()
  const pendingDialogs = new Map<string, {
    resolve: (value: unknown) => void
    timer: NodeJS.Timeout
  }>()

  shimRuntime.broadcast = (channel, args) => {
    const packet = JSON.stringify({ type: 'event', channel, args })
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(packet)
      }
    }
  }

  shimRuntime.dialogHandler = async (kind, options) => {
    const active = [...wsClients].find(c => c.readyState === 1)
    if (!active) {
      if (kind === 'message') return { response: 1, checkboxChecked: false }
      return kind === 'open' ? { canceled: true, filePaths: [] } : { canceled: true, filePath: undefined }
    }
    const requestId = randomBytes(8).toString('hex')
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        pendingDialogs.delete(requestId)
        if (kind === 'message') resolve({ response: 0, checkboxChecked: false })
        else resolve(kind === 'open' ? { canceled: true, filePaths: [] } : { canceled: true, filePath: undefined })
      }, 180_000)
      pendingDialogs.set(requestId, { resolve, timer })
      active.send(JSON.stringify({
        type: 'event',
        channel: 'web:dialog-request',
        args: [{ requestId, kind, options, defaultRoot: NOVELS_DIR, uploadsDir: UPLOADS_DIR }],
      }))
    })
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

      if (url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, version: pkg.version })
        return
      }

      if (url.pathname === '/api/auth/status') {
        sendJson(res, 200, {
          authRequired: Boolean(AUTH_PASSWORD),
          authenticated: verifyAuthCookie(req),
          novelsDir: NOVELS_DIR,
          uploadsDir: UPLOADS_DIR,
        })
        return
      }

      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const raw = (await readRequestBody(req, 16 * 1024)).toString('utf8')
        const body = JSON.parse(raw || '{}') as { password?: string }
        if (AUTH_PASSWORD && !safeEqualText(String(body.password ?? ''), AUTH_PASSWORD)) {
          sendJson(res, 401, { ok: false, error: '密码错误' })
          return
        }
        const cookieVal = issueAuthCookieValue()
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(cookieVal)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
        })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      if (url.pathname === '/mcp') {
        if (!verifyMcpAuth(req, url)) {
          sendJson(res, 401, { error: 'UNAUTHORIZED_MCP' })
          return
        }
        const raw = (await readRequestBody(req, 8 * 1024 * 1024)).toString('utf8')
        await handleMcpHttpRequest(req, res, raw)
        return
      }

      if (url.pathname === '/api/ipc' && req.method === 'POST') {
        if (!verifyAuthCookie(req)) {
          sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })
          return
        }
        const raw = (await readRequestBody(req, 32 * 1024 * 1024)).toString('utf8')
        const { channel, args = [] } = JSON.parse(raw || '{}') as { channel: string; args?: unknown[] }
        try {
          const result = await shimRuntime.invokeIpc(channel, Array.isArray(args) ? args : [])
          sendJson(res, 200, { ok: true, result })
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }

      if (url.pathname === '/api/files/list' && req.method === 'GET') {
        if (!verifyAuthCookie(req)) {
          sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })
          return
        }
        const dir = resolveSafeBrowsePath(url.searchParams.get('dir') || undefined)
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.'))
          .map(e => ({
            name: e.name,
            path: path.join(dir, e.name),
            isDirectory: e.isDirectory(),
            hasProject: e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.ai-novel', 'project.db')),
          }))
          .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-CN'))
        sendJson(res, 200, {
          ok: true,
          dir,
          parentDir: dir === NOVELS_DIR || dir === UPLOADS_DIR ? null : path.dirname(dir),
          novelsDir: NOVELS_DIR,
          uploadsDir: UPLOADS_DIR,
          entries,
        })
        return
      }

      if (url.pathname === '/api/files/mkdir' && req.method === 'POST') {
        if (!verifyAuthCookie(req)) {
          sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })
          return
        }
        const raw = (await readRequestBody(req, 16 * 1024)).toString('utf8')
        const { parentDir, name } = JSON.parse(raw || '{}') as { parentDir?: string; name?: string }
        const safeName = String(name ?? '').trim().replace(/[\\/:*?"<>|]/g, '')
        if (!safeName || safeName === '.' || safeName === '..') {
          sendJson(res, 400, { ok: false, error: '目录名不合法' })
          return
        }
        const base = resolveSafeBrowsePath(parentDir)
        const created = path.join(base, safeName)
        fs.mkdirSync(created, { recursive: true })
        sendJson(res, 200, { ok: true, path: created })
        return
      }

      if (url.pathname === '/api/files/upload' && req.method === 'POST') {
        if (!verifyAuthCookie(req)) {
          sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })
          return
        }
        const filename = path.basename(decodeURIComponent(url.searchParams.get('filename') || `upload-${Date.now()}.txt`))
        const buf = await readRequestBody(req, 64 * 1024 * 1024)
        const target = path.join(UPLOADS_DIR, `${Date.now()}-${filename}`)
        fs.writeFileSync(target, buf)
        sendJson(res, 200, { ok: true, path: target, filename })
        return
      }

      if (url.pathname === '/api/web-dialog/resolve' && req.method === 'POST') {
        if (!verifyAuthCookie(req)) {
          sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' })
          return
        }
        const raw = (await readRequestBody(req, 64 * 1024)).toString('utf8')
        const { requestId, result } = JSON.parse(raw || '{}') as { requestId: string; result: unknown }
        const pending = pendingDialogs.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingDialogs.delete(requestId)
          pending.resolve(result)
        }
        sendJson(res, 200, { ok: true })
        return
      }

      // 静态前端资源托管
      let filePath = path.join(DIST_WEB_DIR, url.pathname === '/' ? 'index.html' : url.pathname)
      if (!filePath.startsWith(DIST_WEB_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(DIST_WEB_DIR, 'index.html')
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Frontend dist-web not built yet.')
        return
      }
      const ext = path.extname(filePath).toLowerCase()
      const content = fs.readFileSync(filePath)
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': String(content.length),
      })
      res.end(content)
    } catch (err) {
      console.error('[Pagekin Web] HTTP error:', err)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'INTERNAL_SERVER_ERROR' })
    }
  })

  server.on('upgrade', (req, socket, _head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    if (url.pathname !== '/ws/ipc' || !verifyAuthCookie(req)) {
      socket.destroy()
      return
    }
    const ws = upgradeWebSocket(req, socket)
    if (!ws) {
      socket.destroy()
      return
    }
    wsClients.add(ws)
    ws.onMessage(raw => {
      try {
        const msg = JSON.parse(raw) as { type?: string; channel?: string; args?: unknown[] }
        if (msg.type === 'send' && typeof msg.channel === 'string') {
          shimRuntime.sendIpc(msg.channel, Array.isArray(msg.args) ? msg.args : [])
        }
      } catch { /* ignore malformed ws frame */ }
    })
    ws.onClose(() => wsClients.delete(ws))
  })

  server.listen(PORT, HOST, () => {
    console.log(`[Pagekin Web] Server listening on http://${HOST}:${PORT} (novels: ${NOVELS_DIR}, mcp: /mcp)`)
  })
}

void bootstrapBackend().catch(err => {
  console.error('[Pagekin Web] Fatal startup error:', err)
  process.exit(1)
})
