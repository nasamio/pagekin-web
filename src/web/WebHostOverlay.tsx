import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { connectWebIpcSocket, installWebPreload } from './web-preload'

interface AuthStatus {
  authRequired: boolean
  authenticated: boolean
  novelsDir: string
  uploadsDir: string
}

interface DialogRequest {
  requestId: string
  kind: 'open' | 'save' | 'message'
  options: {
    title?: string
    message?: string
    detail?: string
    buttons?: string[]
    properties?: string[]
    defaultPath?: string
  }
  defaultRoot: string
  uploadsDir: string
}

interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  hasProject: boolean
}

const isWebMode = installWebPreload()

async function resolveDialog(requestId: string, result: unknown) {
  await fetch('/api/web-dialog/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ requestId, result }),
  })
}

export function WebHostGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(isWebMode ? null : { authRequired: false, authenticated: true, novelsDir: '', uploadsDir: '' })
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)

  const checkAuth = useCallback(async () => {
    if (!isWebMode) return
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' })
    const data = (await res.json()) as AuthStatus
    setStatus(data)
    if (!data.authRequired || data.authenticated) {
      connectWebIpcSocket()
    }
  }, [])

  useEffect(() => {
    void checkAuth()
    if (!isWebMode || !window.aiNovelAPI) return
    return window.aiNovelAPI.on('web:auth-required', () => {
      setStatus(prev => prev ? { ...prev, authRequired: true, authenticated: false } : prev)
    })
  }, [checkAuth])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoggingIn(true)
    setLoginError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setLoginError(data.error || '登录失败')
        return
      }
      setPassword('')
      await checkAuth()
    } catch {
      setLoginError('网络请求失败，请重试')
    } finally {
      setLoggingIn(false)
    }
  }

  if (!isWebMode) return <>{children}</>
  if (!status) {
    return (
      <div className="paper-ink flex h-screen items-center justify-center bg-[#F7F3E8] text-[#2B2623]">
        <span>正在连接书童服务端…</span>
      </div>
    )
  }

  if (status.authRequired && !status.authenticated) {
    return (
      <main className="paper-ink flex h-screen items-center justify-center bg-[#F7F3E8] px-4 text-[#2B2623]">
        <form onSubmit={handleLogin} className="w-full max-w-sm rounded-xl border border-[#D8D0C0] bg-[#FDFBF5] p-6 shadow-sm">
          <h1 className="mb-1 text-lg font-semibold">书童 Pagekin Web</h1>
          <p className="mb-4 text-sm text-[#6E655D]">请输入访问密码以进入创作工作台</p>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="访问密码"
            className="mb-3 w-full rounded-lg border border-[#D8D0C0] bg-white px-3 py-2 text-sm outline-none focus:border-[#B5402C]"
          />
          {loginError && <p className="mb-3 text-xs text-[#B5402C]">{loginError}</p>}
          <button
            type="submit"
            disabled={loggingIn || !password}
            className="w-full rounded-lg bg-[#B5402C] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loggingIn ? '登录中…' : '进入书房'}
          </button>
        </form>
      </main>
    )
  }

  return (
    <>
      {children}
      <WebDialogOverlay />
    </>
  )
}

