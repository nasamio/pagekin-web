import type { AiNovelAPI } from '../shared/desktop-api'

type EventListener = (...args: unknown[]) => void

const listeners = new Map<string, Set<EventListener>>()
let ws: WebSocket | null = null
let reconnectTimer: number | null = null
let zoomLevel = 0

function emitLocal(channel: string, args: unknown[]): void {
  const set = listeners.get(channel)
  if (!set) return
  for (const fn of [...set]) {
    try {
      fn(...args)
    } catch (err) {
      console.error(`[WebPreload] listener error on ${channel}:`, err)
    }
  }
}

export function connectWebIpcSocket(): void {
  if (typeof window === 'undefined') return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${proto}//${window.location.host}/ws/ipc`)
  ws = socket

  socket.onmessage = ev => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type?: string; channel?: string; args?: unknown[] }
      if (msg.type === 'event' && typeof msg.channel === 'string') {
        emitLocal(msg.channel, Array.isArray(msg.args) ? msg.args : [])
      }
    } catch { /* ignore malformed ws frame */ }
  }

  socket.onclose = () => {
    if (ws === socket) ws = null
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connectWebIpcSocket()
    }, 2000)
  }
}

export function installWebPreload(): boolean {
  if (typeof window === 'undefined') return false
  if (window.aiNovelAPI) return false

  const api: AiNovelAPI = {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const res = await fetch('/api/ipc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ channel, args }),
      })
      if (res.status === 401) {
        emitLocal('web:auth-required', [])
        throw new Error('UNAUTHORIZED')
      }
      const data = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
      if (!data.ok) {
        throw new Error(data.error || `IPC failed: ${channel}`)
      }
      return data.result
    },

    on(channel: string, callback: EventListener) {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(callback)
      return () => {
        set?.delete(callback)
      }
    },

    once(channel: string, callback: EventListener) {
      const off = api.on(channel, (...args: unknown[]) => {
        off()
        callback(...args)
      })
    },

    send(channel: string, ...args: unknown[]) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'send', channel, args }))
      }
    },

    setZoomLevel(level: number) {
      zoomLevel = level
      document.documentElement.style.zoom = String(Math.pow(1.2, level))
    },

    setZoomFactor(factor: number) {
      document.documentElement.style.zoom = String(factor)
    },

    getZoomLevel() {
      return zoomLevel
    },
  }

  window.aiNovelAPI = api
  api.on('web:open-external', (payload: unknown) => {
    const url = (payload as { url?: string } | undefined)?.url
    if (url && /^https?:\/\//i.test(url)) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  })
  return true
}
