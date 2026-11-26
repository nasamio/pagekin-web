import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { getCurrentProjectPath, getProjectDb, initProjectDatabase } from '../electron/database'
import { BlueprintRepository } from '../electron/repositories/blueprint-repository'
import { CharacterRepository } from '../electron/repositories/character-repository'
import { readCharacterContinuityNodes } from '../electron/repositories/character-continuity-repository'
import { DraftRepository } from '../electron/repositories/draft-repository'
import { NarrativeThreadRepository } from '../electron/repositories/narrative-thread-repository'
import { ProjectCoreRepository } from '../electron/repositories/project-core-repository'
import { projectAccess } from '../electron/services/project-access'
import { verifyCanonicalProjectData } from '../electron/services/project-data-locator'
import { validateEditorInlineInput } from '../electron/services/editor-inline-generation'
import { countDraftUnits } from '../src/shared/draft-units'
import type { EditorInlineAnnotation } from '../src/shared/editor-inline-generation'
import { shimRuntime } from './electron-shim'
import {
  clearPendingRevision,
  discoverProjectsInNovelsDir,
  getPendingAnnotations,
  readProjectPendingState,
  setPendingAnnotations,
  setPendingRevision,
} from './pending-annotations'

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: McpToolDef[] = [
  {
    name: 'list_projects',
    description: '列出 E3 小说目录下的所有书童作品（包含书名、路径、章节数与当前打开状态）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'open_project',
    description: '打开并激活指定作品，使其成为当前 MCP 会话的操作目标。可传入项目文件夹名称或完整路径。',
    inputSchema: {
      type: 'object',
      properties: {
        nameOrPath: { type: 'string', description: '作品目录名（如 高武_我能先用后付_全校以为我卷疯了）或目录路径' },
      },
      required: ['nameOrPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_project_overview',
    description: '获取当前已打开作品的核心设定、大纲、角色名单、伏笔列表和章节草稿目录（不含正文内容）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_chapter_context',
    description: '获取指定章节的完整上下文：当前最新草稿正文、draftId、本章蓝图、人物状态与伏笔、上一章结尾，以及当前网页端尚未提交的段落批注。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterNumber: { type: 'integer', minimum: 1, description: '章节号（从 1 开始）' },
        draftId: { type: 'integer', minimum: 1, description: '可选：指定草稿 ID（不传则取该章最新版本）' },
      },
      required: ['chapterNumber'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pending_annotations',
    description: '获取当前作品中作者在网页端标注的所有待修改批注（可按章节号过滤，不传则返回全书所有有待处理批注的章节）。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterNumber: { type: 'integer', minimum: 1, description: '可选：仅获取指定章节的批注' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'submit_annotated_revision',
    description: '提交基于批注改写后的新正文。默认写入待审核修订状态并实时通知网页端弹出红删绿增 Diff 逐处确认界面；设置 applyDirectly=true 时直接落库为新批注修订版本。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterNumber: { type: 'integer', minimum: 1, description: '章节号' },
        draftId: { type: 'integer', minimum: 1, description: '可选：目标草稿 ID（默认取该章最新可写版本）' },
        revisedText: { type: 'string', description: '修改后的完整章节正文' },
        summary: { type: 'string', description: '本次修改摘要说明' },
        applyDirectly: { type: 'boolean', description: '是否跳过网页 Diff 确认直接提交入库（默认 false，推荐 false 让作者在网页端对比 Diff）' },
      },
      required: ['chapterNumber', 'revisedText'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_chapter_draft',
    description: '为指定章节创建新草稿，或更新现有可写草稿（draft/reviewed/revised）的正文内容。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterNumber: { type: 'integer', minimum: 1, description: '章节号' },
        content: { type: 'string', description: '完整章节正文' },
        draftId: { type: 'integer', minimum: 1, description: '可选：要更新的草稿 ID；不传则新建一版草稿' },
      },
      required: ['chapterNumber', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_annotation_history',
    description: '查看指定章节已提交的历史批注修稿记录。',
    inputSchema: {
      type: 'object',
      properties: {
        chapterNumber: { type: 'integer', minimum: 1, description: '章节号' },
      },
      required: ['chapterNumber'],
      additionalProperties: false,
    },
  },
]

function requireOpenProject() {
  const projectPath = getCurrentProjectPath()
  const db = getProjectDb()
  if (!projectPath || !db) {
    throw new Error('NO_OPEN_PROJECT: 请先调用 list_projects 查看作品并调用 open_project 打开作品。')
  }
  return { projectPath, db }
}

async function openProjectByNameOrPath(nameOrPath: string) {
  const discovered = discoverProjectsInNovelsDir()
  const target = discovered.find(
    item => item.name === nameOrPath
      || path.basename(item.path) === nameOrPath
      || path.resolve(item.path) === path.resolve(nameOrPath),
  )
  if (!target) {
    throw new Error(`PROJECT_NOT_FOUND: 未在 ${shimRuntime.config.novelsDir} 下找到作品 "${nameOrPath}"`)
  }
  const current = getCurrentProjectPath()
  if (!current || path.resolve(current) !== path.resolve(target.path)) {
    const trusted = projectAccess.adoptLegacyProject(projectAccess.probeExistingProject(target.path))
    const verified = await verifyCanonicalProjectData(trusted.rootPath)
    initProjectDatabase(trusted.rootPath, verified)
    const session = projectAccess.beginSession(trusted)
    shimRuntime.broadcast('web:project-opened-by-mcp', [{ path: trusted.rootPath, projectId: session.projectId }])
  }
  return target
}

function getTargetDraft(chapterNumber: number, draftId?: number) {
  const draft = draftId !== undefined
    ? DraftRepository.getFull(draftId)
    : (() => {
        const latest = DraftRepository.getLatestByChapter(chapterNumber)
        return latest ? DraftRepository.getFull(latest.id) : null
      })()
  if (!draft || draft.chapterNumber !== chapterNumber) {
    throw new Error(`DRAFT_NOT_FOUND: 第 ${chapterNumber} 章暂无对应草稿`)
  }
  return draft
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'list_projects') {
    const current = getCurrentProjectPath()
    const projects = discoverProjectsInNovelsDir().map(item => ({
      ...item,
      folderName: path.basename(item.path),
      isOpen: current ? path.resolve(current) === path.resolve(item.path) : false,
    }))
    return { novelsDir: shimRuntime.config.novelsDir, projects }
  }

  if (name === 'open_project') {
    const nameOrPath = String(args.nameOrPath ?? '').trim()
    if (!nameOrPath) throw new Error('INVALID_ARGUMENT: nameOrPath required')
    const opened = await openProjectByNameOrPath(nameOrPath)
    const core = ProjectCoreRepository.get()
    return {
      opened: true,
      name: core?.projectName ?? opened.name,
      path: opened.path,
      chapterCount: opened.chapterCount,
    }
  }

  if (name === 'get_project_overview') {
    const { projectPath } = requireOpenProject()
    const core = ProjectCoreRepository.get()
    const blueprints = BlueprintRepository.getAll()
    const characters = CharacterRepository.getAll()
    const threads = NarrativeThreadRepository.list()
    const drafts = DraftRepository.listAll()

    const latestDraftByChapter = new Map<number, typeof drafts[number]>()
    for (const d of drafts) {
      latestDraftByChapter.set(d.chapterNumber, d)
    }

    return {
      projectPath,
      projectName: core?.projectName,
      genre: core?.genre,
      subGenre: core?.subGenre,
      targetAudience: core?.targetAudience,
      totalChapters: core?.totalChapters,
      wordsPerChapter: core?.wordsPerChapter,
      coreOutline: core?.coreOutline,
      worldSetting: core?.worldSetting,
      goldenFinger: core?.goldenFinger,
      protagonistProfile: core?.protagonistProfile,
      globalGuidance: core?.globalGuidance,
      writingStyle: core?.writingStyle,
      characters: characters.map(c => ({
        characterId: c.characterId,
        name: c.name,
        role: c.role,
        personality: c.personality,
        abilities: c.abilities,
        motivation: c.motivation,
        currentState: c.currentState,
      })),
      narrativeThreads: threads.map(t => ({
        id: t.id,
        title: t.title,
        type: t.type,
        status: t.status,
        targetStartChapter: t.targetStartChapter,
        targetEndChapter: t.targetEndChapter,
        authorIntent: t.authorIntent,
      })),
      chapters: blueprints.map(bp => {
        const latest = latestDraftByChapter.get(bp.chapterNumber)
        return {
          chapterNumber: bp.chapterNumber,
          title: bp.title,
          role: bp.role,
          latestDraft: latest
            ? { draftId: latest.id, version: latest.version, status: latest.status, wordCount: latest.wordCount, updatedAt: latest.updatedAt }
            : null,
        }
      }),
    }
  }

  if (name === 'get_chapter_context') {
    const { projectPath, db } = requireOpenProject()
    const chapterNumber = Number(args.chapterNumber)
    const draftId = args.draftId !== undefined ? Number(args.draftId) : undefined
    const blueprint = BlueprintRepository.getByChapter(chapterNumber)
    const latestMeta = draftId !== undefined ? DraftRepository.getMeta(draftId) : DraftRepository.getLatestByChapter(chapterNumber)
    const draft = latestMeta ? DraftRepository.getFull(latestMeta.id) : null
    const previousDraft = chapterNumber > 1
      ? (() => {
          const prev = DraftRepository.getFinalizedByChapter(chapterNumber - 1) ?? DraftRepository.getLatestByChapter(chapterNumber - 1)
          const full = prev ? DraftRepository.getFull(prev.id) : null
          return full ? { chapterNumber: chapterNumber - 1, ending: full.content.slice(-800) } : null
        })()
      : null

    const activeThreads = NarrativeThreadRepository.listRelevantActive({ chapterNumber }, db)
    const characters = CharacterRepository.getAll()
    const continuityNodes = readCharacterContinuityNodes(db)
      .filter(n => n.effectiveChapter <= chapterNumber)

    const pendingAnnotations = getPendingAnnotations(projectPath, draft?.id, chapterNumber)
    return {
      chapterNumber,
      blueprint,
      draft: draft
        ? { id: draft.id, version: draft.version, status: draft.status, wordCount: draft.wordCount, content: draft.content }
        : null,
      pendingAnnotations,
      activeThreads,
      characters,
      continuityNodes: continuityNodes.slice(-80),
      previousChapterEnding: previousDraft,
    }
  }

  if (name === 'get_pending_annotations') {
    const { projectPath } = requireOpenProject()
    const state = readProjectPendingState(projectPath)
    if (args.chapterNumber !== undefined) {
      const ch = Number(args.chapterNumber)
      const latest = DraftRepository.getLatestByChapter(ch)
      const annotations = getPendingAnnotations(projectPath, latest?.id, ch)
      return { chapterNumber: ch, draftId: latest?.id ?? null, annotations }
    }
    const byChapter: Array<{ chapterNumber: number; draftId: number | null; annotations: EditorInlineAnnotation[] }> = []
    const seenChapters = new Set<number>()
    for (const [chKey, list] of Object.entries(state.annotationsByChapter)) {
      const ch = Number(chKey)
      if (!list.length) continue
      seenChapters.add(ch)
      const latest = DraftRepository.getLatestByChapter(ch)
      byChapter.push({ chapterNumber: ch, draftId: latest?.id ?? null, annotations: list })
    }
    for (const [draftKey, list] of Object.entries(state.annotationsByDraft)) {
      if (!list.length) continue
      const meta = DraftRepository.getMeta(Number(draftKey))
      if (meta && !seenChapters.has(meta.chapterNumber)) {
        byChapter.push({ chapterNumber: meta.chapterNumber, draftId: meta.id, annotations: list })
      }
    }
    return { pendingChapters: byChapter }
  }

  if (name === 'submit_annotated_revision') {
    const { projectPath, db } = requireOpenProject()
    const chapterNumber = Number(args.chapterNumber)
    const revisedText = String(args.revisedText ?? '')
    const summary = String(args.summary ?? 'MCP 外部 Agent 按批注修订')
    const applyDirectly = Boolean(args.applyDirectly)
    const draftId = args.draftId !== undefined ? Number(args.draftId) : undefined

    const draft = getTargetDraft(chapterNumber, draftId)
    if (!['draft', 'reviewed', 'revised'].includes(draft.status)) {
      throw new Error(`DRAFT_NOT_WRITABLE: 当前草稿状态为 ${draft.status}，请先在网页端重新打开修改或新建草稿`)
    }
    const annotations = getPendingAnnotations(projectPath, draft.id, chapterNumber)

    if (applyDirectly) {
      const safeAnnotations: EditorInlineAnnotation[] = annotations.length > 0
        ? annotations
        : [{ id: randomUUID(), from: 0, to: draft.content.length, selectedText: draft.content, instruction: summary }]
      validateEditorInlineInput({
        action: 'batch-instruct',
        documentText: draft.content,
        selectedText: draft.content,
        from: 0,
        to: draft.content.length,
        annotations: safeAnnotations,
      })
      db.transaction(() => {
        db.prepare('INSERT INTO annotation_history(draft_id,before_text,after_text,annotations_json) VALUES(?,?,?,?)')
          .run(draft.id, draft.content, revisedText, JSON.stringify(safeAnnotations))
        DraftRepository.updateContent(draft.id, revisedText, countDraftUnits(revisedText))
      }).immediate()
      setPendingAnnotations(projectPath, [], draft.id, chapterNumber)
      clearPendingRevision(projectPath, draft.id)
      shimRuntime.broadcast('mcp:revision-applied', [{ draftId: draft.id, chapterNumber, wordCount: countDraftUnits(revisedText) }])
      return { applied: true, draftId: draft.id, chapterNumber, wordCount: countDraftUnits(revisedText) }
    }

    const revision = {
      draftId: draft.id,
      chapterNumber,
      before: draft.content,
      after: revisedText,
      annotations,
      summary,
      createdAt: new Date().toISOString(),
      source: 'mcp' as const,
    }
    setPendingRevision(projectPath, revision)
    shimRuntime.broadcast('mcp:revision-submitted', [revision])
    return {
      submitted: true,
      mode: 'pending-diff-review',
      draftId: draft.id,
      chapterNumber,
      annotationCount: annotations.length,
      message: '已提交至网页端红删绿增 Diff 审阅队列，作者可在网页中逐处接受或微调。',
    }
  }

  if (name === 'save_chapter_draft') {
    requireOpenProject()
    const chapterNumber = Number(args.chapterNumber)
    const content = String(args.content ?? '')
    const words = countDraftUnits(content)
    if (args.draftId !== undefined) {
      const id = Number(args.draftId)
      const existing = DraftRepository.getMeta(id)
      if (!existing || existing.chapterNumber !== chapterNumber) throw new Error('DRAFT_NOT_FOUND')
      DraftRepository.updateContent(id, content, words)
      shimRuntime.broadcast('mcp:draft-updated', [{ draftId: id, chapterNumber, wordCount: words }])
      return { updated: true, draftId: id, chapterNumber, wordCount: words }
    }
    const id = DraftRepository.create({
      chapterNumber,
      source: 'write',
      content,
      wordCount: words,
    })
    shimRuntime.broadcast('mcp:draft-created', [{ draftId: id, chapterNumber, wordCount: words }])
    return { created: true, draftId: id, chapterNumber, wordCount: words }
  }

  if (name === 'list_annotation_history') {
    const { db } = requireOpenProject()
    const chapterNumber = Number(args.chapterNumber)
    const rows = db.prepare(`
      SELECT h.id, d.id AS draftId, d.version, h.before_text AS beforeText, h.after_text AS afterText,
             h.annotations_json AS annotationsJson, h.created_at AS createdAt
      FROM annotation_history h
      JOIN drafts d ON d.id = h.draft_id
      WHERE d.chapter_number = ?
      ORDER BY h.id DESC
      LIMIT 30
    `).all(chapterNumber) as Array<{
      id: number
      draftId: number
      version: number
      beforeText: string
      afterText: string
      annotationsJson: string
      createdAt: string
    }>
    return {
      chapterNumber,
      history: rows.map(({ annotationsJson, ...rest }) => ({
        ...rest,
        annotations: JSON.parse(annotationsJson),
      })),
    }
  }

  throw new Error(`UNKNOWN_TOOL:${name}`)
}

const sessions = new Map<string, { createdAt: number }>()

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    ...extraHeaders,
  })
  res.end(payload)
}

