/**
 * Qabot 引擎：每个用户一个持久会话，一次问答自动生成/更新一张工单。
 * 驱动 agent、统计服务时间、识别转人工。Feishu 网关在 Phase 1b 复用本类。
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation } from './conversation/store.ts'
import type { ConversationRepository, TicketRepository } from './domain/repositories.ts'
import { KeyedSerialExecutor } from './application/keyed-serial.ts'
import { answerRecommendsHumanHandoff } from './handoff-policy.ts'

export interface TurnOutcome {
  /** 本轮回合的最终助手文本（最后一次 assistant/message）。 */
  text: string
  /** turn/end 的 reason（若有）。 */
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  /** 本轮是否发起了转人工。 */
  handoffRequested: boolean
  /** 工单 id。 */
  ticketId: number
  /** 本轮服务毫秒数（turn/start → turn/end）。 */
  serviceMs: number | null
}

/** 空回复兜底文案（重试一次后仍无模型输出时返回给用户，避免空白）。 */
const EMPTY_REPLY_FALLBACK = '模型服务暂时异常，请稍后重试'
/** 空回复重试时注入模型上下文的系统提示（带前缀，转录时隐藏）。 */
const EMPTY_RETRY_PROMPT = '【系统重试】上一轮模型未返回任何内容，请直接重新回答用户最近提出的问题，不要重复无谓的工具调用。'

/** 事件流回调（Phase 1b 飞书流式回传用）。 */
export type SessionEventListener = (sessionId: string, event: SessionEvent) => void

/**
 * Reports whether Qabot has a durable DSH log for a conversation.
 * @param repositoryRoot - Absolute repository root that owns `apps/qabot/data`.
 * @param sessionId - Conversation session identifier.
 * @returns Whether any persisted project directory contains the session log.
 */
export function hasPersistedQabotSession(repositoryRoot: string, sessionId: string): boolean {
  const sessionRoot = join(repositoryRoot, 'apps', 'qabot', 'data', 'sessions')
  return existsSync(sessionRoot) && readdirSync(sessionRoot).some(
    cwdDirectory => existsSync(join(sessionRoot, cwdDirectory, sessionId, 'session.jsonl.zstd')),
  )
}

/**
 * Resolves the historical workspace recorded by Qabot's persisted directory layout.
 * @param repositoryRoot - Absolute repository root that owns `apps/qabot/data`.
 * @param sessionId - Conversation session identifier.
 * @returns Repository root or the historical `apps/qabot` workspace.
 */
export function resolveQabotSessionCwd(repositoryRoot: string, sessionId: string): string {
  const sessionRoot = join(repositoryRoot, 'apps', 'qabot', 'data', 'sessions')
  if (!existsSync(sessionRoot)) return repositoryRoot
  for (const cwdDirectory of readdirSync(sessionRoot)) {
    if (!existsSync(join(sessionRoot, cwdDirectory, sessionId))) continue
    return cwdDirectory.includes('apps-qabot')
      ? join(repositoryRoot, 'apps', 'qabot')
      : repositoryRoot
  }
  return repositoryRoot
}

async function waitUntilIdle(agent: Agent, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs)
    timer.unref?.()
  })
  const timedOut = await Promise.race([agent.whenIdle().then(() => false as const), timeout])
  if (timer !== undefined) clearTimeout(timer)
  return timedOut
}

function summarize(events: readonly SessionEvent[], firstSeq: number): {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  startTime: number | undefined
  endTime: number | undefined
} {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  let startTime: number | undefined
  let endTime: number | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      startTime = event.time
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      reason = event.data.reason
      endTime = event.time
    }
  }
  return { text, reason, startTime, endTime }
}

export class Qabot {
  /** 每用户当前活跃会话。 */
  private readonly current = new Map<string, AgentHandle>()
  /** 每用户全部会话（含历史，供转录查询）。 */
  private readonly allSessions = new Map<string, AgentHandle[]>()
  /** 每个会话最近活动时间（回收空闲会话用）。 */
  private readonly lastActive = new Map<string, number>()
  /** A DSH session admits one employee turn at a time. */
  private readonly turns = new KeyedSerialExecutor()