function WebDialogOverlay() {
  const [dialogReq, setDialogReq] = useState<DialogRequest | null>(null)
  const [currentDir, setCurrentDir] = useState('')
  const [parentDir, setParentDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [saveFileName, setSaveFileName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const loadDir = useCallback(async (dir: string) => {
    setError('')
    const res = await fetch(`/api/files/list?dir=${encodeURIComponent(dir)}`, { credentials: 'same-origin' })
    const data = (await res.json()) as { ok: boolean; dir: string; parentDir: string | null; entries: FileEntry[]; error?: string }
    if (!data.ok) {
      setError(data.error || '读取目录失败')
      return
    }
    setCurrentDir(data.dir)
    setParentDir(data.parentDir)
    setEntries(data.entries)
    setSelectedPath(data.dir)
  }, [])

  useEffect(() => {
    if (!window.aiNovelAPI) return
    return window.aiNovelAPI.on('web:dialog-request', (raw: unknown) => {
      const req = raw as DialogRequest
      setDialogReq(req)
      setError('')
      setNewFolderName('')
      setSaveFileName(req.options.defaultPath ? req.options.defaultPath.split(/[\\/]/).pop() || 'export.zip' : 'export.zip')
      if (req.kind !== 'message') {
        void loadDir(req.defaultRoot)
      }
    })
  }, [loadDir])

  if (!dialogReq) return null

  const cancel = async () => {
    const req = dialogReq
    setDialogReq(null)
    if (req.kind === 'message') await resolveDialog(req.requestId, { response: 0, checkboxChecked: false })
    else if (req.kind === 'open') await resolveDialog(req.requestId, { canceled: true, filePaths: [] })
    else await resolveDialog(req.requestId, { canceled: true, filePath: undefined })
  }

  if (dialogReq.kind === 'message') {
    const buttons = dialogReq.options.buttons ?? ['取消', '确认']
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md rounded-xl border border-[#D8D0C0] bg-[#FDFBF5] p-5 text-[#2B2623] shadow-xl">
          <h3 className="mb-2 text-base font-semibold">{dialogReq.options.title || '确认操作'}</h3>
          {dialogReq.options.message && <p className="mb-2 text-sm">{dialogReq.options.message}</p>}
          {dialogReq.options.detail && <p className="mb-4 text-xs text-[#6E655D]">{dialogReq.options.detail}</p>}
          <div className="flex justify-end gap-2">
            {buttons.map((label, idx) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  const id = dialogReq.requestId
                  setDialogReq(null)
                  void resolveDialog(id, { response: idx, checkboxChecked: false })
                }}
                className={idx === buttons.length - 1 ? 'rounded-lg bg-[#B5402C] px-3 py-1.5 text-sm text-white' : 'rounded-lg border border-[#D8D0C0] px-3 py-1.5 text-sm'}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const isDirectoryMode = Boolean(dialogReq.options.properties?.includes('openDirectory'))

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return
    const res = await fetch('/api/files/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ parentDir: currentDir, name: newFolderName.trim() }),
    })
    const data = (await res.json()) as { ok: boolean; path?: string; error?: string }
    if (!data.ok) {
      setError(data.error || '新建目录失败')
      return
    }
    setNewFolderName('')
    await loadDir(currentDir)
    if (data.path) setSelectedPath(data.path)
  }

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    setError('')
    try {
      const uploadedPaths: string[] = []
      for (const file of Array.from(files)) {
        const res = await fetch(`/api/files/upload?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          credentials: 'same-origin',
          body: file,
        })
        const data = (await res.json()) as { ok: boolean; path?: string }
        if (data.ok && data.path) uploadedPaths.push(data.path)
      }
      if (uploadedPaths.length > 0 && dialogReq.kind === 'open' && !isDirectoryMode) {
        const id = dialogReq.requestId
        setDialogReq(null)
        await resolveDialog(id, { canceled: false, filePaths: uploadedPaths })
      } else {
        await loadDir(dialogReq.uploadsDir)
      }
    } catch {
      setError('上传文件失败')
    } finally {
      setUploading(false)
    }
  }

  const confirmSelection = async () => {
    const req = dialogReq
    setDialogReq(null)
    if (req.kind === 'save') {
      const filePath = `${currentDir.replace(/\/$/, '')}/${saveFileName.trim() || 'export.zip'}`
      await resolveDialog(req.requestId, { canceled: false, filePath })
      return
    }
    const target = selectedPath || currentDir
    await resolveDialog(req.requestId, { canceled: false, filePaths: [target] })
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-[#D8D0C0] bg-[#FDFBF5] p-5 text-[#2B2623] shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">{dialogReq.options.title || (isDirectoryMode ? '选择服务端目录' : '选择或上传文件')}</h3>
          <button type="button" onClick={cancel} className="text-xs text-[#6E655D] hover:text-black">关闭</button>
        </div>

        <div className="mb-2 flex items-center gap-2 text-xs text-[#6E655D]">
          <button
            type="button"
            onClick={() => void loadDir(dialogReq.defaultRoot)}
            className="rounded border border-[#D8D0C0] px-2 py-1 hover:bg-[#EFE9DC]"
          >
            小说根目录
          </button>
          <button
            type="button"
            onClick={() => void loadDir(dialogReq.uploadsDir)}
            className="rounded border border-[#D8D0C0] px-2 py-1 hover:bg-[#EFE9DC]"
          >
            上传目录
          </button>
          {parentDir && (
            <button
              type="button"
              onClick={() => void loadDir(parentDir)}
              className="rounded border border-[#D8D0C0] px-2 py-1 hover:bg-[#EFE9DC]"
            >
              返回上级
            </button>
          )}
          <span className="truncate font-mono">{currentDir}</span>
        </div>

        <div className="mb-3 flex-1 overflow-y-auto rounded-lg border border-[#E5DEC9] bg-white p-2">
          {entries.length === 0 ? (
            <p className="py-6 text-center text-xs text-[#6E655D]">当前目录为空</p>
          ) : (
            entries.map(entry => {
              const active = selectedPath === entry.path
              return (
                <div
                  key={entry.path}
                  onClick={() => setSelectedPath(entry.path)}
                  onDoubleClick={() => { if (entry.isDirectory) void loadDir(entry.path) }}
                  className={`flex cursor-pointer items-center justify-between rounded px-2.5 py-1.5 text-sm ${active ? 'bg-[#F4E6DF] text-[#B5402C]' : 'hover:bg-[#F7F3E8]'}`}
                >
                  <span className="truncate">
                    {entry.isDirectory ? '📁 ' : '📄 '}
                    {entry.name}
                  </span>
                  <div className="flex items-center gap-2">
                    {entry.hasProject && <span className="rounded bg-[#E7F2EA] px-1.5 py-0.5 text-[11px] text-[#2F6B43]">书童作品</span>}
                    {entry.isDirectory && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); void loadDir(entry.path) }}
                        className="text-xs text-[#6E655D] underline"
                      >
                        进入
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            placeholder="新建文件夹名称…"
            className="flex-1 rounded border border-[#D8D0C0] bg-white px-2.5 py-1 text-xs"
          />
          <button type="button" onClick={handleCreateFolder} className="rounded border border-[#D8D0C0] px-2.5 py-1 text-xs hover:bg-[#EFE9DC]">
            新建文件夹
          </button>
          {!isDirectoryMode && (
            <label className="cursor-pointer rounded border border-[#D8D0C0] px-2.5 py-1 text-xs hover:bg-[#EFE9DC]">
              {uploading ? '上传中…' : '从本地上传文件'}
              <input type="file" className="hidden" onChange={e => void handleUpload(e.target.files)} />
            </label>
          )}
        </div>

        {dialogReq.kind === 'save' && (
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span>文件名：</span>
            <input
              type="text"
              value={saveFileName}
              onChange={e => setSaveFileName(e.target.value)}
              className="flex-1 rounded border border-[#D8D0C0] bg-white px-2.5 py-1"
            />
          </div>
        )}

        {error && <p className="mb-2 text-xs text-[#B5402C]">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-[#6E655D]">已选: {selectedPath || currentDir}</span>
          <div className="flex gap-2">
            <button type="button" onClick={cancel} className="rounded-lg border border-[#D8D0C0] px-3 py-1.5 text-sm">取消</button>
            <button type="button" onClick={confirmSelection} className="rounded-lg bg-[#B5402C] px-3 py-1.5 text-sm text-white">确定选择</button>
          </div>
        </div>
      </div>
    </div>
  )
}
