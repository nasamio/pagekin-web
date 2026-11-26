import { EventEmitter } from 'node:events'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'

export interface ShimConfig {
  dataDir: string
  novelsDir: string
  uploadsDir: string
  rendererUrl: string
  appVersion: string
  appRoot: string
}

export type DialogBridgeHandler = (
  kind: 'open' | 'save' | 'message',
  options: Record<string, unknown>,
) => Promise<unknown>

type BroadcastFn = (channel: string, args: unknown[]) => void

export interface VirtualWebContents extends EventEmitter {
  id: number
  mainFrame: { url: string }
  isDestroyed: () => boolean
  isLoadingMainFrame: () => boolean
  send: (channel: string, ...args: unknown[]) => void
  setWindowOpenHandler: (handler: unknown) => void
}

export interface VirtualBrowserWindow extends EventEmitter {
  id: number
  webContents: VirtualWebContents
  isDestroyed: () => boolean
  isMinimized: () => boolean
  isFocused: () => boolean
  isMaximized: () => boolean
  minimize: () => void
  maximize: () => void
  unmaximize: () => void
  close: () => void
  setMenuBarVisibility: (visible: boolean) => void
  loadURL: (url: string) => void
  loadFile: (file: string) => void
}

class ShimRuntime {
  config!: ShimConfig
  broadcast: BroadcastFn = () => {}
  dialogHandler: DialogBridgeHandler | null = null

  readonly ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  readonly ipcEmitter = new EventEmitter()
  readonly appEmitter = new EventEmitter()
  readonly paths = new Map<string, string>()

  virtualWindow!: VirtualBrowserWindow
  virtualWebContents!: VirtualWebContents

  private secretKey: Buffer | null = null

  init(config: ShimConfig): void {
    this.config = config
    fs.mkdirSync(config.dataDir, { recursive: true })
    fs.mkdirSync(config.novelsDir, { recursive: true })
    fs.mkdirSync(config.uploadsDir, { recursive: true })

    this.paths.set('appData', path.join(config.dataDir, 'app-data-parent'))
    this.paths.set('userData', path.join(config.dataDir, 'user-data'))
    this.paths.set('documents', config.novelsDir)
    this.paths.set('home', config.novelsDir)
    this.paths.set('temp', os.tmpdir())
    this.paths.set('logs', path.join(config.dataDir, 'logs'))
    fs.mkdirSync(this.paths.get('appData')!, { recursive: true })
    fs.mkdirSync(this.paths.get('userData')!, { recursive: true })
    fs.mkdirSync(this.paths.get('logs')!, { recursive: true })

    const wc = new EventEmitter() as VirtualWebContents
    wc.id = 1
    wc.mainFrame = { url: config.rendererUrl }
    wc.isDestroyed = () => false
    wc.isLoadingMainFrame = () => false
    wc.setWindowOpenHandler = () => {}
    wc.send = (channel: string, ...args: unknown[]) => {
      this.broadcast(channel, args)
    }

    const win = new EventEmitter() as VirtualBrowserWindow
    win.id = 1
    win.webContents = wc
    win.isDestroyed = () => false
    win.isMinimized = () => false
    win.isFocused = () => true
    win.isMaximized = () => true
    win.minimize = () => {}
    win.maximize = () => {}
    win.unmaximize = () => {}
    win.close = () => {}
    win.setMenuBarVisibility = () => {}
    win.loadURL = () => {}
    win.loadFile = () => {}

    this.virtualWebContents = wc
    this.virtualWindow = win
  }

  getSecretKey(): Buffer {
    if (this.secretKey) return this.secretKey
    const keyPath = path.join(this.config.dataDir, '.secret.key')
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf8').trim()
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        this.secretKey = Buffer.from(hex, 'hex')
        return this.secretKey
      }
    }
    const key = randomBytes(32)
    fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 })
    this.secretKey = key
    return key
  }

  createFakeIpcEvent(): { sender: VirtualWebContents; senderFrame: { url: string } } {
    return {
      sender: this.virtualWebContents,
      senderFrame: this.virtualWebContents.mainFrame,
    }
  }

  async invokeIpc(channel: string, args: unknown[]): Promise<unknown> {
    const handler = this.ipcHandlers.get(channel)
    if (!handler) {
      throw new Error(`IPC_CHANNEL_NOT_FOUND:${channel}`)
    }
    return await handler(this.createFakeIpcEvent(), ...args)
  }

  sendIpc(channel: string, args: unknown[]): void {
    this.ipcEmitter.emit(channel, this.createFakeIpcEvent(), ...args)
  }
}

export const shimRuntime = new ShimRuntime()

function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let offset = 2
  while (offset + 8 < buf.length) {
    if (buf[offset] !== 0xff) break
    const marker = buf[offset + 1]!
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) }
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const segLen = buf.readUInt16BE(offset + 2)
    if (segLen < 2) break
    offset += 2 + segLen
  }
  return null
}

