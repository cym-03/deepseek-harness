/**
 * qabot HTTP 服务：供门户 NestJS smart-qa 模块薄代理调用。
 * 纯 node:http，无框架依赖。飞书通知通过 adapter 注入（未注入则静默跳过）。
 *
 * 接口（前缀 /api）：
 *   POST /api/chat                 { userId, message }            → { text, ticketId, handoffRequested, serviceMs }
 *   GET  /api/tickets              ?status=&limit=                → Ticket[]
 *   GET  /api/tickets/:id                                        → { ticket, transcript: SessionEvent[] }
 *   POST /api/tickets/:id/accept   { assignee? }                  → { ticket }
 *   POST /api/tickets/:id/reply    { message }                    → { ok }  人工回复（经飞书发给用户）
 *   POST /api/tickets/:id/close    { satisfaction? }              → { ticket }
 *   GET  /api/stats                                              → 服务统计
 *   GET  /v1/knowledge/sources                                   → 在线知识源及同步状态
 *   POST /v1/knowledge/sources      { title, url, group }          → 新增并首次同步
 *   PATCH /v1/knowledge/sources/:id { title, group }               → 修改标题和维护分组
 *   POST /v1/knowledge/sources/:id/sync                           → 立即同步单个来源
 *   DELETE /v1/knowledge/sources/:id                              → 软移除来源
 *
 * 鉴权：所有环境必须配置 QABOT_API_TOKEN（缺失拒绝启动，防止内网绕过门户直接调用）。
 * 除静态测试页与 /api/health 外，所有 /api/* 请求需携带请求头 X-Qabot-Token。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KbStore, type KbMediaRef } from '../kb/store.ts'
import type { KnowledgeMediaSearch, KnowledgeSearch } from '../kb/search.ts'
import {
  KNOWLEDGE_GROUPS,
  type KnowledgeGroup,
  type KnowledgeSourceRecord,
  type MysqlKnowledgeSourceRepository,
} from '../database/mysql-knowledge-sources.ts'
import type { Ticket } from '../ticket/store.ts'
import { EMPLOYEE_TICKET_MESSAGE_PREFIX, loadConversationTimeline } from '../conversation/timeline.ts'
import { Qabot } from '../runner.ts'
import { buildWeeklyReport } from '../report/weekly.ts'
import { hasRole, verifyPortalIdentity, type PortalIdentity } from '../security/identity.ts'
import { canAccessTicket, canManageKnowledgeSource, isServiceDeskUser } from '../security/authorization.ts'
import type {
  AuditRepository,
  ConversationMessageRepository,
  OutboxRepository,
  StaffRepository,
  TicketRepository,
} from '../domain/repositories.ts'

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public')

/** 解析可作为在线知识源的飞书链接。 */
export function parseFeishuUrl(url: string): {
  kind: 'wiki' | 'docx' | 'sheet' | 'bitable'
  token: string
  tableId?: string
  sheetId?: string
} | null {
  try {
    const u = new URL(url)
    const path = u.pathname
    const tableId = u.searchParams.get('table') ?? undefined
    const wiki = path.match(/\/wiki\/([A-Za-z0-9]+)/)?.[1]
    if (wiki !== undefined) return { kind: 'wiki', token: wiki, ...(tableId ? { tableId } : {}) }
    const docx = path.match(/\/docx\/([A-Za-z0-9]+)/)?.[1]
    if (docx !== undefined) return { kind: 'docx', token: docx }
    const sheet = path.match(/\/sheets\/([A-Za-z0-9]+)/)?.[1]
    if (sheet !== undefined) {
      const sheetId = u.searchParams.get('sheet') ?? u.searchParams.get('sheetId') ?? undefined
      return { kind: 'sheet', token: sheet, ...(sheetId ? { sheetId } : {}) }
    }
    const base = path.match(/\/base\/([A-Za-z0-9]+)/)?.[1]
    if (base !== undefined && tableId !== undefined) return { kind: 'bitable', token: base, tableId }
    return null
  } catch {
    return null
  }
}

/** 对外通知适配器（飞书实现注入；缺省时静默）。 */
export interface QabotNotificationAdapter {
  /** 发一条消息给某用户（人工回复、转人工确认等）。 */
  sendToUser(userKey: string, text: string): Promise<void>
  /** 转人工时通知服务人员（发卡片，含进入后台的按钮）。 */
  notifyHandoff(ticket: Ticket): Promise<void>
}

interface HttpContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  json: unknown
  identity?: PortalIdentity
}

export interface QabotHttpOptions {
  port: number
  /** 监听地址，默认 0.0.0.0（内网可访问）。 */
  host?: string
  qabot: Qabot
  tickets: TicketRepository
  kb: KbStore
  knowledgeSearch?: KnowledgeSearch
  knowledgeMedia?: KnowledgeMediaSearch
  staff: StaffRepository
  /** MySQL source registry and synchronization entry points. */
  knowledgeSources?: MysqlKnowledgeSourceRepository
  syncKnowledgeSource?: (source: KnowledgeSourceRecord) => Promise<{ synced: number; failed: number; errors: string[] }>
  /** Persists the current knowledge index without invoking embedding providers. */
  projectKnowledge?: () => Promise<void>
  audit: AuditRepository
  outbox: OutboxRepository
  messages?: ConversationMessageRepository
}