export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
): Promise<void> {
  if (req.method === 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Use POST for Streamable HTTP MCP requests.' }))
    return
  }
  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id']
    if (typeof sid === 'string') sessions.delete(sid)
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }

  let parsed: JsonRpcRequest | JsonRpcRequest[]
  try {
    parsed = JSON.parse(rawBody) as JsonRpcRequest | JsonRpcRequest[]
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  const handleSingle = async (rpc: JsonRpcRequest): Promise<{ sid?: string; response: unknown | null }> => {
    const id = rpc.id ?? null
    if (rpc.method === 'notifications/initialized' || rpc.method.startsWith('notifications/')) {
      return { response: null }
    }
    if (rpc.method === 'initialize') {
      const sid = randomUUID()
      sessions.set(sid, { createdAt: Date.now() })
      return {
        sid,
        response: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'pagekin-shutong-mcp', version: '1.5.3-web' },
          },
        },
      }
    }
    if (rpc.method === 'ping') {
      return { response: { jsonrpc: '2.0', id, result: {} } }
    }
    if (rpc.method === 'tools/list') {
      return { response: { jsonrpc: '2.0', id, result: { tools: TOOLS } } }
    }
    if (rpc.method === 'tools/call') {
      const params = rpc.params ?? {}
      const toolName = String(params.name ?? '')
      const toolArgs = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
      try {
        const result = await callTool(toolName, toolArgs)
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          },
        }
      } catch (err) {
        return {
          response: {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            },
          },
        }
      }
    }
    return {
      response: {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      },
    }
  }

  if (Array.isArray(parsed)) {
    const results = []
    let newSid: string | undefined
    for (const item of parsed) {
      const out = await handleSingle(item)
      if (out.sid) newSid = out.sid
      if (out.response !== null) results.push(out.response)
    }
    const headers: Record<string, string> = newSid ? { 'Mcp-Session-Id': newSid } : {}
    if (results.length === 0) {
      res.writeHead(202, headers)
      res.end()
      return
    }
    sendJson(res, 200, results, headers)
    return
  }

  const out = await handleSingle(parsed)
  const headers: Record<string, string> = out.sid ? { 'Mcp-Session-Id': out.sid } : {}
  if (out.response === null) {
    res.writeHead(202, headers)
    res.end()
    return
  }
  sendJson(res, 200, out.response, headers)
}
