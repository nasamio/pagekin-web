import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ipcMain } from 'electron'
import { getCurrentProjectPath } from '../electron/database'
import { registerRecentProject } from '../electron/controllers/project-controller'
import { externalFileGrants } from '../electron/services/external-file-grant-service'
import { assertRequiredExpectedProjectPath } from '../electron/utils/project-context'
import type { EditorInlineAnnotation } from '../src/shared/editor-inline-generation'
import { shimRuntime } from './electron-shim'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

export interface PendingRevisionState {
  draftId: number
  chapterNumber?: number
  before: string
  after: string
  annotations: EditorInlineAnnotation[]
  summary: string
  createdAt: string
  source: 'mcp'
}

export interface ProjectWebPendingState {
  annotationsByDraft: Record<string, EditorInlineAnnotation[]>
  annotationsByChapter: Record<string, EditorInlineAnnotation[]>
  revisionsByDraft: Record<string, PendingRevisionState>
}

export interface DiscoveredProject {
  name: string
  path: string
  projectId?: string
  genre?: string
  chapterCount: number
  updatedAt: string
}

const EMPTY_STATE: ProjectWebPendingState = {
  annotationsByDraft: {},
  annotationsByChapter: {},
  revisionsByDraft: {},
}

function pendingStatePath(projectPath: string): string {
  return path.join(projectPath, '.ai-novel', 'web-pending-state.json')
}

export function readProjectPendingState(projectPath: string): ProjectWebPendingState {
  const file = pendingStatePath(projectPath)
  if (!fs.existsSync(file)) {
    return {
      annotationsByDraft: {},
      annotationsByChapter: {},
      revisionsByDraft: {},
    }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProjectWebPendingState>
    return {
      annotationsByDraft: parsed.annotationsByDraft ?? {},
      annotationsByChapter: parsed.annotationsByChapter ?? {},
      revisionsByDraft: parsed.revisionsByDraft ?? {},
    }
  } catch {
    return {
      annotationsByDraft: {},
      annotationsByChapter: {},
      revisionsByDraft: {},
    }
  }
}

