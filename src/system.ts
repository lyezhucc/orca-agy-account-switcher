// 系统适配层（红队加固版）：
// - C-0: 通过 `orca terminal send` 跨任意工作区发送重启命令，绕开 Host API 仅限 active worktree 的限制；
// - C-1: `ps -A -o pid=,ppid=,ucomm=` 避免 macOS 16 字符截断，支持绝对路径 agy 与 Homebrew Shell；
// - C-2: lsof 同时匹配 `cli-*.log`、`acp-server-*.log` 与显式 `--log-file`，放开 `u` 读写模式；
// - C-5/M-2: 显式返回查询成功/失败/截断标记，绝不 Fail-Open 伪装成空数组；
// - H-3/L-2: 异步 fs/promises 读日志 + (size, mtimeMs) 缓存失效 + O(1) LRU + 尾优先防边界截断；
// - H-4: 发 SIGTERM 前校验 pid>1 且复核 ucomm+lstart 防 PID 复用，僵尸态 Z 立即判退；
// - H-8: `lsof -n -P` 防 DNS 反查超时，合并单次 `ps eww` 且跳过命令行前缀防伪造 env。
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open as fsOpen, stat as fsStat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import {
  classifyAgyCommand,
  extractExplicitLogFile,
  isAgyFamilyBinary,
  isManagedAcpBinary,
  isManagedAcpCommand,
  shouldIgnoreUnstructuredAcpProbe
} from './command-builder'
import type { AccountBucketGroup, AgyProcessKind } from './protocol'

const execFileAsync = promisify(execFile)
const MAX_LOG_CACHE_SIZE = 200

export interface QueryResult<T> {
  ok: boolean
  items: T[]
  truncated?: boolean
  degradedReason?: string | null
}

export interface RawOrcaAccount {
  id: string
  email: string
  label: string | null
  status: string
  sessionUsedPercent: number | null
  sessionResetsAt: number | null
  weeklyUsedPercent: number | null
  weeklyResetsAt: number | null
  buckets: AccountBucketGroup[]
  usageUpdatedAt?: number | null
}

export interface RawAccountState {
  activeAccountId: string | null
  selectedAccountId: string | null
  currentEmail: string | null
  accounts: RawOrcaAccount[]
  /** `orca account list` 探测到的宿主原生 Chat 是否走本机 `agy` 登录（超时竞速时可能缺省为 null）。 */
  chatUsesAgy?: boolean | null
  chatGoogleSignInInUse?: 'agy' | 'orca' | null
}

export interface RawOrcaTerminal {
  handle: string
  paneKey: string | null
  worktreeId: string | null
  worktreePath: string | null
  title: string
  connected: boolean
  writable: boolean
  agentIdentity: string | null
}

export interface RawOrcaAgent {
  orcaSessionId?: string | null
  kind?: string | null
  terminalId: string | null
  paneKey: string | null
  worktreeId: string | null
  workspace: string | null
  repo: string | null
  agent: string | null
  state: string
  title: string | null
}

export interface RawAgyProcess {
  pid: number
  ppid: number
  processKind: AgyProcessKind
  parentIsShell: boolean
  hasAgyAncestor: boolean
  startedAtText: string
  command: string
  terminalHandle: string | null
  worktreeId: string | null
  conversationId: string | null
  authEmail: string | null
  orcaSessionId?: string | null
  isStructuredSession?: boolean
  isManagedAcpServer?: boolean
}

export interface SystemAdapter {
  getAntigravityAccounts(): Promise<RawAccountState>
  selectAntigravityAccount(accountIdOrEmail: string): Promise<void>
  listOrcaTerminals(): Promise<QueryResult<RawOrcaTerminal>>
  listOrcaAgents(): Promise<QueryResult<RawOrcaAgent>>
  scanAgyProcesses(): Promise<QueryResult<RawAgyProcess>>
  sendTerminalText(
    terminalId: string,
    text: string,
    enter: boolean
  ): Promise<{ accepted: boolean; reason?: string }>
  stopProcessGracefully(
    pid: number,
    expectedStartedAtText?: string | null,
    timeoutMs?: number
  ): Promise<boolean>
  waitForShellReady(parentPid: number, timeoutMs?: number): Promise<boolean>
  isProcessAlive(pid: number): boolean
  pathExists(p: string): boolean
  sleep(ms: number): Promise<void>
}

const SHELL_BASENAMES = new Set(['zsh', 'bash', 'fish', 'sh'])

function resolveBinary(candidates: readonly (string | undefined)[], fallback: string): string {
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return fallback
}

