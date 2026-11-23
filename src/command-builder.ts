// 纯函数工具：邮箱规范化、命令分类、白名单安全命令重构、最优账号选择、状态栏展示计算。
import type { AccountInfo, SwitcherSnapshot, WorkingPolicy } from './protocol'

// 不允许以 `=` 开头（防止 zsh EQUALS 扩展将 `=cmd` 展开成路径）
const SAFE_TOKEN_RE = /^[A-Za-z0-9_@%+:,.\/-][A-Za-z0-9_@%+=:,./-]*$/
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g

const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'acp',
  'agent',
  'agents',
  'changelog',
  'help',
  'install',
  'mcp',
  'mic-serve',
  'models',
  'plugin',
  'plugins',
  'remote-control',
  'update'
])

/** 已知安全可重放的持久会话无值布尔标志（白名单）。 */
const SAFE_BOOL_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--sandbox',
  '--remote-agent',
  '--remote-control',
  '--disable-slash-commands'
])

/** 已知安全可重放的持久会话带值标志（白名单）。明确排除 -i / --prompt-interactive / --new-project / --print / --prompt。 */
const SAFE_VALUE_FLAGS = new Set([
  '--model',
  '--effort',
  '--mode',
  '--agent',
  '--project',
  '--add-dir',
  '--log-file'
])

/** 会消耗 1 个后续值参数的危险/一次性标志（解析时需要跳过其值，防止误判为子命令）。 */
const SKIPPED_VALUE_FLAGS = new Set([
  '-i',
  '--prompt-interactive',
  '-p',
  '--print',
  '--prompt',
  '--print-timeout',
  '--input-format',
  '--output-format',
  '--json-schema',
  '--settings'
])

/** 统一邮箱大小写与空白，杜绝大小写差异导致的死循环切号。 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const trimmed = email.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

export function emailsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEmail(a)
  const nb = normalizeEmail(b)
  return na !== null && nb !== null && na === nb
}

/** 剥离控制字符并对单个 shell 参数进行安全转义。 */
export function shellQuote(arg: string): string {
  const cleaned = arg.replace(CONTROL_CHARS_RE, '')
  if (cleaned.length === 0) return "''"
  if (SAFE_TOKEN_RE.test(cleaned)) return cleaned
  return `'${cleaned.replace(/'/g, "'\\''")}'`
}

function tokenBasename(token: string): string {
  const normalized = token.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

/** 判定可执行文件 token 是否为 Orca 托管 Antigravity ACP Server（兼容 macOS 内核 16 字节截断名 `.p`/`.e`）。 */
export function isManagedAcpBinary(tokenOrCommand: string): boolean {
  const b = tokenBasename(tokenOrCommand.replace(/^-/, ''))
  return (
    b === 'agy_acp_server.par' ||
    b === 'agy_acp_server.exe' ||
    b === 'agy_acp_server.p' ||
    b === 'agy_acp_server.e'
  )
}

/**
 * 判定完整命令行（可能含 `Application Support` / `My - App` 等空格与连字符）是否由托管 `agy_acp_server` 启动：
 * 仅检查首个 `--flag` / `-f` 字母选项之前的命令主体，避免把 `--add-dir /.../agy_acp_server.par` 参数误判成托管进程。
 */
export function isManagedAcpCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  const firstFlagIdx = trimmed.search(/\s+--?[A-Za-z]/)
  const head = (firstFlagIdx >= 0 ? trimmed.slice(0, firstFlagIdx) : trimmed)
    .trim()
    .replace(/^['"]|['"]$/g, '')
  const b = tokenBasename(head)
  return b === 'agy_acp_server.par' || b === 'agy_acp_server.exe'
}

/** 判定进程名是否属于 Antigravity (`agy` 或托管 `agy_acp_server`) 家族。 */
export function isAgyFamilyBinary(ucommOrToken: string): boolean {
  const b = tokenBasename(ucommOrToken.replace(/^-/, ''))
  return b === 'agy' || isManagedAcpBinary(b)
}

/**
 * 过滤 Orca 后台短命探活（约每 5 分钟拉起 4s 做 `listSessions` 检查）与命名助手 `agy acp`：
 * 真正的 Orca 原生 Chat 必注入 `ORCA_STRUCTURED_SESSION=1` 与 `ORCA_AGENT_SESSION_ID`。
 * 仅在已成功采集环境变量（`hasEnvData`）时执行过滤，防止权限/截断降级误隐藏真实对话。
 */
export function shouldIgnoreUnstructuredAcpProbe(params: {
  processKind: 'cli' | 'acp' | 'ignore'
  isManagedAcpServer: boolean
  hasEnvData: boolean
  isStructuredSession: boolean
  orcaSessionId: string | null
  terminalHandle: string | null
}): boolean {
  if (params.processKind !== 'acp' || params.isManagedAcpServer) return false
  if (!params.hasEnvData) return false
  return !params.isStructuredSession && !params.orcaSessionId && !params.terminalHandle
}

/**
 * 简单拆分命令行（支持平衡单双引号与反斜杠转义）。
 * 若 `ps -o args=` 丢掉了原始引号且文本内含有未闭合的单/双引号，则回退按空白拆分，避免把后续所有参数吞成一团。
 */
export function splitCommandArgs(command: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote !== null) {
    // 存在未闭合引号（例如 `ps` 脱引号后的 "Don't"），回退简单空白切分以保留后续独立 flag
    return command
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0)
  }
  if (current.length > 0) {
    args.push(current)
  }
  return args
}