export function writeProjectPendingState(projectPath: string, state: ProjectWebPendingState): void {
  const dir = path.join(projectPath, '.ai-novel')
  fs.mkdirSync(dir, { recursive: true })
  const file = pendingStatePath(projectPath)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function getPendingAnnotations(
  projectPath: string,
  draftId?: number,
  chapterNumber?: number,
): EditorInlineAnnotation[] {
  const state = readProjectPendingState(projectPath)
  if (draftId !== undefined && state.annotationsByDraft[String(draftId)]) {
    return state.annotationsByDraft[String(draftId)]!
  }
  if (chapterNumber !== undefined && state.annotationsByChapter[String(chapterNumber)]) {
    return state.annotationsByChapter[String(chapterNumber)]!
  }
  return []
}

export function setPendingAnnotations(
  projectPath: string,
  annotations: EditorInlineAnnotation[],
  draftId?: number,
  chapterNumber?: number,
): void {
  const state = readProjectPendingState(projectPath)
  if (draftId !== undefined) {
    if (annotations.length === 0) delete state.annotationsByDraft[String(draftId)]
    else state.annotationsByDraft[String(draftId)] = annotations
  }
  if (chapterNumber !== undefined) {
    if (annotations.length === 0) delete state.annotationsByChapter[String(chapterNumber)]
    else state.annotationsByChapter[String(chapterNumber)] = annotations
  }
  writeProjectPendingState(projectPath, state)
}

export function getPendingRevision(projectPath: string, draftId: number): PendingRevisionState | null {
  const state = readProjectPendingState(projectPath)
  return state.revisionsByDraft[String(draftId)] ?? null
}

export function setPendingRevision(projectPath: string, revision: PendingRevisionState): void {
  const state = readProjectPendingState(projectPath)
  state.revisionsByDraft[String(revision.draftId)] = revision
  writeProjectPendingState(projectPath, state)
}

export function clearPendingRevision(projectPath: string, draftId: number): void {
  const state = readProjectPendingState(projectPath)
  delete state.revisionsByDraft[String(draftId)]
  writeProjectPendingState(projectPath, state)
}

export function discoverProjectsInNovelsDir(novelsDir = shimRuntime.config.novelsDir): DiscoveredProject[] {
  if (!fs.existsSync(novelsDir)) return []
  const items: DiscoveredProject[] = []
  for (const entry of fs.readdirSync(novelsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const projectDir = path.join(novelsDir, entry.name)
    const dbPath = path.join(projectDir, '.ai-novel', 'project.db')
    const manifestPath = path.join(projectDir, '.ai-novel', 'project.json')
    if (!fs.existsSync(dbPath) || !fs.existsSync(manifestPath)) continue

    let name = entry.name
    let genre: string | undefined
    let projectId: string | undefined
    let chapterCount = 0
    let updatedAt = fs.statSync(dbPath).mtime.toISOString()

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { projectId?: string }
      projectId = manifest.projectId
    } catch { /* ignore */ }

    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      try {
        const core = db.prepare('SELECT project_name, genre FROM project_core WHERE id = ?').get('main') as
          | { project_name?: string; genre?: string }
          | undefined
        if (core?.project_name) name = core.project_name
        if (core?.genre) genre = core.genre
        const countRow = db.prepare('SELECT COUNT(DISTINCT chapter_number) AS cnt FROM drafts').get() as
          | { cnt?: number }
          | undefined
        chapterCount = countRow?.cnt ?? 0
      } finally {
        db.close()
      }
    } catch { /* ignore */ }

    items.push({ name, path: projectDir, projectId, genre, chapterCount, updatedAt })
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function assertInsideNovelsDir(targetPath: string): string {
  const root = path.resolve(shimRuntime.config.novelsDir)
  const resolved = path.resolve(targetPath)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('WEB_PATH_OUTSIDE_NOVELS_DIR')
  }
  return resolved
}

export function registerWebPendingAndProjectHelpers(): void {
  ipcMain.handle('web:pending-annotations:get', async (
    _event,
    draftId: number | undefined,
    chapterNumber: number | undefined,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return getPendingAnnotations(expectedProjectPath, draftId, chapterNumber)
  })

  ipcMain.handle('web:pending-annotations:set', async (
    _event,
    draftId: number | undefined,
    chapterNumber: number | undefined,
    annotations: EditorInlineAnnotation[],
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    setPendingAnnotations(expectedProjectPath, annotations, draftId, chapterNumber)
    return { success: true }
  })

  ipcMain.handle('web:pending-annotations:clear', async (
    _event,
    draftId: number | undefined,
    chapterNumber: number | undefined,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    setPendingAnnotations(expectedProjectPath, [], draftId, chapterNumber)
    return { success: true }
  })

  ipcMain.handle('web:pending-revision:get', async (
    _event,
    draftId: number,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return getPendingRevision(expectedProjectPath, draftId)
  })

  ipcMain.handle('web:pending-revision:clear', async (
    _event,
    draftId: number,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    clearPendingRevision(expectedProjectPath, draftId)
    return { success: true }
  })

  ipcMain.handle('web:projects:discover', async () => {
    const discovered = discoverProjectsInNovelsDir()
    for (const item of discovered) {
      try {
        registerRecentProject({
          name: item.name,
          path: item.path,
          projectId: item.projectId,
          updatedAt: item.updatedAt,
        })
      } catch { /* ignore */ }
    }
    return discovered
  })

  ipcMain.handle('web:project:grant-novels-dir', async (
    event: { sender: { id: number } },
    purpose: 'project-create' | 'project-open',
    subPath?: string,
  ) => {
    const target = subPath ? assertInsideNovelsDir(subPath) : path.resolve(shimRuntime.config.novelsDir)
    const grant = externalFileGrants.issueDirectory({
      webContentsId: event.sender.id,
      directoryPath: target,
      operations: [purpose],
      ttlMs: 10 * 60 * 1_000,
    })
    return { grantId: grant.grantId, displayName: path.basename(target), path: target }
  })
}

export { EMPTY_STATE }