export async function startHttpServer(options: QabotHttpOptions): Promise<ReturnType<typeof createServer>> {
  const { qabot, tickets, kb, staff, audit, outbox, messages, knowledgeSources,
    syncKnowledgeSource, projectKnowledge } = options
  const knowledgeSearch = options.knowledgeSearch ?? kb
  const knowledgeMedia = options.knowledgeMedia
  const token = process.env.QABOT_API_TOKEN
  if (token === undefined || token.trim() === '') {
    throw new Error('必须配置 QABOT_API_TOKEN（所有环境强制）。未配置时拒绝启动，防止内网机器绕过门户直接调用本服务；apps/qabot/start-qabot.bat 已内置默认令牌。')
  }
  const identitySecret = process.env.QABOT_IDENTITY_SECRET
  if (identitySecret === undefined || identitySecret.trim() === '') {
    throw new Error('必须配置 QABOT_IDENTITY_SECRET，用于校验门户签名身份令牌')
  }

  const maxBodyBytes = Number(process.env.QABOT_MAX_BODY_BYTES ?? 1_048_576)
  const maxMessageLength = Number(process.env.QABOT_MAX_MESSAGE_LENGTH ?? 8_000)
  const idleConversationMs = Number(process.env.QABOT_IDLE_CONVERSATION_MS ?? 3_600_000)
  const idleSweepMs = Number(process.env.QABOT_IDLE_SWEEP_MS ?? 60_000)
  if (!Number.isFinite(idleConversationMs) || idleConversationMs <= 0 || !Number.isFinite(idleSweepMs) || idleSweepMs <= 0) {
    throw new Error('QABOT_IDLE_CONVERSATION_MS 和 QABOT_IDLE_SWEEP_MS 必须为正数')
  }
  interface LiveChange {
    revision: number
    employeeId: string | null
    groups: string[]
    assignees: string[]
  }
  const liveChanges = new EventEmitter()
  liveChanges.setMaxListeners(1_000)
  let liveRevision = 0
  const publishTicketChange = (ticket: Ticket | undefined, previous?: Ticket): void => {
    if (ticket === undefined) return
    liveRevision += 1
    liveChanges.emit('change', {
      revision: liveRevision,
      employeeId: ticket.userKey,
      groups: [...new Set([ticket.department, previous?.department].filter(group => group !== null && group !== undefined))],
      assignees: [...new Set([ticket.assignee, previous?.assignee].filter(assignee => assignee !== null && assignee !== undefined))],
    } satisfies LiveChange)
  }
  const publishTicketSweepChange = (): void => {
    liveRevision += 1
    liveChanges.emit('change', {
      revision: liveRevision,
      employeeId: null,
      groups: [],
      assignees: [],
    } satisfies LiveChange)
  }
  const canReceiveChange = (identity: PortalIdentity, change: LiveChange): boolean => {
    if (change.employeeId === null) return true
    if (hasRole(identity, ['SystemAdmin'])) return true
    if (isServiceDeskUser(identity)) {
      return change.groups.some(group => identity.departmentIds.includes(group))
        || change.assignees.includes(identity.displayName)
    }
    return identity.employeeId === change.employeeId
  }

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      size += buffer.byteLength
      if (size > maxBodyBytes) throw new Error('REQUEST_BODY_TOO_LARGE')
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? {} : JSON.parse(text)
  }

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  type Match = { params: Record<string, string> } | null
  const matchPath = (pattern: string, pathname: string): Match => {
    const names: string[] = []
    const source = pattern.replace(/<(\w+)>/g, (_all, name: string) => {
      names.push(name)
      return '([^/]+)'
    })
    const m = pathname.match(new RegExp(`^${source}$`))
    if (m === null) return null
    return { params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(m[i + 1] ?? '')])) }
  }

  const routes: Array<{ method: string; pattern: string; handler: Handler }> = []
  type Handler = (ctx: HttpContext) => Promise<unknown>

  const route = (method: string, pattern: string, handler: Handler): void => {
    routes.push({ method, pattern, handler })
  }

  const requireEmployee = (ctx: HttpContext): PortalIdentity => {
    const identity = ctx.identity
    if (identity === undefined || !hasRole(identity, ['Employee', 'SystemAdmin'])) {
      throw new Error('FORBIDDEN')
    }
    return identity
  }

  const requireServiceDesk = (ctx: HttpContext): PortalIdentity => {
    const identity = ctx.identity
    if (identity === undefined || !isServiceDeskUser(identity)) throw new Error('FORBIDDEN')
    return identity
  }

  const requireSystemAdmin = (ctx: HttpContext): PortalIdentity => {
    const identity = ctx.identity
    if (identity === undefined || !hasRole(identity, ['SystemAdmin'])) throw new Error('FORBIDDEN')
    return identity
  }

  const requireKnowledgeOperator = (ctx: HttpContext): PortalIdentity => {
    const identity = ctx.identity
    if (identity === undefined || (!isServiceDeskUser(identity)
      && !hasRole(identity, ['KnowledgeEditor', 'KnowledgeReviewer']))) throw new Error('FORBIDDEN')
    return identity
  }

  const requireKnowledgeSourceAccess = async (ctx: HttpContext): Promise<{
    identity: PortalIdentity
    source: KnowledgeSourceRecord
  }> => {
    const identity = requireKnowledgeOperator(ctx)
    if (knowledgeSources === undefined) throw new Error('KNOWLEDGE_SYNC_UNAVAILABLE')
    const source = await knowledgeSources.get(Number(ctx.params.id))
    if (source === undefined || source.removedAt !== null) throw new Error('KNOWLEDGE_SOURCE_NOT_FOUND')
    if (!canManageKnowledgeSource(identity, source.group)) throw new Error('FORBIDDEN')
    return { identity, source }
  }

  const requireTicketAccess = async (ctx: HttpContext, id: number): Promise<{ identity: PortalIdentity; ticket: Ticket }> => {
    const identity = requireServiceDesk(ctx)
    const ticket = await tickets.get(id)
    if (ticket === undefined || !canAccessTicket(identity, ticket)) throw new Error('TICKET_NOT_FOUND')
    return { identity, ticket }
  }

  const attachVisionMedia = async (sessionId: string, question: string): Promise<KbMediaRef[]> => {
    const events = await qabot.transcript(sessionId)
    const assistant = events.findLast(event => event.type === 'assistant/message')
    const assistantText = assistant === undefined ? '' : assistant.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const media = knowledgeMedia === undefined
      ? await kb.findVisionMedia(question, 3, assistantText)
      : await knowledgeMedia.findVisionMedia(question, 3, assistantText)
    if (media.length === 0) return media
    if (assistant !== undefined) {
      if (messages === undefined) {
        kb.setConversationMedia(sessionId, assistant.seq, media)
      } else {
        await messages.upsert([{
          sessionId,
          sourceType: 'dsh_event',
          sourceId: String(assistant.seq),
          sourceOrder: assistant.seq,
          role: 'assistant',
          text: assistantText,
          createdAt: assistant.time,
          images: media,
        }])
      }
    }
    return media
  }

  const answerConversation = async (userId: string, message: string, sessionId?: string): Promise<Record<string, unknown>> => {
    const currentTicket = sessionId === undefined ? undefined : await tickets.forSession(sessionId)
    if (sessionId !== undefined && currentTicket !== undefined
      && ['waiting_agent', 'in_service', 'waiting_employee', 'reopened'].includes(currentTicket.status)) {
      if (!await knowledgeSearch.hasRelevantContent(message)) {
        await tickets.addReply(currentTicket.id, `${EMPLOYEE_TICKET_MESSAGE_PREFIX}${message}`)
        await qabot.employeeMessage(sessionId, message)
        return {
          text: '', ticketId: currentTicket.id, sessionId, handoffRequested: false,
          humanServiceActive: true, knowledgeAnswered: false, serviceMs: null, images: [],
        }
      }
      const outcome = await qabot.ask(userId, message, sessionId)
      return {
        text: outcome.text, ticketId: currentTicket.id, sessionId, handoffRequested: false,
        humanServiceActive: true, knowledgeAnswered: true, serviceMs: outcome.serviceMs,
        images: await attachVisionMedia(sessionId, message),
      }
    }
    const outcome = await qabot.ask(userId, message, sessionId)
    const answeredSessionId = qabot.sessionIdOf(userId)
    return {
      text: outcome.text,
      ticketId: outcome.ticketId,
      sessionId: answeredSessionId,
      handoffRequested: outcome.handoffRequested,
      serviceMs: outcome.serviceMs,
      images: answeredSessionId === undefined ? [] : await attachVisionMedia(answeredSessionId, message),
    }
  }

  const conversationPayload = async (sessionId: string): Promise<{
    sessionId: string
    messages: Array<{ role: 'user' | 'assistant' | 'human' | 'system'; text: string; createdAt: number; images?: KbMediaRef[] }>
    ticket: Ticket | null
    handoffRecommended: boolean
    latestMessageId: number
  }> => {
    const timeline = await loadConversationTimeline(sessionId, qabot, tickets, kb, messages)
    const ticket = await tickets.forSession(sessionId)
    const handoffRecommended = ticket?.status === 'open' && timeline.events.some(
      event => event.type === 'tool/call' && event.data.name === 'request_human_handoff',
    )
    return {
      sessionId,
      messages: timeline.messages.map(({ role, text, createdAt, images }) => ({
        role,
        text,
        createdAt,
        ...(images === undefined ? {} : { images }),
      })),
      ticket: ticket ?? null,
      handoffRecommended,
      latestMessageId: timeline.latestMessageId,
    }
  }

  route('POST', '/v1/conversations', async (ctx) => {
    const identity = requireEmployee(ctx)
    return { id: await qabot.newConversation(identity.employeeId) }
  })

  route('GET', '/v1/events', (ctx) => {
    const identity = ctx.identity
    if (identity === undefined) throw new Error('FORBIDDEN')
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    ctx.res.write(`event: ready\ndata: ${JSON.stringify({ revision: liveRevision })}\n\n`)
    const onChange = (change: LiveChange): void => {
      if (canReceiveChange(identity, change)) {
        ctx.res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`)
      }
    }
    liveChanges.on('change', onChange)
    const keepAlive = setInterval(() => ctx.res.write(': keep-alive\n\n'), 25_000)
    keepAlive.unref()
    ctx.req.on('close', () => {
      clearInterval(keepAlive)
      liveChanges.off('change', onChange)
    })
    return Promise.resolve(undefined)
  })

  route('GET', '/v1/conversations', async (ctx) => {
    const identity = requireEmployee(ctx)
    const conversations = await qabot.listConversations(identity.employeeId)
    const visibleMessageCounts = messages === undefined
      ? new Map<string, number>()
      : new Map(await Promise.all(conversations.map(async conversation => [
        conversation.sessionId,
        await messages.count(conversation.sessionId),
      ] as const)))
    const unread = messages === undefined
      ? new Map<string, number>()
      : await messages.unreadCounts(
        conversations.map(conversation => conversation.sessionId),
        `employee:${identity.employeeId}`,
        ['assistant', 'human', 'system'],
      )
    return {
      conversations: conversations.map(conversation => ({
        ...conversation,
        messageCount: visibleMessageCounts.get(conversation.sessionId) ?? conversation.messageCount,
        unreadCount: unread.get(conversation.sessionId) ?? 0,
      })),
    }
  })

  route('GET', '/v1/conversations/<sessionId>/messages', async (ctx) => {
    const identity = requireEmployee(ctx)
    const sessionId = ctx.params.sessionId ?? ''
    if (!(await qabot.listConversations(identity.employeeId)).some(item => item.sessionId === sessionId)) {
      throw new Error('CONVERSATION_NOT_FOUND')
    }
    const { latestMessageId, ...payload } = await conversationPayload(sessionId)
    if (ctx.url.searchParams.get('markRead') === '1' && latestMessageId > 0) {
      await messages?.markRead(sessionId, `employee:${identity.employeeId}`, latestMessageId)
    }
    return payload
  })

  route('POST', '/v1/conversations/<sessionId>/end', async (ctx) => {
    const identity = requireEmployee(ctx)
    const sessionId = ctx.params.sessionId ?? ''
    if (!(await qabot.listConversations(identity.employeeId)).some(item => item.sessionId === sessionId)) {
      throw new Error('CONVERSATION_NOT_FOUND')
    }
    const ticket = await tickets.forSession(sessionId)
    if (ticket === undefined) throw new Error('TICKET_NOT_FOUND')
    await tickets.closeService(sessionId)
    await tickets.close(ticket.id, null)
    const closed = await tickets.get(ticket.id)
    publishTicketChange(closed)
    return { ticket: closed }
  })

  route('POST', '/v1/conversations/<sessionId>/handoff', async (ctx) => {
    const identity = requireEmployee(ctx)
    const sessionId = ctx.params.sessionId ?? ''
    if (!(await qabot.listConversations(identity.employeeId)).some(item => item.sessionId === sessionId)) {
      throw new Error('CONVERSATION_NOT_FOUND')
    }
    const body = ctx.json as { group?: unknown }
    const group = typeof body.group === 'string' ? body.group : ''
    if (!['IT', '人事', '行政', '财务', '其他'].includes(group)) throw new Error('HANDOFF_GROUP_INVALID')
    const ticket = await tickets.forSession(sessionId)
    if (ticket === undefined) throw new Error('TICKET_NOT_FOUND')
    const serviceGroup = group === '其他' ? 'default' : group
    await tickets.markHandoff(sessionId, ticket.handoffReason ?? '员工选择转人工', serviceGroup)
    const current = await tickets.forSession(sessionId)
    if (current !== undefined) {
      await outbox.enqueue(`ticket:${current.id}:handoff:${current.version}`, 'ticket.handoff', {
        ticketId: current.id,
        ticketVersion: current.version,
      })
    }
    publishTicketChange(current)
    return { ticket: current }
  })

  route('POST', '/v1/conversations/<sessionId>/messages', async (ctx) => {
    const identity = requireEmployee(ctx)
    const body = ctx.json as { message?: unknown }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (message === '' || message.length > maxMessageLength) throw new Error('MESSAGE_INVALID')
    const sessionId = ctx.params.sessionId ?? ''
    const outcome = await answerConversation(identity.employeeId, message, sessionId)
    await loadConversationTimeline(sessionId, qabot, tickets, kb, messages)
    publishTicketChange(await tickets.forSession(sessionId))
    return outcome
  })

  route('POST', '/v1/conversations/<sessionId>/messages/stream', async (ctx) => {
    const identity = requireEmployee(ctx)
    const body = ctx.json as { message?: unknown }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (message === '' || message.length > maxMessageLength) throw new Error('MESSAGE_INVALID')
    const sessionId = ctx.params.sessionId ?? ''
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    const event = (type: string, data: unknown): void => {
      ctx.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    event('started', { sessionId })
    try {
      const outcome = await answerConversation(identity.employeeId, message, sessionId)
      await loadConversationTimeline(sessionId, qabot, tickets, kb, messages)
      publishTicketChange(await tickets.forSession(sessionId))
      if (typeof outcome.text === 'string' && outcome.text !== '') event('text-delta', { text: outcome.text })
      if (Array.isArray(outcome.images)) {
        for (const image of outcome.images as unknown[]) event('citation', { modality: 'image', source: image })
      }
      if (outcome.handoffRequested === true) event('handoff', { recommended: true })
      event('completed', outcome)
    } catch (error) {
      event('error', { code: error instanceof Error ? error.message : 'INTERNAL_ERROR' })
    } finally {
      ctx.res.end()
    }
    return undefined
  })

  route('POST', '/v1/conversations/<sessionId>/cancel', async (ctx) => {
    const identity = requireEmployee(ctx)
    const sessionId = ctx.params.sessionId ?? ''
    if (!(await qabot.listConversations(identity.employeeId)).some(item => item.sessionId === sessionId)) throw new Error('CONVERSATION_NOT_FOUND')
    await qabot.cancelConversation(identity.employeeId, sessionId)
    return { ok: true }
  })

  route('DELETE', '/v1/conversations/<sessionId>', async (ctx) => {
    const identity = requireEmployee(ctx)
    if (!await qabot.archiveConversation(identity.employeeId, ctx.params.sessionId ?? '')) {
      throw new Error('CONVERSATION_NOT_FOUND')
    }
    return { ok: true }
  })

  route('POST', '/v1/conversations/<sessionId>/rating', async (ctx) => {
    const identity = requireEmployee(ctx)
    const sessionId = ctx.params.sessionId ?? ''
    const body = ctx.json as { ticketId?: unknown; rating?: unknown; comment?: unknown; version?: unknown }
    const ticketId = typeof body.ticketId === 'number' && Number.isInteger(body.ticketId) ? body.ticketId : null
    const rating = typeof body.rating === 'number' && Number.isInteger(body.rating) ? body.rating : null
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : null
    const comment = typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : null
    if (ticketId === null || rating === null || rating < 1 || rating > 5 || version === null) {
      throw new Error('RATING_INVALID')
    }
    if (comment !== null && comment.length > 1000) throw new Error('RATING_INVALID')
    const ticket = await tickets.get(ticketId)
    if (ticket === undefined || ticket.sessionId !== sessionId || ticket.userKey !== identity.employeeId) {
      throw new Error('TICKET_NOT_FOUND')
    }
    if (!await tickets.rate(ticketId, rating, comment, version)) throw new Error('TICKET_CONFLICT')
    const rated = await tickets.get(ticketId)
    publishTicketChange(rated)
    return { ticket: rated }
  })

  route('GET', '/v1/agent/tickets', async (ctx) => {
    const identity = requireServiceDesk(ctx)
    const limitRaw = Number(ctx.url.searchParams.get('limit') ?? 50)
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50
    const visible = hasRole(identity, ['SystemAdmin'])
      ? await tickets.list({ limit })
      : (await Promise.all(identity.departmentIds.map(async group => await tickets.listByGroup(group, limit)))).flat()
    const unique = [...new Map(visible.map(ticket => [ticket.id, ticket])).values()]
    const selected = unique.sort((left, right) => right.id - left.id).slice(0, limit)
    const unread = messages === undefined
      ? new Map<string, number>()
      : await messages.unreadCounts(
        selected.map(ticket => ticket.sessionId),
        `agent:${identity.employeeId}`,
        ['user'],
      )
    return {
      tickets: selected.map(ticket => ({ ...ticket, unreadCount: unread.get(ticket.sessionId) ?? 0 })),
    }
  })

  route('GET', '/v1/agent/tickets/<id>', async (ctx) => {
    const { identity, ticket } = await requireTicketAccess(ctx, Number(ctx.params.id))
    const timeline = await conversationPayload(ticket.sessionId)
    if (timeline.latestMessageId > 0) {
      await messages?.markRead(ticket.sessionId, `agent:${identity.employeeId}`, timeline.latestMessageId)
    }
    return {
      ticket,
      transcript: await qabot.transcript(ticket.sessionId),
      replies: await tickets.replies(ticket.id),
      messages: timeline.messages.map(message => ({ ...message, role: message.role === 'assistant' ? 'ai' : message.role })),
    }
  })

  route('POST', '/v1/agent/tickets/<id>/accept', async (ctx) => {
    const id = Number(ctx.params.id)
    const { identity } = await requireTicketAccess(ctx, id)
    const body = ctx.json as { version?: unknown }
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : null
    if (version === null) throw new Error('VERSION_REQUIRED')
    if (!await tickets.accept(id, identity.displayName || identity.employeeId, version)) throw new Error('TICKET_CONFLICT')
    await audit.append({
      actorId: identity.employeeId,
      action: 'ticket.accept',
      resourceType: 'ticket',
      resourceId: String(id),
      detail: null,
    })
    const accepted = await tickets.get(id)
    publishTicketChange(accepted)
    return { ticket: accepted }
  })

  route('POST', '/v1/agent/tickets/<id>/reply', async (ctx) => {
    const id = Number(ctx.params.id)
    const { identity, ticket } = await requireTicketAccess(ctx, id)
    const body = ctx.json as { message?: unknown; version?: unknown }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : null
    if (message === '' || message.length > maxMessageLength) throw new Error('MESSAGE_INVALID')
    if (version === null) throw new Error('VERSION_REQUIRED')
    if (await tickets.reply(id, message, version) === undefined) throw new Error('TICKET_CONFLICT')
    await qabot.humanReply(ticket.sessionId, message)
    await loadConversationTimeline(ticket.sessionId, qabot, tickets, kb, messages)
    await audit.append({
      actorId: identity.employeeId,
      action: 'ticket.reply',
      resourceType: 'ticket',
      resourceId: String(id),
      detail: null,
    })
    const replied = await tickets.get(id)
    publishTicketChange(replied)
    return { ok: true, ticket: replied }
  })

  route('POST', '/v1/agent/tickets/<id>/transfer', async (ctx) => {
    const id = Number(ctx.params.id)
    const { identity, ticket: previousTicket } = await requireTicketAccess(ctx, id)
    const body = ctx.json as { toGroup?: unknown; assignee?: unknown; note?: unknown; version?: unknown }
    const toGroup = typeof body.toGroup === 'string' ? body.toGroup.trim() : ''
    const assignee = typeof body.assignee === 'string' ? body.assignee.trim() : ''
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : null
    const target = (await staff.list()).find(member => member.active && member.group === toGroup
      && (member.name === assignee || member.openId === assignee))
    if (toGroup === '' || target === undefined) throw new Error('TRANSFER_TARGET_INVALID')
    if (version === null) throw new Error('VERSION_REQUIRED')
    if (!await tickets.transfer(id, toGroup, typeof body.note === 'string' ? body.note : null, version)) throw new Error('TICKET_CONFLICT')
    await tickets.assign(id, target.name ?? target.openId, toGroup)
    const ticket = await tickets.get(id)
    if (ticket !== undefined) {
      await outbox.enqueue(`ticket:${id}:handoff:${ticket.version}`, 'ticket.handoff', { ticketId: id, ticketVersion: ticket.version })
    }
    await audit.append({ actorId: identity.employeeId, action: 'ticket.transfer', resourceType: 'ticket', resourceId: String(id), detail: JSON.stringify({ toGroup, assignee: target.openId }) })
    publishTicketChange(ticket, previousTicket)
    return { ok: true, ticket }
  })

  route('POST', '/v1/agent/tickets/<id>/close', async (ctx) => {
    const id = Number(ctx.params.id)
    const { identity } = await requireTicketAccess(ctx, id)
    const body = ctx.json as { satisfaction?: unknown; version?: unknown }
    const satisfaction = typeof body.satisfaction === 'number' ? body.satisfaction : null
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : null
    if (satisfaction !== null && (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5)) throw new Error('RATING_INVALID')
    if (version === null) throw new Error('VERSION_REQUIRED')
    if (!await tickets.close(id, satisfaction, version)) throw new Error('TICKET_CONFLICT')
    await audit.append({ actorId: identity.employeeId, action: 'ticket.close', resourceType: 'ticket', resourceId: String(id), detail: null })
    const closed = await tickets.get(id)
    publishTicketChange(closed)
    return { ticket: closed }
  })

  route('GET', '/v1/agent/staff', async (ctx) => {
    requireServiceDesk(ctx)
    const group = ctx.url.searchParams.get('group')
    const members = await staff.list()
    return { staff: group === null ? members : members.filter(member => member.group === group) }
  })

  route('POST', '/v1/system/staff', async (ctx) => {
    const identity = requireSystemAdmin(ctx)
    const body = ctx.json as { openId?: unknown; group?: unknown; name?: unknown; active?: unknown }
    const openId = typeof body.openId === 'string' ? body.openId.trim() : ''
    if (openId === '') throw new Error('STAFF_INVALID')
    await staff.upsert({ openId, ...(typeof body.group === 'string' ? { group: body.group } : {}), ...(typeof body.name === 'string' ? { name: body.name } : {}), ...(typeof body.active === 'boolean' ? { active: body.active } : {}) })
    await audit.append({ actorId: identity.employeeId, action: 'staff.upsert', resourceType: 'staff', resourceId: openId, detail: typeof body.group === 'string' ? JSON.stringify({ group: body.group }) : null })
    return { ok: true, staff: await staff.list() }
  })

  route('DELETE', '/v1/system/staff/<openId>', async (ctx) => {
    const identity = requireSystemAdmin(ctx)
    const group = ctx.url.searchParams.get('group')
    if (!await staff.remove(ctx.params.openId ?? '', group ?? undefined)) throw new Error('STAFF_NOT_FOUND')
    await audit.append({ actorId: identity.employeeId, action: 'staff.remove', resourceType: 'staff', resourceId: ctx.params.openId ?? '', detail: group === null ? null : JSON.stringify({ group }) })
    return { ok: true, staff: await staff.list() }
  })

  route('GET', '/v1/knowledge/sources', async (ctx) => {
    const identity = requireKnowledgeOperator(ctx)
    if (knowledgeSources === undefined) throw new Error('KNOWLEDGE_SYNC_UNAVAILABLE')
    const items = await knowledgeSources.list()
    return {
      sources: items.map(source => ({
        ...source,
        canManage: canManageKnowledgeSource(identity, source.group),
      })),
    }
  })

  route('POST', '/v1/knowledge/sources', async (ctx) => {
    const identity = requireKnowledgeOperator(ctx)
    if (knowledgeSources === undefined || syncKnowledgeSource === undefined) {
      throw new Error('KNOWLEDGE_SYNC_UNAVAILABLE')
    }
    const body = ctx.json as { title?: unknown; url?: unknown; group?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    const group = typeof body.group === 'string' && KNOWLEDGE_GROUPS.includes(body.group as KnowledgeGroup)
      ? body.group as KnowledgeGroup
      : null
    const parsed = parseFeishuUrl(url)
    if (title === '' || parsed === null || group === null) throw new Error('KNOWLEDGE_SOURCE_INVALID')
    if (!canManageKnowledgeSource(identity, group)) throw new Error('FORBIDDEN')
    const sourceKey = parsed.kind === 'wiki'
      ? `wiki:${parsed.token}`
      : parsed.kind === 'sheet'
        ? `sheet:${parsed.token}:${parsed.sheetId ?? ''}`
        : parsed.kind === 'bitable'
          ? `bitable:${parsed.token}:${parsed.tableId ?? ''}`
          : `feishu:docx:${parsed.token}`
    const created = await knowledgeSources.createOrReactivate({
      sourceType: parsed.kind === 'wiki'
        ? 'feishu_wiki'
        : parsed.kind === 'sheet'
          ? 'feishu_sheet'
          : parsed.kind === 'bitable' ? 'feishu_bitable' : 'feishu_docx',
      sourceKey,
      title,
      url,
      group,
      submitterEmployeeId: identity.employeeId,
      submitterName: identity.displayName,
      allowMigrationClaim: hasRole(identity, ['SystemAdmin']),
    })
    await audit.append({
      actorId: identity.employeeId,
      action: created.claimed
        ? 'knowledge.source.claim'
        : created.reactivated ? 'knowledge.source.restore' : 'knowledge.source.add',
      resourceType: 'knowledge-source',
      resourceId: String(created.source.id),
      detail: JSON.stringify({ title, group, url }),
    })
    const result = await syncKnowledgeSource(created.source)
    return { source: await knowledgeSources.get(created.source.id), result }
  })

  route('PATCH', '/v1/knowledge/sources/<id>', async (ctx) => {
    const { identity, source } = await requireKnowledgeSourceAccess(ctx)
    if (knowledgeSources === undefined) throw new Error('KNOWLEDGE_SYNC_UNAVAILABLE')
    const body = ctx.json as { title?: unknown; group?: unknown }
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const group = typeof body.group === 'string' && KNOWLEDGE_GROUPS.includes(body.group as KnowledgeGroup)
      ? body.group as KnowledgeGroup
      : null
    if (title === '' || group === null) throw new Error('KNOWLEDGE_SOURCE_INVALID')
    if (!canManageKnowledgeSource(identity, group)) throw new Error('FORBIDDEN')
    if (!await knowledgeSources.update(source.id, title, group)) throw new Error('KNOWLEDGE_SOURCE_NOT_FOUND')
    await audit.append({ actorId: identity.employeeId, action: 'knowledge.source.edit',
      resourceType: 'knowledge-source', resourceId: String(source.id), detail: JSON.stringify({ title, group }) })
    return { source: await knowledgeSources.get(source.id) }
  })

  route('POST', '/v1/knowledge/sources/<id>/sync', async (ctx) => {
    const access = await requireKnowledgeSourceAccess(ctx)
    const { identity } = access
    let { source } = access
    if (syncKnowledgeSource === undefined || knowledgeSources === undefined) throw new Error('KNOWLEDGE_SYNC_UNAVAILABLE')
    if (source.submitterEmployeeId === 'system-migration' && hasRole(identity, ['SystemAdmin'])) {
      if (await knowledgeSources.claimMigrated(source.id, identity.employeeId, identity.displayName)) {
        await audit.append({ actorId: identity.employeeId, action: 'knowledge.source.claim',
          resourceType: 'knowledge-source', resourceId: String(source.id), detail: JSON.stringify({ group: source.group }) })
        source = await knowledgeSources.get(source.id) ?? source
      }
    }
    const result = await syncKnowledgeSource(source)
    await audit.append({ actorId: identity.employeeId, action: result.failed > 0 ? 'knowledge.source.sync_failed' : 'knowledge.source.sync',
      resourceType: 'knowledge-source', resourceId: String(source.id), detail: JSON.stringify(result) })
    return { source: await knowledgeSources.get(source.id), result }
  })

  route('DELETE', '/v1/knowledge/sources/<id>', async (ctx) => {
    const { identity, source } = await requireKnowledgeSourceAccess(ctx)
    if (knowledgeSources === undefined) throw new Error('KNOWLEDGE_SYNC_UNAVAILABLE')
    if (!await knowledgeSources.remove(source.id)) throw new Error('KNOWLEDGE_SOURCE_NOT_FOUND')
    kb.setPublication(source.sourceKey, false)
    await projectKnowledge?.()
    await audit.append({ actorId: identity.employeeId, action: 'knowledge.source.remove',
      resourceType: 'knowledge-source', resourceId: String(source.id), detail: JSON.stringify({ group: source.group }) })
    return { ok: true }
  })

  route('GET', '/v1/knowledge/vision-status', (ctx) => {
    requireKnowledgeOperator(ctx)
    return Promise.resolve(kb.visionStatus())
  })

  route('GET', '/v1/analytics/weekly', async (ctx) => {
    const identity = requireServiceDesk(ctx)
    const weeks = Number(ctx.url.searchParams.get('weeks') ?? 1)
    const sinceRaw = ctx.url.searchParams.get('since')
    const since = sinceRaw === null ? undefined : Number(sinceRaw)
    const requestedAssignee = ctx.url.searchParams.get('assignee') ?? undefined
    const assignee = hasRole(identity, ['SystemAdmin']) ? requestedAssignee : identity.displayName
    return buildWeeklyReport(
      tickets,
      Number.isFinite(since) ? since : undefined,
      Number.isFinite(weeks) && weeks > 0 ? weeks : 1,
      assignee,
      messages,
    )
  })

  route('GET', '/v1/system/audit', async (ctx) => {
    requireSystemAdmin(ctx)
    const limitRaw = Number(ctx.url.searchParams.get('limit') ?? 100)
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100
    return { records: await audit.list(limit) }
  })

  route('POST', '/api/chat', async (ctx) => {
    const body = ctx.json as { userId?: unknown; message?: unknown; sessionId?: unknown }
    const userId = typeof body.userId === 'string' ? body.userId : ''
    const message = typeof body.message === 'string' ? body.message : ''
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
    if (userId === '' || message === '') {
      send(ctx.res, 400, { error: 'userId 和 message 必填' })
      return undefined
    }
    return await answerConversation(userId, message, sessionId)
  })

  route('POST', '/api/conversations/<sessionId>/handoff', async (ctx) => {
    const sessionId = ctx.params.sessionId ?? ''
    const body = ctx.json as { userId?: unknown; group?: unknown }
    const userId = typeof body.userId === 'string' ? body.userId : ''
    const group = typeof body.group === 'string' ? body.group : ''
    if (!['IT', '人事', '行政', '财务', '其他'].includes(group)) {
      send(ctx.res, 400, { error: '请选择人事、行政、IT、财务或其他服务' })
      return undefined
    }
    const ticket = await tickets.forSession(sessionId)
    if (ticket === undefined || ticket.userKey !== userId) {
      send(ctx.res, 404, { error: '工单不存在' })
      return undefined
    }
    const serviceGroup = group === '其他' ? 'default' : group
    await tickets.markHandoff(sessionId, ticket.handoffReason ?? '员工选择转人工', serviceGroup)
    const current = await tickets.forSession(sessionId)
    if (current !== undefined) {
      await outbox.enqueue(`ticket:${current.id}:handoff:${current.version}`, 'ticket.handoff', {
        ticketId: current.id, ticketVersion: current.version,
      })
    }
    return { ticket: current }
  })

  route('POST', '/api/conversations/new', async (ctx) => {
    const body = ctx.json as { userId?: unknown }
    const userId = typeof body.userId === 'string' ? body.userId : ''
    if (userId === '') {
      send(ctx.res, 400, { error: 'userId 必填' })
      return undefined
    }
    const sessionId = await qabot.newConversation(userId)
    return { ok: true, sessionId }
  })

  // 结束会话：关闭该会话对应工单，满意度由员工在聊天界面提交。
  route('POST', '/api/conversations/<sessionId>/end', async (ctx) => {
    const sessionId = ctx.params.sessionId ?? ''
    const ticket = await tickets.forSession(sessionId)
    if (ticket === undefined) {
      send(ctx.res, 404, { error: '该会话无工单' })
      return undefined
    }
    await tickets.closeService(sessionId)
    await tickets.close(ticket.id, null)
    return { ok: true, ticket: await tickets.get(ticket.id) }
  })

  route('POST', '/api/conversations/<sessionId>/rating', async (ctx) => {
    const sessionId = ctx.params.sessionId ?? ''
    const body = ctx.json as { userId?: unknown; ticketId?: unknown; rating?: unknown; comment?: unknown; version?: unknown }
    const userId = typeof body.userId === 'string' ? body.userId : ''
    const ticketId = typeof body.ticketId === 'number' && Number.isInteger(body.ticketId) ? body.ticketId : null
    const rating = typeof body.rating === 'number' && Number.isInteger(body.rating) ? body.rating : null
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : null
    const comment = typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : null
    if (userId === '' || ticketId === null || rating === null || rating < 1 || rating > 5 || version === null || (comment !== null && comment.length > 1000)) {
      send(ctx.res, 400, { error: '评分参数无效' })
      return undefined
    }
    const ticket = await tickets.get(ticketId)
    if (ticket === undefined || ticket.sessionId !== sessionId || ticket.userKey !== userId) {
      send(ctx.res, 404, { error: '工单不存在或不属于当前员工' })
      return undefined
    }
    if (!await tickets.rate(ticketId, rating, comment, version)) {
      send(ctx.res, 409, { error: '工单状态已更新，请刷新后重新评分' })
      return undefined
    }
    return { ticket: await tickets.get(ticketId) }
  })

  // 某用户的历史会话列表（前端会话栏）。
  route('GET', '/api/conversations', async (ctx) => {
    const userId = ctx.url.searchParams.get('userId') ?? ''
    if (userId === '') {
      send(ctx.res, 400, { error: 'userId 必填' })
      return undefined
    }
    return { conversations: await qabot.listConversations(userId) }
  })

  // 某会话的历史消息（前端切换会话时加载）。合并人工回复。
  route('GET', '/api/conversations/<sessionId>/messages', async (ctx) => {
    const sessionId = ctx.params.sessionId ?? ''
    const { latestMessageId: _latestMessageId, ...payload } = await conversationPayload(sessionId)
    return payload
  })

  route('GET', '/api/kb/assets/<id>', async (ctx) => {
    const asset = knowledgeMedia === undefined
      ? kb.visionAsset(Number(ctx.params.id))
      : await knowledgeMedia.visionAsset(Number(ctx.params.id))
    if (asset === undefined) {
      send(ctx.res, 404, { error: '图片不存在' })
      return undefined
    }
    ctx.res.writeHead(200, {
      'content-type': asset.mime,
      'content-length': String(asset.image.byteLength),
      'cache-control': 'private, max-age=86400',
    })
    ctx.res.end(asset.image)
    return undefined
  })

  route('GET', '/api/kb/vision-status', async () => knowledgeMedia === undefined
    ? kb.visionStatus()
    : knowledgeMedia.visionStatus())

  route('DELETE', '/api/conversations/<sessionId>', async (ctx) => {
    const sessionId = ctx.params.sessionId ?? ''
    const body = ctx.json as { userId?: unknown }
    const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
    if (userId === '') {
      send(ctx.res, 400, { error: 'userId 必填' })
      return undefined
    }
    if (!await qabot.archiveConversation(userId, sessionId)) {
      send(ctx.res, 404, { error: '会话不存在或无权删除' })
      return undefined
    }
    return { ok: true }
  })

  route('GET', '/api/tickets', async (ctx) => {
    const status = ctx.url.searchParams.get('status')
    const group = ctx.url.searchParams.get('group')
    const assignee = ctx.url.searchParams.get('assignee')
    const limitRaw = Number(ctx.url.searchParams.get('limit') ?? 50)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50
    if (group !== null && group !== '') return tickets.listByGroup(group, limit)
    if (assignee !== null && assignee !== '') return tickets.list({ assignee, limit })
    return tickets.list({
      ...status !== null ? { status: status as Ticket['status'] } : {},
      limit,
    })
  })

  route('GET', '/api/tickets/<id>', async (ctx) => {
    const ticket = await tickets.get(Number(ctx.params.id))
    if (ticket === undefined) {
      send(ctx.res, 404, { error: '工单不存在' })
      return undefined
    }
    const timeline = await loadConversationTimeline(ticket.sessionId, qabot, tickets, kb, messages)
    const events = timeline.events
    const limitRaw = Number(ctx.url.searchParams.get('transcriptLimit') ?? 200)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200
    const replies = await tickets.repliesBySession(ticket.sessionId)
    return {
      ticket,
      transcript: events.slice(-limit),
      transcriptTotal: events.length,
      replies,
      messages: timeline.messages.map(({ role, text, createdAt }) => ({
        role: role === 'assistant' ? 'ai' : role,
        text,
        createdAt,
      })),
    }
  })

  route('POST', '/api/tickets/<id>/accept', async (ctx) => {
    const id = Number(ctx.params.id)
    const body = ctx.json as { assignee?: unknown; version?: unknown }
    const assignee = typeof body.assignee === 'string' ? body.assignee : 'unknown'
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : undefined
    if (!await tickets.accept(id, assignee, version)) {
      send(ctx.res, 409, { error: '工单已被处理或状态已更新，请刷新后重试' })
      return undefined
    }
    return { ticket: await tickets.get(id) }
  })

  route('POST', '/api/tickets/<id>/reply', async (ctx) => {
    const id = Number(ctx.params.id)
    const body = ctx.json as { message?: unknown; version?: unknown }
    const message = typeof body.message === 'string' ? body.message : ''
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : null
    if (message === '') {
      send(ctx.res, 400, { error: 'message 必填' })
      return undefined
    }
    if (version === null) {
      send(ctx.res, 400, { error: 'version 必填' })
      return undefined
    }
    const ticket = await tickets.get(id)
    if (ticket === undefined) {
      send(ctx.res, 404, { error: '工单不存在' })
      return undefined
    }
    const replyId = await tickets.reply(id, message, version)
    if (replyId === undefined) {
      send(ctx.res, 409, { error: '请先接单；若工单已更新，请刷新后重试' })
      return undefined
    }
    await qabot.humanReply(ticket.sessionId, message)
    await loadConversationTimeline(ticket.sessionId, qabot, tickets, kb, messages)
    return { ok: true, ticket: await tickets.get(id) }
  })

  // 工单转接：分类判断有误时转到其他身份组，重新通知新组。
  route('POST', '/api/tickets/<id>/transfer', async (ctx) => {
    const id = Number(ctx.params.id)
    const body = ctx.json as { toGroup?: unknown; assignee?: unknown; note?: unknown; version?: unknown }
    const toGroup = typeof body.toGroup === 'string' && body.toGroup !== '' ? body.toGroup : ''
    const assignee = typeof body.assignee === 'string' ? body.assignee.trim() : ''
    if (toGroup === '') {
      send(ctx.res, 400, { error: 'toGroup 必填（IT/人事/行政/财务/default）' })
      return undefined
    }
    const target = (await staff.list()).find(member => member.active && member.group === toGroup
      && (member.name === assignee || member.openId === assignee))
    if (target === undefined) {
      send(ctx.res, 400, { error: '请选择目标服务组中已启用的服务人员' })
      return undefined
    }
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : undefined
    if (!await tickets.transfer(id, toGroup, typeof body.note === 'string' ? body.note : null, version)) {
      send(ctx.res, 409, { error: '工单已更新，请刷新后重试' })
      return undefined
    }
    let ticket = await tickets.get(id)
    if (ticket !== undefined) {
      await tickets.assign(ticket.id, target.name ?? target.openId, toGroup)
      ticket = await tickets.get(id)
    }
    if (ticket !== undefined) {
      await outbox.enqueue(`ticket:${id}:handoff:${ticket.version}`, 'ticket.handoff', {
        ticketId: id,
        ticketVersion: ticket.version,
      })
    }
    return { ok: true, ticket }
  })

  route('POST', '/api/tickets/<id>/close', async (ctx) => {
    const id = Number(ctx.params.id)
    const body = ctx.json as { satisfaction?: unknown; version?: unknown }
    const satisfaction = typeof body.satisfaction === 'number' ? body.satisfaction : null
    if (satisfaction !== null && (satisfaction < 1 || satisfaction > 5)) {
      send(ctx.res, 400, { error: '满意度需在 1-5' })
      return undefined
    }
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : undefined
    if (!await tickets.close(id, satisfaction, version)) {
      send(ctx.res, 409, { error: '工单已更新，请刷新后重试' })
      return undefined
    }
    return { ticket: await tickets.get(id) }
  })

  route('GET', '/api/kb', () => Promise.resolve(kb.list()))

  route('POST', '/api/kb/ingest', async (ctx) => {
    const body = ctx.json as { title?: unknown; content?: unknown }
    const title = typeof body.title === 'string' ? body.title : '未命名'
    const content = typeof body.content === 'string' ? body.content : ''
    if (content === '') {
      send(ctx.res, 400, { error: 'content 必填' })
      return undefined
    }
    const chunks = kb.ingestText(title, content)
    const embedded = await kb.embedMissing()
    await projectKnowledge?.()
    return { chunks, embedded }
  })

  route('DELETE', '/api/kb/<source>', async (ctx) => {
    kb.remove(ctx.params.source ?? '')
    await projectKnowledge?.()
    return { ok: true }
  })

  route('GET', '/api/stats', async () => tickets.stats())

  // 周报（供门户「数据报告」模块调用）。?weeks=1 默认最近一周，?since=时间戳 指定起点。
  route('GET', '/api/reports/weekly', async (ctx) => {
    const weeks = Number(ctx.url.searchParams.get('weeks') ?? 1)
    const sinceRaw = ctx.url.searchParams.get('since')
    const since = sinceRaw !== null ? Number(sinceRaw) : undefined
    const assignee = ctx.url.searchParams.get('assignee') ?? undefined
    return buildWeeklyReport(
      tickets,
      Number.isFinite(since) ? since : undefined,
      Number.isFinite(weeks) && weeks > 0 ? weeks : 1,
      assignee,
      messages,
    )
  })

  // 服务人员名单（qa-admin 后台配置用，按身份组）
  route('GET', '/api/staff', async (ctx) => {
    const group = ctx.url.searchParams.get('group')
    const members = await staff.list()
    return group === null ? members : members.filter(m => m.group === group)
  })

  route('POST', '/api/staff', async (ctx) => {
    const body = ctx.json as { openId?: unknown; group?: unknown; name?: unknown; active?: unknown }
    const openId = typeof body.openId === 'string' ? body.openId.trim() : ''
    if (openId === '') {
      send(ctx.res, 400, { error: 'openId 必填' })
      return undefined
    }
    await staff.upsert({
      openId,
      ...typeof body.group === 'string' ? { group: body.group } : {},
      ...typeof body.name === 'string' ? { name: body.name } : {},
      ...typeof body.active === 'boolean' ? { active: body.active } : {},
    })
    return { ok: true, staff: await staff.list() }
  })

  route('DELETE', '/api/staff/<openId>', async (ctx) => {
    const group = ctx.url.searchParams.get('group')
    const removed = group === null
      ? await staff.remove(ctx.params.openId ?? '')
      : await staff.remove(ctx.params.openId ?? '', group)
    if (!removed) {
      send(ctx.res, 404, { error: '服务人员不存在' })
      return undefined
    }
    return { ok: true, staff: await staff.list() }
  })

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      // 静态测试页 + 健康检查不暴露任何数据，豁免鉴权；其余所有 /api/* 一律校验 X-Qabot-Token。
      const isPublicPath = url.pathname === '/' || url.pathname === '/chat.html' || url.pathname === '/api/health'
      let identity: PortalIdentity | undefined
      if (url.pathname.startsWith('/v1/')) {
        const authorization = req.headers.authorization
        if (authorization === undefined || !authorization.startsWith('Bearer ')) {
          send(res, 401, { code: 'IDENTITY_REQUIRED', message: '缺少门户身份令牌' })
          return
        }
        try {
          identity = verifyPortalIdentity(authorization.slice('Bearer '.length), identitySecret)
        } catch {
          send(res, 401, { code: 'IDENTITY_INVALID', message: '门户身份令牌无效或已过期' })
          return
        }
      } else if (!isPublicPath && req.headers['x-qabot-token'] !== token) {
        send(res, 401, { error: '未授权：缺少或错误的 X-Qabot-Token' })
        return
      }
      // 测试聊天页（浏览器入口）
      if (url.pathname === '/' || url.pathname === '/chat.html') {
        try {
          const html = await readFile(join(PUBLIC_DIR, 'chat.html'), 'utf8')
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(html)
        } catch {
          send(res, 404, { error: '页面不存在' })
        }
        return
      }
      if (url.pathname === '/api/health') {
        send(res, 200, { status: 'ok' })
        return
      }
      const json = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')
        ? await readJson(req)
        : {}
      for (const { method, pattern, handler } of routes) {
        if (req.method !== method) continue
        const match = matchPath(pattern, url.pathname)
        if (match === null) continue
        const ctx: HttpContext = { req, res, url, params: match.params, json, ...(identity === undefined ? {} : { identity }) }
        const result = await handler(ctx)
        if (result !== undefined) send(res, 200, result)
        return
      }
      send(res, 404, { error: '未找到接口' })
    } catch (error) {
      console.error('[http] 请求失败:', error)
      if (!res.headersSent) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg === 'REQUEST_BODY_TOO_LARGE') {
          send(res, 413, { code: msg, message: '请求体过大' })
          return
        }
        if (msg === 'MESSAGE_INVALID') {
          send(res, 400, { code: msg, message: `消息必须为 1-${maxMessageLength} 个字符` })
          return
        }
        if (msg === 'FORBIDDEN') {
          send(res, 403, { code: msg, message: '无权执行此操作' })
          return
        }
        if (msg === 'CONVERSATION_NOT_FOUND') {
          send(res, 404, { code: msg, message: '会话不存在' })
          return
        }
        if (msg === 'TICKET_NOT_FOUND') {
          send(res, 404, { code: msg, message: '工单不存在' })
          return
        }
        if (msg === 'TICKET_CONFLICT') {
          send(res, 409, { code: msg, message: '工单已被处理或状态不允许该操作' })
          return
        }
        if (msg === 'VERSION_REQUIRED') {
          send(res, 400, { code: msg, message: '必须提供工单 version' })
          return
        }
        if (msg === 'RATING_INVALID') {
          send(res, 400, { code: msg, message: '评分必须为 1-5' })
          return
        }
        if (msg === 'TRANSFER_TARGET_INVALID' || msg === 'STAFF_INVALID' || msg === 'KNOWLEDGE_URL_INVALID') {
          send(res, 400, { code: msg, message: msg === 'TRANSFER_TARGET_INVALID' ? '请选择目标服务组中已启用的服务人员' : msg === 'STAFF_INVALID' ? '服务人员标识不能为空' : '请输入有效的飞书文档链接' })
          return
        }
        if (msg === 'STAFF_NOT_FOUND') {
          send(res, 404, { code: msg, message: '服务人员不存在' })
          return
        }
        if (msg === 'KNOWLEDGE_SYNC_UNAVAILABLE') {
          send(res, 503, { code: msg, message: '知识同步服务未配置' })
          return
        }
        if (msg === 'KNOWLEDGE_SOURCE_EXISTS') {
          send(res, 409, { code: msg, message: '知识源已存在' })
          return
        }
        if (msg === 'KNOWLEDGE_SOURCE_NOT_FOUND') {
          send(res, 404, { code: msg, message: '知识源不存在或已移除' })
          return
        }
        if (msg === 'KNOWLEDGE_SOURCE_INVALID') {
          send(res, 400, { code: msg, message: '请填写标题、有效的飞书文档链接和知识分组' })
          return
        }
        // 中转网关余额不足 / 流被掐断 → 给出明确提示而非生硬错误。
        if (msg.includes('STREAM_CLOSED') || msg.includes('Insufficient Balance') || msg.includes('stream ended')) {
          send(res, 503, {
            error: '模型服务暂时不可用：可能是中转网关余额不足或网关异常。请及时给中转充值，稍后重试。',
          })
        } else {
          send(res, 500, { error: msg })
        }
      }
    }
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res)
  })

  const closeIdleConversations = async (): Promise<void> => {
    const count = await tickets.closeStaleConversations(Date.now() - idleConversationMs)
    if (count > 0) {
      publishTicketSweepChange()
      console.log(`[ticket] 已自动结束 ${count} 个超过空闲时限的会话`)
    }
  }
  await closeIdleConversations()
  const idleTimer = setInterval(() => {
    void closeIdleConversations().catch((error: unknown) => {
      console.error('[ticket] 自动结束空闲智能会话失败:', error instanceof Error ? error.message : error)
    })
  }, idleSweepMs)
  idleTimer.unref()
  server.on('close', () => {
    clearInterval(idleTimer)
  })

  await new Promise<void>(resolve => server.listen(options.port, options.host ?? '0.0.0.0', resolve))
  console.log(`[http] qabot 服务已启动：http://${options.host ?? '0.0.0.0'}:${options.port}`)
  return server
}