/**
 * 精准按 token 分类 agy 进程：
 * - `'acp'`：首位置子命令为 `acp`（Orca 原生 Chat 后台服务）
 * - `'ignore'`：非交互子命令（update/install/mcp/plugin/remote-control/models/...）或带 --print/-p/--prompt/--output-format 探针
 * - `'cli'`：交互式 TUI 会话
 */
export function classifyAgyCommand(command: string): 'cli' | 'acp' | 'ignore' {
  if (isManagedAcpCommand(command)) {
    return 'acp'
  }
  const tokens = splitCommandArgs(command.trim())
  const rest = tokens.length > 0 && tokenBasename(tokens[0]!) === 'agy' ? tokens.slice(1) : tokens

  let firstSubcommand: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!
    if (
      tok === '--print' ||
      tok === '-p' ||
      tok === '--prompt' ||
      tok === '--output-format' ||
      tok.startsWith('--print=') ||
      tok.startsWith('--prompt=') ||
      tok.startsWith('--output-format=')
    ) {
      return 'ignore'
    }
    if (tok === '--conversation' || SAFE_VALUE_FLAGS.has(tok) || SKIPPED_VALUE_FLAGS.has(tok)) {
      if (i + 1 < rest.length && !rest[i + 1]!.startsWith('-')) {
        i += 1
      }
      continue
    }
    if (tok.startsWith('-')) {
      continue
    }
    if (firstSubcommand === null) {
      firstSubcommand = tok
      break
    }
  }

  if (firstSubcommand === 'acp') return 'acp'
  if (firstSubcommand && NON_INTERACTIVE_SUBCOMMANDS.has(firstSubcommand)) return 'ignore'
  return 'cli'
}

/** 从命令行中提取显式传入的 `--log-file` 路径（用于 lsof 自定义日志匹配）。 */
export function extractExplicitLogFile(command: string): string | null {
  const tokens = splitCommandArgs(command.trim())
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (tok === '--log-file' && i + 1 < tokens.length && !tokens[i + 1]!.startsWith('-')) {
      return tokens[i + 1]!
    }
    if (tok.startsWith('--log-file=')) {
      const v = tok.slice('--log-file='.length)
      return v.length > 0 ? v : null
    }
  }
  return null
}