  constructor(
    private readonly ctx: Context,
    private readonly tickets: TicketRepository,
    private readonly conversations: ConversationRepository,
    private readonly repositoryRoot: string,
    private readonly onEvent?: SessionEventListener,
    private readonly persistedSessionIds?: Set<string>,
  ) {
    // 火线订阅所有会话事件，按 sessionId 路由（Phase 1b 飞书流式用）。
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onEvent?.(String(session.id), event)
    })
    this.startIdleSweep()
  }

  /** 周期性回收空闲会话（内存释放，会话日志已持久化，下次可恢复）。 */
  private startIdleSweep(): void {
    const timer = setInterval(() => this.sweepIdleSessions(), 5 * 60 * 1000)
    timer.unref?.()
  }

  private sweepIdleSessions(): void {
    const idleMs = Number(process.env.QABOT_SESSION_IDLE_MS ?? 30 * 60 * 1000)
    if (!Number.isFinite(idleMs) || idleMs <= 0) return
    const now = Date.now()
    const toRemove: Array<{ userKey: string; handle: AgentHandle }> = []
    for (const [userKey, handles] of this.allSessions) {
      for (const handle of handles) {
        const sid = String(handle.agent.session.id)
        const last = this.lastActive.get(sid)
        if (last !== undefined && now - last > idleMs) {
          toRemove.push({ userKey, handle })
        }
      }
    }
    for (const { userKey, handle } of toRemove) {
      const sid = String(handle.agent.session.id)
      try { void handle.dispose() } catch { /* 忽略单点清理失败 */ }
      this.lastActive.delete(sid)
      // 从 allSessions 移除；若它是当前会话，一并清掉 current（下次提问会重建并从持久化恢复）。
      const list = this.allSessions.get(userKey)
      if (list !== undefined) {
        const idx = list.indexOf(handle)
        if (idx >= 0) list.splice(idx, 1)
        if (list.length === 0) this.allSessions.delete(userKey)
      }
      if (this.current.get(userKey) === handle) this.current.delete(userKey)
    }
    if (toRemove.length > 0) {
      console.log(`[qabot] 已回收 ${toRemove.length} 个空闲会话`)
    }
  }

  /** 新建一个会话（Agent），并设为该用户当前会话。 */
  private async spawnSession(userKey: string, sessionId: string): Promise<AgentHandle> {
    const selection = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (selection === undefined) throw new Error('agentDefaultModel 未就绪')
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    }
    const handle = this.hasPersistedSession(sessionId)
      ? await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: { provider: selection.provider, model: selection.model },
        setup,
      })
      : await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: this.sessionCwd(sessionId) },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup,
      })
    const list = this.allSessions.get(userKey) ?? []
    list.push(handle)
    this.allSessions.set(userKey, list)
    this.current.set(userKey, handle)
    await this.conversations.create(userKey, sessionId)
    this.persistedSessionIds?.add(sessionId)
    return handle
  }

  /** 兼容从仓库根目录和 apps/qabot 两种历史启动目录写入的会话。 */
  private sessionCwd(sessionId: string): string {
    return resolveQabotSessionCwd(this.repositoryRoot, sessionId)
  }

  private hasPersistedSession(sessionId: string): boolean {
    return this.persistedSessionIds?.has(sessionId)
      ?? hasPersistedQabotSession(this.repositoryRoot, sessionId)
  }

  /** 取（或建）该用户当前会话。 */
  private async ensureAgent(userKey: string): Promise<Agent> {
    const existing = this.current.get(userKey)
    if (existing !== undefined) return existing.agent
    const handle = await this.spawnSession(userKey, `user-${userKey}`)
    return handle.agent
  }

  /** 切换到某会话（按 sessionId 定位；若不在内存则按 id 新建）。 */
  private async switchToSession(userKey: string, sessionId: string): Promise<Agent> {
    for (const handle of this.allSessions.get(userKey) ?? []) {
      if (String(handle.agent.session.id) === sessionId) {
        this.current.set(userKey, handle)
        return handle.agent
      }
    }
    // 历史会话只允许其持有者恢复，避免通过猜测 session id 越权读取或写入。
    if (await this.conversations.ownerOf(sessionId) !== userKey) throw new Error('CONVERSATION_NOT_FOUND')
    const handle = await this.spawnSession(userKey, sessionId)
    return handle.agent
  }

  /**
   * 新增会话：若已存在空会话（无消息）则复用，否则新建。保证一个用户最多一个空会话。
   */
  async newConversation(userKey: string): Promise<string> {
    const empty = await this.conversations.findEmpty(userKey)
    if (empty !== undefined) {
      const agent = await this.switchToSession(userKey, empty.sessionId)
      return String(agent.session.id)
    }
    const sessionId = `user-${userKey}-${Date.now()}-${randomUUID().slice(0, 8)}`
    const handle = await this.spawnSession(userKey, sessionId)
    return String(handle.agent.session.id)
  }

  /** 某用户的历史会话列表（最近活动倒序）。 */
  async listConversations(userKey: string): Promise<Conversation[]> {
    return await this.conversations.list(userKey)
  }

  /** Lists every active conversation for administrative projection jobs. */
  async listAllConversations(): Promise<Conversation[]> {
    return await this.conversations.listAll()
  }

  /** 发一次提问（可指定会话），等 agent 空闲，返回结果并更新工单。 */
  async ask(userKey: string, question: string, requestedSessionId?: string): Promise<TurnOutcome> {
    return await this.turns.run(userKey, async () => this.askSerial(userKey, question, requestedSessionId))
  }

  /** Cancels the active turn for one owned conversation; an idle conversation is unchanged. */
  async cancelConversation(userKey: string, sessionId: string): Promise<void> {
    const agent = await this.switchToSession(userKey, sessionId)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await this.releaseSessionHandle(userKey, sessionId)
  }

  /** Releases one idle in-memory handle while retaining its durable session log. */
  private async releaseSessionHandle(userKey: string, sessionId: string): Promise<void> {
    const handles = this.allSessions.get(userKey)
    const handle = handles?.find(candidate => String(candidate.agent.session.id) === sessionId)
    if (handle === undefined) return
    await this.ctx.sessions.flush(handle.agent.session)
    await handle.dispose()
    this.lastActive.delete(sessionId)
    const remaining = handles?.filter(candidate => candidate !== handle) ?? []
    if (remaining.length === 0) this.allSessions.delete(userKey)
    else this.allSessions.set(userKey, remaining)
    if (this.current.get(userKey) === handle) this.current.delete(userKey)
  }

  private async askSerial(userKey: string, question: string, requestedSessionId?: string): Promise<TurnOutcome> {
    const agent = requestedSessionId === undefined
      ? await this.ensureAgent(userKey)
      : await this.switchToSession(userKey, requestedSessionId)
    const sessionId = String(agent.session.id)
    this.lastActive.set(sessionId, Date.now())

    // 工单：复用未关闭的，否则新建；记录服务开始。
    const ticket = await this.tickets.ensureOpen({ sessionId, userKey, question })
    await this.tickets.openService(sessionId)

    const firstSeq = agent.session.seq

    // 空回复重试：回合结束 text 为空（中继网关异常被 agent-loop 吞成 error/空完成，而非抛出）
    // 时，注入一条系统提示再追问一轮；连续两次仍空则返回兜底文案，避免用户看到空白。
    let text = ''
    let reason: TurnOutcome['reason'] = undefined
    let serviceStart: number | undefined
    let serviceEnd: number | undefined
    let releaseAfterTurn = false
    const turnTimeoutMs = Number(process.env.QABOT_MODEL_TURN_TIMEOUT_MS ?? 45_000)
    if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) {
      throw new Error('QABOT_MODEL_TURN_TIMEOUT_MS 必须是正数')
    }
    for (let attempt = 0; ; attempt++) {
      const attemptSeq = agent.session.seq
      agent.followup(attempt === 0
        ? createUserMessage({ content: [{ type: 'text', text: question }], source: { kind: 'user' } })
        : createUserMessage({ content: [{ type: 'text', text: EMPTY_RETRY_PROMPT }], source: { kind: 'plugin', plugin: 'qabot' } }))
      const timedOut = await waitUntilIdle(agent, turnTimeoutMs)
      if (timedOut) {
        console.error(`[qabot] 用户 ${userKey} 模型回合超过 ${turnTimeoutMs}ms，已主动取消`)
        agent.cancel({ kind: 'hook', reason: 'qabot model turn timeout' })
        await agent.whenIdle()
        releaseAfterTurn = true
      }
      const result = summarize(agent.session.events, attemptSeq)
      text = result.text
      reason = result.reason
      if (serviceStart === undefined) serviceStart = result.startTime
      serviceEnd = result.endTime
      // 已有输出 / 用户主动取消 / 已重试一次 → 结束循环。
      if (text !== '' || timedOut || reason?.kind === 'aborted' || attempt >= 1) break
      console.warn(`[qabot] 用户 ${userKey} 本轮回复为空（turn/end=${reason?.kind ?? '无'}），重试一次…`)
    }
    if (text === '') {
      console.error(`[qabot] 用户 ${userKey} 回复为空（turn/end=${reason?.kind ?? '无'}），返回兜底文案「${EMPTY_REPLY_FALLBACK}」`)
      text = EMPTY_REPLY_FALLBACK
    }

    // 转人工建议保留在 session 工具事件中；员工选择服务组后才更新工单状态。
    const handoffRequested = agent.session.events.slice(firstSeq).some(
      event => event.type === 'tool/call' && event.data.name === 'request_human_handoff',
    ) || answerRecommendsHumanHandoff(text)
    // 服务时间：随会话累积，工单在整个会话期间保持 open，仅在结束会话时关闭。
    await this.tickets.closeService(sessionId)

    // 更新会话元数据（标题取首问，消息数，时间）。
    const messageCount = agent.session.events.filter(
      event => event.type === 'user/message' || event.type === 'assistant/message',
    ).length
    await this.conversations.touch(userKey, sessionId, messageCount, question)

    if (releaseAfterTurn) await this.releaseSessionHandle(userKey, sessionId)

    const serviceMs = serviceStart !== undefined && serviceEnd !== undefined
      ? serviceEnd - serviceStart
      : null
    return { text, reason, handoffRequested, ticketId: ticket.id, serviceMs }
  }

  /** 某用户当前会话 id（未建会话返回 undefined）。 */
  sessionIdOf(userKey: string): string | undefined {
    const handle = this.current.get(userKey)
    return handle === undefined ? undefined : String(handle.agent.session.id)
  }

  /** 某用户全部会话 id（历史 + 当前）。 */
  sessionIdsOf(userKey: string): string[] {
    return (this.allSessions.get(userKey) ?? []).map(h => String(h.agent.session.id))
  }

  /** 某会话的完整事件日志；不在内存时从持久化会话恢复。 */
  async transcript(sessionId: string): Promise<readonly SessionEvent[]> {
    for (const handles of this.allSessions.values()) {
      for (const handle of handles) {
        if (String(handle.agent.session.id) === sessionId) {
          return handle.agent.session.events
        }
      }
    }
    const owner = await this.conversations.ownerOf(sessionId)
    if (owner === undefined) return []
    const agent = await this.switchToSession(owner, sessionId)
    return agent.session.events
  }

  /** 人工回复注入 agent 上下文（agent.inject 不触发新回合），让员工继续提问时 agent 知道有人工回复过。 */
  async humanReply(sessionId: string, message: string): Promise<void> {
    let agent: Agent | undefined
    for (const handles of this.allSessions.values()) {
      for (const handle of handles) {
        if (String(handle.agent.session.id) === sessionId) agent = handle.agent
      }
    }
    if (agent === undefined) {
      const owner = await this.conversations.ownerOf(sessionId)
      if (owner === undefined) return
      agent = await this.switchToSession(owner, sessionId)
    }
    if (agent === undefined) return
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `【人工客服回复】${message}` }],
      source: { kind: 'user' },
    }))
    await this.ctx.sessions.flush(agent.session)
    const owner = await this.conversations.ownerOf(sessionId)
    if (owner !== undefined) {
      const messageCount = agent.session.events.filter(
        event => event.type === 'user/message' || event.type === 'assistant/message',
      ).length
      await this.conversations.touch(owner, sessionId, messageCount)
    }
  }

  /** 人工接管期间只记录员工消息，不触发模型回合。 */
  async employeeMessage(sessionId: string, message: string): Promise<void> {
    let agent: Agent | undefined
    for (const handles of this.allSessions.values()) {
      for (const handle of handles) {
        if (String(handle.agent.session.id) === sessionId) agent = handle.agent
      }
    }
    if (agent === undefined) {
      const owner = await this.conversations.ownerOf(sessionId)
      if (owner === undefined) return
      agent = await this.switchToSession(owner, sessionId)
    }
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `【人工接管期间员工消息】${message}` }],
      source: { kind: 'user' },
    }))
    await this.ctx.sessions.flush(agent.session)
    const owner = await this.conversations.ownerOf(sessionId)
    if (owner !== undefined) {
      const messageCount = agent.session.events.filter(
        event => event.type === 'user/message' || event.type === 'assistant/message',
      ).length
      await this.conversations.touch(owner, sessionId, messageCount, message)
    }
  }

  async archiveConversation(userKey: string, sessionId: string): Promise<boolean> {
    return await this.conversations.archive(userKey, sessionId)
  }

  /** 把某用户当前会话落盘。 */
  async flush(userKey: string): Promise<void> {
    const handle = this.current.get(userKey)
    if (handle !== undefined) await this.ctx.sessions.flush(handle.agent.session)
  }

  async dispose(): Promise<void> {
    for (const handles of this.allSessions.values()) {
      for (const handle of handles) {
        try { await handle.dispose() } catch { /* 忽略单点清理失败 */ }
      }
    }
    this.current.clear()
    this.allSessions.clear()
  }
}