function resolveOrcaBin(): string {
  return resolveBinary(
    [
      process.env.ORCA_CLI_COMMAND,
      process.env.ORCA_CLI_BIN_DIR ? join(process.env.ORCA_CLI_BIN_DIR, 'orca') : undefined,
      '/Applications/Orca.app/Contents/Resources/bin/orca',
      '/opt/homebrew/bin/orca',
      '/usr/local/bin/orca'
    ],
    'orca'
  )
}

const PS_BIN = resolveBinary(['/bin/ps', '/usr/bin/ps'], 'ps')
const LSOF_BIN = resolveBinary(['/usr/sbin/lsof', '/usr/bin/lsof'], 'lsof')

async function runCmd(
  file: string,
  args: string[],
  timeoutMs = 15000,
  extraEnv?: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer: 12 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}:/Applications/Orca.app/Contents/Resources/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        ...extraEnv
      }
    })
    return { stdout, stderr, code: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
      code: typeof e.code === 'number' ? e.code : 1
    }
  }
}

function safeParseJson<T>(raw: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(raw) as T }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// 要求邮箱后必须紧跟逗号或换行，杜绝读取窗口恰好截断在邮箱中间产生半截毒邮箱
const AUTH_EMAIL_RE = /applyAuthResult:\s*email=([^,\s\r\n]+)(?=[,\r\n])/g

function findLastAuthEmail(text: string): string | null {
  let last: string | null = null
  for (const m of text.matchAll(AUTH_EMAIL_RE)) {
    if (m[1]) last = m[1]
  }
  return last
}

/**
 * 异步读取 agy/acp 日志中的最新登录邮箱：
 * - 优先读文件末尾 256 KiB 取最后一个完整匹配（覆盖启动后手动 /login 换号）；
 * - 若未命中且文件大于 256 KiB，再读文件头部 128 KiB 兜底。
 */
async function readAuthEmailFromLogAsync(logPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fsOpen>> | null = null
  try {
    handle = await fsOpen(logPath, 'r')
    const st = await handle.stat()
    if (st.size <= 0) return null

    const tailSize = Math.min(262144, st.size)
    const tailPos = Math.max(0, st.size - tailSize)
    const tailBuf = Buffer.allocUnsafe(tailSize)
    const { bytesRead: tailRead } = await handle.read(tailBuf, 0, tailSize, tailPos)
    if (tailRead > 0) {
      const hit = findLastAuthEmail(tailBuf.subarray(0, tailRead).toString('utf8'))
      if (hit) return hit
    }

    if (tailPos > 0) {
      const headSize = Math.min(131072, tailPos)
      const headBuf = Buffer.allocUnsafe(headSize)
      const { bytesRead: headRead } = await handle.read(headBuf, 0, headSize, 0)
      if (headRead > 0) {
        const hit = findLastAuthEmail(headBuf.subarray(0, headRead).toString('utf8'))
        if (hit) return hit
      }
    }
    return null
  } catch {
    return null
  } finally {
    if (handle) {
      await handle.close().catch(() => {})
    }
  }
}

/**
 * 解析 `lsof -n -P -Fpfan` 输出：
 * - 匹配 `cli-*.log`、`acp-server-*.log` 或显式 `--log-file` 路径，允许 fd 1/2 及写/读写模式 (`w`/`u`)；
 * - 匹配 `presence/<uuid>.lock` 提取精确 conversationId。
 */
export function parseLsofOutput(
  stdout: string,
  explicitLogFiles?: ReadonlyMap<number, string>
): Map<number, { logPath: string | null; conversationId: string | null }> {
  const result = new Map<number, { logPath: string | null; conversationId: string | null }>()
  let currentPid: number | null = null
  let currentFd: string | null = null
  let currentAccess: string | null = null

  const ensure = (pid: number) => {
    let entry = result.get(pid)
    if (!entry) {
      entry = { logPath: null, conversationId: null }
      result.set(pid, entry)
    }
    return entry
  }

  for (const rawLine of stdout.split('\n')) {
    if (!rawLine) continue
    const tag = rawLine[0]
    const value = rawLine.slice(1)
    if (tag === 'p') {
      const parsed = Number.parseInt(value, 10)
      currentPid = Number.isFinite(parsed) ? parsed : null
      currentFd = null
      currentAccess = null
    } else if (tag === 'f') {
      currentFd = value
      currentAccess = null
    } else if (tag === 'a') {
      currentAccess = value
    } else if (tag === 'n' && currentPid !== null) {
      const entry = ensure(currentPid)
      const isWritableFd =
        currentFd === '1' || currentFd === '2' || currentAccess === 'w' || currentAccess === 'u'
      const explicitPath = explicitLogFiles?.get(currentPid)
      const isLogMatch =
        /\/antigravity-cli\/log\/(?:cli|acp-server)-[^/]+\.log$/.test(value) ||
        (Boolean(explicitPath) && value === explicitPath)

      if (isWritableFd && isLogMatch) {
        // 优先保留 fd 1 / fd 2 写入日志，避免被次要日志覆盖
        if (!entry.logPath || currentFd === '1' || currentFd === '2') {
          entry.logPath = value
        }
      }
      if (!entry.conversationId) {
        const lockMatch = value.match(/\/antigravity-cli\/presence\/([0-9a-f-]{36})\.lock$/i)
        if (lockMatch?.[1]) {
          entry.conversationId = lockMatch[1]
        }
      }
    }
  }

  return result
}

