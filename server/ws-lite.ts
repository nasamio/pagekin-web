import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface LiteWebSocket {
  readyState: number
  send: (text: string) => void
  onMessage: (cb: (text: string) => void) => void
  onClose: (cb: () => void) => void
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

export function upgradeWebSocket(req: IncomingMessage, socket: Duplex): LiteWebSocket | null {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || !key) return null

  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  let buffer = Buffer.alloc(0)
  let fragments: Buffer[] = []
  let closed = false
  const messageCbs: Array<(text: string) => void> = []
  const closeCbs: Array<() => void> = []

  const client: LiteWebSocket = {
    get readyState() {
      return closed || socket.destroyed ? 3 : 1
    },
    send(text: string) {
      if (closed || socket.destroyed) return
      socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')))
    },
    onMessage(cb) {
      messageCbs.push(cb)
    },
    onClose(cb) {
      closeCbs.push(cb)
    },
  }

  const cleanup = () => {
    if (closed) return
    closed = true
    for (const cb of closeCbs) cb()
  }

  socket.on('close', cleanup)
  socket.on('error', cleanup)

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 2) {
      const b0 = buffer[0]!
      const b1 = buffer[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f
      let offset = 2
      if (payloadLen === 126) {
        if (buffer.length < 4) return
        payloadLen = buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return
        payloadLen = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      if (buffer.length < offset + maskLen + payloadLen) return

      const mask = masked ? buffer.subarray(offset, offset + 4) : null
      offset += maskLen
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen))
      buffer = buffer.subarray(offset + payloadLen)

      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ mask[i % 4]!
        }
      }

      if (opcode === 0x8) {
        socket.end(encodeFrame(0x8, Buffer.alloc(0)))
        cleanup()
        return
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload))
        continue
      }
      if (opcode === 0xa) continue
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload)
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf8')
          fragments = []
          for (const cb of messageCbs) cb(text)
        }
      }
    }
  })

  return client
}
