// Panel <-> Worker 通信协议，两边共享强类型定义。

export type WorkingPolicy = 'queue' | 'skip' | 'force'

export type TerminalAgentState = 'working' | 'blocked' | 'waiting' | 'done' | 'idle' | 'unknown'

export type AgyProcessKind = 'cli' | 'acp'

export type ChatEngine = 'host-agy' | 'orca-managed'

export type ChatBackendMode = 'host-agy' | 'orca-managed' | 'unknown'

export interface AccountBucketGroup {
  group: string
  sessionUsedPercent: number | null
  sessionResetsAt: number | null
  weeklyUsedPercent: number | null
  weeklyResetsAt: number | null
}

export interface AccountInfo {
  id: string
  email: string
  label: string | null
  isActive: boolean
  isSelected: boolean
  status: string
  sessionUsedPercent: number | null
  sessionResetsAt: number | null
  weeklyUsedPercent: number | null
  weeklyResetsAt: number | null
  buckets: AccountBucketGroup[]
  terminalCount: number
  /** 该账号额度快照的实际观测时间戳（毫秒，来自 Orca `usage.updatedAt`；非当前激活号为历史缓存时刻，未读过时为 null）。 */
  usageUpdatedAt?: number | null
}

export interface AgyTerminalInfo {
  pid: number
  processKind: AgyProcessKind
  terminalId: string | null
  worktreeId: string | null
  workspaceName: string
  title: string
  conversationId: string | null
  authEmail: string | null
  /** 面板展示用截断命令摘要（防止触发 panels.post 256 KiB 上限）。 */
  commandPreview: string
  canRestartInPlace: boolean
  restartBlockedReason: string | null
  isExternal: boolean
  agentState: TerminalAgentState
  isOutdated: boolean
  queuedTargetEmail: string | null
  startedAtText: string
  /** Orca 会话唯一 ID（原生 Chat 用于与 `orca agent list` 1-on-1 绑定）。 */
  orcaSessionId?: string | null
  /** 原生 Chat 所运行的底层引擎：宿主 `agy`（共享系统号）或 Orca 托管独立账号池。 */
  chatEngine?: ChatEngine | null
}

export interface DriftWarning {
  expectedAccountId: string | null
  expectedEmail: string
  actualEmail: string
  detectedAt: number
}

export interface RecoveryCommandItem {
  label: string
  command: string
  reason: string
}

export interface PluginUpdateInfo {
  currentVersion: string
  latestVersion: string
  pluginKey: string
  sourceKind: string
  /** 是否可直接点击按钮一键升级（GitHub/Catalog 安装，或本地源码目录已拉取新版本）。 */
  canOneClickUpdate: boolean
  /** 若新版本增加了权限需要用户确认，展示此完整授权命令。 */
  approvalCommand?: string | null
}

export interface ApplyUpdateOutput {
  status: 'updated' | 'approval_required' | 'failed'
  newVersion?: string | null
  message: string
  approvalCommand?: string | null
}

export interface OperationSummary {
  at: number
  targetEmail: string
  restartedCount: number
  queuedCount: number
  skippedCount: number
  failedCount: number
  rolledBackCount: number
  message: string
  details: string[]
  /** 任何未能自动恢复的终端恢复命令，独立存储、永不截断。 */
  recoveryCommands: RecoveryCommandItem[]
}

export interface SwitcherSnapshot {
  updatedAt: number
  accountsUpdatedAt: number | null
  currentEmail: string | null
  activeAccountId: string | null
  selectedAccountId: string | null
  desiredEmail: string | null
  accounts: AccountInfo[]
  terminals: AgyTerminalInfo[]
  outdatedCount: number
  externalOutdatedCount: number
  acpOutdatedCount: number
  unknownAuthCount: number
  queuedCount: number
  workingPolicy: WorkingPolicy
  chatBackendMode?: ChatBackendMode
  drift: DriftWarning | null
  busy: boolean
  busyLabel: string | null
  scanDegradedReason: string | null
  lastOperation: OperationSummary | null
  error: string | null
  pluginVersion?: string
  updateInfo?: PluginUpdateInfo | null
  isPreview?: boolean
}

export interface GetStateInput {
  refresh?: boolean
  refreshAccounts?: boolean
}

export interface SwitchAllInput {
  targetAccountId: string
  workingPolicy?: WorkingPolicy
  onlyOutdated?: boolean
  terminalIds?: string[]
}

export interface SwitchBestInput {
  workingPolicy?: WorkingPolicy
}

export interface SyncToCurrentInput {
  workingPolicy?: WorkingPolicy
}

export interface RestartOneInput {
  terminalId: string
  targetAccountId?: string
  force?: boolean
}

export interface KillExternalInput {
  pid: number
  startedAtText?: string
}

export interface FocusTerminalInput {
  terminalId: string
}

export interface SetPolicyInput {
  workingPolicy: WorkingPolicy
}

// 注意：Orca 的 PluginRequestInput 条件类型要求 `input` 键必须非可选（内部字段可为可选），
// 否则会被推断为 undefined；无参请求不声明 `input` 键。
declare module 'orca' {
  interface PluginRequests {
    'switcher.getState': {
      input: GetStateInput
      output: SwitcherSnapshot
    }
    'switcher.switchAll': {
      input: SwitchAllInput
      output: SwitcherSnapshot
    }
    'switcher.switchBest': {
      input: SwitchBestInput
      output: SwitcherSnapshot
    }
    'switcher.syncToCurrent': {
      input: SyncToCurrentInput
      output: SwitcherSnapshot
    }
    'switcher.restartOne': {
      input: RestartOneInput
      output: SwitcherSnapshot
    }
    'switcher.forceDrainQueue': {
      output: SwitcherSnapshot
    }
    'switcher.killExternal': {
      input: KillExternalInput
      output: SwitcherSnapshot
    }
    'switcher.cancelQueue': {
      output: SwitcherSnapshot
    }
    'switcher.focusTerminal': {
      input: FocusTerminalInput
      output: { focused: boolean }
    }
    'switcher.setPolicy': {
      input: SetPolicyInput
      output: SwitcherSnapshot
    }
    'switcher.applyUpdate': {
      output: ApplyUpdateOutput
    }
  }

  interface PluginPanelEvents {
    'state.updated': SwitcherSnapshot
  }
}
