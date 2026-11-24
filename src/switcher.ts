// 核心换号与守护服务（红队对抗加固版）：
// - 同步互斥锁（零 await TOCTOU）、accountMutationEpoch 防旧缓存倒灌；
// - Fail-Closed 降级保护（CLI/lsof 失败绝不误杀 working 终端或误清队列）；
// - 切号半途失败自动回滚拉起 + 永不截断的 recoveryCommands 兜底；
// - 跨工作区 `orca terminal send` 原地重启、嵌套进程去重、队列指数退避重试与僵尸项清理。
import { basename } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  buildRestartCommand,
  computeStatusBar,
  emailsEqual,
  isManagedChatTerminal,
  isQuotaWindowExpired,
  pickBestAccount,
  resolvePrimaryQuota,
  shortEmail
} from './command-builder'
import type {
  AccountInfo,
  AgyTerminalInfo,
  ChatBackendMode,
  ChatEngine,
  DriftWarning,
  OperationSummary,
  RecoveryCommandItem,
  SwitcherSnapshot,
  TerminalAgentState,
  WorkingPolicy
} from './protocol'
import type { RawAccountState, RawOrcaAgent, SystemAdapter } from './system'

const STORAGE_DESIRED_ACCOUNT = 'desiredAccount'
const STORAGE_PENDING_QUEUE = 'pendingQueue'
const STORAGE_PREVIEW_SNAPSHOT = '__previewSnapshot'
const MAX_QUEUE_ATTEMPTS = 3
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000]

interface StoredDesiredAccount {
  id: string
  email: string
  observedSelectedId: string | null
  setAt: number
}

interface PendingQueueItem {
  terminalId: string
  targetAccountId: string
  targetEmail: string
  enqueuedAt: number
  attempts: number
  nextRetryAt: number
}

export interface SwitcherSettings {
  processPollIntervalSec: number
  quotaPollIntervalSec: number
  workingPolicy: WorkingPolicy
  autoGuardDrift: boolean
  notifyOnComplete: boolean
}

function unrefTimer(timer: unknown): void {
  const t = timer as { unref?: () => void } | null
  t?.unref?.()
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback
  return Math.max(min, Math.min(max, Math.round(val)))
}

function normalizeAgentState(
  raw: string | undefined | null,
  agentsQueryOk: boolean
): TerminalAgentState {
  if (!agentsQueryOk) return 'unknown'
  if (raw === 'working' || raw === 'blocked' || raw === 'waiting' || raw === 'done') {
    return raw
  }
  return 'idle'
}

const AGENT_STATE_PRIORITY: Record<string, number> = {
  working: 4,
  blocked: 3,
  waiting: 2,
  done: 1,
  idle: 1,
  unknown: 0
}

/** Fail-Closed：working / blocked / unknown 均视为不可在不强制模式下自动打断。 */
function isUnsafeToAutoRestart(state: TerminalAgentState): boolean {
  return state === 'working' || state === 'blocked' || state === 'unknown'
}

function workspaceDisplayName(
  worktreePath: string | null,
  worktreeId: string | null,
  isAcp: boolean
): string {
  if (worktreePath) return basename(worktreePath) || worktreePath
  if (worktreeId) {
    const idx = worktreeId.indexOf('::')
    const p = idx >= 0 ? worktreeId.slice(idx + 2) : worktreeId
    return basename(p) || p
  }
  return isAcp ? 'Orca 原生对话' : '外部终端'
}

function chatWorkspaceDisplay(
  chatAgent: RawOrcaAgent | null,
  fallbackWorktreeId: string | null
): string {
  if (chatAgent) {
    const repo = chatAgent.repo?.trim()
    const ws = chatAgent.workspace?.trim()
    if (repo && ws && repo !== ws) return `${repo} · ${ws}`
    if (ws) return ws
    if (repo) return repo
  }
  return workspaceDisplayName(null, fallbackWorktreeId, true)
}

function resolveChatBackendMode(
  acctState: RawAccountState,
  terminals: readonly AgyTerminalInfo[]
): ChatBackendMode {
  if (acctState.chatUsesAgy === true || acctState.chatGoogleSignInInUse === 'agy') {
    return 'host-agy'
  }
  if (acctState.chatUsesAgy === false || acctState.chatGoogleSignInInUse === 'orca') {
    return 'orca-managed'
  }
  let hasManaged = false
  let hasHost = false
  for (const t of terminals) {
    if (t.processKind !== 'acp') continue
    if (t.chatEngine === 'orca-managed') hasManaged = true
    else if (t.chatEngine === 'host-agy') hasHost = true
  }
  if (hasManaged && !hasHost) return 'orca-managed'
  if (hasHost && !hasManaged) return 'host-agy'
  return 'unknown'
}

function makeConflictError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string }
  err.code = 'conflict'
  return err
}

export class SwitcherService {
  private snapshot: SwitcherSnapshot | null = null
  private cachedAccountState: RawAccountState | null = null
  private accountsFetchedAt: number | null = null
  private accountMutationEpoch = 0
  private inFlightRefresh: { promise: Promise<SwitcherSnapshot>; includesAccounts: boolean } | null =
    null
  private busy = false
  private busyLabel: string | null = null
  private lastOperation: OperationSummary | null = null
  private lastDriftNotifiedKey: string | null = null
  private lastPublishedDigest: string | null = null
  private disposed = false
  private drainTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private postRestartTimer: ReturnType<typeof setTimeout> | null = null
  /** 完整命令行与父 PID 仅保留在 Worker 内存，避免超大载荷击穿 panels.post 256 KiB 上限。 */
  private runtimeProcessMeta = new Map<number, { command: string; ppid: number }>()

  constructor(
    private readonly orca: OrcaWorkerApi,
    private readonly sys: SystemAdapter
  ) {}

  isDisposed(): boolean {
    return this.disposed
  }