/**
 * 白名单安全重构原地无损重启命令：
 * - 仅保留已知安全的持久会话选项（如 `--dangerously-skip-permissions`、`--model`、`--effort`、`--mode`、`--agent`、`--sandbox`、`--project`、`--add-dir`）；
 * - 明确剥离 `-i` / `--prompt-interactive` / `--new-project` / `-c` / `--continue` 与位置参数，杜绝二次重放危险初始 Prompt；
 * - 两遍解析确保任何顺序下的 `-c` 与 `--conversation` 都不冲突；
 * - 对路径型参数支持传入 `pathExists` 校验（若因 `ps` 脱引号导致含空格路径碎裂且不存在，安全跳过避免启动崩溃）；
 * - 所有 token 严格过滤控制字符并安全转义，前置 `stty sane;` 恢复终端行模式。
 */
export function buildRestartCommand(
  originalCommand: string,
  conversationId: string | null,
  options?: { pathExists?: (p: string) => boolean }
): string {
  const tokens = splitCommandArgs(originalCommand.trim())
  const binary =
    tokens[0] && tokenBasename(tokens[0]) === 'agy'
      ? tokens[0].replace(CONTROL_CHARS_RE, '')
      : 'agy'
  const rest = tokens.length > 0 && tokenBasename(tokens[0]!) === 'agy' ? tokens.slice(1) : tokens

  let existingConvId: string | null = null
  const kept: string[] = []

  for (let i = 0; i < rest.length; i++) {
    const rawTok = rest[i]!
    const tok = rawTok.replace(CONTROL_CHARS_RE, '')
    if (!tok) continue

    if (tok === '--conversation') {
      const next = rest[i + 1]?.replace(CONTROL_CHARS_RE, '')
      if (next && !next.startsWith('-')) {
        existingConvId = next
        i += 1
      }
      continue
    }
    if (tok.startsWith('--conversation=')) {
      const v = tok.slice('--conversation='.length)
      if (v) existingConvId = v
      continue
    }

    // 跳过危险或一次性标志及其值（避免重复执行初始 Prompt）
    if (SKIPPED_VALUE_FLAGS.has(tok)) {
      if (i + 1 < rest.length && !rest[i + 1]!.startsWith('-')) {
        i += 1
      }
      continue
    }
    if (
      tok === '-c' ||
      tok === '--continue' ||
      tok === '--new-project' ||
      tok.startsWith('--prompt-interactive=') ||
      tok.startsWith('--settings=') ||
      tok.startsWith('--json-schema=')
    ) {
      continue
    }

    if (SAFE_BOOL_FLAGS.has(tok)) {
      kept.push(tok)
      continue
    }

    if (SAFE_VALUE_FLAGS.has(tok)) {
      const next = rest[i + 1]?.replace(CONTROL_CHARS_RE, '')
      if (next && !next.startsWith('-')) {
        i += 1
        // 若校验函数表明含空格路径已碎裂不存在，安全丢弃该残缺路径而非拼出崩溃命令
        if (tok === '--add-dir' && options?.pathExists && !options.pathExists(next)) {
          continue
        }
        kept.push(tok, next)
      }
      continue
    }

    const eqIdx = tok.indexOf('=')
    if (eqIdx > 0) {
      const flagName = tok.slice(0, eqIdx)
      const flagVal = tok.slice(eqIdx + 1)
      if (SAFE_VALUE_FLAGS.has(flagName) && flagVal.length > 0) {
        if (flagName === '--add-dir' && options?.pathExists && !options.pathExists(flagVal)) {
          continue
        }
        kept.push(flagName, flagVal)
      }
    }
  }

  const finalConvId = (conversationId ?? existingConvId)?.replace(CONTROL_CHARS_RE, '') || null
  const finalArgs = [binary, ...kept]
  if (finalConvId) {
    finalArgs.push('--conversation', finalConvId)
  }

  return `stty sane; ${finalArgs.map(shellQuote).join(' ')}`
}