export function createElectronShimModule() {
  const ipcMain = {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
      shimRuntime.ipcHandlers.set(channel, listener)
    },
    removeHandler(channel: string) {
      shimRuntime.ipcHandlers.delete(channel)
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      shimRuntime.ipcEmitter.on(channel, listener)
      return ipcMain
    },
    once(channel: string, listener: (...args: unknown[]) => void) {
      shimRuntime.ipcEmitter.once(channel, listener)
      return ipcMain
    },
    off(channel: string, listener: (...args: unknown[]) => void) {
      shimRuntime.ipcEmitter.off(channel, listener)
      return ipcMain
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void) {
      shimRuntime.ipcEmitter.removeListener(channel, listener)
      return ipcMain
    },
  }

  const app = {
    isPackaged: true,
    getPath(name: string): string {
      return shimRuntime.paths.get(name) ?? shimRuntime.config?.dataDir ?? os.tmpdir()
    },
    setPath(name: string, target: string): void {
      shimRuntime.paths.set(name, target)
    },
    getVersion(): string {
      return shimRuntime.config?.appVersion ?? '1.5.3'
    },
    getAppPath(): string {
      return shimRuntime.config?.appRoot ?? process.cwd()
    },
    getLocale(): string {
      return process.env.PAGEKIN_LOCALE || 'zh-CN'
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      shimRuntime.appEmitter.on(event, listener)
      return app
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      shimRuntime.appEmitter.off(event, listener)
      return app
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      shimRuntime.appEmitter.once(event, listener)
      return app
    },
    whenReady: () => Promise.resolve(),
    quit: () => {},
    exit: (code = 0) => {
      process.exit(code)
    },
    requestSingleInstanceLock: () => true,
    setAppUserModelId: () => {},
    commandLine: {
      appendSwitch: () => {},
      getSwitchValue: () => '',
    },
    dock: {
      setIcon: () => {},
    },
  }

  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString(plainText: string): Buffer {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', shimRuntime.getSecretKey(), iv)
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([Buffer.from('PGK1', 'ascii'), iv, tag, encrypted])
    },
    decryptString(encrypted: Buffer): string {
      if (encrypted.subarray(0, 4).toString('ascii') === 'PGK1' && encrypted.length >= 32) {
        const iv = encrypted.subarray(4, 16)
        const tag = encrypted.subarray(16, 32)
        const payload = encrypted.subarray(32)
        const decipher = createDecipheriv('aes-256-gcm', shimRuntime.getSecretKey(), iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
      }
      return encrypted.toString('utf8')
    },
  }

  const nativeImage = {
    createFromBuffer(bytes: Buffer) {
      const dims = parsePngDimensions(bytes) ?? parseJpegDimensions(bytes)
      const makeHandle = (buf: Buffer, size: { width: number; height: number } | null) => ({
        isEmpty: () => buf.length === 0,
        getSize: () => size ?? { width: 128, height: 128 },
        resize: () => makeHandle(buf, size),
        toPNG: () => buf,
        toJPEG: () => buf,
      })
      return makeHandle(bytes, dims)
    },
  }

  const dialog = {
    async showOpenDialog(options: Record<string, unknown> = {}) {
      if (shimRuntime.dialogHandler) {
        return await shimRuntime.dialogHandler('open', options)
      }
      return { canceled: true, filePaths: [] as string[] }
    },
    async showSaveDialog(options: Record<string, unknown> = {}) {
      if (shimRuntime.dialogHandler) {
        return await shimRuntime.dialogHandler('save', options)
      }
      return { canceled: true, filePath: undefined as string | undefined }
    },
    async showMessageBox(options: Record<string, unknown> = {}) {
      if (shimRuntime.dialogHandler) {
        return await shimRuntime.dialogHandler('message', options)
      }
      return { response: 1, checkboxChecked: false }
    },
  }

  class BrowserWindow {
    static getAllWindows() {
      return [shimRuntime.virtualWindow]
    }
    static fromWebContents(wc: unknown) {
      return wc === shimRuntime.virtualWebContents ? shimRuntime.virtualWindow : null
    }
  }

  class Notification {
    static isSupported() {
      return false
    }
    static handleActivation() {}
    on() {
      return this
    }
    show() {}
  }

  const shell = {
    async openExternal(url: string) {
      shimRuntime.broadcast('web:open-external', [{ url, id: randomUUID() }])
    },
  }

  return {
    app,
    ipcMain,
    safeStorage,
    nativeImage,
    dialog,
    BrowserWindow,
    Notification,
    shell,
  }
}

let installed = false

export function installElectronShim(config: ShimConfig): void {
  shimRuntime.init(config)
  if (installed) return
  installed = true

  const electronExports = createElectronShimModule()
  ;(globalThis as Record<string, unknown>).__PAGEKIN_ELECTRON_SHIM__ = electronExports

  const source = [
    'const mod = globalThis.__PAGEKIN_ELECTRON_SHIM__;',
    'export const app = mod.app;',
    'export const ipcMain = mod.ipcMain;',
    'export const safeStorage = mod.safeStorage;',
    'export const nativeImage = mod.nativeImage;',
    'export const dialog = mod.dialog;',
    'export const BrowserWindow = mod.BrowserWindow;',
    'export const Notification = mod.Notification;',
    'export const shell = mod.shell;',
    'export default mod;',
  ].join('\n')

  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'electron') {
        return {
          url: `data:text/javascript,${encodeURIComponent(source)}`,
          shortCircuit: true,
        }
      }
      return next(specifier, context)
    },
  })
}