  isBusy(): boolean {
    return this.busy
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.drainTimers.values()) {
      clearTimeout(timer)
    }
    this.drainTimers.clear()
    if (this.postRestartTimer) {
      clearTimeout(this.postRestartTimer)
      this.postRestartTimer = null
    }
  }

  async readSettings(): Promise<SwitcherSettings> {
    const raw = (await this.orca.settings.get().catch(() => ({}))) as Record<string, unknown>
    const wp = raw.workingPolicy
    const workingPolicy: WorkingPolicy =
      wp === 'skip' || wp === 'force' || wp === 'queue' ? wp : 'queue'
    return {
      processPollIntervalSec: clampInt(raw.processPollIntervalSec, 10, 120, 15),
      quotaPollIntervalSec: clampInt(raw.quotaPollIntervalSec, 30, 600, 120),
      workingPolicy,
      autoGuardDrift: raw.autoGuardDrift !== false,
      notifyOnComplete: raw.notifyOnComplete !== false
    }
  }

  /**
   * 同步获取独占锁（第一行同步检查并置位 `this.busy = true`，零 await TOCTOU 窗口），
   * 保护全部写操作（切号、强切、单终端重启、杀外部进程、清空队列）。
   */
  private async withExclusiveLock<T>(
    initialLabel: string,
    fn: () => Promise<T>
  ): Promise<T> {
    if (this.busy) {
      throw makeConflictError('当前正在执行换号或进程操作，请稍候完成后再试')
    }
    this.busy = true
    this.busyLabel = initialLabel
    await this.broadcastBusyState()
    try {
      return await fn()
    } finally {
      this.busy = false
      this.busyLabel = null
      await this.broadcastBusyState()
    }
  }

  private async setBusyLabel(label: string): Promise<void> {
    this.busyLabel = label
    await this.broadcastBusyState()
  }

  private async broadcastBusyState(): Promise<void> {
    if (!this.snapshot) return
    const updated: SwitcherSnapshot = {
      ...this.snapshot,
      busy: this.busy,
      busyLabel: this.busyLabel
    }
    this.snapshot = updated
    await this.updateStatusBar(updated)
    this.publish(updated, true)
  }

  private async readDesiredAccount(): Promise<StoredDesiredAccount | null> {
    const raw = await this.orca.storage.get(STORAGE_DESIRED_ACCOUNT).catch(() => null)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const obj = raw as Record<string, unknown>
    if (typeof obj.id === 'string' && typeof obj.email === 'string') {
      return {
        id: obj.id,
        email: obj.email,
        observedSelectedId:
          typeof obj.observedSelectedId === 'string' ? obj.observedSelectedId : obj.id,
        setAt: typeof obj.setAt === 'number' ? obj.setAt : Date.now()
      }
    }
    return null
  }

  private async writeDesiredAccount(account: {
    id: string
    email: string
    observedSelectedId?: string | null
  }): Promise<void> {
    this.accountMutationEpoch += 1
    await this.orca.storage.set(STORAGE_DESIRED_ACCOUNT, {
      id: account.id,
      email: account.email,
      observedSelectedId: account.observedSelectedId ?? account.id,
      setAt: Date.now()
    })
  }

  private async readQueue(): Promise<PendingQueueItem[]> {
    const raw = await this.orca.storage.get(STORAGE_PENDING_QUEUE).catch(() => null)
    if (!Array.isArray(raw)) return []
    const items: PendingQueueItem[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const obj = item as Record<string, unknown>
      if (
        typeof obj.terminalId === 'string' &&
        typeof obj.targetAccountId === 'string' &&
        typeof obj.targetEmail === 'string'
      ) {
        items.push({
          terminalId: obj.terminalId,
          targetAccountId: obj.targetAccountId,
          targetEmail: obj.targetEmail,
          enqueuedAt: typeof obj.enqueuedAt === 'number' ? obj.enqueuedAt : Date.now(),
          attempts: typeof obj.attempts === 'number' && obj.attempts >= 0 ? obj.attempts : 0,
          nextRetryAt: typeof obj.nextRetryAt === 'number' ? obj.nextRetryAt : 0
        })
      }
    }
    return items
  }

  private async writeQueue(items: PendingQueueItem[]): Promise<void> {
    await this.orca.storage.set(
      STORAGE_PENDING_QUEUE,
      items.map((x) => ({
        terminalId: x.terminalId,
        targetAccountId: x.targetAccountId,
        targetEmail: x.targetEmail,
        enqueuedAt: x.enqueuedAt,
        attempts: x.attempts,
        nextRetryAt: x.nextRetryAt
      }))
    )
  }

  /** 仅当显式标记 `isPreview: true` 时读取预览快照（防止误劫持生产环境）。 */
  private async readPreviewSnapshot(): Promise<SwitcherSnapshot | null> {
    const raw = await this.orca.storage.get(STORAGE_PREVIEW_SNAPSHOT).catch(() => null)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const obj = raw as Record<string, unknown>
    if (obj.isPreview !== true) return null
    return obj as unknown as SwitcherSnapshot
  }

  async getSnapshot(options?: {
    refresh?: boolean
    refreshAccounts?: boolean
  }): Promise<SwitcherSnapshot> {
    const preview = await this.readPreviewSnapshot()
    if (preview) {
      this.snapshot = preview
      await this.updateStatusBar(preview)
      return preview
    }
    const force = Boolean(options?.refresh)
    const forceAccounts = Boolean(options?.refreshAccounts ?? options?.refresh)
    if (!force && this.snapshot && Date.now() - this.snapshot.updatedAt < 3000) {
      return this.snapshot
    }
    return this.refreshSnapshot({ refreshAccounts: forceAccounts })
  }

  /**
   * 快慢双通道 + Singleflight 合并刷新：
   * - 快通道（~0.3s，零联网）：扫描本机 agy/acp 进程与 Orca 终端/Agent 状态；
   * - 慢通道（~5s）：仅在首次启动、达到有效刷新周期（有旧号进程时上限自动缩至 45s 加速漂移发现）或手动刷新时拉远程额度；
   * - 切号独占锁期间后台被动刷新不覆写存储队列/期望账号。
   */
  async refreshSnapshot(options?: {
    refreshAccounts?: boolean
    fromBackground?: boolean
  }): Promise<SwitcherSnapshot> {
    const preview = await this.readPreviewSnapshot()
    if (preview) {
      this.snapshot = preview
      await this.updateStatusBar(preview)
      return preview
    }

    // 后台巡检在切号执行期直接避让，避免重启空窗误清队列或闪烁
    if (options?.fromBackground && this.busy && this.snapshot) {
      return this.snapshot
    }

    const settings = await this.readSettings()
    const hasOutdatedNow =
      (this.snapshot?.outdatedCount ?? 0) +
        (this.snapshot?.externalOutdatedCount ?? 0) +
        (this.snapshot?.acpOutdatedCount ?? 0) >
      0
    // 存在旧号进程时缩短账号巡检上限至 45s，降低 2~10 分钟漂移盲区
    const effectiveQuotaIntervalMs =
      (hasOutdatedNow ? Math.min(settings.quotaPollIntervalSec, 45) : settings.quotaPollIntervalSec) *
      1000

    const accountsStale =
      !this.cachedAccountState ||
      this.accountsFetchedAt === null ||
      Date.now() - this.accountsFetchedAt >= effectiveQuotaIntervalMs
    const needAccounts = Boolean(options?.refreshAccounts || accountsStale)

    if (this.inFlightRefresh) {
      if (!needAccounts || this.inFlightRefresh.includesAccounts) {
        return this.inFlightRefresh.promise
      }
      await this.inFlightRefresh.promise.catch(() => {})
    }

    const promise = this.doRefreshSnapshot(settings, needAccounts, Boolean(options?.fromBackground)).finally(
      () => {
        if (this.inFlightRefresh?.promise === promise) {
          this.inFlightRefresh = null
        }
      }
    )
    this.inFlightRefresh = { promise, includesAccounts: needAccounts }
    return promise
  }

  private async doRefreshSnapshot(
    settings: SwitcherSettings,
    fetchAccounts: boolean,
    fromBackground: boolean
  ): Promise<SwitcherSnapshot> {
    const [desiredInitial, queueInitial] = await Promise.all([
      this.readDesiredAccount(),
      this.readQueue()
    ])
    let desired = desiredInitial
    let queue = queueInitial
    let queueDirty = false
    let errorMessage: string | null = null
    const startEpoch = this.accountMutationEpoch

    try {
      const accountPromise: Promise<RawAccountState | null> = fetchAccounts
        ? this.sys.getAntigravityAccounts().catch((err: unknown) => {
            errorMessage = err instanceof Error ? err.message : String(err)
            this.orca.log(`getAntigravityAccounts failed: ${errorMessage}`)
            return this.cachedAccountState
          })
        : Promise.resolve(this.cachedAccountState)

      const [fetchedAcctState, termsRes, agentsRes, procsRes] = await Promise.all([
        accountPromise,
        this.sys.listOrcaTerminals(),
        this.sys.listOrcaAgents(),
        this.sys.scanAgyProcesses()
      ])

      // H-1 防旧缓存倒灌：若远程拉取期间发生了切号写操作（epoch 变化），丢弃陈旧回包，改用最新本地缓存
      let acctState: RawAccountState | null = fetchedAcctState
      if (fetchAccounts) {
        if (startEpoch !== this.accountMutationEpoch) {
          acctState = this.cachedAccountState
        } else if (fetchedAcctState && !errorMessage) {
          this.cachedAccountState = fetchedAcctState
          this.accountsFetchedAt = Date.now()
        }
      }

      if (!acctState) {
        throw new Error(errorMessage || '未能获取 Antigravity 账号列表')
      }

      const degradedReasons: string[] = []
      if (termsRes.degradedReason) degradedReasons.push(termsRes.degradedReason)
      if (agentsRes.degradedReason) degradedReasons.push(agentsRes.degradedReason)
      if (procsRes.degradedReason) degradedReasons.push(procsRes.degradedReason)
      const scanDegradedReason = degradedReasons.length > 0 ? degradedReasons.join('；') : null
      // 只有终端表、进程扫描均完整无截断且非切号中途，才允许清理队列或归类外部进程
      const scanComplete =
        termsRes.ok && !termsRes.truncated && procsRes.ok && !this.busy && !fromBackground

      const termByHandle = new Map(termsRes.items.map((t) => [t.handle, t]))
      const handleByPaneKey = new Map<string, string>()
      for (const t of termsRes.items) {
        if (t.paneKey) handleByPaneKey.set(t.paneKey, t.handle)
      }

      // M-1: 按状态优先级合并 agent，同时建立 terminalHandle 与 orcaSessionId 双索引（严禁历史 done 覆盖活跃 working）
      const agentByTerm = new Map<string, (typeof agentsRes.items)[number]>()
      const agentBySessionId = new Map<string, (typeof agentsRes.items)[number]>()
      if (agentsRes.ok) {
        for (const ag of agentsRes.items) {
          if (ag.orcaSessionId) {
            const prevSess = agentBySessionId.get(ag.orcaSessionId)
            if (
              !prevSess ||
              (AGENT_STATE_PRIORITY[ag.state] ?? 0) > (AGENT_STATE_PRIORITY[prevSess.state] ?? 0)
            ) {
              agentBySessionId.set(ag.orcaSessionId, ag)
            }
          }
          const resolvedTermId =
            ag.terminalId ?? (ag.paneKey ? handleByPaneKey.get(ag.paneKey) ?? null : null)
          if (!resolvedTermId) continue
          const prev = agentByTerm.get(resolvedTermId)
          if (
            !prev ||
            (AGENT_STATE_PRIORITY[ag.state] ?? 0) > (AGENT_STATE_PRIORITY[prev.state] ?? 0)
          ) {
            agentByTerm.set(resolvedTermId, ag)
          }
        }
      }

      const activeAccount =
        acctState.accounts.find((a) => a.id === acctState.activeAccountId) ??
        acctState.accounts.find((a) => emailsEqual(a.email, acctState.currentEmail)) ??
        null
      const selectedAccount =
        acctState.accounts.find((a) => a.id === acctState.selectedAccountId) ?? null
      const referenceEmail = activeAccount?.email ?? acctState.currentEmail ?? null

      // H-5: 只要用户在 Orca 原生界面改选了 selectedAccountId（即使同时发生漂移），
      // 自动同步承认用户的新选择并同步更新排队目标，绝不误报或把队列切回旧号！
      const allowStorageWrite = !this.busy && startEpoch === this.accountMutationEpoch
      if (
        allowStorageWrite &&
        desired &&
        acctState.selectedAccountId &&
        acctState.selectedAccountId !== desired.observedSelectedId &&
        selectedAccount
      ) {
        desired = {
          id: selectedAccount.id,
          email: selectedAccount.email,
          observedSelectedId: acctState.selectedAccountId,
          setAt: Date.now()
        }
        await this.writeDesiredAccount(desired)
        if (queue.length > 0) {
          queue = queue.map((q) => ({
            ...q,
            targetAccountId: selectedAccount.id,
            targetEmail: selectedAccount.email,
            attempts: 0,
            nextRetryAt: 0
          }))
          queueDirty = true
        }
      }

      // C-6: 剔除祖先链已是 agy 的嵌套子进程，并统计每个 terminalId 绑定的顶层 agy 数量防双发命令
      const topLevelProcs = procsRes.items.filter((p) => !p.hasAgyAncestor)
      const countByHandle = new Map<string, number>()
      for (const p of topLevelProcs) {
        if (p.processKind === 'cli' && p.terminalHandle) {
          countByHandle.set(p.terminalHandle, (countByHandle.get(p.terminalHandle) ?? 0) + 1)
        }
      }

      // 更新内部完整命令缓存（面板仅收 300 字摘要防超 256 KiB）
      this.runtimeProcessMeta.clear()
      for (const p of topLevelProcs) {
        this.runtimeProcessMeta.set(p.pid, { command: p.command, ppid: p.ppid })
      }

      const queueByTerm = new Map(queue.map((q) => [q.terminalId, q]))

      const terminals: AgyTerminalInfo[] = topLevelProcs.map((proc) => {
        const isAcp = proc.processKind === 'acp'
        const chatEngine: ChatEngine | null = isAcp
          ? proc.isManagedAcpServer
            ? 'orca-managed'
            : 'host-agy'
          : null
        const isManagedChat = chatEngine === 'orca-managed'

        const orcaTerm =
          !isAcp && proc.terminalHandle ? termByHandle.get(proc.terminalHandle) ?? null : null
        // 同工作区可能开多个原生 Chat，必须严格按 ORCA_AGENT_SESSION_ID === orcaSessionId 1-on-1 配对，绝不按 cwd 猜测
        const orcaAgent = isAcp
          ? proc.orcaSessionId
            ? agentBySessionId.get(proc.orcaSessionId) ?? null
            : null
          : proc.terminalHandle
            ? agentByTerm.get(proc.terminalHandle) ?? null
            : null
        // 若 terminal list 失败或截断，带 ORCA_TERMINAL_HANDLE 的进程不误判为外部野进程
        const isExternal =
          !isAcp && !orcaTerm && !(proc.terminalHandle && (!termsRes.ok || termsRes.truncated))

        let agentState: TerminalAgentState = 'unknown'
        if (!isExternal) {
          if (isAcp) {
            agentState = orcaAgent
              ? normalizeAgentState(orcaAgent.state ?? null, agentsRes.ok)
              : 'unknown'
          } else {
            agentState = normalizeAgentState(orcaAgent?.state ?? null, agentsRes.ok)
          }
        }

        const effectiveAuthEmail = isManagedChat ? null : proc.authEmail
        const queued = proc.terminalHandle ? queueByTerm.get(proc.terminalHandle) ?? null : null
        // H-5: 补齐 desired?.email，避免 selectedAccountId 为空且发生漂移时颠倒黑白
        const expectedForThisTerm =
          queued?.targetEmail ?? selectedAccount?.email ?? desired?.email ?? referenceEmail
        // 托管内置账号（acp_token.json）完全独立于宿主账号池，不参与宿主旧号校验
        const isOutdated = Boolean(
          !isManagedChat &&
            expectedForThisTerm &&
            effectiveAuthEmail &&
            !emailsEqual(effectiveAuthEmail, expectedForThisTerm)
        )

        const duplicateOnSameTerminal =
          Boolean(proc.terminalHandle) && (countByHandle.get(proc.terminalHandle!) ?? 0) > 1
        let restartBlockedReason: string | null = null
        if (isAcp) {
          if (isManagedChat) {
            restartBlockedReason = 'Orca 托管内置账号（独立于终端池，不受本面板切号影响）'
          } else if (agentState === 'working' || agentState === 'blocked') {
            restartBlockedReason = '原生 Chat 干活中（共用系统账号），需等其空闲或手动重开'
          } else {
            restartBlockedReason = '原生 Chat 不支持插件原地重启（切号时 Orca 将释放空闲会话）'
          }
        } else if (isExternal) {
          restartBlockedReason = '外部非 Orca 终端，不支持原地拉起'
        } else if (!orcaTerm) {
          restartBlockedReason = '终端列表查询降级，暂禁原地重启'
        } else if (!orcaTerm.writable) {
          restartBlockedReason = '终端当前不可写'
        } else if (!proc.parentIsShell) {
          restartBlockedReason = '非交互 Shell 启动，退出将关闭终端'
        } else if (duplicateOnSameTerminal) {
          restartBlockedReason = '同一终端存在多个 agy 进程，暂禁自动原地重启以防串入命令'
        } else if (!procsRes.ok && !proc.conversationId) {
          restartBlockedReason = 'lsof 降级导致缺少会话 ID，暂禁自动重启以免丢失上下文'
        }

        const commandPreview =
          proc.command.length > 240 ? `${proc.command.slice(0, 240)}…` : proc.command

        const workspaceName = isAcp
          ? chatWorkspaceDisplay(orcaAgent, proc.worktreeId ?? null)
          : workspaceDisplayName(
              orcaTerm?.worktreePath ?? null,
              orcaTerm?.worktreeId ?? proc.worktreeId,
              false
            )
        const title = isAcp
          ? orcaAgent?.title || (isManagedChat ? `Orca 托管 Chat (PID ${proc.pid})` : `Orca 原生 Chat (PID ${proc.pid})`)
          : orcaTerm?.title || orcaAgent?.title || `PID ${proc.pid}`

        return {
          pid: proc.pid,
          processKind: proc.processKind,
          terminalId: orcaTerm?.handle ?? null,
          worktreeId: orcaAgent?.worktreeId ?? orcaTerm?.worktreeId ?? proc.worktreeId ?? null,
          workspaceName,
          title,
          conversationId: proc.conversationId,
          authEmail: effectiveAuthEmail,
          commandPreview,
          canRestartInPlace: restartBlockedReason === null,
          restartBlockedReason,
          isExternal,
          agentState,
          isOutdated,
          queuedTargetEmail: queued?.targetEmail ?? null,
          startedAtText: proc.startedAtText,
          orcaSessionId: proc.orcaSessionId ?? orcaAgent?.orcaSessionId ?? null,
          chatEngine
        }
      })

      // C-5 & M-7: 仅当扫描完整且未处切号窗口时，才清理已消失、已同步、不可重启或超 24h 的僵尸队列项
      let finalQueue = queue
      if (allowStorageWrite && (scanComplete || queueDirty)) {
        const liveTermById = new Map(
          terminals.filter((t) => t.terminalId).map((t) => [t.terminalId!, t])
        )
        const accountIdSet = new Set(acctState.accounts.map((a) => a.id))
        const now = Date.now()
        const cleaned = queue.filter((q) => {
          if (!accountIdSet.has(q.targetAccountId)) return false
          if (now - q.enqueuedAt > MAX_QUEUE_AGE_MS) return false
          if (!scanComplete) return true
          const t = liveTermById.get(q.terminalId)
          if (!t) return false
          if (!t.canRestartInPlace) return false
          if (t.authEmail && emailsEqual(t.authEmail, q.targetEmail)) return false
          return true
        })
        if (queueDirty || cleaned.length !== queue.length) {
          finalQueue = cleaned
          await this.writeQueue(cleaned)
        }
      }

      const countByNormEmail = new Map<string, number>()
      for (const t of terminals) {
        const norm = t.authEmail?.trim().toLowerCase()
        if (norm) {
          countByNormEmail.set(norm, (countByNormEmail.get(norm) ?? 0) + 1)
        }
      }

      const accounts: AccountInfo[] = acctState.accounts.map((a) => ({
        id: a.id,
        email: a.email,
        label: a.label,
        isActive:
          a.id === acctState.activeAccountId ||
          (acctState.activeAccountId === null && emailsEqual(a.email, acctState.currentEmail)),
        isSelected: a.id === acctState.selectedAccountId,
        status: a.status,
        sessionUsedPercent: a.sessionUsedPercent,
        sessionResetsAt: a.sessionResetsAt,
        weeklyUsedPercent: a.weeklyUsedPercent,
        weeklyResetsAt: a.weeklyResetsAt,
        buckets: a.buckets ?? [],
        terminalCount: countByNormEmail.get(a.email.trim().toLowerCase()) ?? 0,
        usageUpdatedAt: a.usageUpdatedAt ?? null
      }))

      // 真漂移检测：优先按账号 ID 比对（兼容同邮箱多账号），再兜底邮箱比对
      let drift: DriftWarning | null = null
      if (
        acctState.selectedAccountId &&
        acctState.activeAccountId &&
        acctState.selectedAccountId !== acctState.activeAccountId &&
        selectedAccount &&
        referenceEmail
      ) {
        drift = {
          expectedAccountId: selectedAccount.id,
          expectedEmail: selectedAccount.email,
          actualEmail: referenceEmail,
          detectedAt: Date.now()
        }
      } else if (
        desired &&
        referenceEmail &&
        !emailsEqual(desired.email, referenceEmail) &&
        (!acctState.selectedAccountId || acctState.selectedAccountId === desired.id) &&
        accounts.some((a) => a.id === desired!.id || emailsEqual(a.email, desired!.email))
      ) {
        drift = {
          expectedAccountId: desired.id,
          expectedEmail: desired.email,
          actualEmail: referenceEmail,
          detectedAt: Date.now()
        }
      }

      if (drift) {
        const driftKey = `${drift.expectedAccountId ?? drift.expectedEmail}->${drift.actualEmail}`
        if (settings.autoGuardDrift && this.lastDriftNotifiedKey !== driftKey) {
          this.lastDriftNotifiedKey = driftKey
          void this.orca.host
            .call('notifications.show', {
              title: '检测到反重力账号漂移',
              body: `全局凭证已被旧进程覆盖为 ${shortEmail(drift.actualEmail)}（预期 ${shortEmail(
                drift.expectedEmail
              )}），请打开右侧「反重力换号」面板确认后拉齐全部终端。`
            })
            .catch(() => {})
        }
      } else {
        this.lastDriftNotifiedKey = null
      }

      terminals.sort((a, b) => {
        if (a.isOutdated !== b.isOutdated) return a.isOutdated ? -1 : 1
        if (a.processKind !== b.processKind) return a.processKind === 'cli' ? -1 : 1
        if (a.isExternal !== b.isExternal) return a.isExternal ? 1 : -1
        const wsCmp = a.workspaceName.localeCompare(b.workspaceName)
        if (wsCmp !== 0) return wsCmp
        const titleCmp = a.title.localeCompare(b.title)
        if (titleCmp !== 0) return titleCmp
        return a.pid - b.pid
      })

      const outdatedCount = terminals.filter(
        (t) => t.processKind === 'cli' && !t.isExternal && t.isOutdated
      ).length
      const externalOutdatedCount = terminals.filter(
        (t) => t.processKind === 'cli' && t.isExternal && t.isOutdated
      ).length
      const acpOutdatedCount = terminals.filter(
        (t) => t.processKind === 'acp' && t.isOutdated
      ).length
      // 托管 Chat 使用独立凭据池，不纳入宿主未识别邮箱计数
      const unknownAuthCount = terminals.filter(
        (t) => !t.authEmail && !isManagedChatTerminal(t)
      ).length
      const chatBackendMode = resolveChatBackendMode(acctState, terminals)

      const snap: SwitcherSnapshot = {
        updatedAt: Date.now(),
        accountsUpdatedAt: this.accountsFetchedAt,
        currentEmail: referenceEmail,
        activeAccountId: acctState.activeAccountId,
        selectedAccountId: acctState.selectedAccountId,
        desiredEmail: desired?.email ?? null,
        accounts,
        terminals,
        outdatedCount,
        externalOutdatedCount,
        acpOutdatedCount,
        unknownAuthCount,
        queuedCount: finalQueue.length,
        workingPolicy: settings.workingPolicy,
        chatBackendMode,
        drift,
        busy: this.busy,
        busyLabel: this.busyLabel,
        scanDegradedReason,
        lastOperation: this.lastOperation,
        error: errorMessage
      }

      this.snapshot = snap
      await this.updateStatusBar(snap)
      this.publish(snap, false)
      return snap
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.orca.log(`refreshSnapshot failed: ${message}`)
      const fallback: SwitcherSnapshot = {
        updatedAt: Date.now(),
        accountsUpdatedAt: this.accountsFetchedAt,
        currentEmail: this.snapshot?.currentEmail ?? null,
        activeAccountId: this.snapshot?.activeAccountId ?? null,
        selectedAccountId: this.snapshot?.selectedAccountId ?? null,
        desiredEmail: desired?.email ?? null,
        accounts: this.snapshot?.accounts ?? [],
        terminals: this.snapshot?.terminals ?? [],
        outdatedCount: this.snapshot?.outdatedCount ?? 0,
        externalOutdatedCount: this.snapshot?.externalOutdatedCount ?? 0,
        acpOutdatedCount: this.snapshot?.acpOutdatedCount ?? 0,
        unknownAuthCount: this.snapshot?.unknownAuthCount ?? 0,
        queuedCount: queue.length,
        workingPolicy: settings.workingPolicy,
        chatBackendMode: this.snapshot?.chatBackendMode ?? 'unknown',
        drift: null,
        busy: this.busy,
        busyLabel: this.busyLabel,
        scanDegradedReason: this.snapshot?.scanDegradedReason ?? null,
        lastOperation: this.lastOperation,
        error: message
      }
      this.snapshot = fallback
      await this.updateStatusBar(fallback)
      this.publish(fallback, true)
      return fallback
    }
  }

  private async updateStatusBar(snap: SwitcherSnapshot): Promise<void> {
    const view = computeStatusBar(snap)
    try {
      await this.orca.host.call('statusBar.update', {
        id: 'agy-account-status',
        text: view.text,
        tone: view.tone,
        tooltip: view.tooltip,
        visible: true
      })
    } catch (err: unknown) {
      this.orca.log(
        `statusBar.update failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private publish(snap: SwitcherSnapshot, force: boolean): void {
    // 按分钟级时间桶去重：正常状态变化立刻推送，静止时每分钟推送一次让精确到分的倒计时自动跳动
    const digest = JSON.stringify({
      ...snap,
      updatedAt: Math.floor(snap.updatedAt / 60_000)
    })
    if (!force && digest === this.lastPublishedDigest) return
    this.lastPublishedDigest = digest
    try {
      this.orca.panels.post('state.updated', snap)
    } catch (err: unknown) {
      this.orca.log(`panels.post failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 跨工作区安全原地重启（C-0 + H-7）：
   * 1. 等待父 Shell 回到空闲提示符（无其他前台子进程，且父 Shell 仍存活）；
   * 2. 通过 `orca terminal send` 先发 Ctrl+E + Ctrl+U 清空整行，再发白名单重启命令 + Enter。
   */
  private async relaunchInTerminal(
    terminalId: string,
    parentPid: number,
    restartCmd: string
  ): Promise<void> {
    if (parentPid > 1) {
      const shellReady = await this.sys.waitForShellReady(parentPid, 1500)
      if (!shellReady) {
        throw new Error('父级 Shell 已退出或存在未结束子进程，为安全起见未注入命令')
      }
    }
    try {
      await this.sys.sendTerminalText(terminalId, '\u0005\u0015', false)
      await this.sys.sleep(80)
    } catch {
      // 清行失败不影响主命令发送
    }
    const res = await this.sys.sendTerminalText(terminalId, restartCmd, true)
    if (!res.accepted) {
      throw new Error(res.reason || '终端未接受重启命令（可能已关闭或不可写）')
    }
  }

  private schedulePostRestartRefresh(): void {
    if (this.disposed) return
    if (this.postRestartTimer) clearTimeout(this.postRestartTimer)
    this.postRestartTimer = setTimeout(() => {
      this.postRestartTimer = null
      if (!this.disposed && !this.busy) {
        void this.refreshSnapshot({ refreshAccounts: false, fromBackground: true }).catch((err) =>
          this.orca.log(`postRestartRefresh failed: ${err instanceof Error ? err.message : String(err)}`)
        )
      }
    }, 2800)
    unrefTimer(this.postRestartTimer)
  }

  /**
   * 锁内核心换号执行器（供 switchAll / switchBest / syncToCurrent / forceDrainQueue / restartOne / quickSyncCommand 共享），
   * 消除多入口的锁外预处理与双锁释放间隙。
   */
  private async executeSwitchAllLocked(options: {
    targetAccountId: string
    workingPolicy?: WorkingPolicy
    onlyOutdated?: boolean
    terminalIds?: string[]
    preserveOtherQueueTargets?: boolean
    preloadedSnapshot?: SwitcherSnapshot
  }): Promise<number> {
    let restartedCount = 0
    const settings = await this.readSettings()
    const policy = options.workingPolicy ?? settings.workingPolicy
    const onlyOutdated = options.onlyOutdated !== false

    const currentSnap =
      options.preloadedSnapshot ??
      (await this.refreshSnapshot({
        refreshAccounts: !this.cachedAccountState
      }))
    const targetAccount =
      currentSnap.accounts.find((a) => a.id === options.targetAccountId) ??
      currentSnap.accounts.find((a) => emailsEqual(a.email, options.targetAccountId))

    if (!targetAccount) {
      throw new Error(`找不到目标账号：${options.targetAccountId}`)
    }

    const targetIdSet = options.terminalIds ? new Set(options.terminalIds) : null
    const candidates = currentSnap.terminals.filter((t) => {
      if (t.processKind !== 'cli' || t.isExternal || !t.terminalId || !t.canRestartInPlace) {
        return false
      }
      if (targetIdSet && !targetIdSet.has(t.terminalId)) return false
      if (onlyOutdated && (!t.authEmail || emailsEqual(t.authEmail, targetAccount.email))) {
        return false
      }
      return true
    })

    const immediateTargets: AgyTerminalInfo[] = []
    const queueTargets: AgyTerminalInfo[] = []
    const skippedTargets: AgyTerminalInfo[] = []

    for (const t of candidates) {
      if (isUnsafeToAutoRestart(t.agentState) && policy !== 'force') {
        if (policy === 'queue') {
          queueTargets.push(t)
        } else {
          skippedTargets.push(t)
        }
      } else {
        immediateTargets.push(t)
      }
    }

    const details: string[] = []
    const recoveryCommands: RecoveryCommandItem[] = []
    let failedCount = 0
    let rolledBackCount = 0

    // 第 1 步：先停掉所有「立即重启组」旧进程（带 PID 启动时间复核）
    const stoppedItems: Array<{
      term: AgyTerminalInfo
      parentPid: number
      restartCmd: string
    }> = []
    const stopFailedIds = new Set<string>()

    if (immediateTargets.length > 0) {
      await this.setBusyLabel(`AGY 正在退出 ${immediateTargets.length} 个旧终端...`)
      const stopResults = await Promise.all(
        immediateTargets.map(async (term) => {
          const meta = this.runtimeProcessMeta.get(term.pid)
          const fullCmd = meta?.command ?? term.commandPreview
          const restartCmd = buildRestartCommand(fullCmd, term.conversationId, {
            pathExists: (p) => this.sys.pathExists(p)
          })
          const stopped = await this.sys.stopProcessGracefully(
            term.pid,
            term.startedAtText,
            12000
          )
          return { term, parentPid: meta?.ppid ?? 0, restartCmd, stopped }
        })
      )
      for (const r of stopResults) {
        if (r.stopped) {
          stoppedItems.push({
            term: r.term,
            parentPid: r.parentPid,
            restartCmd: r.restartCmd
          })
        } else {
          failedCount += 1
          stopFailedIds.add(r.term.terminalId!)
          details.push(`✗ ${r.term.workspaceName} · ${r.term.title}：旧进程未在超时内退出或 PID 身份变化`)
        }
      }
    }

    // 第 2 步：所有待重启旧进程退出后，切换全局 Antigravity 账号；失败则并发回滚原位拉起！
    await this.setBusyLabel(`AGY 正在切换到 ${shortEmail(targetAccount.email)}...`)
    try {
      this.accountMutationEpoch += 1
      await this.sys.selectAntigravityAccount(targetAccount.id)
    } catch (selectErr: unknown) {
      const selectMsg = selectErr instanceof Error ? selectErr.message : String(selectErr)
      this.orca.log(`selectAntigravityAccount failed: ${selectMsg}`)
      details.push(`✗ 切换全局账号失败：${selectMsg}`)

      if (stoppedItems.length > 0) {
        await this.setBusyLabel(`切号失败，正在回滚恢复 ${stoppedItems.length} 个终端...`)
        const rbResults = await Promise.all(
          stoppedItems.map(async (item) => {
            try {
              await this.relaunchInTerminal(item.term.terminalId!, item.parentPid, item.restartCmd)
              return { item, ok: true as const, error: '' }
            } catch (rbErr: unknown) {
              return {
                item,
                ok: false as const,
                error: rbErr instanceof Error ? rbErr.message : String(rbErr)
              }
            }
          })
        )
        for (const r of rbResults) {
          if (r.ok) {
            rolledBackCount += 1
            details.push(`↩ 已自动回滚恢复：${r.item.term.workspaceName} · ${r.item.term.title}`)
          } else {
            failedCount += 1
            recoveryCommands.push({
              label: `${r.item.term.workspaceName} · ${r.item.term.title}`,
              command: r.item.restartCmd,
              reason: `切号失败且自动回滚拉起失败（${r.error}）`
            })
            this.orca.log(`RECOVERY_CMD [${r.item.term.workspaceName}]: ${r.item.restartCmd}`)
          }
        }
      }

      this.lastOperation = {
        at: Date.now(),
        targetEmail: targetAccount.email,
        restartedCount: 0,
        queuedCount: 0,
        skippedCount: skippedTargets.length,
        failedCount: Math.max(1, failedCount),
        rolledBackCount,
        message: `切号失败（${selectMsg}）${
          rolledBackCount > 0 ? `，已自动回滚恢复 ${rolledBackCount} 个终端` : ''
        }${recoveryCommands.length > 0 ? `，另有 ${recoveryCommands.length} 个需手动恢复` : ''}`,
        details: details.slice(0, 20),
        recoveryCommands
      }
      return 0
    }

    try {
      await this.writeDesiredAccount({
        id: targetAccount.id,
        email: targetAccount.email,
        observedSelectedId: targetAccount.id
      })
    } catch (storageErr: unknown) {
      this.orca.log(
        `writeDesiredAccount warning: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`
      )
    }

    if (this.cachedAccountState) {
      this.cachedAccountState = {
        ...this.cachedAccountState,
        activeAccountId: targetAccount.id,
        selectedAccountId: targetAccount.id,
        currentEmail: targetAccount.email
      }
    }

    // 第 3 步：并行跨工作区原位拉起所有已停止终端（8 终端耗时从 ~10s 压缩到 ~1s）
    const succeededRestartIds = new Set<string>()
    const relaunchFailedIds = new Set<string>()
    if (stoppedItems.length > 0) {
      await this.setBusyLabel(`AGY 正在原地恢复 ${stoppedItems.length} 个对话...`)
      const launchResults = await Promise.all(
        stoppedItems.map(async (item) => {
          try {
            await this.relaunchInTerminal(item.term.terminalId!, item.parentPid, item.restartCmd)
            return { item, ok: true as const, error: '' }
          } catch (err: unknown) {
            return {
              item,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err)
            }
          }
        })
      )
      for (const r of launchResults) {
        if (r.ok) {
          restartedCount += 1
          succeededRestartIds.add(r.item.term.terminalId!)
          const convTag = r.item.term.conversationId ? '（已续接原对话）' : '（空白新会话）'
          details.push(`✓ ${r.item.term.workspaceName} · ${r.item.term.title}${convTag}`)
        } else {
          failedCount += 1
          relaunchFailedIds.add(r.item.term.terminalId!)
          details.push(`✗ ${r.item.term.workspaceName} · ${r.item.term.title}：拉起失败（${r.error}）`)
          recoveryCommands.push({
            label: `${r.item.term.workspaceName} · ${r.item.term.title}`,
            command: r.item.restartCmd,
            reason: r.error
          })
          this.orca.log(`RECOVERY_CMD [${r.item.term.workspaceName}]: ${r.item.restartCmd}`)
        }
      }
    }

    // 第 4 步：更新排队队列
    const existingQueue = await this.readQueue()
    const nextQueueMap = new Map<string, PendingQueueItem>()
    const now = Date.now()
    for (const q of existingQueue) {
      if (succeededRestartIds.has(q.terminalId) || relaunchFailedIds.has(q.terminalId)) {
        continue
      }
      if (stopFailedIds.has(q.terminalId)) {
        const nextAttempts = q.attempts + 1
        if (nextAttempts >= MAX_QUEUE_ATTEMPTS) {
          details.push(`✗ 排队终端 ${q.terminalId} 连续 ${nextAttempts} 次退出超时，已移出队列`)
          continue
        }
        const backoff = RETRY_BACKOFF_MS[Math.min(nextAttempts - 1, RETRY_BACKOFF_MS.length - 1)]!
        nextQueueMap.set(q.terminalId, {
          ...q,
          attempts: nextAttempts,
          nextRetryAt: now + backoff
        })
        continue
      }
      if (options.preserveOtherQueueTargets) {
        nextQueueMap.set(q.terminalId, q)
      } else {
        nextQueueMap.set(q.terminalId, {
          ...q,
          targetAccountId: targetAccount.id,
          targetEmail: targetAccount.email,
          attempts: 0,
          nextRetryAt: 0
        })
      }
    }

    for (const qTerm of queueTargets) {
      nextQueueMap.set(qTerm.terminalId!, {
        terminalId: qTerm.terminalId!,
        targetAccountId: targetAccount.id,
        targetEmail: targetAccount.email,
        enqueuedAt: now,
        attempts: 0,
        nextRetryAt: 0
      })
      const stateHint = qTerm.agentState === 'unknown' ? '状态未知' : '干活中'
      details.push(`⏳ ${qTerm.workspaceName} · ${qTerm.title}（${stateHint}，已加入空闲自动切队列）`)
    }
    for (const sTerm of skippedTargets) {
      details.push(`↷ ${sTerm.workspaceName} · ${sTerm.title}（按策略跳过）`)
    }
    await this.writeQueue([...nextQueueMap.values()])

    const externalOutdated = currentSnap.terminals.filter(
      (t) =>
        t.processKind === 'cli' &&
        t.isExternal &&
        t.authEmail &&
        !emailsEqual(t.authEmail, targetAccount.email)
    )
    if (externalOutdated.length > 0) {
      details.push(
        `⚠️ 另有 ${externalOutdated.length} 个外部非 Orca 的 agy 进程仍用旧号，建议在下方结束以防回跳`
      )
    }

    const acpOutdated = currentSnap.terminals.filter(
      (t) =>
        t.processKind === 'acp' &&
        !isManagedChatTerminal(t) &&
        t.authEmail &&
        !emailsEqual(t.authEmail, targetAccount.email)
    )
    if (acpOutdated.length > 0) {
      details.push(
        `⚠️ 仍有 ${acpOutdated.length} 个宿主原生 Chat 进程挂在旧号（空闲者将由 Orca 释放，干活中需待其完成或重开面板）`
      )
    }

    const parts: string[] = [`已切到 ${shortEmail(targetAccount.email)}`]
    if (restartedCount > 0) parts.push(`原地换号 ${restartedCount} 个`)
    if (queueTargets.length > 0) parts.push(`排队等空闲 ${queueTargets.length} 个`)
    if (skippedTargets.length > 0) parts.push(`跳过 ${skippedTargets.length} 个`)
    if (failedCount > 0) parts.push(`失败 ${failedCount} 个`)
    if (
      restartedCount === 0 &&
      queueTargets.length === 0 &&
      skippedTargets.length === 0 &&
      failedCount === 0
    ) {
      parts.push(
        externalOutdated.length + acpOutdated.length > 0
          ? 'Orca 终端已同步（请留意下方外部/Chat 旧进程）'
          : '全部终端均已同步'
      )
    }

    this.lastOperation = {
      at: Date.now(),
      targetEmail: targetAccount.email,
      restartedCount,
      queuedCount: queueTargets.length,
      skippedCount: skippedTargets.length,
      failedCount,
      rolledBackCount,
      message: parts.join('，'),
      details: details.slice(0, 20),
      recoveryCommands
    }

    if (settings.notifyOnComplete) {
      void this.orca.host
        .call('notifications.show', {
          title: failedCount > 0 ? '反重力换号部分失败' : '反重力换号完成',
          body: this.lastOperation.message
        })
        .catch(() => {})
    }

    if (restartedCount > 0) {
      await this.sys.sleep(1000)
    }
    return restartedCount
  }

  private async finalizeAfterSwitch(restartedCount: number): Promise<SwitcherSnapshot> {
    const updatedSnap = await this.refreshSnapshot({ refreshAccounts: false })
    if (restartedCount > 0) {
      this.schedulePostRestartRefresh()
    }
    return updatedSnap
  }

  /** 核心防竞态一键换号（单次独占锁原子完成）。 */
  async switchAll(options: {
    targetAccountId: string
    workingPolicy?: WorkingPolicy
    onlyOutdated?: boolean
    terminalIds?: string[]
    preserveOtherQueueTargets?: boolean
  }): Promise<SwitcherSnapshot> {
    let restartedCount = 0
    await this.withExclusiveLock('AGY 正在准备换号...', async () => {
      restartedCount = await this.executeSwitchAllLocked(options)
    })
    return this.finalizeAfterSwitch(restartedCount)
  }

  /** 自动挑选额度最充裕的健康账号并全终端换号（全程单次独占锁，零闪烁零间隙）。 */
  async switchBest(workingPolicy?: WorkingPolicy): Promise<SwitcherSnapshot> {
    let restartedCount = 0
    await this.withExclusiveLock('AGY 正在检测各账号最新额度...', async () => {
      const snap = await this.refreshSnapshot({ refreshAccounts: true })
      const best = pickBestAccount(snap.accounts, snap.updatedAt)
      if (!best) {
        throw new Error('没有状态正常（ok）的可用 Antigravity 账号，已取消切换以保护现有终端')
      }
      restartedCount = await this.executeSwitchAllLocked({
        targetAccountId: best.id,
        workingPolicy,
        onlyOutdated: true,
        preloadedSnapshot: snap
      })
    })
    return this.finalizeAfterSwitch(restartedCount)
  }

  /** 将所有旧号终端拉齐到预期账号（单次独占锁原子完成）。 */
  async syncToCurrent(workingPolicy?: WorkingPolicy): Promise<SwitcherSnapshot> {
    let restartedCount = 0
    await this.withExclusiveLock('AGY 正在准备同步旧号终端...', async () => {
      const snap = await this.refreshSnapshot({ refreshAccounts: false })
      const target = this.resolvePreferredTargetAccount(snap)
      if (!target) {
        throw new Error('未能确定当前 Antigravity 账号')
      }
      restartedCount = await this.executeSwitchAllLocked({
        targetAccountId: target.id,
        workingPolicy,
        onlyOutdated: true,
        preloadedSnapshot: snap
      })
    })
    return this.finalizeAfterSwitch(restartedCount)
  }

  private resolvePreferredTargetAccount(snap: SwitcherSnapshot): AccountInfo | null {
    if (snap.drift) {
      const byId = snap.drift.expectedAccountId
        ? snap.accounts.find((a) => a.id === snap.drift!.expectedAccountId)
        : null
      const byEmail = snap.accounts.find((a) => emailsEqual(a.email, snap.drift!.expectedEmail))
      if (byId || byEmail) return byId ?? byEmail ?? null
    }
    const selected = snap.selectedAccountId
      ? snap.accounts.find((a) => a.id === snap.selectedAccountId)
      : null
    if (selected) return selected
    return snap.accounts.find((a) => a.isActive) ?? null
  }

  /** 一键强制立即重连当前排队中的所有终端（单次独占锁原子完成）。 */
  async forceDrainQueue(): Promise<SwitcherSnapshot> {
    let restartedCount = 0
    await this.withExclusiveLock('AGY 正在强切排队终端...', async () => {
      const queue = await this.readQueue()
      if (queue.length === 0) return
      const targetAccountId = queue[0]!.targetAccountId
      const terminalIds = queue.map((q) => q.terminalId)
      restartedCount = await this.executeSwitchAllLocked({
        targetAccountId,
        workingPolicy: 'force',
        onlyOutdated: true,
        terminalIds
      })
    })
    return this.finalizeAfterSwitch(restartedCount)
  }

  /** 底部状态栏一键点击智能动作（全程单次独占锁，绝不静默强杀 working）。 */
  async quickSyncCommand(): Promise<string> {
    if (this.busy) {
      return '当前正在执行换号操作，请稍候完成后再试'
    }
    let resultMessage = ''
    let restartedCount = 0
    await this.withExclusiveLock('AGY 正在检测账号与终端状态...', async () => {
      const snap = await this.refreshSnapshot({ refreshAccounts: true })
      if (snap.drift || snap.outdatedCount > 0) {
        const target = this.resolvePreferredTargetAccount(snap)
        if (!target) {
          resultMessage = '未能确定目标 Antigravity 账号'
          return
        }
        restartedCount = await this.executeSwitchAllLocked({
          targetAccountId: target.id,
          workingPolicy: 'queue',
          onlyOutdated: true,
          preloadedSnapshot: snap
        })
        resultMessage = this.lastOperation?.message ?? '已同步旧号终端'
        return
      }
      const externalAndAcp = snap.externalOutdatedCount + snap.acpOutdatedCount
      if (externalAndAcp > 0) {
        resultMessage = `Orca CLI 终端已齐，但仍有 ${externalAndAcp} 个外部/原生 Chat 旧号进程，请打开右侧「反重力换号」面板处理`
        return
      }
      const active = snap.accounts.find((a) => a.isActive)
      const activePrimary = active ? resolvePrimaryQuota(active) : null
      if (
        active &&
        activePrimary &&
        !isQuotaWindowExpired(activePrimary.sessionResetsAt, snap.updatedAt) &&
        typeof activePrimary.sessionUsedPercent === 'number' &&
        activePrimary.sessionUsedPercent >= 100
      ) {
        const best = pickBestAccount(snap.accounts, snap.updatedAt)
        if (best && best.id !== active.id) {
          restartedCount = await this.executeSwitchAllLocked({
            targetAccountId: best.id,
            workingPolicy: 'queue',
            onlyOutdated: true,
            preloadedSnapshot: snap
          })
          resultMessage = this.lastOperation?.message ?? `已切换到 ${shortEmail(best.email)}`
          return
        }
      }
      resultMessage = `当前账号 ${shortEmail(snap.currentEmail)}，共 ${snap.terminals.length} 个 agy 进程，全部已同步`
    })
    await this.finalizeAfterSwitch(restartedCount)
    return resultMessage
  }

  /** 单独原地重启某一个终端（单次独占锁，不篡改其他排队终端的目标账号）。 */
  async restartOne(options: {
    terminalId: string
    targetAccountId?: string
    force?: boolean
  }): Promise<SwitcherSnapshot> {
    let restartedCount = 0
    await this.withExclusiveLock('AGY 正在原地重启终端...', async () => {
      const snap = await this.refreshSnapshot({ refreshAccounts: false })
      const target = options.targetAccountId
        ? snap.accounts.find(
            (a) =>
              a.id === options.targetAccountId || emailsEqual(a.email, options.targetAccountId)
          ) ?? null
        : this.resolvePreferredTargetAccount(snap)

      if (!target) {
        throw new Error('找不到目标账号')
      }

      restartedCount = await this.executeSwitchAllLocked({
        targetAccountId: target.id,
        workingPolicy: options.force === false ? undefined : 'force',
        onlyOutdated: false,
        terminalIds: [options.terminalId],
        preserveOtherQueueTargets: true,
        preloadedSnapshot: snap
      })
    })
    return this.finalizeAfterSwitch(restartedCount)
  }

  /** 结束一个外部（非 Orca）的 agy 进程（走独占锁 + PID 启动时间复核，防误杀）。 */
  async killExternalProcess(pid: number, expectedStartedAtText?: string): Promise<SwitcherSnapshot> {
    await this.withExclusiveLock(`AGY 正在终止外部进程 ${pid}...`, async () => {
      const snap = await this.refreshSnapshot({ refreshAccounts: false })
      const proc = snap.terminals.find(
        (t) => t.pid === pid && t.isExternal && t.processKind === 'cli'
      )
      if (!proc) {
        throw new Error(`未找到可结束的外部 agy 进程 PID ${pid}`)
      }
      const stopped = await this.sys.stopProcessGracefully(
        pid,
        expectedStartedAtText ?? proc.startedAtText,
        10000
      )
      this.lastOperation = {
        at: Date.now(),
        targetEmail: snap.currentEmail ?? '',
        restartedCount: 0,
        queuedCount: 0,
        skippedCount: 0,
        failedCount: stopped ? 0 : 1,
        rolledBackCount: 0,
        message: stopped ? `已结束外部进程 PID ${pid}` : `结束外部进程 PID ${pid} 超时或身份不匹配`,
        details: [
          stopped
            ? `✓ 已优雅终止外部进程 PID ${pid}（原账号 ${shortEmail(proc.authEmail)}）`
            : `✗ 外部进程 PID ${pid} 未在超时内退出或已变更`
        ],
        recoveryCommands: []
      }
    })
    return this.refreshSnapshot({ refreshAccounts: false })
  }

  async cancelQueue(): Promise<SwitcherSnapshot> {
    await this.withExclusiveLock('AGY 正在清空队列...', async () => {
      await this.writeQueue([])
      for (const timer of this.drainTimers.values()) {
        clearTimeout(timer)
      }
      this.drainTimers.clear()
      this.lastOperation = {
        at: Date.now(),
        targetEmail: this.snapshot?.currentEmail ?? '',
        restartedCount: 0,
        queuedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        rolledBackCount: 0,
        message: '已清空等待换号队列',
        details: [],
        recoveryCommands: []
      }
    })
    return this.refreshSnapshot({ refreshAccounts: false })
  }

  async setWorkingPolicy(policy: WorkingPolicy): Promise<SwitcherSnapshot> {
    await this.orca.settings.set('workingPolicy', policy)
    return this.refreshSnapshot({ refreshAccounts: false })
  }

  async focusTerminal(terminalId: string): Promise<{ focused: boolean }> {
    return this.orca.host.call('terminal.focus', { terminalId })
  }

  /**
   * 监听 `agent.status.changed`：当排队中的终端变为空闲时，防抖 800ms 后自动批量消费。
   * H-9 修复：await 后再次核对 `this.disposed`，且所有回调均有 `.catch()` 防 Worker 崩溃。
   */
  async handleAgentStatusChanged(event: {
    terminalId?: string
    state: 'working' | 'blocked' | 'waiting' | 'done'
  }): Promise<void> {
    if (this.disposed) return
    const terminalId = event.terminalId
    if (!terminalId) return

    if (event.state === 'working' || event.state === 'blocked') {
      const existingTimer = this.drainTimers.get(terminalId)
      if (existingTimer) {
        clearTimeout(existingTimer)
        this.drainTimers.delete(terminalId)
      }
      return
    }

    const queue = await this.readQueue()
    if (this.disposed) return
    if (!queue.some((q) => q.terminalId === terminalId)) return

    const existingTimer = this.drainTimers.get(terminalId)
    if (existingTimer) clearTimeout(existingTimer)

    const timer = setTimeout(() => {
      this.drainTimers.delete(terminalId)
      if (this.disposed) return
      void this.drainAnyIdleQueued().catch((err) =>
        this.orca.log(
          `drainAnyIdleQueued (event) failed: ${err instanceof Error ? err.message : String(err)}`
        )
      )
    }, 800)
    unrefTimer(timer)
    this.drainTimers.set(terminalId, timer)
  }

  /** 批量消费所有已进入空闲且超过退避时间的排队终端（全量异常兜底，绝不打崩 Worker）。 */
  async drainAnyIdleQueued(): Promise<void> {
    if (this.busy || this.disposed) return
    const queue = await this.readQueue()
    if (queue.length === 0) return

    const snap = await this.refreshSnapshot({ refreshAccounts: false, fromBackground: true })
    if (this.busy || this.disposed) return

    const latestQueue = await this.readQueue()
    const now = Date.now()
    const readyIds: string[] = []
    let targetAccountId: string | null = null

    for (const q of latestQueue) {
      if (q.nextRetryAt > now) continue
      const t = snap.terminals.find((item) => item.terminalId === q.terminalId)
      if (
        t &&
        t.canRestartInPlace &&
        !isUnsafeToAutoRestart(t.agentState) &&
        t.authEmail &&
        !emailsEqual(t.authEmail, q.targetEmail)
      ) {
        readyIds.push(q.terminalId)
        targetAccountId = q.targetAccountId
      }
    }

    if (readyIds.length === 0 || !targetAccountId) return
    this.orca.log(`排队终端已空闲（${readyIds.length} 个），自动原地补切至 ${targetAccountId}`)
    try {
      await this.switchAll({
        targetAccountId,
        workingPolicy: 'force',
        onlyOutdated: true,
        terminalIds: readyIds
      })
    } catch (err: unknown) {
      this.orca.log(
        `drainAnyIdleQueued switchAll failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}