/** 提取邮箱前缀便于状态栏紧凑显示。 */
export function shortEmail(email: string | null | undefined): string {
  if (!email) return '未登录'
  const idx = email.indexOf('@')
  return idx > 0 ? email.slice(0, idx) : email
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 判断单个额度窗口的重置时间点是否已经过期（resetsAt <= nowMs）。 */
export function isQuotaWindowExpired(
  resetsAt: number | null | undefined,
  nowMs: number
): boolean {
  return typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt <= nowMs
}

/** 格式化快照实际观测时刻距今时长（缺失返回 null）。 */
export function formatSnapshotAge(
  updatedAt: number | null | undefined,
  nowMs: number
): string | null {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  const diffMs = Math.max(0, nowMs - updatedAt)
  if (diffMs < 60_000) return '刚刚'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}分钟前`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}小时前`
  return `${Math.floor(diffMs / 86_400_000)}天前`
}

/**
 * 精确到分钟格式化重置倒计时与目标时刻：
 * - 已过期（resetsAt <= now）返回「窗口已过 · 切入刷新」或当前号「窗口已过 · 点刷新」，消除「已可重置」的手动操作歧义；
 * - 5h 窗口（< 24 小时）：如 `3时02分 · 01:36`、`42分钟 · 23:16`；
 * - 周窗口（>= 24 小时）：如 `5天18时14分 · 11/28`；
 * - mode='short' 用于窄卡片右对齐，`mode='full'` 用于状态栏 tooltip。
 */