export interface ParsedPsEnvInfo {
  terminalHandle: string | null
  worktreeId: string | null
  orcaSessionId: string | null
  isStructuredSession: boolean
  geminiHome: string | null
  hasEnvData: boolean
}

/**
 * 解析合并 `ps eww -o pid=,command= -p <pids>` 输出，跳过已知命令行前缀后再提取环境变量，
 * 避免命令行参数中的文本伪造 `ORCA_TERMINAL_HANDLE=` / `ORCA_AGENT_SESSION_ID=`。
 */
export function parsePsEnvOutput(
  stdout: string,
  commandByPid: ReadonlyMap<number, string>
): Map<number, ParsedPsEnvInfo> {
  const result = new Map<number, ParsedPsEnvInfo>()
  for (const rawLine of stdout.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    const m = trimmed.match(/^(\d+)\s+([\s\S]+)$/)
    if (!m) continue
    const pid = Number.parseInt(m[1]!, 10)
    if (!Number.isFinite(pid)) continue

    let rest = m[2]!
    const knownCmd = commandByPid.get(pid)
    if (knownCmd && rest.startsWith(knownCmd)) {
      rest = rest.slice(knownCmd.length)
    }

    const hasEnvData = /(?:^|\s)[A-Z_][A-Z0-9_]*=/.test(rest)
    const handleMatch = rest.match(/(?:^|\s)ORCA_TERMINAL_HANDLE=([^\s]+)/)
    // ORCA_WORKTREE_ID / GEMINI_HOME 可能含空格路径，直到下一个 ` KEY=` 环境变量起点或行尾
    const wtMatch = rest.match(/(?:^|\s)ORCA_WORKTREE_ID=(.+?)(?=\s+[A-Z_][A-Z0-9_]*=|$)/)
    const sessionMatch = rest.match(/(?:^|\s)ORCA_AGENT_SESSION_ID=([^\s]+)/)
    const structuredMatch = rest.match(/(?:^|\s)ORCA_STRUCTURED_SESSION=([^\s]+)/)
    const geminiHomeMatch = rest.match(/(?:^|\s)GEMINI_HOME=(.+?)(?=\s+[A-Z_][A-Z0-9_]*=|$)/)
    const structuredVal = structuredMatch?.[1]?.trim().toLowerCase() ?? ''

    result.set(pid, {
      terminalHandle: handleMatch?.[1] ?? null,
      worktreeId: wtMatch?.[1]?.trim() ?? null,
      orcaSessionId: sessionMatch?.[1]?.trim() ?? null,
      isStructuredSession: structuredVal === '1' || structuredVal === 'true',
      geminiHome: geminiHomeMatch?.[1]?.trim() ?? null,
      hasEnvData
    })
  }
  return result
}

function isProcessAliveImpl(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    return code === 'EPERM'
  }
}

