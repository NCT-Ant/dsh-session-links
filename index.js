import { appendFileSync, promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const ROUTE_PREFIX = '/dsh-session-links'
const ECHO_TTL = 20000
const RECENT_LIMIT = 40

export const name = 'session-links'
export const inject = ['webServer', 'sessionController', 'tools', 'systemPrompt']

export function apply(ctx) {
  const debugFile = process.env.DSH_SESSION_LINKS_DEBUG
    ? path.join(process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh'), 'session-links-debug.log')
    : null

  const log = (...args) => {
    try {
      console.log('[session-links]', ...args)
    } catch {
      /* ignore */
    }
    if (!debugFile) return
    try {
      appendFileSync(
        debugFile,
        new Date().toISOString() + ' ' +
          args
            .map((item) =>
              item instanceof Error
                ? String(item.stack || item.message)
                : typeof item === 'string'
                  ? item
                  : JSON.stringify(item),
            )
            .join(' ') + '\n',
      )
    } catch {
      /* ignore */
    }
  }

  const state = {
    groups: [],
    colors: {},
    options: { compact: true, maxChars: 1200, dedupeMs: 8000, quiet: true },
  }
  const stats = { relays: 0, chars: 0, rawChars: 0, skipped: 0 }
  let loaded = null
  let saveTimer = null

  const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
  const DEFAULTS = { compact: true, maxChars: 1200, dedupeMs: 8000, quiet: true }

  const storeFile = (() => {
    const dir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh')
    return path.join(dir, 'session-links.json')
  })()

  function normalizeOptions(input) {
    const source = input && typeof input === 'object' ? input : {}
    const maxChars = Number(source.maxChars)
    const dedupeMs = Number(source.dedupeMs)
    return {
      compact: typeof source.compact === 'boolean' ? source.compact : DEFAULTS.compact,
      quiet: typeof source.quiet === 'boolean' ? source.quiet : DEFAULTS.quiet,
      maxChars: Number.isFinite(maxChars) ? Math.min(8000, Math.max(200, Math.round(maxChars))) : DEFAULTS.maxChars,
      dedupeMs: Number.isFinite(dedupeMs) ? Math.min(120000, Math.max(0, Math.round(dedupeMs))) : DEFAULTS.dedupeMs,
    }
  }

  function setOptions(patch) {
    state.options = normalizeOptions({ ...state.options, ...(patch && typeof patch === 'object' ? patch : {}) })
    scheduleSave()
    return { ok: true, options: state.options, stats: publicStats() }
  }

  function publicStats() {
    const saved = Math.max(0, stats.rawChars - stats.chars)
    return {
      relays: stats.relays,
      chars: stats.chars,
      rawChars: stats.rawChars,
      skipped: stats.skipped,
      savedChars: saved,
      savedPercent: stats.rawChars > 0 ? Math.round((saved / stats.rawChars) * 100) : 0,
    }
  }

  async function load() {
    if (loaded) return loaded
    loaded = (async () => {
      try {
        const raw = await fs.readFile(storeFile, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.groups)) {
          state.groups = parsed.groups
            .filter((group) => group && typeof group.id === 'string' && Array.isArray(group.sessions))
            .map((group) => ({
              id: group.id,
              name: typeof group.name === 'string' && group.name ? group.name : '连接组',
              createdAt: typeof group.createdAt === 'number' ? group.createdAt : Date.now(),
              sessions: group.sessions.filter((id) => typeof id === 'string' && id),
              leader:
                typeof group.leader === 'string' && group.sessions.includes(group.leader)
                  ? group.leader
                  : null,
            }))
        }
        if (parsed && parsed.colors && typeof parsed.colors === 'object') {
          for (const [sessionId, color] of Object.entries(parsed.colors)) {
            if (typeof sessionId === 'string' && typeof color === 'string' && COLOR_PATTERN.test(color)) {
              state.colors[sessionId] = color
            }
          }
        }
        if (parsed && parsed.options && typeof parsed.options === 'object') {
          state.options = normalizeOptions(parsed.options)
        }
        log('已载入', state.groups.length, '个连接组')
      } catch (error) {
        if (error && error.code !== 'ENOENT') log('读取连接组失败', error && error.message)
      }
    })()
    return loaded
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      saveTimer = null
      try {
        await fs.mkdir(path.dirname(storeFile), { recursive: true })
        await fs.writeFile(
          storeFile,
          JSON.stringify(
            { groups: state.groups, colors: state.colors, options: state.options },
            null,
            2,
          ),
          'utf8',
        )
      } catch (error) {
        log('保存连接组失败', error && error.message)
      }
    }, 60)
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  function groupOf(sessionId) {
    return state.groups.find((group) => group.sessions.includes(sessionId))
  }

  function leaderOf(group) {
    if (!group || !group.leader) return null
    return group.sessions.includes(group.leader) ? group.leader : null
  }

  // 任命/撤销组长；leaderSessionId 为空表示撤销
  function setLeader(groupIdOrSession, leaderSessionId) {
    const group = groupIdOrSession
      ? state.groups.find((item) => item.id === groupIdOrSession) || groupOf(groupIdOrSession)
      : null
    if (!group) return { ok: false, error: '找不到连接组' }
    if (leaderSessionId == null || leaderSessionId === '') {
      group.leader = null
      scheduleSave()
      return { ok: true, group, groups: state.groups }
    }
    if (typeof leaderSessionId !== 'string' || !group.sessions.includes(leaderSessionId)) {
      return { ok: false, error: '被任命的会话不在这个连接组里' }
    }
    group.leader = leaderSessionId
    scheduleSave()
    return { ok: true, group, groups: state.groups }
  }

  // 设置/清除某个会话的侧边栏底色
  function setColor(sessionId, color) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: '缺少会话 id' }
    if (color == null || color === '') {
      if (state.colors[sessionId] !== undefined) {
        delete state.colors[sessionId]
        scheduleSave()
      }
      return { ok: true, colors: state.colors }
    }
    if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
      return { ok: false, error: '颜色格式必须是 #RRGGBB' }
    }
    state.colors[sessionId] = color
    scheduleSave()
    return { ok: true, colors: state.colors }
  }

  // ---------- 消息广播 ----------

  const echoes = new Map()

  function echoKey(sessionId, text) {
    const digest = crypto.createHash('sha1').update(text).digest('hex')
    return sessionId + '\u0000' + digest
  }

  function markEcho(sessionId, text) {
    const key = echoKey(sessionId, text)
    const list = echoes.get(key) || []
    list.push(Date.now() + ECHO_TTL)
    echoes.set(key, list)
  }

  function consumeEcho(sessionId, text) {
    const key = echoKey(sessionId, text)
    const list = echoes.get(key)
    if (!list || list.length === 0) return false
    const now = Date.now()
    while (list.length > 0 && list[0] < now) list.shift()
    if (list.length === 0) {
      echoes.delete(key)
      return false
    }
    list.shift()
    if (list.length === 0) echoes.delete(key)
    return true
  }

  function textOfMessage(message) {
    const content = message && Array.isArray(message.content) ? message.content : []
    const pieces = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        pieces.push(block.text)
      }
    }
    return pieces.join('\n\n').trim()
  }

  let lastDeliverError = ''

  /**
   * 选投递模式：对端正在跑这一轮时，queue 只会排到「下一轮」（本轮不结束就一直看不到），
   * 而 steer 会插进当前轮的下一步，才能真正「即时」送达。所以默认自动判断：
   * 空闲 → queue（直接开启新一轮）；运行中 → steer（插进当前轮，下一步就能看到）。
   */
  async function pickMode(sessionId, modeOverride, signal) {
    if (modeOverride === 'queue' || modeOverride === 'steer') return modeOverride
    try {
      const state = await ctx.sessionController.state({ sessionId }, signal)
      if (state && state.running) return 'steer'
    } catch (error) {
      log('读取会话运行状态失败，退回排队投递', sessionId, String((error && error.message) || error))
    }
    return 'queue'
  }

  async function promptOnce(sessionId, text, mode, signal) {
    await ctx.sessionController.prompt(
      {
        requestId: crypto.randomUUID(),
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      },
      signal,
    )
  }

  // 投递失败（对端忙、刚好在换轮、超时）时不丢消息：进队列，等对端空闲后重投。
  const DELIVER_TIMEOUT_MS = 120000
  const DELIVER_RETRY_MS = 8000
  const MAX_PENDING = 20
  const pendingDeliveries = new Map()

  function enqueueDelivery(sessionId, text) {
    const list = pendingDeliveries.get(sessionId) || []
    if (!list.some((item) => item.text === text)) {
      if (list.length >= MAX_PENDING) list.shift()
      list.push({ text, attempts: 0 })
    }
    pendingDeliveries.set(sessionId, list)
  }

  let pumping = false
  async function pumpDeliveries() {
    if (pumping) return
    pumping = true
    try {
      for (const [sessionId, list] of Array.from(pendingDeliveries.entries())) {
        while (list.length > 0) {
          const item = list[0]
          const ok = await deliver(sessionId, item.text, 'queue')
          if (!ok) {
            item.attempts += 1
            if (item.attempts > 60) list.shift()
            break
          }
          list.shift()
        }
        if (list.length === 0) pendingDeliveries.delete(sessionId)
      }
    } finally {
      pumping = false
    }
  }

  // 用 ctx.effect 管理重投定时器：插件禁用/重载时会被清理，避免多个泵同时跑。
  ctx.effect(() => {
    const retryTimer = setInterval(() => {
      void pumpDeliveries()
    }, DELIVER_RETRY_MS)
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref()
    return () => clearInterval(retryTimer)
  })

  async function deliver(sessionId, text, modeOverride) {
    lastDeliverError = ''
    markEcho(sessionId, text)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DELIVER_TIMEOUT_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
    try {
      const mode = await pickMode(sessionId, modeOverride, controller.signal)
      try {
        await promptOnce(sessionId, text, mode, controller.signal)
      } catch (error) {
        if (mode !== 'steer') throw error
        // 插话失败（对方刚好结束这一轮等）时退回排队，保证消息不丢。
        log('插话投递失败，退回排队重试', sessionId, String((error && error.message) || error))
        await promptOnce(sessionId, text, 'queue', controller.signal)
      }
      return true
    } catch (error) {
      lastDeliverError = String((error && error.message) || error)
      // 不丢消息：进队列，等对方这一轮结束/空闲时再重投。
      enqueueDelivery(sessionId, text)
      log('向会话投递失败，已排队等待重投', sessionId, lastDeliverError)
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  function compactLabel(sessionId) {
    const full = labelOf(sessionId)
    return full.length > 12 ? full.slice(0, 12) + '…' : full
  }

  // 上下文节能：单条转发的正文上限，超出保留头尾并在尾部提示可用 read 取全文。
  function shorten(text, max) {
    const value = String(text || '')
    if (value.length <= max) return { text: value, truncated: 0 }
    const headLen = Math.max(1, Math.floor(max * 0.7))
    const tailLen = Math.max(0, max - headLen - 2)
    const head = value.slice(0, headLen)
    const tail = tailLen > 0 ? value.slice(-tailLen) : ''
    return { text: head + ' … ' + tail, truncated: value.length - head.length - tail.length }
  }

  function countRelay(rawLength, sentLength) {
    stats.relays += 1
    stats.rawChars += rawLength
    stats.chars += sentLength
  }

  const relaySeen = new Map()

  function relayFingerprint(sourceSessionId, text) {
    const value = String(text || '')
    const head = value.slice(0, 80)
    const tail = value.length > 160 ? value.slice(-80) : ''
    return sourceSessionId + '\u0000' + value.length + '\u0000' + head + '\u0000' + tail
  }

  function shouldSkipRelay(sourceSessionId, text) {
    const window = state.options.dedupeMs
    if (!window) return false
    const now = Date.now()
    if (relaySeen.size > 200) {
      for (const [key, at] of relaySeen) if (now - at > window) relaySeen.delete(key)
    }
    const key = relayFingerprint(sourceSessionId, text)
    const seenAt = relaySeen.get(key)
    if (seenAt && now - seenAt < window) {
      stats.skipped += 1
      return true
    }
    relaySeen.set(key, now)
    return false
  }

  function relayText(sourceSessionId, text) {
    const raw = String(text || '')
    const { text: body, truncated } = shorten(raw, state.options.maxChars)
    const name = state.options.compact ? compactLabel(sourceSessionId) : labelOf(sourceSessionId)
    const head = state.options.compact
      ? '〔' + name + '〕'
      : '【相连会话「' + name + '」同步过来的消息】\n'
    const notes = []
    if (truncated > 0) notes.push('已省略 ' + truncated + ' 字')
    if (state.options.compact) notes.push('全文用 session_links action=read')
    if (state.options.quiet) {
      const group = groupOf(sourceSessionId)
      const leader = group ? leaderOf(group) : null
      const reportTo = leader && leader !== sourceSessionId ? '用 session_links action=send 把结论报给组长' : '把结论用一句话说清'
      notes.push(
        '组内同步·静默执行：不需要回复正文，处理完即可。只有两种情况才输出文字——①失败或严重错误需说明原因；②用户在本会话里直接插话提问。其余情况' +
          reportTo +
          '（结论 + 产出路径，两行以内）',
      )
    } else if (state.options.compact) {
      notes.push('组内同步，非你执行的任务就一句话确认')
    }
    const tail = notes.length ? '\n（' + notes.join('；') + '）' : ''
    const out = head + body + tail
    countRelay(raw.length, out.length)
    return out
  }

  function announceText(sourceSessionId, text) {
    const raw = String(text || '')
    const { text: body, truncated } = shorten(raw, state.options.maxChars)
    const from = sourceSessionId ? '来自「' + labelOf(sourceSessionId) + '」·' : ''
    const notes = []
    if (truncated > 0) notes.push('已省略 ' + truncated + ' 字')
    const tail = notes.length ? '（' + notes.join('；') + '）' : ''
    const out =
      '〔通报·无需回复·' + from + '〕' +
      body +
      tail +
      '\n（只需知道，请只回「收到」，不要调用工具或展开说明。）'
    countRelay(raw.length, out.length)
    return out
  }

  async function announce(sessionIds, text, sourceSessionId) {
    const targets = Array.from(new Set(sessionIds.filter((id) => typeof id === 'string' && id)))
    const body = announceText(sourceSessionId, text)
    const delivered = []
    const failed = []
    for (const id of targets) {
      const ok = await deliver(id, body)
      if (ok) delivered.push(id)
      else failed.push({ sessionId: id, error: lastDeliverError })
    }
    return { delivered, failed, text: body }
  }

  async function broadcast(sourceSessionId, message) {
    await load()
    const group = groupOf(sourceSessionId)
    if (!group) return
    const text = textOfMessage(message)
    if (!text) return
    if (consumeEcho(sourceSessionId, text)) return
    if (shouldSkipRelay(sourceSessionId, text)) {
      log('跳过重复转发', sourceSessionId)
      return
    }
    const body = relayText(sourceSessionId, text)
    const peers = group.sessions.filter((id) => id !== sourceSessionId)
    for (const peer of peers) {
      await deliver(peer, body)
    }
  }

  ctx.on('agent/inbox/inserted', (payload) => {
    const sessionId = payload && payload.agent ? payload.agent.id : undefined
    if (!sessionId) return
    void broadcast(sessionId, payload.message)
  })

  // ---------- 最近消息缓存（供跨会话读取） ----------

  const recent = new Map()

  function pushRecent(sessionId, entry) {
    const list = recent.get(sessionId) || []
    list.push({ at: Date.now(), ...entry })
    while (list.length > RECENT_LIMIT) list.shift()
    recent.set(sessionId, list)
  }

  function clip(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    return value.length > max ? value.slice(0, max) + '…' : value
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session && session.id
    if (!sessionId || !event) return
    if (event.type === 'user/message') {
      const text = clip(textOfMessage(event.data), 400)
      if (text) pushRecent(sessionId, { role: '用户', text, time: event.time })
    } else if (event.type === 'assistant/message') {
      const text = clip(textOfMessage(event.data && event.data.message), 400)
      if (text) pushRecent(sessionId, { role: '助手', text, time: event.time })
    } else if (event.type === 'tool/call') {
      const name = event.data && event.data.name
      if (!name) return
      const args = clip(event.data.arguments, 160)
      pushRecent(sessionId, { role: '工具', text: name + ' ' + args, time: event.time })
    }
  })

  // ---------- 组内投票（会话自决策） ----------

  const votes = []
  const VOTE_HISTORY = 10
  const VOTE_POLL = 700

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
  }

  function pushVote(record) {
    votes.push(record)
    while (votes.length > VOTE_HISTORY) votes.shift()
    return record
  }

  function publicVote(record) {
    return {
      id: record.id,
      groupId: record.groupId,
      groupName: record.groupName,
      task: record.task,
      mode: record.mode,
      phase: record.phase,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt || 0,
      error: record.error || '',
      winner: record.winner || null,
      order: record.order || [],
      members: record.members.map((member) => ({
        sessionId: member.sessionId,
        label: member.label,
        proposal: member.proposal || '',
        vote: member.vote || '',
      })),
    }
  }

  // 等待某个会话在 sinceAt 之后产出一条助手消息；超时返回空串
  async function waitForReply(sessionId, sinceAt, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const list = recent.get(sessionId) || []
      let hit = null
      for (const entry of list) {
        if (entry.at > sinceAt && entry.role === '助手' && entry.text) hit = entry
      }
      if (hit) return hit.text
      await sleep(VOTE_POLL)
    }
    return ''
  }

  function voteAskText(mode, task, seconds, memberCount) {
    if (mode === 'order') {
      return [
        '【组内投票·第 1 轮｜提案】',
        '任务：' + task,
        '组内共 ' + memberCount + ' 个会话参与，你只有 ' + seconds + ' 秒。',
        '要求：极简、直接。不要调用任何工具、不要读文件、不要写代码、不要解释理由。',
        '输出格式：一行执行顺序，用会话标题与箭头表示谁先做什么、再交给谁，例如「甲：做 A → 乙：做 B → 丙：出成品」。',
      ].join('\n')
    }
    return [
      '【组内投票·第 1 轮｜提案】',
      '任务：' + task,
      '组内共 ' + memberCount + ' 个会话参与，你只有 ' + seconds + ' 秒。',
      '要求：极简、直接。不要调用任何工具、不要读文件、不要写代码、不要解释理由。',
      '输出格式：3 行以内。第一行你打算怎么做；第二行需要什么输入；第三行产出什么。',
    ].join('\n')
  }

  function voteBallotText(mode, task, members, seconds) {
    const lines = ['【组内投票·第 2 轮｜表决】', '任务：' + task, '各成员提案：']
    members.forEach((member, index) => {
      lines.push('[' + (index + 1) + '] ' + member.label + '：' + (member.proposal || '（未提交）'))
    })
    lines.push('')
    lines.push('你只有 ' + seconds + ' 秒。不要调用工具、不要解释。')
    if (mode === 'order') {
      lines.push('请只回复你认可的执行顺序，用编号与箭头表示，例如 2→1，不要任何其他文字。')
    } else {
      lines.push('请只回复你选择的执行者编号，例如 2，不要任何其他文字。')
    }
    return lines.join('\n')
  }

  function parsePick(text, size) {
    const matched = String(text || '').match(/\d+/g)
    if (!matched) return 0
    for (const piece of matched) {
      const value = Number(piece)
      if (value >= 1 && value <= size) return value
    }
    return 0
  }

  function parseOrder(text, size) {
    const matched = String(text || '').match(/\d+/g) || []
    const picked = []
    for (const piece of matched) {
      const value = Number(piece)
      if (value >= 1 && value <= size && !picked.includes(value)) picked.push(value)
    }
    return picked
  }

  function voteResultText(record) {
    if (record.mode === 'order' && record.order.length > 0) {
      const names = record.order.map((sessionId) => '「' + labelOf(sessionId) + '」')
      return '【组内投票结果】任务：' + record.task + '\n执行顺序：' + names.join(' → ')
    }
    if (record.winner) {
      return '【组内投票结果】任务：' + record.task + '\n执行者：「' + labelOf(record.winner) + '」'
    }
    return '【组内投票结果】任务：' + record.task + '\n未形成结论'
  }

  async function announceVote(record, group) {
    const result = voteResultText(record)
    if (record.mode === 'order' && record.order.length > 0) {
      const steps = record.order.map((sessionId, index) => index + 1 + '. 「' + labelOf(sessionId) + '」').join('\n')
      const text =
        result +
        '\n各步负责人：\n' +
        steps +
        '\n请按顺序执行：轮到你时完成你的部分，完成后用 session_links action=send 通知下一位；未轮到的不要提前动手。'
      for (const sessionId of group.sessions) {
        await deliver(sessionId, text)
      }
      return
    }
    if (record.winner) {
      for (const sessionId of group.sessions) {
        if (sessionId === record.winner) {
          await deliver(
            sessionId,
            result +
              '\n你被组内投票选为执行者。现在开始执行这个任务；完成后用 session_links action=send 把结果同步给组内其他会话。',
          )
        } else {
          await deliver(sessionId, result + '\n本次任务由该会话执行，你不需要重复执行；需要时可以用 session_links 协作。')
        }
      }
    }
  }

  async function runVote(group, task, mode, timeoutMs) {
    const members = group.sessions.map((sessionId) => ({
      sessionId,
      label: labelOf(sessionId),
      proposal: '',
      vote: '',
    }))
    const seconds = Math.max(15, Math.round(timeoutMs / 1000))
    const record = pushVote({
      id: crypto.randomUUID(),
      groupId: group.id,
      groupName: group.name,
      task,
      mode,
      phase: 'proposal',
      startedAt: Date.now(),
      members,
    })
    try {
      const marks = {}
      for (const member of members) {
        marks[member.sessionId] = Date.now()
        await deliver(member.sessionId, voteAskText(mode, task, seconds, members.length))
      }
      const proposals = await Promise.all(
        members.map((member) => waitForReply(member.sessionId, marks[member.sessionId], timeoutMs)),
      )
      members.forEach((member, index) => {
        member.proposal = clip(proposals[index], 240)
      })
      const responders = members.filter((member) => member.proposal)
      if (responders.length === 0) {
        record.phase = 'failed'
        record.error = '组内没有会话在限定时间内给出提案'
        record.finishedAt = Date.now()
        return { ok: false, vote: publicVote(record), error: record.error }
      }
      if (responders.length === 1 && mode === 'pick') {
        record.phase = 'done'
        record.winner = responders[0].sessionId
        record.finishedAt = Date.now()
        await announceVote(record, group)
        return { ok: true, vote: publicVote(record) }
      }
      record.phase = 'ballot'
      const ballot = voteBallotText(mode, task, members, seconds)
      const marks2 = {}
      for (const member of members) {
        marks2[member.sessionId] = Date.now()
        await deliver(member.sessionId, ballot)
      }
      const ballots = await Promise.all(
        members.map((member) => waitForReply(member.sessionId, marks2[member.sessionId], timeoutMs)),
      )
      ballots.forEach((text, index) => {
        members[index].vote = clip(text, 60)
      })
      if (mode === 'order') {
        const tally = new Map()
        members.forEach((member) => {
          const order = parseOrder(member.vote, members.length)
          if (order.length < 2) return
          const key = order.join('>')
          const current = tally.get(key) || { order, count: 0 }
          current.count += 1
          tally.set(key, current)
        })
        const best = Array.from(tally.values()).sort((a, b) => b.count - a.count)[0]
        record.finishedAt = Date.now()
        if (!best) {
          record.phase = 'failed'
          record.error = '没有形成有效的顺序票'
          return { ok: false, vote: publicVote(record), error: record.error }
        }
        record.phase = 'done'
        record.order = best.order.map((index) => members[index - 1].sessionId)
      } else {
        const tally = new Map()
        members.forEach((member) => {
          const pick = parsePick(member.vote, members.length)
          if (!pick) return
          tally.set(pick, (tally.get(pick) || 0) + 1)
        })
        let winner = 0
        let bestCount = 0
        for (const [pick, count] of tally) {
          if (count > bestCount) {
            bestCount = count
            winner = pick
          }
        }
        record.finishedAt = Date.now()
        if (!winner) {
          record.phase = 'failed'
          record.error = '没有形成有效的表决票'
          return { ok: false, vote: publicVote(record), error: record.error }
        }
        record.phase = 'done'
        record.winner = members[winner - 1].sessionId
      }
      await announceVote(record, group)
      return { ok: true, vote: publicVote(record) }
    } catch (error) {
      record.phase = 'failed'
      record.error = String((error && error.message) || error)
      record.finishedAt = Date.now()
      return { ok: false, vote: publicVote(record), error: record.error }
    }
  }

  // ---------- 会话列表 ----------

  const titles = new Map()
  let known = null

  function pickTitle(summary) {
    const values = summary && summary.projections ? summary.projections.values : undefined
    if (!values) return null
    for (const key of ['title', 'sessionTitle', 'name']) {
      const value = values[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return null
  }

  function labelOf(sessionId) {
    const title = titles.get(sessionId)
    if (!title) return sessionId.slice(0, 8)
    return title.length > 24 ? title.slice(0, 24) + '…' : title
  }

  async function listSessions() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    if (timer && typeof timer.unref === 'function') timer.unref()
    try {
      const value = await ctx.sessionController.list({}, controller.signal)
      const items = (value && value.items) || []
      const list = items.map((item) => ({
        sessionId: item.sessionId,
        title: pickTitle(item),
        updatedAt: item.updatedAt || 0,
        running: !!item.running,
        blank: !!item.blank,
        cwd: item.cwd || null,
      }))
      for (const item of list) {
        if (item.title) titles.set(item.sessionId, item.title)
      }
      if (list.length) known = new Set(list.map((item) => item.sessionId))
      return list
    } catch (error) {
      log('列出会话失败', error && error.message)
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  ctx.effect(() => {
    void listSessions().then(() => pruneGroups())
    const timer = setInterval(() => {
      void listSessions().then(() => pruneGroups())
    }, 15000)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  // 剔除已被删除/归档的会话，成员不足两个的组自动解散
  function pruneGroups() {
    if (!known || known.size === 0) return state.groups
    let changed = false
    const dropped = []
    const next = []
    for (const group of state.groups) {
      const alive = group.sessions.filter((id) => known.has(id))
      if (alive.length !== group.sessions.length) changed = true
      if (alive.length < 2) {
        changed = true
        dropped.push(group)
        continue
      }
      group.sessions = alive
      if (group.leader && !alive.includes(group.leader)) {
        group.leader = null
        changed = true
      }
      next.push(group)
    }
    if (changed) {
      state.groups = next
      scheduleSave()
      const linked = new Set(state.groups.flatMap((item) => item.sessions))
      for (const group of dropped) gcGroup(group, Array.from(linked))
    }
    return state.groups
  }

  // ---------- 组操作 ----------

  // 勾选集就是目标组的最终成员：不再做「有交集就合并」，取消勾选即为移出。
  // 一个会话只属于一个组（互斥）：勾选的会话会从其他组里摘掉，其他组不足 2 人则自动散伙。
  function connect(sessionIds, name, groupId) {
    const ids = Array.from(new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === 'string' && id)))
    if (ids.length < 2) return { ok: false, error: '至少需要选择两个会话才能连接' }
    const target = typeof groupId === 'string' && groupId
      ? state.groups.find((item) => item.id === groupId) || null
      : null
    if (typeof groupId === 'string' && groupId && !target) {
      return { ok: false, error: '要编辑的连接组不存在（可能已被解散），请重新选择' }
    }

    const removedFrom = []
    for (const group of state.groups) {
      if (target && group.id === target.id) continue
      const kept = group.sessions.filter((id) => !ids.includes(id))
      if (kept.length !== group.sessions.length) {
        removedFrom.push(group.name)
        group.sessions = kept
        if (group.leader && !kept.includes(group.leader)) group.leader = null
      }
    }
    state.groups = state.groups.filter((group) => (target && group.id === target.id) || group.sessions.length >= 2)

    if (target) {
      target.sessions = ids.slice()
      if (target.leader && !ids.includes(target.leader)) target.leader = null
      if (typeof name === 'string' && name.trim()) target.name = name.trim()
      else if (!target.name) target.name = '连接组 ' + (state.groups.length + 1)
      scheduleSave()
      return { ok: true, group: target, groups: state.groups, removedFrom }
    }

    const group = {
      id: crypto.randomUUID(),
      name: (typeof name === 'string' && name.trim()) || '连接组 ' + (state.groups.length + 1),
      createdAt: Date.now(),
      sessions: ids.slice(),
      leader: null,
    }
    state.groups.push(group)
    scheduleSave()
    return { ok: true, group, groups: state.groups, removedFrom }
  }

  function disconnect(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: '缺少会话 id' }
    let changed = false
    const dropped = []
    state.groups = state.groups.filter((group) => {
      if (!group.sessions.includes(sessionId)) return true
      changed = true
      group.sessions = group.sessions.filter((id) => id !== sessionId)
      if (group.leader === sessionId) group.leader = null
      if (group.sessions.length < 2) {
        dropped.push(group)
        return false
      }
      return true
    })
    let freed = null
    if (changed) {
      scheduleSave()
      const linked = new Set(state.groups.flatMap((item) => item.sessions))
      for (const group of dropped) {
        const part = gcGroup(group, Array.from(linked))
        freed = freed || { recent: 0, votes: 0, dedupe: 0, pending: 0 }
        freed.recent += part.recent
        freed.votes += part.votes
        freed.dedupe += part.dedupe
        freed.pending += part.pending
      }
      if (!linked.has(sessionId)) {
        const part = gcGroup({ id: '', sessions: [sessionId] }, Array.from(linked))
        freed = freed || { recent: 0, votes: 0, dedupe: 0, pending: 0 }
        freed.recent += part.recent
        freed.dedupe += part.dedupe
        freed.pending += part.pending
      }
    }
    return { ok: true, groups: state.groups, freed, cache: cacheSummary() }
  }

  // ---------- 冗余数据回收 ----------

  /**
   * 清理与某个连接组绑定的运行时缓存。
   * 会话若仍属于其他组则保留其缓存；否则一并丢弃。
   */
  function gcGroup(group, keepSessionIds) {
    const owned = group ? group.sessions.filter((id) => !(keepSessionIds || []).includes(id)) : []
    const freed = { recent: 0, votes: 0, dedupe: 0, pending: 0 }
    for (const sessionId of owned) {
      const entries = recent.get(sessionId)
      if (entries && entries.length) {
        freed.recent += entries.length
        recent.delete(sessionId)
      }
      const queued = pendingDeliveries.get(sessionId)
      if (queued && queued.length) {
        freed.pending += queued.length
        pendingDeliveries.delete(sessionId)
      }
      for (const key of Array.from(relaySeen.keys())) {
        const cut = key.indexOf('\u0000')
        const owner = cut > 0 ? key.slice(0, cut) : key
        if (owner === sessionId) {
          relaySeen.delete(key)
          freed.dedupe += 1
        }
      }
    }
    if (group) {
      const before = votes.length
      for (let index = votes.length - 1; index >= 0; index -= 1) {
        if (votes[index].groupId === group.id) votes.splice(index, 1)
      }
      freed.votes = before - votes.length
    }
    return freed
  }

  function cacheSummary() {
    let recentEntries = 0
    for (const entries of recent.values()) recentEntries += entries.length
    let pendingItems = 0
    for (const items of pendingDeliveries.values()) pendingItems += items.length
    return {
      recentSessions: recent.size,
      recentEntries,
      votes: votes.length,
      dedupeKeys: relaySeen.size,
      pendingSessions: pendingDeliveries.size,
      pendingItems,
    }
  }

  function dissolve(groupId) {
    const group = state.groups.find((item) => item.id === groupId)
    if (!group) return { ok: false, error: '连接组不存在（可能已被解散）' }
    state.groups = state.groups.filter((item) => item.id !== groupId)
    scheduleSave()
    const stillLinked = new Set(state.groups.flatMap((item) => item.sessions))
    const freed = gcGroup(group, Array.from(stillLinked))
    return { ok: true, groups: state.groups, freed, cache: cacheSummary() }
  }

  /** 清理所有已解散组的孤儿缓存（成员都不在任何组里）。 */
  function gcOrphans() {
    const linked = new Set(state.groups.flatMap((item) => item.sessions))
    const freed = { recent: 0, votes: 0, dedupe: 0, pending: 0 }
    for (const sessionId of Array.from(recent.keys())) {
      if (linked.has(sessionId)) continue
      const entries = recent.get(sessionId)
      freed.recent += entries ? entries.length : 0
      recent.delete(sessionId)
    }
    for (const sessionId of Array.from(pendingDeliveries.keys())) {
      if (linked.has(sessionId)) continue
      const items = pendingDeliveries.get(sessionId)
      freed.pending += items ? items.length : 0
      pendingDeliveries.delete(sessionId)
    }
    for (const key of Array.from(relaySeen.keys())) {
      const cut = key.indexOf('\u0000')
      const sessionId = cut > 0 ? key.slice(0, cut) : key
      if (linked.has(sessionId)) continue
      relaySeen.delete(key)
      freed.dedupe += 1
    }
    const liveGroupIds = new Set(state.groups.map((item) => item.id))
    const before = votes.length
    for (let index = votes.length - 1; index >= 0; index -= 1) {
      if (!liveGroupIds.has(votes[index].groupId)) votes.splice(index, 1)
    }
    freed.votes = before - votes.length
    const total = freed.recent + freed.votes + freed.dedupe + freed.pending
    return { ok: true, freed, total, cache: cacheSummary() }
  }

  function rename(groupId, name) {
    const group = state.groups.find((item) => item.id === groupId)
    if (!group) return { ok: false, error: '连接组不存在' }
    const next = typeof name === 'string' ? name.trim() : ''
    if (!next) return { ok: false, error: '组名不能为空' }
    group.name = next
    scheduleSave()
    return { ok: true, groups: state.groups }
  }

  // ---------- HTTP 路由 ----------

  function sendJson(res, status, value) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }

  async function readBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  const traces = []

  function trace(entry) {
    traces.push({ at: Date.now(), ...entry })
    if (traces.length > 40) traces.shift()
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const route = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
      if (route !== 'trace' && req.method !== 'GET') trace({ method: req.method, route })
      if (req.method === 'GET' && route === 'trace') {
        sendJson(res, 200, { traces })
        return
      }
      await load()
      if (req.method === 'GET' && route === 'state') {
        if (!known) await listSessions()
        sendJson(res, 200, {
          groups: pruneGroups(),
          votes: votes.map(publicVote),
          colors: state.colors,
          options: state.options,
          stats: publicStats(),
          cache: cacheSummary(),
        })
        return
      }
      if (req.method === 'GET' && route === 'colors') {
        sendJson(res, 200, { colors: state.colors })
        return
      }
      if (req.method === 'GET' && route === 'options') {
        sendJson(res, 200, { ok: true, options: state.options, stats: publicStats() })
        return
      }
      if (req.method === 'GET' && route === 'sessions') {
        const sessions = await listSessions()
        pruneGroups()
        sendJson(res, 200, { sessions })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readBody(req)
      if (route === 'connect') {
        sendJson(res, 200, connect(body.sessionIds, body.name, body.groupId))
        return
      }
      if (route === 'disconnect') {
        sendJson(res, 200, disconnect(body.sessionId))
        return
      }
      if (route === 'dissolve') {
        sendJson(res, 200, dissolve(body.groupId))
        return
      }
      if (route === 'gc') {
        sendJson(res, 200, gcOrphans())
        return
      }
      if (route === 'rename') {
        sendJson(res, 200, rename(body.groupId, body.name))
        return
      }
      if (route === 'leader') {
        sendJson(res, 200, setLeader(body.groupId || body.sessionId, body.leaderSessionId))
        return
      }
      if (route === 'color') {
        sendJson(res, 200, setColor(body.sessionId, body.color))
        return
      }
      if (route === 'options') {
        sendJson(res, 200, setOptions(body))
        return
      }
      if (route === 'peers') {
        const group = groupOf(body.sessionId)
        sendJson(res, 200, { ok: true, group: group || null })
        return
      }
      if (route === 'send') {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        const target = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!text || !target) {
          sendJson(res, 200, { ok: false, error: '缺少 sessionId 或 text' })
          return
        }
        if (shouldSkipRelay(body.from || '', text)) {
          sendJson(res, 200, { ok: true, delivered: false, skipped: true, error: '' })
          return
        }
        const sent = await deliver(target, relayText(body.from || '', text))
        sendJson(res, 200, { ok: sent, delivered: sent, error: lastDeliverError })
        return
      }
      if (route === 'vote') {
        const task = typeof body.task === 'string' ? body.task.trim() : ''
        if (!task) {
          sendJson(res, 200, { ok: false, error: '缺少 task（要决策的任务描述）' })
          return
        }
        const mode = body.mode === 'order' ? 'order' : 'pick'
        const group = body.groupId
          ? state.groups.find((item) => item.id === body.groupId)
          : groupOf(body.sessionId)
        if (!group) {
          sendJson(res, 200, { ok: false, error: '找不到要投票的连接组' })
          return
        }
        if (group.sessions.length < 2) {
          sendJson(res, 200, { ok: false, error: '连接组至少需要两个会话才能投票' })
          return
        }
        const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 60000, 20000), 180000)
        const result = await runVote(group, task, mode, timeoutMs)
        sendJson(res, 200, result)
        return
      }
      if (route === 'read') {
        const target = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (!target) {
          sendJson(res, 200, { ok: false, error: '缺少 sessionId' })
          return
        }
        const limit = Math.min(Math.max(Number(body.limit) || 12, 1), 40)
        const entries = (recent.get(target) || []).slice(-limit)
        sendJson(res, 200, {
          ok: true,
          title: labelOf(target),
          entries: entries.map((entry) => ({ time: entry.time, role: entry.role, text: entry.text })),
        })
        return
      }
      if (route === 'announce') {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          sendJson(res, 200, { ok: false, error: '缺少 text（要通报的内容）' })
          return
        }
        let targets = Array.isArray(body.sessionIds) ? body.sessionIds.slice() : []
        if (!targets.length) {
          const group = body.groupId
            ? state.groups.find((item) => item.id === body.groupId)
            : groupOf(body.sessionId)
          if (group) targets = group.sessions.filter((id) => id !== body.sessionId)
        }
        if (!targets.length) {
          sendJson(res, 200, { ok: false, error: '没有选择要通报的会话' })
          return
        }
        const result = await announce(targets, text, body.sessionId || '')
        sendJson(res, 200, { ok: result.failed.length === 0, ...result })
        return
      }
      sendJson(res, 404, { ok: false, error: 'unknown route: ' + route })
    } catch (error) {
      log('HTTP 处理失败', error && error.message)
      try {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
      } catch {
        /* ignore */
      }
    }
  }

  ctx.effect(() => {
    try {
      return ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle })
    } catch (error) {
      log('注册 HTTP 路由失败', error)
      throw error
    }
  })

  // ---------- 系统提示 ----------

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'session-links',
      order: 620,
      text: (context) => {
        const sessionId = context && context.scope && context.scope.id
        if (!sessionId) return ''
        const group = groupOf(sessionId)
        if (!group) return ''
        const peers = group.sessions.filter((id) => id !== sessionId)
        if (peers.length === 0) return ''
        const names = peers.map((id) => '「' + labelOf(id) + '」').join('、')
        const leader = leaderOf(group)
        const lines = [
          '本会话属于「' + group.name + '」连接组，组内还有 ' + peers.length + ' 个相连会话：' + names + '。',
          '用户发来的每条消息会同时送达组内所有会话（对端会看到带〔来源〕前缀的紧凑副本，超长会截断并提示用 action=read 取全文）；这些会话运行在同一台机器与同一工作目录上，彼此产出的文件、脚本与结果可以互相查看和修改。',
          '需要协作时调用 session_links 工具：action=read 读取其他会话最近的消息与工具调用，action=send 向指定会话发一条消息，action=assign 向组员分派任务，action=announce 向组内发通报（对方只需知道，不必回复），action=status 查看组成员与组长。',
        ]
        if (leader === sessionId) {
          lines.push(
            '你是本连接组的**组长**。职责：',
            '1) 接到用户任务先判断规模：一个人能独立做完的，先派给组员而不是自己全做完；需要多人接力或互有依赖的，先定好分工与顺序。',
            '2) 派活用 session_links action=assign（peerSessionId + text），把目标、验收标准、所需输入、交付物写成组员能独立执行的一句话；不确定派给谁就用 action=vote mode=pick。',
            '3) 用 action=read 跟踪组员进展，用 action=announce 同步关键决定；组员迟迟不动时可以再 action=send 催一次并指明卡点。',
            '4) 组员的产出由你统一向用户汇报（讲清谁做了什么、结果在哪），不要让每个成员各自向用户汇报。',
            '5) 你是组长不是主力：不要替组员做他们份内的活，除非他们明确失败或该任务只有你能做。',
          )
        } else if (leader) {
          lines.push(
            '本组组长是「' + labelOf(leader) + '」。执行纪律：',
            '1) 收到组长分派的任务优先执行，不要自行改变分工；拿不准先 action=send 问组长。',
            '2) 完成后用 session_links action=send 把结果发给组长（给结论 + 产出文件路径，不写长篇解释），由组长向用户汇报。',
            '3) 不要抢做其他组员的份内任务；需要别的会话的资源时找组长协调。',
          )
        }
        lines.push(
          '会话自决策：判断用户这次的任务类型后，主动调用 session_links action=vote 发起组内投票——',
          '（1）任务可以被任意一个会话独立完成时，用 mode=pick：各会话提交执行大纲，互相查看后投票选出执行者；',
          '（2）任务有前后依赖、需要多个会话接力完成时，用 mode=order：各会话提交执行顺序，互相查看后投票确定顺序。',
          '投票重在高速度而非精细：直接给结论，不写长文、不调用其它工具。投票结果会自动通知全组，被选中的会话按结果执行。',
        )
        if (state.options.quiet) {
          lines.push(
            '静默执行（默认开启，省内存与上下文）：组内同步来的消息不需要长篇回复。只有两种情况要输出文字——① 任务失败或出现严重错误，需说明原因；② 用户在本会话里直接插话提问。其余情况处理完即可：' +
              (leader && leader !== sessionId
                ? '用 session_links action=send 把结论 + 产出路径报给组长，两行以内；'
                : leader === sessionId
                  ? '把结论用一句话说清即可；'
                  : '把结论用一句话说清即可；') +
              '不要复述任务、不要贴代码、不要写总结段落。',
          )
        }
        return lines.join('\n')
      },
    }),
  )

  // ---------- 协作工具 ----------

  ctx.effect(() =>
    ctx.tools.register({
      name: 'session_links',
      description:
        '连接会话协作工具。status：查看本会话所在的连接组（含组长）；read：读取组内其他会话最近的消息与工具调用摘要；send：向组内指定会话发送一条消息（对方会据此开始或继续工作）；assign：组长向组员分派一个具体任务（写明目标与交付物），组员会以执行优先处理并回报；vote：发起一轮组内投票（mode=pick 选出由谁执行；mode=order 排出多步任务的执行顺序），组内各会话互相查看方案后表决，结果会自动通知所有人；announce：向组内会话发一条通报（例如「我新装了某插件，之后大家都能用」），收件方只需知道、不必回复正文。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'read', 'send', 'assign', 'vote', 'announce'], description: '要执行的动作' },
          peerSessionId: { type: 'string', description: 'read / send / assign 的目标会话 id；省略时使用组内第一个其他会话' },
          text: { type: 'string', description: 'send 的消息文本、assign 的任务内容，或 announce 的通报内容' },
          sessionIds: { type: 'array', items: { type: 'string' }, description: 'announce 的目标会话 id 列表；省略时发给组内其他所有会话' },
          limit: { type: 'number', description: 'read 返回的条目数，默认 12，最大 40' },
          mode: { type: 'string', enum: ['pick', 'order'], description: 'vote 的模式：pick 选出执行者，order 排出执行顺序' },
          task: { type: 'string', description: 'vote 的任务描述（组内投票要决策的事情）' },
          timeoutMs: { type: 'number', description: 'vote 每轮等待的毫秒数，默认 45000' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, content: { type: 'string' } },
          required: ['ok', 'content'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: String((value && value.content) || '') }]
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : {}
        const selfId = exec && exec.agent ? exec.agent.id : undefined
        if (!selfId) return { ok: false, content: '该工具只能在某个会话的模型回合中调用。' }
        await load()
        const group = groupOf(selfId)
        if (!group) return { ok: false, content: '当前会话不属于任何连接组。' }
        const peerId = typeof input.peerSessionId === 'string' && group.sessions.includes(input.peerSessionId) && input.peerSessionId !== selfId
          ? input.peerSessionId
          : group.sessions.find((id) => id !== selfId)
        if (input.action === 'status') {
          const leader = leaderOf(group)
          const s = publicStats()
          const modeText = state.options.compact ? '紧凑转写' : '全文转写'
          const budgetText =
            '上下文节能：' + modeText +
            '，单条上限 ' + state.options.maxChars + ' 字' +
            (state.options.dedupeMs ? '，' + Math.round(state.options.dedupeMs / 1000) + ' 秒内重复消息跳过' : '') +
            '；已转发 ' + s.relays + ' 条、投递 ' + s.chars + ' 字（原文 ' + s.rawChars + ' 字，省下 ' + s.savedChars + ' 字/' + s.savedPercent + '%），跳过重复 ' + s.skipped + ' 条。'
          return {
            ok: true,
            content:
              '连接组「' + group.name + '」共 ' + group.sessions.length + ' 个会话' +
              (leader ? '，组长：' + labelOf(leader) + (leader === selfId ? '（就是本会话）' : '') : '，尚未任命组长') +
              '：\n' +
              group.sessions
                .map((id) =>
                  '- ' + labelOf(id) + '（' + id + '）' +
                  (id === selfId ? ' ← 本会话' : '') +
                  (id === leader ? ' ★组长' : ''),
                )
                .join('\n') +
              '\n' + budgetText,
          }
        }
        if (input.action === 'assign') {
          const leader = leaderOf(group)
          if (!leader) return { ok: false, content: '本连接组还没有组长，无法分派任务（请用户在连接会话面板里任命组长）。' }
          if (leader !== selfId) {
            return { ok: false, content: '只有组长才能分派任务；本组组长是「' + labelOf(leader) + '」。' }
          }
          const text = typeof input.text === 'string' ? input.text.trim() : ''
          if (!text) return { ok: false, content: '缺少 text 参数（要分派的任务内容）。' }
          if (!input.peerSessionId || !group.sessions.includes(input.peerSessionId) || input.peerSessionId === selfId) {
            return { ok: false, content: '请用 peerSessionId 指定一个组内的其他会话作为执行者。' }
          }
          const target = input.peerSessionId
          const body =
            '【组长分派·请执行】来自组长「' + labelOf(selfId) + '」的任务：\n' +
            text +
            '\n\n（这是组长分派给你的任务，请优先执行。完成后用 session_links action=send 把结果发给组长，只给结论 + 产出文件路径，不要长篇解释。）'
          const delivered = await deliver(target, body)
          return delivered
            ? { ok: true, content: '已把任务分派给「' + labelOf(target) + '」：\n' + text }
            : { ok: false, content: '向「' + labelOf(target) + '」分派任务失败。' }
        }
        if (input.action === 'vote') {
          const task = typeof input.task === 'string' ? input.task.trim() : ''
          if (!task) return { ok: false, content: '缺少 task 参数（要决策的任务描述）。' }
          const mode = input.mode === 'order' ? 'order' : 'pick'
          const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 45000, 20000), 180000)
          const result = await runVote(group, task, mode, timeoutMs)
          const record = result.vote
          const lines = [
            '投票模式：' + (mode === 'order' ? '排执行顺序' : '选执行者') +
              '　结果：' + (result.ok ? '已形成结论并通知全组' : '未形成结论（' + (result.error || '') + '）'),
            '各成员提案：',
          ]
          record.members.forEach((member, index) => {
            lines.push(
              '[' + (index + 1) + '] ' + member.label + '：' + (member.proposal || '（未提交）') +
                (member.vote ? '　← 表决：' + member.vote : ''),
            )
          })
          lines.push('')
          lines.push(voteResultText(record))
          return { ok: !!result.ok, content: lines.join('\n') }
        }
        if (input.action === 'announce') {
          const text = typeof input.text === 'string' ? input.text.trim() : ''
          if (!text) return { ok: false, content: '缺少 text 参数（要通报的内容）。' }
          const targets = Array.isArray(input.sessionIds) && input.sessionIds.length
            ? input.sessionIds.filter((id) => group.sessions.includes(id))
            : group.sessions.filter((id) => id !== selfId)
          if (!targets.length) return { ok: false, content: '没有可通报的会话。' }
          const result = await announce(targets, text, selfId)
          const lines = [
            '已向 ' + result.delivered.length + ' 个会话发出通报（不需要它们回复正文，只需知道）：',
            ...result.delivered.map((id) => '- ' + labelOf(id)),
          ]
          if (result.failed.length) {
            lines.push('以下会话投递失败：')
            result.failed.forEach((item) => lines.push('- ' + labelOf(item.sessionId) + '：' + item.error))
          }
          return { ok: result.failed.length === 0, content: lines.join('\n') }
        }
        if (!peerId) return { ok: false, content: '组内没有其他会话。' }
        if (input.action === 'read') {
          const limit = Math.min(Math.max(Number(input.limit) || 12, 1), 40)
          const entries = (recent.get(peerId) || []).slice(-limit)
          if (entries.length === 0) return { ok: true, content: '会话「' + labelOf(peerId) + '」暂时没有记录。' }
          const lines = entries.map((entry) => {
            const time = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })
            return '[' + time + '] ' + entry.role + '：' + entry.text
          })
          return {
            ok: true,
            content: '会话「' + labelOf(peerId) + '」（' + peerId + '）最近 ' + entries.length + ' 条记录：\n' + lines.join('\n'),
          }
        }
        if (input.action === 'send') {
          const text = typeof input.text === 'string' ? input.text.trim() : ''
          if (!text) return { ok: false, content: '缺少 text 参数。' }
          const delivered = await deliver(peerId, relayText(selfId, text))
          return delivered
            ? { ok: true, content: '已把消息发送到会话「' + labelOf(peerId) + '」。' }
            : { ok: false, content: '发送到会话「' + labelOf(peerId) + '」失败。' }
        }
        return { ok: false, content: '未知 action：' + String(input.action) }
      },
    }),
  )

  log('插件已加载，连接组文件：' + storeFile)
}