export function formatResetCountdown(
  resetsAt: number | null | undefined,
  nowMs: number,
  mode: 'short' | 'full' = 'short',
  options?: { isActive?: boolean }
): string {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '—'
  const diffMs = resetsAt - nowMs
  if (diffMs <= 0) {
    if (options?.isActive) {
      return mode === 'full' ? '窗口已过，待刷新' : '窗口已过 · 点刷新'
    }
    return mode === 'full' ? '窗口已过，切入后刷新' : '窗口已过 · 切入刷新'
  }

  const totalMins = Math.ceil(diffMs / 60_000)
  const days = Math.floor(totalMins / (24 * 60))
  const hours = Math.floor((totalMins % (24 * 60)) / 60)
  const mins = totalMins % 60

  const dt = new Date(resetsAt)
  const hhmm = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`
  const mmdd = `${dt.getMonth() + 1}/${dt.getDate()}`

  if (days > 0) {
    const duration = `${days}天${hours}时${pad2(mins)}分`
    return mode === 'full' ? `${duration}（${mmdd} ${hhmm}）` : `${duration} · ${mmdd}`
  }
  if (hours > 0) {
    const duration = `${hours}时${pad2(mins)}分`
    return mode === 'full' ? `${duration}（${hhmm}）` : `${duration} · ${hhmm}`
  }
  const duration = `${Math.max(1, mins)}分钟`
  return mode === 'full' ? `${duration}（${hhmm}）` : `${duration} · ${hhmm}`
}

/** 精简展示模型分组名（如 `Gemini Models` -> `Gemini`，`Claude and GPT models` -> `Claude/GPT`）。 */
export function shortBucketGroupName(group: string): string {
  const lower = group.toLowerCase()
  if (lower.includes('gemini')) return 'Gemini'
  if (lower.includes('claude') && lower.includes('gpt')) return 'Claude/GPT'
  if (lower.includes('claude')) return 'Claude'
  return group.replace(/\s*models$/i, '').trim() || group
}

/** 账号是否为 Orca 刚添加、尚未切入读取过额度的新号。 */
export function isAccountUnfetched(account: Pick<AccountInfo, 'status'>): boolean {
  return account.status === 'unfetched'
}

/** 账号额度是否明确处于读取异常或不可用状态（区别于未读取 `unfetched`）。 */
export function isAccountError(account: Pick<AccountInfo, 'status'>): boolean {
  return account.status !== 'ok' && account.status !== 'unfetched'
}

function effectiveWindowScore(
  usedPercent: number | null,
  resetsAt: number | null | undefined,
  nowMs: number
): { effectivePct: number; estimatedByExpiry: boolean } {
  if (isQuotaWindowExpired(resetsAt, nowMs)) {
    return { effectivePct: 0, estimatedByExpiry: true }
  }
  return { effectivePct: usedPercent ?? 100, estimatedByExpiry: false }
}

/**
 * 按真实可用余量排序比较两个账号：
 * - 状态分层：健康(`ok`) < 未读取(`unfetched`) < 异常(`error`/其他)；
 * - 已过重置点的窗口在排序时按有效 0% 估算（不被过期的 100% 死缓存卡死），但同为 0% 时实测未过期者严格优先；
 * - 同等情况下优先周额度更充裕者，再优先当前激活号。
 */
export function compareAccountsByHeadroom(
  a: AccountInfo,
  b: AccountInfo,
  nowMs = Date.now()
): number {
  const statusRank = (acc: AccountInfo): number =>
    acc.status === 'ok' ? 0 : acc.status === 'unfetched' ? 1 : 2
  const rankDiff = statusRank(a) - statusRank(b)
  if (rankDiff !== 0) return rankDiff

  const aSess = effectiveWindowScore(a.sessionUsedPercent, a.sessionResetsAt, nowMs)
  const bSess = effectiveWindowScore(b.sessionUsedPercent, b.sessionResetsAt, nowMs)
  if (aSess.effectivePct !== bSess.effectivePct) return aSess.effectivePct - bSess.effectivePct

  const aWeek = effectiveWindowScore(a.weeklyUsedPercent, a.weeklyResetsAt, nowMs)
  const bWeek = effectiveWindowScore(b.weeklyUsedPercent, b.weeklyResetsAt, nowMs)
  if (aWeek.effectivePct !== bWeek.effectivePct) return aWeek.effectivePct - bWeek.effectivePct

  const sessEstDiff = Number(aSess.estimatedByExpiry) - Number(bSess.estimatedByExpiry)
  if (sessEstDiff !== 0) return sessEstDiff

  const weekEstDiff = Number(aWeek.estimatedByExpiry) - Number(bWeek.estimatedByExpiry)
  if (weekEstDiff !== 0) return weekEstDiff

  const rawSessDiff = (a.sessionUsedPercent ?? 100) - (b.sessionUsedPercent ?? 100)
  if (rawSessDiff !== 0) return rawSessDiff

  const rawWeekDiff = (a.weeklyUsedPercent ?? 100) - (b.weeklyUsedPercent ?? 100)
  if (rawWeekDiff !== 0) return rawWeekDiff

  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
  return a.email.localeCompare(b.email)
}

/**
 * 选择当前额度最充裕的健康可用账号：
 * - 严格只从 `status === 'ok'` 的账号中选择（跳过未读取与异常号，绝不自动切往未知或失效账号）；
 * - 使用 `compareAccountsByHeadroom(..., nowMs)` 避免过期 100% 缓存阻止选号，同时保证实测 0% 优先于过期推算。
 */
export function pickBestAccount(
  accounts: readonly AccountInfo[],
  nowMs = Date.now()
): AccountInfo | null {
  const healthy = accounts.filter((a) => a.status === 'ok')
  if (healthy.length === 0) return null
  const sorted = [...healthy].sort((a, b) => compareAccountsByHeadroom(a, b, nowMs))
  return sorted[0] ?? null
}

export interface StatusBarPresentation {
  text: string
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip: string
}

const STATUS_TEXT_MAX = 64
const STATUS_TOOLTIP_MAX = 256

function fitSingleLine(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= 1) return text.slice(0, maxLen)
  return `${text.slice(0, maxLen - 1)}…`
}

function fitTooltipLines(lines: readonly string[], maxLen = STATUS_TOOLTIP_MAX): string {
  const kept: string[] = []
  let len = 0
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (!line) continue
    const sep = kept.length > 0 ? 1 : 0
    const remain = maxLen - len - sep
    if (remain <= 0) break
    if (line.length <= remain) {
      kept.push(line)
      len += sep + line.length
    } else if (remain >= 6) {
      kept.push(`${line.slice(0, remain - 1)}…`)
      break
    } else {
      break
    }
  }
  return kept.join('\n')
}

function formatStatusResult(
  text: string,
  tone: StatusBarPresentation['tone'],
  tooltipLines: readonly string[]
): StatusBarPresentation {
  return {
    text: fitSingleLine(text, STATUS_TEXT_MAX),
    tone,
    tooltip: fitTooltipLines(tooltipLines, STATUS_TOOLTIP_MAX)
  }
}

/** 计算 Orca 底部状态栏显示文本、警示色和悬停提示（严格满足 Orca text<=64 / tooltip<=256 上限）。 */
export function computeStatusBar(snapshot: SwitcherSnapshot): StatusBarPresentation {
  if (snapshot.error && snapshot.accounts.length === 0) {
    return formatStatusResult('AGY 读取异常', 'warning', [
      `反重力 (AGY) 状态获取失败：${snapshot.error}`
    ])
  }

  if (snapshot.busy) {
    return formatStatusResult(snapshot.busyLabel || 'AGY 正在换号...', 'accent', [
      '反重力 (AGY) 正在执行全终端无损换号...'
    ])
  }

  const active =
    snapshot.accounts.find((a) => a.isActive) ??
    snapshot.accounts.find((a) => emailsEqual(a.email, snapshot.currentEmail)) ??
    null
  const name = shortEmail(active?.email ?? snapshot.currentEmail)
  const used = active?.sessionUsedPercent
  const activeSessionExpired = isQuotaWindowExpired(active?.sessionResetsAt, snapshot.updatedAt)
  const activeWeeklyExpired = isQuotaWindowExpired(active?.weeklyResetsAt, snapshot.updatedAt)
  const usedLabel = activeSessionExpired
    ? '待刷新'
    : typeof used === 'number'
      ? `${used}%`
      : '?'

  const sessionResetStr = formatResetCountdown(active?.sessionResetsAt, snapshot.updatedAt, 'full', {
    isActive: true
  })
  const weeklyResetStr = formatResetCountdown(active?.weeklyResetsAt, snapshot.updatedAt, 'full', {
    isActive: true
  })
  const sessionDetail = activeSessionExpired
    ? `5h 已过重置${typeof used === 'number' ? `·上轮${used}%` : ''}（待刷新）`
    : `5h ${usedLabel}（${sessionResetStr}）`
  const weeklyPctStr =
    typeof active?.weeklyUsedPercent === 'number' ? `${active.weeklyUsedPercent}%` : '?'
  const weeklyDetail = activeWeeklyExpired
    ? `周 已过重置${typeof active?.weeklyUsedPercent === 'number' ? `·上轮${active.weeklyUsedPercent}%` : ''}（待刷新）`
    : `周 ${weeklyPctStr}（${weeklyResetStr}）`
  const managedChatsCount = snapshot.terminals.filter((t) => isManagedChatTerminal(t)).length
  const procSummary =
    managedChatsCount > 0
      ? `运行中：${snapshot.terminals.length} 进程（含 ${managedChatsCount} 托管Chat）`
      : `运行中：${snapshot.terminals.length} 进程`

  const tooltipLines: string[] = [
    `反重力 (AGY) 当前账号：${active?.email ?? snapshot.currentEmail ?? '未知'}`,
    `${sessionDetail} | ${weeklyDetail}`,
    procSummary
  ]

  if (snapshot.scanDegradedReason) {
    tooltipLines.push(`⚠️ 降级：${snapshot.scanDegradedReason}`)
  }

  if (snapshot.drift) {
    tooltipLines.push(
      `⚠️ 漂移：预期 ${shortEmail(snapshot.drift.expectedEmail)} -> 实际 ${shortEmail(snapshot.drift.actualEmail)}`,
      '请打开右侧「反重力换号」面板确认并拉齐'
    )
    return formatStatusResult(`AGY:${name} ⚠漂移`, 'danger', tooltipLines)
  }

  const totalOutdated =
    snapshot.outdatedCount + snapshot.externalOutdatedCount + snapshot.acpOutdatedCount
  if (totalOutdated > 0) {
    const outdatedNames = snapshot.terminals
      .filter((t) => t.isOutdated)
      .slice(0, 3)
      .map((t) => `• ${t.workspaceName} (${shortEmail(t.authEmail)})`)
    tooltipLines.push(`⚠️ ${totalOutdated} 个旧号进程（可能顶号）：`, ...outdatedNames)
    if (snapshot.queuedCount > 0) {
      tooltipLines.push(`⏳ ${snapshot.queuedCount} 个干活中，空闲自动切换`)
    }
    tooltipLines.push('请打开右侧「反重力换号」面板处理')
    return formatStatusResult(`AGY:${name} · ${totalOutdated}旧号`, 'warning', tooltipLines)
  }

  if (snapshot.unknownAuthCount > 0) {
    tooltipLines.push(`ℹ️ ${snapshot.unknownAuthCount} 个进程邮箱识别中`)
  }

  if (activeSessionExpired) {
    tooltipLines.push('5h 窗口已过重置，可在右侧「反重力换号」面板刷新')
    return formatStatusResult(`AGY:${name} 待刷新`, 'neutral', tooltipLines)
  }

  if (typeof used === 'number' && used >= 100) {
    tooltipLines.push('5h 额度已满，请打开右侧「反重力换号」面板切换')
    return formatStatusResult(`AGY:${name} 100%`, 'danger', tooltipLines)
  }

  if (typeof used === 'number' && used >= 85) {
    tooltipLines.push('5h 额度接近上限，可在右侧「反重力换号」面板切换')
    return formatStatusResult(`AGY:${name} ${usedLabel}`, 'warning', tooltipLines)
  }

  tooltipLines.push('已识别进程账号一致 ✓（仅展示，换号请打开右侧「反重力换号」面板）')
  return formatStatusResult(`AGY:${name} ${usedLabel}`, 'neutral', tooltipLines)
}

export interface SwitchImpactSummary {
  immediateCount: number
  queueCount: number
  skipCount: number
  forcedBusyCount: number
  externalCount: number
  acpCount: number
  managedChatCount: number
  blockedCount: number
  unknownAuthCount: number
  totalManagedCliCount: number
}

/** 托管内置账号引擎的原生 Chat 使用独立凭据池，不计入宿主未识别邮箱或旧号范围。 */
export function isManagedChatTerminal(t: {
  processKind: string
  chatEngine?: string | null
}): boolean {
  return t.processKind === 'acp' && t.chatEngine === 'orca-managed'
}

/**
 * 与 Worker 端 `executeSwitchAllLocked(onlyOutdated=true)` 使用完全一致的筛选规则，
 * 计算若现在切换到 `targetEmail`（配合 `policy`），将会实际影响多少个终端。
 */
export function computeSwitchImpact(
  snapshot: SwitcherSnapshot,
  targetEmail: string,
  policy: WorkingPolicy
): SwitchImpactSummary {
  let immediateCount = 0
  let queueCount = 0
  let skipCount = 0
  let forcedBusyCount = 0
  let externalCount = 0
  let acpCount = 0
  let managedChatCount = 0
  let blockedCount = 0
  let unknownAuthCount = 0

  for (const t of snapshot.terminals) {
    if (isManagedChatTerminal(t)) {
      managedChatCount += 1
      continue
    }
    if (!t.authEmail) {
      unknownAuthCount += 1
      continue
    }
    if (emailsEqual(t.authEmail, targetEmail)) continue

    if (t.processKind === 'acp') {
      acpCount += 1
      continue
    }
    if (t.isExternal) {
      externalCount += 1
      continue
    }
    if (!t.terminalId || !t.canRestartInPlace) {
      blockedCount += 1
      continue
    }

    const unsafe =
      t.agentState === 'working' || t.agentState === 'blocked' || t.agentState === 'unknown'
    if (unsafe && policy !== 'force') {
      if (policy === 'queue') queueCount += 1
      else skipCount += 1
    } else {
      immediateCount += 1
      if (unsafe) forcedBusyCount += 1
    }
  }

  return {
    immediateCount,
    queueCount,
    skipCount,
    forcedBusyCount,
    externalCount,
    acpCount,
    managedChatCount,
    blockedCount,
    unknownAuthCount,
    totalManagedCliCount: immediateCount + queueCount + skipCount
  }
}