function sleepImpl(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface LogCacheEntry {
  size: number
  mtimeMs: number
  email: string | null
}

export interface RawUsageBucketInput {
  name?: string | null
  group?: string | null
  windowName?: string | null
  windowMinutes?: number | null
  usedPercent?: number | null
  resetsAt?: number | null
}

/**
 * 将 Orca `usage.buckets` 按模型池分组汇总为独立的 5h / 周窗口，
 * 避免与顶层跨池汇总字段（`usage.session` / `usage.weekly`）混用导致池间串值。
 */
export function parseAccountBuckets(
  buckets: readonly RawUsageBucketInput[] | null | undefined
): AccountBucketGroup[] {
  const groupMap = new Map<string, AccountBucketGroup>()
  for (const b of buckets ?? []) {
    const fallbackGroup = b.name?.split('·')[0]?.trim()
    const groupName = b.group?.trim() || fallbackGroup
    if (!groupName) continue
    let item = groupMap.get(groupName)
    if (!item) {
      item = {
        group: groupName,
        sessionUsedPercent: null,
        sessionResetsAt: null,
        weeklyUsedPercent: null,
        weeklyResetsAt: null
      }
      groupMap.set(groupName, item)
    }
    // 优先使用结构化字段 windowMinutes / windowName 判定窗口类型，仅在均缺省时兜底解析 name，避免模型名误匹配
    const winNameLower = (b.windowName ?? '').toLowerCase()
    const fullNameLower = (b.name ?? '').toLowerCase()
    const isWeeklyByStruct =
      (typeof b.windowMinutes === 'number' && Number.isFinite(b.windowMinutes) && b.windowMinutes >= 1440) ||
      winNameLower.includes('weekly') ||
      winNameLower.includes('week') ||
      winNameLower.includes('7d')
    const isFiveHourByStruct =
      !isWeeklyByStruct &&
      ((typeof b.windowMinutes === 'number' &&
        Number.isFinite(b.windowMinutes) &&
        b.windowMinutes > 0 &&
        b.windowMinutes < 1440) ||
        winNameLower.includes('five hour') ||
        winNameLower.includes('5 hour') ||
        winNameLower.includes('5h'))
    const isWeekly =
      isWeeklyByStruct ||
      (!isFiveHourByStruct &&
        (fullNameLower.includes('weekly') ||
          fullNameLower.includes('week') ||
          fullNameLower.includes('7d')))
    const isFiveHour =
      isFiveHourByStruct ||
      (!isWeekly &&
        (fullNameLower.includes('five hour') ||
          fullNameLower.includes('5 hour') ||
          fullNameLower.includes('5h')))

    if (isWeekly) {
      if (typeof b.usedPercent === 'number' && Number.isFinite(b.usedPercent)) {
        item.weeklyUsedPercent = b.usedPercent
      }
      if (typeof b.resetsAt === 'number' && Number.isFinite(b.resetsAt)) {
        item.weeklyResetsAt = b.resetsAt
      }
    } else if (isFiveHour) {
      if (typeof b.usedPercent === 'number' && Number.isFinite(b.usedPercent)) {
        item.sessionUsedPercent = b.usedPercent
      }
      if (typeof b.resetsAt === 'number' && Number.isFinite(b.resetsAt)) {
        item.sessionResetsAt = b.resetsAt
      }
    }
  }
  return [...groupMap.values()]
}

export class RealSystemAdapter implements SystemAdapter {
  private readonly orcaBin = resolveOrcaBin()
  private readonly logEmailCache = new Map<string, LogCacheEntry>()

  private async getCachedLogEmail(logPath: string): Promise<string | null> {
    try {
      const st = await fsStat(logPath)
      const cached = this.logEmailCache.get(logPath)
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        // O(1) LRU：命中后移至末尾
        this.logEmailCache.delete(logPath)
        this.logEmailCache.set(logPath, cached)
        return cached.email
      }
      const email = await readAuthEmailFromLogAsync(logPath)
      if (this.logEmailCache.size >= MAX_LOG_CACHE_SIZE) {
        const oldestKey = this.logEmailCache.keys().next().value
        if (oldestKey) this.logEmailCache.delete(oldestKey)
      }
      this.logEmailCache.set(logPath, { size: st.size, mtimeMs: st.mtimeMs, email })
      return email
    } catch {
      return null
    }
  }

  async getAntigravityAccounts(): Promise<RawAccountState> {
    const res = await runCmd(this.orcaBin, ['account', 'list', '--json'], 25000)
    if (res.code !== 0) {
      throw new Error(`orca account list 失败：${res.stderr.trim() || res.stdout.trim()}`)
    }
    const parsedRes = safeParseJson<{
      ok?: boolean
      error?: { message?: string }
      result?: {
        antigravity?: {
          activeAccountId?: string | null
          selectedAccountId?: string | null
          currentAccount?: { email?: string | null } | null
          chatUsesAgy?: boolean | null
          chatGoogleSignInInUse?: string | null
          accounts?: Array<{
            id: string
            email: string
            label?: string | null
            usage?: {
              status?: string
              updatedAt?: number | null
              session?: { usedPercent?: number | null; resetsAt?: number | null } | null
              weekly?: { usedPercent?: number | null; resetsAt?: number | null } | null
              buckets?: Array<RawUsageBucketInput> | null
            } | null
          }>
        }
      }
    }>(res.stdout)

    if (!parsedRes.ok) {
      throw new Error(`解析 orca account list 输出失败：${parsedRes.error}`)
    }
    if (parsedRes.data.ok === false) {
      throw new Error(parsedRes.data.error?.message || 'orca account list 返回 ok: false')
    }
    const ag = parsedRes.data.result?.antigravity
    if (!ag) {
      throw new Error('Orca 返回中未找到 Antigravity 账号信息')
    }

    const accounts: RawOrcaAccount[] = (ag.accounts ?? []).map((a) => {
      const buckets = parseAccountBuckets(a.usage?.buckets)

      const hasUsageObject = a.usage != null
      const status = hasUsageObject ? (a.usage?.status ?? 'unknown') : 'unfetched'
      const usageUpdatedAt =
        typeof a.usage?.updatedAt === 'number' && Number.isFinite(a.usage.updatedAt)
          ? a.usage.updatedAt
          : null

      return {
        id: a.id,
        email: a.email,
        label: a.label ?? null,
        status,
        sessionUsedPercent:
          typeof a.usage?.session?.usedPercent === 'number' &&
          Number.isFinite(a.usage.session.usedPercent)
            ? a.usage.session.usedPercent
            : null,
        sessionResetsAt:
          typeof a.usage?.session?.resetsAt === 'number' &&
          Number.isFinite(a.usage.session.resetsAt)
            ? a.usage.session.resetsAt
            : null,
        weeklyUsedPercent:
          typeof a.usage?.weekly?.usedPercent === 'number' &&
          Number.isFinite(a.usage.weekly.usedPercent)
            ? a.usage.weekly.usedPercent
            : null,
        weeklyResetsAt:
          typeof a.usage?.weekly?.resetsAt === 'number' &&
          Number.isFinite(a.usage.weekly.resetsAt)
            ? a.usage.weekly.resetsAt
            : null,
        buckets,
        usageUpdatedAt
      }
    })
    return {
      activeAccountId: ag.activeAccountId ?? null,
      selectedAccountId: ag.selectedAccountId ?? null,
      currentEmail: ag.currentAccount?.email ?? null,
      accounts,
      chatUsesAgy: typeof ag.chatUsesAgy === 'boolean' ? ag.chatUsesAgy : null,
      chatGoogleSignInInUse:
        ag.chatGoogleSignInInUse === 'agy' || ag.chatGoogleSignInInUse === 'orca'
          ? ag.chatGoogleSignInInUse
          : null
    }
  }

  async selectAntigravityAccount(accountIdOrEmail: string): Promise<void> {
    const res = await runCmd(
      this.orcaBin,
      ['account', 'select', '--agent', 'antigravity', '--account', accountIdOrEmail, '--json'],
      20000
    )
    if (res.code !== 0) {
      throw new Error(`orca account select 失败：${res.stderr.trim() || res.stdout.trim()}`)
    }
    const parsed = safeParseJson<{ ok?: boolean; error?: { message?: string } }>(res.stdout)
    if (parsed.ok && parsed.data.ok === false) {
      throw new Error(parsed.data.error?.message || 'orca account select 返回失败')
    }
  }

  async listOrcaTerminals(): Promise<QueryResult<RawOrcaTerminal>> {
    const res = await runCmd(this.orcaBin, ['terminal', 'list', '--limit', '500', '--json'], 15000)
    if (res.code !== 0) {
      return {
        ok: false,
        items: [],
        degradedReason: `orca terminal list 失败：${res.stderr.trim() || `exit ${res.code}`}`
      }
    }
    const parsed = safeParseJson<{
      ok?: boolean
      error?: { message?: string }
      result?: {
        truncated?: boolean
        terminals?: Array<{
          handle: string
          tabId?: string | null
          leafId?: string | null
          worktreeId?: string | null
          worktreePath?: string | null
          title?: string | null
          connected?: boolean
          writable?: boolean
          agentIdentity?: string | null
        }>
      }
    }>(res.stdout)

    if (!parsed.ok || parsed.data.ok === false) {
      return {
        ok: false,
        items: [],
        degradedReason: parsed.ok
          ? parsed.data.error?.message || 'orca terminal list 返回失败'
          : `解析 terminal list 失败：${parsed.error}`
      }
    }

    const truncated = Boolean(parsed.data.result?.truncated)
    const items = (parsed.data.result?.terminals ?? []).map((t) => ({
      handle: t.handle,
      paneKey: t.tabId && t.leafId ? `${t.tabId}:${t.leafId}` : null,
      worktreeId: t.worktreeId ?? null,
      worktreePath: t.worktreePath ?? null,
      title: t.title ?? 'Terminal',
      connected: Boolean(t.connected),
      writable: Boolean(t.writable),
      agentIdentity: t.agentIdentity ?? null
    }))
    return {
      ok: true,
      items,
      truncated,
      degradedReason: truncated ? 'Orca 终端数量超过 500 发生了分页截断' : null
    }
  }

  async listOrcaAgents(): Promise<QueryResult<RawOrcaAgent>> {
    const res = await runCmd(this.orcaBin, ['agent', 'list', '--json'], 15000)
    if (res.code !== 0) {
      return {
        ok: false,
        items: [],
        degradedReason: `orca agent list 失败：${res.stderr.trim() || `exit ${res.code}`}`
      }
    }
    const parsed = safeParseJson<{
      ok?: boolean
      error?: { message?: string }
      result?: {
        truncated?: boolean
        agents?: Array<{
          orcaSessionId?: string | null
          kind?: string
          agent?: string | null
          state?: string
          worktreeId?: string | null
          workspace?: string | null
          repo?: string | null
          paneKey?: string | null
          title?: string | null
        }>
      }
    }>(res.stdout)

    if (!parsed.ok || parsed.data.ok === false) {
      return {
        ok: false,
        items: [],
        degradedReason: parsed.ok
          ? parsed.data.error?.message || 'orca agent list 返回失败'
          : `解析 agent list 失败：${parsed.error}`
      }
    }

    const truncated = Boolean(parsed.data.result?.truncated)
    const items = (parsed.data.result?.agents ?? []).map((a) => ({
      orcaSessionId: a.orcaSessionId ?? null,
      kind: a.kind ?? null,
      terminalId: null,
      paneKey: a.paneKey ?? null,
      worktreeId: a.worktreeId ?? null,
      workspace: a.workspace ?? null,
      repo: a.repo ?? null,
      agent: a.agent ?? null,
      state: a.state ?? 'unknown',
      title: a.title ?? null
    }))
    return {
      ok: true,
      items,
      truncated,
      degradedReason: truncated ? 'orca agent list 返回被截断' : null
    }
  }

  async scanAgyProcesses(): Promise<QueryResult<RawAgyProcess>> {
    // 第 1 步：用 `ucomm=`（纯进程名，不受 macOS comm= 16 字符路径截断影响！）获取全系统进程树
    const psTree = await runCmd(PS_BIN, ['-A', '-o', 'pid=,ppid=,ucomm='], 8000, { LC_TIME: 'C' })
    if (psTree.code !== 0) {
      return {
        ok: false,
        items: [],
        degradedReason: `扫描系统进程失败：${psTree.stderr.trim() || `exit ${psTree.code}`}`
      }
    }

    const procMeta = new Map<number, { ppid: number; ucomm: string }>()
    const agyPids: number[] = []

    for (const rawLine of psTree.stdout.split('\n')) {
      const m = rawLine.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = Number.parseInt(m[1]!, 10)
      const ppid = Number.parseInt(m[2]!, 10)
      const ucomm = m[3]!.trim()
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      procMeta.set(pid, { ppid, ucomm })
      if (isAgyFamilyBinary(ucomm)) {
        agyPids.push(pid)
      }
    }

    if (agyPids.length === 0) {
      return { ok: true, items: [] }
    }

    const pidList = agyPids.join(',')

    // 第 2 步：对筛选出的 agy PID 批量拉取未截断启动时间+命令行、单次合并 env、以及 `lsof -n -P`
    const [psArgs, psEnv, lsofInfo] = await Promise.all([
      runCmd(PS_BIN, ['-ww', '-o', 'pid=,lstart=,args=', '-p', pidList], 6000, { LC_TIME: 'C' }),
      runCmd(PS_BIN, ['eww', '-o', 'pid=,command=', '-p', pidList], 6000, { LC_TIME: 'C' }),
      runCmd(LSOF_BIN, ['-n', '-P', '-Fpfan', '-p', pidList], 8000)
    ])

    if (psArgs.code !== 0) {
      return {
        ok: false,
        items: [],
        degradedReason: `读取 agy 命令行失败：${psArgs.stderr.trim() || `exit ${psArgs.code}`}`
      }
    }

    const degradedNotes: string[] = []
    const lineRe =
      /^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/

    const basicRows: Array<{
      pid: number
      ppid: number
      processKind: AgyProcessKind
      isManagedBinary: boolean
      startedAtText: string
      command: string
    }> = []
    const commandByPid = new Map<number, string>()
    const explicitLogFiles = new Map<number, string>()

    for (const rawLine of psArgs.stdout.split('\n')) {
      const m = rawLine.trim().match(lineRe)
      if (!m) continue
      const pid = Number.parseInt(m[1]!, 10)
      const startedAtText = m[2]!
      const cmd = m[3]!.trim()
      const kind = classifyAgyCommand(cmd)
      if (kind === 'ignore') continue

      const meta = procMeta.get(pid)
      const isManagedByUcomm = meta ? isManagedAcpBinary(meta.ucomm) : false
      const isManagedByCmd = isManagedAcpCommand(cmd)
      // macOS ucomm 截断为 16 字节 (`agy_acp_server.p`)，若遇同前 16 字但非 `.par`/`.exe` 的杂鱼进程需在此剔除
      if (isManagedByUcomm && !isManagedByCmd) continue
      const isManagedBinary = isManagedByCmd
      basicRows.push({
        pid,
        ppid: meta?.ppid ?? 0,
        processKind: kind,
        isManagedBinary,
        startedAtText,
        command: cmd
      })
      commandByPid.set(pid, cmd)
      const explicitLog = extractExplicitLogFile(cmd)
      if (explicitLog) explicitLogFiles.set(pid, explicitLog)
    }

    if (basicRows.length === 0) {
      return { ok: true, items: [] }
    }

    // macOS 上 lsof -p <多PID> 只要含 1 个刚退出的短命进程就会返回 exit 1，但 stdout 仍包含其余活进程的完整数据！
    // 先结合 psEnv 剔除后台短命探活 `agy acp` 鬼影，再判定真实存活目标是否缺失 lsof 记录。
    const lsofHasStdout = lsofInfo.stdout.trim().length > 0
    const lsofMap = lsofHasStdout ? parseLsofOutput(lsofInfo.stdout, explicitLogFiles) : new Map()
    const envMap =
      psEnv.stdout.trim().length > 0 ? parsePsEnvOutput(psEnv.stdout, commandByPid) : new Map()

    const activeRows = basicRows.filter((row) => {
      const envInfo = envMap.get(row.pid)
      return !shouldIgnoreUnstructuredAcpProbe({
        processKind: row.processKind,
        isManagedAcpServer: row.isManagedBinary,
        hasEnvData: Boolean(envInfo?.hasEnvData),
        isStructuredSession: Boolean(envInfo?.isStructuredSession),
        orcaSessionId: envInfo?.orcaSessionId ?? null,
        terminalHandle: envInfo?.terminalHandle ?? null
      })
    })

    if (activeRows.length === 0) {
      return { ok: true, items: [] }
    }

    const missingLiveLsof =
      lsofInfo.code !== 0 &&
      activeRows.some((r) => !lsofMap.has(r.pid) && isProcessAliveImpl(r.pid))
    if (missingLiveLsof) {
      degradedNotes.push('lsof 扫描不完整（部分会话 ID 或邮箱可能缺失）')
    }

    const hasAgyAncestor = (pid: number): boolean => {
      let cur = procMeta.get(pid)?.ppid ?? 0
      const visited = new Set<number>([pid])
      while (cur > 1 && !visited.has(cur)) {
        visited.add(cur)
        const meta = procMeta.get(cur)
        if (!meta) break
        if (isAgyFamilyBinary(meta.ucomm)) return true
        cur = meta.ppid
      }
      return false
    }

    const items = await Promise.all(
      activeRows.map(async (row): Promise<RawAgyProcess> => {
        const fdInfo = lsofMap.get(row.pid)
        const envInfo = envMap.get(row.pid)
        const isManagedAcpServer =
          row.isManagedBinary || Boolean(envInfo?.geminiHome?.includes('antigravity-chat'))
        const logPath =
          !isManagedAcpServer ? fdInfo?.logPath ?? explicitLogFiles.get(row.pid) ?? null : null
        const authEmail = logPath ? await this.getCachedLogEmail(logPath) : null

        const cmdConvMatch = row.command.match(/--conversation(?:=|\s+)([0-9a-f-]{36})/i)
        const conversationId = fdInfo?.conversationId ?? cmdConvMatch?.[1] ?? null

        const parentUcomm = procMeta.get(row.ppid)?.ucomm ?? ''
        const parentBase = basename(parentUcomm.replace(/^-/, ''))
        const parentIsShell = row.processKind === 'cli' && SHELL_BASENAMES.has(parentBase)

        return {
          pid: row.pid,
          ppid: row.ppid,
          processKind: row.processKind,
          parentIsShell,
          hasAgyAncestor: hasAgyAncestor(row.pid),
          startedAtText: row.startedAtText,
          command: row.command,
          terminalHandle: envInfo?.terminalHandle ?? null,
          worktreeId: envInfo?.worktreeId ?? null,
          conversationId,
          authEmail,
          orcaSessionId: envInfo?.orcaSessionId ?? null,
          isStructuredSession: Boolean(envInfo?.isStructuredSession),
          isManagedAcpServer
        }
      })
    )

    return {
      ok: !missingLiveLsof,
      items,
      degradedReason: degradedNotes.length > 0 ? degradedNotes.join('；') : null
    }
  }

  /**
   * 通过 `orca terminal send` 向任意工作区的终端发送文本（不受插件 Host API 仅限当前聚焦工作区的约束）。
   */
  async sendTerminalText(
    terminalId: string,
    text: string,
    enter: boolean
  ): Promise<{ accepted: boolean; reason?: string }> {
    const args = ['terminal', 'send', '--terminal', terminalId, `--text=${text}`]
    if (enter) args.push('--enter')
    args.push('--json')

    const res = await runCmd(this.orcaBin, args, 15000)
    if (res.code !== 0) {
      return {
        accepted: false,
        reason: res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`
      }
    }
    const parsed = safeParseJson<{
      ok?: boolean
      error?: { message?: string }
      result?: { accepted?: boolean; send?: { accepted?: boolean; refusedReason?: string } }
    }>(res.stdout)
    if (!parsed.ok) {
      return { accepted: true }
    }
    if (parsed.data.ok === false) {
      return { accepted: false, reason: parsed.data.error?.message || 'terminal send 拒绝请求' }
    }
    const accepted =
      parsed.data.result?.accepted ?? parsed.data.result?.send?.accepted ?? true
    return {
      accepted: Boolean(accepted),
      reason: parsed.data.result?.send?.refusedReason
    }
  }

  /**
   * 带 PID 复用复核与僵尸态检测的优雅停止：
   * - 强校验 `pid > 1`；
   * - 发 SIGTERM 前复核进程仍是 `agy` 且启动时间一致（防 PID 复用误杀）；
   * - 进程消失或进入 Zombie (`Z`) 态即刻视为退出。
   */
  async stopProcessGracefully(
    pid: number,
    expectedStartedAtText?: string | null,
    timeoutMs = 12000
  ): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 1) return false
    if (!isProcessAliveImpl(pid)) return true

    // 复核目标进程身份，防 PID 复用误杀其他无关进程
    const verify = await runCmd(PS_BIN, ['-o', 'ucomm=,stat=,lstart=', '-p', String(pid)], 3000, {
      LC_TIME: 'C'
    })
    if (verify.code !== 0 || !verify.stdout.trim()) {
      return true
    }
    const vm = verify.stdout
      .trim()
      .match(/^(\S+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\d{4})$/)
    if (vm) {
      const ucommBase = basename(vm[1]!.replace(/^-/, ''))
      const statStr = vm[2]!
      const actualLstart = vm[3]!
      if (statStr.startsWith('Z')) return true
      if (ucommBase !== 'agy') return false
      if (expectedStartedAtText && actualLstart !== expectedStartedAtText) {
        return false
      }
    }

    try {
      process.kill(pid, 'SIGTERM')
    } catch (err: unknown) {
      const code = (err as { code?: string }).code
      if (code === 'ESRCH') return true
      return false
    }

    const deadline = Date.now() + timeoutMs
    let ticks = 0
    while (Date.now() < deadline) {
      await sleepImpl(150)
      if (!isProcessAliveImpl(pid)) return true
      ticks += 1
      // 每隔约 750ms 检查一次是否已进入僵尸态 Z
      if (ticks % 5 === 0) {
        const st = await runCmd(PS_BIN, ['-o', 'stat=', '-p', String(pid)], 2000)
        if (st.code !== 0 || !st.stdout.trim() || st.stdout.trim().startsWith('Z')) {
          return true
        }
      }
    }
    return !isProcessAliveImpl(pid)
  }

  /**
   * 轮询确认父级交互 Shell 仍存活且其下无正在占用前台（stat 含 `+`）的非僵尸子进程，
   * 既避免被后台 `&` 服务 / p10k `gitstatusd` 误拖 1.5s，又防止向刚启动的前台程序（如 vim）注入命令。
   */
  async waitForShellReady(parentPid: number, timeoutMs = 1500): Promise<boolean> {
    if (!Number.isInteger(parentPid) || parentPid <= 1) return false
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isProcessAliveImpl(parentPid)) return false
      const psRes = await runCmd(PS_BIN, ['-A', '-o', 'pid=,ppid=,stat='], 3000)
      if (psRes.code === 0) {
        let hasForegroundChild = false
        for (const line of psRes.stdout.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/)
          if (!m) continue
          const ppid = Number.parseInt(m[2]!, 10)
          const stat = m[3]!
          if (ppid === parentPid && !stat.startsWith('Z') && stat.includes('+')) {
            hasForegroundChild = true
            break
          }
        }
        if (!hasForegroundChild) {
          await sleepImpl(250)
          return isProcessAliveImpl(parentPid)
        }
      }
      await sleepImpl(120)
    }
    return isProcessAliveImpl(parentPid)
  }

  isProcessAlive(pid: number): boolean {
    return isProcessAliveImpl(pid)
  }

  pathExists(p: string): boolean {
    return existsSync(p)
  }

  sleep(ms: number): Promise<void> {
    return sleepImpl(ms)
  }
}

export function getHomeAgyLogDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'log')
}
