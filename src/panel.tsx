// 反重力多账号一键切换 - Orca 原生 Components 侧边栏面板（跨模型池精确隔离版 v0.2.8）：
// - 先在下方选账号、再点上方闪电主按钮，且所有批量换号/同步操作均先展开影响预览确认框，杜绝误触惊吓；
// - 原生 Chat 对话 1-on-1 按 ORCA_AGENT_SESSION_ID 匹配真实工作区/标题/状态，区分宿主 `agy` 与 Orca 托管独立引擎且绝不强杀；
// - Tabs 分栏「账号 / 终端」，5h & 周额度双进度条 + 单账号快照时效 + 过期窗口诚实展示与未读新号手动解死锁。
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  EmptyState,
  Heading,
  IconButton,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import {
  compareAccountsByHeadroom,
  computeSwitchImpact,
  emailsEqual,
  formatResetCountdown,
  formatSnapshotAge,
  isAccountError,
  isAccountUnfetched,
  isManagedChatTerminal,
  isQuotaWindowExpired,
  pickBestAccount,
  resolveAccountQuotaPools,
  shortEmail,
  type ResolvedQuotaPool
} from './command-builder'
import type { AccountInfo, AgyTerminalInfo, SwitcherSnapshot, WorkingPolicy } from './protocol'

interface PendingSwitchConfirm {
  mode: 'best' | 'selected' | 'sync'
  targetAccountId: string
  targetEmail: string
}

const snapshotAtom = atom<SwitcherSnapshot | null>(null)
const actionErrorAtom = atom<string | null>(null)
const noticeInfoAtom = atom<string | null>(null)
const refreshingAtom = atom<boolean>(false)
const pendingActionAtom = atom<boolean>(false)
const confirmKeyAtom = atom<string | null>(null)
const selectedTargetIdAtom = atom<string | null>(null)
const pendingSwitchAtom = atom<PendingSwitchConfirm | null>(null)
const activeTabAtom = atom<'accounts' | 'terminals'>('accounts')

let confirmResetTimer: ReturnType<typeof setTimeout> | null = null
let panelSignal: AbortSignal | undefined

function setSnapshotIfNewer(next: SwitcherSnapshot): void {
  const prev = read(snapshotAtom)
  if (prev && next.updatedAt < prev.updatedAt && !next.busy && prev.busy === next.busy) {
    return
  }
  set(snapshotAtom, next)
}

function clearConfirm(): void {
  if (confirmResetTimer) {
    clearTimeout(confirmResetTimer)
    confirmResetTimer = null
  }
  set(confirmKeyAtom, null)
  set(pendingSwitchAtom, null)
  set(noticeInfoAtom, null)
}

function requireConfirm(key: string): boolean {
  if (read(confirmKeyAtom) === key) {
    clearConfirm()
    return true
  }
  if (confirmResetTimer) clearTimeout(confirmResetTimer)
  set(confirmKeyAtom, key)
  confirmResetTimer = setTimeout(() => {
    confirmResetTimer = null
    if (read(confirmKeyAtom) === key) {
      set(confirmKeyAtom, null)
    }
  }, 4000)
  return false
}

function clampPercent(val: number | null): number {
  if (val === null || !Number.isFinite(val)) return 0
  return Math.max(0, Math.min(100, val))
}

async function refreshState(forceAccounts = true): Promise<void> {
  if (read(refreshingAtom)) return
  set(refreshingAtom, true)
  set(actionErrorAtom, null)
  try {
    const snap = await plugin.request(
      'switcher.getState',
      { refresh: true, refreshAccounts: forceAccounts },
      { timeoutMs: 45000, signal: panelSignal }
    )
    setSnapshotIfNewer(snap)
  } catch (err: unknown) {
    if (!panelSignal?.aborted) {
      set(actionErrorAtom, err instanceof Error ? err.message : String(err))
    }
  } finally {
    set(refreshingAtom, false)
  }
}

async function runAction(fn: () => Promise<SwitcherSnapshot>): Promise<void> {
  if (read(pendingActionAtom)) return
  clearConfirm()
  set(pendingActionAtom, true)
  set(actionErrorAtom, null)
  try {
    const snap = await fn()
    setSnapshotIfNewer(snap)
  } catch (err: unknown) {
    if (!panelSignal?.aborted) {
      set(actionErrorAtom, err instanceof Error ? err.message : String(err))
    }
  } finally {
    set(pendingActionAtom, false)
  }
}

async function focusTerminal(terminalId: string): Promise<void> {
  set(actionErrorAtom, null)
  try {
    const res = await plugin.request(
      'switcher.focusTerminal',
      { terminalId },
      { timeoutMs: 10000, signal: panelSignal }
    )
    if (!res.focused) {
      set(actionErrorAtom, '未能将焦点切到该终端（可能已被关闭或窗口处于后台）')
    }
  } catch (err: unknown) {
    if (!panelSignal?.aborted) {
      set(actionErrorAtom, err instanceof Error ? err.message : String(err))
    }
  }
}

function quotaTextTone(percent: number | null): 'neutral' | 'warning' | 'danger' {
  if (percent === null) return 'neutral'
  if (percent >= 100) return 'danger'
  if (percent >= 80) return 'warning'
  return 'neutral'
}

function agentStateLabel(t: AgyTerminalInfo): {
  text: string
  tone: 'neutral' | 'accent' | 'warning' | 'success'
} {
  if (t.processKind === 'acp') {
    if (isManagedChatTerminal(t)) {
      if (t.agentState === 'working') return { text: '托管·干活', tone: 'accent' }
      if (t.agentState === 'blocked') return { text: '托管·待审', tone: 'warning' }
      return { text: '独立托管', tone: 'neutral' }
    }
    if (t.agentState === 'working') return { text: 'Chat·干活', tone: 'accent' }
    if (t.agentState === 'blocked') return { text: 'Chat·待审', tone: 'warning' }
    if (t.agentState === 'done' || t.agentState === 'idle' || t.agentState === 'waiting') {
      return { text: 'Chat·空闲', tone: 'success' }
    }
    return { text: '原生Chat', tone: 'warning' }
  }
  if (t.isExternal) return { text: '外部终端', tone: 'warning' }
  if (t.queuedTargetEmail) return { text: '排队中', tone: 'accent' }
  if (t.agentState === 'working') return { text: '干活中', tone: 'accent' }
  if (t.agentState === 'blocked') return { text: '待确认', tone: 'warning' }
  if (t.agentState === 'unknown') return { text: '未知', tone: 'warning' }
  return { text: '空闲', tone: 'success' }
}

interface SecondaryPoolView {
  key: string
  name: string
  summary: string
  resetHint: string | null
  tone: 'neutral' | 'warning' | 'danger'
  hasUsage: boolean
}

/** 格式化副池（如 Claude/GPT）活跃窗口的紧凑重置提示；全 0 或已过期返回 null 保持卡片极简。 */
function formatSecondaryResetHint(
  pool: ResolvedQuotaPool,
  nowMs: number,
  isActive: boolean
): string | null {
  const sExpired = isQuotaWindowExpired(pool.sessionResetsAt, nowMs)
  const wExpired = isQuotaWindowExpired(pool.weeklyResetsAt, nowMs)
  const sActive = !sExpired && pool.sessionUsedPercent !== null && pool.sessionUsedPercent > 0
  const wActive = !wExpired && pool.weeklyUsedPercent !== null && pool.weeklyUsedPercent > 0

  const sReset =
    sActive && pool.sessionResetsAt !== null
      ? formatResetCountdown(pool.sessionResetsAt, nowMs, 'short', { isActive })
      : null
  const wReset =
    wActive && pool.weeklyResetsAt !== null
      ? formatResetCountdown(pool.weeklyResetsAt, nowMs, 'short', { isActive })
      : null

  if (sReset && sReset !== '—' && wReset && wReset !== '—') {
    const sDur = sReset.split(' · ')[0] ?? sReset
    const wDur = wReset.split(' · ')[0] ?? wReset
    return `5h重置 ${sDur} · 周重置 ${wDur}`
  }
  if (sReset && sReset !== '—') return `5h重置 ${sReset}`
  if (wReset && wReset !== '—') return `周重置 ${wReset}`
  return null
}

/** 将副模型池格式化为展示视图，识别各自窗口过期态，绝不让过期峰值永久标红或隐藏 0% 池。 */
function formatSecondaryPools(
  pools: readonly ResolvedQuotaPool[],
  nowMs: number,
  isActive: boolean
): SecondaryPoolView[] {
  const result: SecondaryPoolView[] = []
  for (const b of pools) {
    const name = b.name ?? b.bucketGroup ?? '其他'
    const s = b.sessionUsedPercent
    const w = b.weeklyUsedPercent
    if (s === null && w === null) continue
    const sExpired = isQuotaWindowExpired(b.sessionResetsAt, nowMs)
    const wExpired = isQuotaWindowExpired(b.weeklyResetsAt, nowMs)
    const sTxt = sExpired ? '已过重置' : s === null ? '—' : `${clampPercent(s)}%`
    const wTxt = wExpired ? '已过重置' : w === null ? '—' : `${clampPercent(w)}%`
    const activeMaxPct = Math.max(sExpired ? 0 : (s ?? 0), wExpired ? 0 : (w ?? 0))
    result.push({
      key: b.bucketGroup ?? name,
      name,
      summary: `5h ${sTxt} · 周 ${wTxt}`,
      resetHint: formatSecondaryResetHint(b, nowMs, isActive),
      tone: quotaTextTone(activeMaxPct),
      hasUsage: activeMaxPct > 0
    })
  }
  return result
}

export function setup(ctx: PanelContext): void {
  panelSignal = ctx.signal
  ctx.subscriptions.push(
    plugin.on('state.updated', (snap) => {
      setSnapshotIfNewer(snap)
    }),
    {
      dispose() {
        clearConfirm()
        panelSignal = undefined
      }
    }
  )
  void refreshState(false)
}

function policyDisplayName(policy: WorkingPolicy): string {
  if (policy === 'force') return '立刻中断强切'
  if (policy === 'skip') return '跳过不动'
  return '等空闲自动换号'
}

function AccountRow(
  account: AccountInfo,
  snap: SwitcherSnapshot,
  locked: boolean,
  selectedTargetId: string | null
) {
  const { primary, secondary } = resolveAccountQuotaPools(account)
  const sessionPct = primary.sessionUsedPercent
  const weeklyPct = primary.weeklyUsedPercent
  const sessionExpired = isQuotaWindowExpired(primary.sessionResetsAt, snap.updatedAt)
  const weeklyExpired = isQuotaWindowExpired(primary.weeklyResetsAt, snap.updatedAt)
  const allOutdated = snap.outdatedCount + snap.externalOutdatedCount + snap.acpOutdatedCount
  const isCurrentAndAllClean =
    account.isActive &&
    !snap.drift &&
    allOutdated === 0 &&
    snap.unknownAuthCount === 0 &&
    snap.queuedCount === 0
  const onlyExternalLeft =
    account.isActive && !snap.drift && snap.outdatedCount === 0 && allOutdated > 0
  const isUnfetched = isAccountUnfetched(account)
  const isErrorAccount = isAccountError(account)
  const isDraftSelected = selectedTargetId === account.id

  const sessionReset = formatResetCountdown(primary.sessionResetsAt, snap.updatedAt, 'short', {
    isActive: account.isActive
  })
  const weeklyReset = formatResetCountdown(primary.weeklyResetsAt, snap.updatedAt, 'short', {
    isActive: account.isActive
  })
  const extraPools = formatSecondaryPools(secondary, snap.updatedAt, account.isActive)
  const primaryPrefix = primary.name && extraPools.length > 0 ? `${primary.name} ` : ''

  const statusMeta = [
    account.isActive ? '当前' : null,
    account.terminalCount > 0 ? `${account.terminalCount} 进程` : null
  ]
    .filter(Boolean)
    .join(' · ')

  const snapshotAge = !account.isActive ? formatSnapshotAge(account.usageUpdatedAt, snap.updatedAt) : null
  const footerLeft = [account.label ? account.email : null, snapshotAge ? `快照 · ${snapshotAge}` : null]
    .filter(Boolean)
    .join(' · ')

  const canSelectAsTarget = !locked && !isCurrentAndAllClean && !onlyExternalLeft

  return (
    <Box
      key={account.id}
      direction="column"
      gap="sm"
      padding="md"
      border={isDraftSelected ? 'accent' : true}
      radius="md"
      background={isDraftSelected ? 'accent' : 'card'}
    >
      {/* 卡头：用户名 + 当前/终端或未读/异常标注，选中为待切目标时卡片整卡高亮 */}
      <Row justify="between" align="center" gap="xs">
        <Text weight="semibold" size="sm" truncate>
          {account.label || shortEmail(account.email)}
        </Text>
        {isErrorAccount ? (
          <Badge tone="danger">额度异常</Badge>
        ) : isUnfetched ? (
          <Badge tone="neutral">未读取</Badge>
        ) : statusMeta ? (
          <Text size="xs" tone={account.isActive ? 'success' : 'warning'} weight="medium">
            {statusMeta}
          </Text>
        ) : null}
      </Row>

      {/* 主额度区：未读取新号给出友好提示，其余分别处理未过期与已过重置窗口 */}
      {isUnfetched && sessionPct === null && weeklyPct === null ? (
        <Text muted size="xs">
          尚未读取额度，切入此账号后自动刷新
        </Text>
      ) : (
        <>
          {/* 5 小时额度 */}
          <Stack gap="xs">
            <Row justify="between" align="center" gap="xs">
              <Text
                size="xs"
                weight={sessionExpired ? 'medium' : 'semibold'}
                tone={sessionExpired ? 'neutral' : quotaTextTone(sessionPct)}
              >
                {sessionExpired
                  ? `${primaryPrefix}5h 已过重置`
                  : `${primaryPrefix}5h ${sessionPct === null ? '—' : `${clampPercent(sessionPct)}%`}`}
              </Text>
              <Text muted size="xs">
                {sessionExpired
                  ? sessionPct !== null
                    ? `上轮 ${clampPercent(sessionPct)}% · ${account.isActive ? '点刷新' : '切入刷新'}`
                    : account.isActive
                      ? '点刷新'
                      : '切入刷新'
                  : sessionReset}
              </Text>
            </Row>
            <Progress
              label={`${account.email} 5小时额度`}
              labelHidden
              value={sessionExpired ? 0 : clampPercent(sessionPct)}
            />
          </Stack>

          {/* 周额度（与 5h 同级醒目 + 独立进度条 + 精确到分） */}
          <Stack gap="xs">
            <Row justify="between" align="center" gap="xs">
              <Text
                size="xs"
                weight={weeklyExpired ? 'medium' : 'semibold'}
                tone={weeklyExpired ? 'neutral' : quotaTextTone(weeklyPct)}
              >
                {weeklyExpired
                  ? `${primaryPrefix}周 已过重置`
                  : `${primaryPrefix}周 ${weeklyPct === null ? '—' : `${clampPercent(weeklyPct)}%`}`}
              </Text>
              <Text muted size="xs">
                {weeklyExpired
                  ? weeklyPct !== null
                    ? `上轮 ${clampPercent(weeklyPct)}% · ${account.isActive ? '点刷新' : '切入刷新'}`
                    : account.isActive
                      ? '点刷新'
                      : '切入刷新'
                  : weeklyReset}
              </Text>
            </Row>
            <Progress
              label={`${account.email} 周额度`}
              labelHidden
              value={weeklyExpired ? 0 : clampPercent(weeklyPct)}
            />
          </Stack>
        </>
      )}

      {/* 副模型池（如 Claude/GPT）：每个有该池的账号均清晰展示，绝不因 0% 隐藏；有活跃用量时附紧凑重置倒计时 */}
      {extraPools.map((pool) => (
        <Stack key={pool.key} gap="none">
          <Row justify="between" align="center" gap="xs">
            <Text muted size="xs">
              {pool.name}
            </Text>
            <Text
              size="xs"
              muted={!pool.hasUsage}
              weight={pool.hasUsage ? 'medium' : 'regular'}
              tone={pool.tone}
            >
              {pool.summary}
            </Text>
          </Row>
          {pool.resetHint ? (
            <Row justify="end">
              <Text muted size="xs">
                {pool.resetHint}
              </Text>
            </Row>
          ) : null}
        </Stack>
      ))}

      {/* 底部行：左（可选别名邮箱 + 快照龄），右（纯选中/取消选中目标，未读/异常号亦开放手动切入） */}
      <Row justify="between" align="center" gap="xs">
        <Text muted size="xs" truncate>
          {footerLeft}
        </Text>
        {isCurrentAndAllClean ? (
          <Text muted size="xs">
            ✓ 已全同步
          </Text>
        ) : onlyExternalLeft ? (
          <Button size="xs" variant="ghost" disabled>
            请见终端页
          </Button>
        ) : (
          <Button
            size="xs"
            variant={isDraftSelected ? 'solid' : 'outline'}
            tone={isDraftSelected ? 'accent' : 'neutral'}
            icon={isDraftSelected ? 'check' : undefined}
            disabled={!canSelectAsTarget}
            tooltip={
              isDraftSelected
                ? '点击取消选中，恢复为顶部「自动选最空闲号」模式'
                : isErrorAccount
                  ? '上次读取额度异常，仍可手动选为目标切入并重刷'
                  : '先选为待切换目标，然后再点顶部闪电执行'
            }
            onPress={() => {
              set(pendingSwitchAtom, null)
              set(noticeInfoAtom, null)
              set(selectedTargetIdAtom, isDraftSelected ? null : account.id)
            }}
          >
            {isDraftSelected ? '已选中' : '选择'}
          </Button>
        )}
      </Row>
    </Box>
  )
}

function TerminalRow(
  term: AgyTerminalInfo,
  snap: SwitcherSnapshot,
  locked: boolean,
  confirmKey: string | null
) {
  const st = agentStateLabel(term)
  const isBusyOrUnknown =
    term.agentState === 'working' ||
    term.agentState === 'blocked' ||
    term.agentState === 'unknown'
  const restartConfirmId = `restart:${term.terminalId ?? term.pid}`
  const killConfirmId = `kill:${term.pid}`
  const isConfirmingRestart = confirmKey === restartConfirmId
  const isConfirmingKill = confirmKey === killConfirmId

  return (
    <Box
      key={`${term.pid}-${term.terminalId ?? term.processKind}`}
      direction="column"
      gap="xs"
      padding="sm"
      border={term.isOutdated ? 'warning' : true}
      radius="md"
      background="card"
    >
      <Row justify="between" align="center" gap="xs">
        <Row gap="xs" align="center">
          <Text weight="semibold" size="sm" truncate>
            {term.workspaceName}
          </Text>
          <Badge tone={term.isOutdated ? 'danger' : st.tone}>
            {term.isOutdated ? '旧号' : st.text}
          </Badge>
        </Row>
        <Text muted size="xs">
          {isManagedChatTerminal(term)
            ? '独立凭据'
            : term.authEmail
              ? shortEmail(term.authEmail)
              : '识别中'}
        </Text>
      </Row>

      <Text muted size="xs" truncate>
        {term.title}
      </Text>

      {term.restartBlockedReason && !term.isExternal && term.processKind === 'cli' ? (
        <Text tone="warning" size="xs">
          {term.restartBlockedReason}
        </Text>
      ) : null}

      <Row justify="between" align="center" gap="xs">
        <Text muted size="xs">
          {term.processKind === 'acp'
            ? isManagedChatTerminal(term)
              ? '托管引擎 · 不随面板切号'
              : term.isOutdated
                ? '宿主共号 · 空闲切号由 Orca 释放'
                : '宿主共号 · 不支持原地重连'
            : term.conversationId
              ? `${st.text} · ${term.conversationId.slice(0, 8)}`
              : `${st.text} · 空白会话`}
        </Text>
        <Row gap="xs">
          {term.terminalId ? (
            <Button
              size="xs"
              variant="ghost"
              icon="terminal"
              onPress={() => void focusTerminal(term.terminalId!)}
            >
              定位
            </Button>
          ) : null}

          {term.processKind === 'cli' &&
          !term.isExternal &&
          term.terminalId &&
          term.canRestartInPlace ? (
            <Button
              size="xs"
              variant={term.isOutdated || isConfirmingRestart ? 'solid' : 'outline'}
              tone={isConfirmingRestart ? 'danger' : term.isOutdated ? 'warning' : 'neutral'}
              icon="refresh"
              disabled={locked}
              tooltip={
                isBusyOrUnknown
                  ? '该终端正在运行或状态未知；二次点击确认后立即原地续接重连'
                  : '在原 Tab 原地重启并续接原对话'
              }
              onPress={() => {
                if (isBusyOrUnknown && !requireConfirm(restartConfirmId)) return
                void runAction(() =>
                  plugin.request(
                    'switcher.restartOne',
                    { terminalId: term.terminalId!, force: true },
                    { timeoutMs: 60000, signal: panelSignal }
                  )
                )
              }}
            >
              {isConfirmingRestart ? '确认强切' : isBusyOrUnknown ? '强切' : '换号'}
            </Button>
          ) : null}

          {term.processKind === 'cli' && term.isExternal && (term.isOutdated || !term.authEmail) ? (
            <Button
              size="xs"
              variant={isConfirmingKill ? 'solid' : 'outline'}
              tone="danger"
              icon="stop"
              disabled={locked}
              tooltip="优雅终止该外部旧进程（需二次点击确认）"
              onPress={() => {
                if (!requireConfirm(killConfirmId)) return
                void runAction(() =>
                  plugin.request(
                    'switcher.killExternal',
                    { pid: term.pid, startedAtText: term.startedAtText },
                    { timeoutMs: 30000, signal: panelSignal }
                  )
                )
              }}
            >
              {isConfirmingKill ? '确认结束' : '结束'}
            </Button>
          ) : null}
        </Row>
      </Row>
    </Box>
  )
}

function resolveSyncTargetAccount(snap: SwitcherSnapshot): AccountInfo | null {
  if (snap.drift) {
    const byId = snap.drift.expectedAccountId
      ? snap.accounts.find((a) => a.id === snap.drift!.expectedAccountId)
      : null
    const byEmail = snap.accounts.find((a) => emailsEqual(a.email, snap.drift!.expectedEmail))
    if (byId || byEmail) return byId ?? byEmail ?? null
  }
  if (snap.selectedAccountId) {
    const selected = snap.accounts.find((a) => a.id === snap.selectedAccountId)
    if (selected) return selected
  }
  return snap.accounts.find((a) => a.isActive) ?? null
}

function SwitchConfirmBox(
  confirm: PendingSwitchConfirm,
  snap: SwitcherSnapshot,
  locked: boolean
) {
  const target =
    snap.accounts.find((a) => a.id === confirm.targetAccountId) ??
    snap.accounts.find((a) => emailsEqual(a.email, confirm.targetEmail))
  if (!target) {
    return (
      <Callout tone="warning" title="目标账号状态已变化" icon="warning">
        <Row justify="between" align="center" gap="xs">
          <Text size="xs">该账号已不在当前列表中，请重新选择。</Text>
          <Button size="xs" variant="outline" onPress={() => set(pendingSwitchAtom, null)}>
            关闭
          </Button>
        </Row>
      </Callout>
    )
  }

  const impact = computeSwitchImpact(snap, target.email, snap.workingPolicy)
  const { primary, secondary } = resolveAccountQuotaPools(target)
  const sPct = primary.sessionUsedPercent
  const wPct = primary.weeklyUsedPercent
  const sTxt = sPct === null ? '—' : `${clampPercent(sPct)}%`
  const wTxt = wPct === null ? '—' : `${clampPercent(wPct)}%`
  const sessionExpired = isQuotaWindowExpired(primary.sessionResetsAt, snap.updatedAt)
  const weeklyExpired = isQuotaWindowExpired(primary.weeklyResetsAt, snap.updatedAt)
  const isUnfetched = isAccountUnfetched(target)
  const isErrorAccount = isAccountError(target)
  const snapshotAge = !target.isActive ? formatSnapshotAge(target.usageUpdatedAt, snap.updatedAt) : null
  const isFull5h = !sessionExpired && sPct !== null && sPct >= 100
  const isForceRisk = impact.forcedBusyCount > 0
  const manualCliCount = impact.externalCount + impact.blockedCount
  const activeSecondaryPools = formatSecondaryPools(secondary, snap.updatedAt, target.isActive).filter(
    (p) => p.hasUsage
  )

  const title =
    confirm.mode === 'best'
      ? `确认切到最空闲号 ${shortEmail(target.email)}？`
      : confirm.mode === 'sync'
        ? `确认同步旧终端到 ${shortEmail(target.email)}？`
        : target.isActive
          ? `确认同步到当前号 ${shortEmail(target.email)}？`
          : `确认切换到 ${shortEmail(target.email)}？`

  let impactText = ''
  if (isForceRisk) {
    impactText = `⚠ 将立刻强行中断 ${impact.forcedBusyCount} 个干活中/未知终端并重启（共重启 ${impact.immediateCount} 个）。`
  } else if (impact.totalManagedCliCount === 0) {
    impactText = `仅修改全局默认账号（当前 ${snap.terminals.length} 个运行中进程均无需重启）。`
  } else {
    const immPart =
      impact.immediateCount > 0 ? `立即原地重启 ${impact.immediateCount} 个空闲终端` : '暂不立即打断终端'
    const tailParts: string[] = []
    if (impact.queueCount > 0) {
      tailParts.push(`${impact.queueCount} 个干活中将按「${policyDisplayName(snap.workingPolicy)}」排队等待`)
    }
    if (impact.skipCount > 0) {
      tailParts.push(`${impact.skipCount} 个干活中按策略跳过`)
    }
    impactText = `将修改全局账号；${[immPart, ...tailParts].join('，')}。`
  }
  if (impact.acpCount > 0) {
    impactText += ` 另有 ${impact.acpCount} 个宿主原生 Chat 持旧号（空闲将由 Orca 释放，干活中待完成）。`
  }
  if (manualCliCount > 0) {
    impactText += ` 另有 ${manualCliCount} 个外部/受限终端需手动处理。`
  }
  if (impact.managedChatCount > 0) {
    impactText += `（${impact.managedChatCount} 个托管 Chat 使用独立账号，不随本次切换）`
  }

  let targetQuotaSummary: string
  if (isUnfetched && sPct === null && wPct === null) {
    targetQuotaSummary = `目标：${target.email}（尚未读取额度，切入后自动刷新）`
  } else {
    const sPart = sessionExpired
      ? sPct !== null
        ? `已过重置·上轮${clampPercent(sPct)}%`
        : '已过重置'
      : sTxt
    const wPart = weeklyExpired
      ? wPct !== null
        ? `已过重置·上轮${clampPercent(wPct)}%`
        : '已过重置'
      : wTxt
    const ageSuffix = snapshotAge ? ` · ${snapshotAge}快照` : ''
    const poolPrefix = primary.name ? `${primary.name} ` : ''
    targetQuotaSummary = `目标：${target.email}（${poolPrefix}5h ${sPart} · 周 ${wPart}${ageSuffix}）${isFull5h ? ' ⚠ 5h已满' : ''}`
  }

  return (
    <Callout
      tone={isForceRisk || isFull5h || isErrorAccount ? 'danger' : 'warning'}
      title={title}
      icon="warning"
    >
      <Stack gap="xs">
        <Text size="xs">{targetQuotaSummary}</Text>
        {activeSecondaryPools.map((p) => (
          <Text
            key={p.key}
            size="xs"
            muted={p.tone === 'neutral'}
            tone={p.tone === 'neutral' ? undefined : p.tone}
          >
            {`${p.name} ${p.summary}`}
          </Text>
        ))}
        {confirm.mode === 'best' && (sessionExpired || weeklyExpired) ? (
          <Text size="xs" muted>
            注：基于旧快照推算（原窗口已过重置），切入后将实时刷新该账号真实额度。
          </Text>
        ) : null}
        <Text size="xs" tone={isForceRisk ? 'danger' : undefined}>
          {impactText}
        </Text>
        {isErrorAccount ? (
          <Text size="xs" tone="danger">
            {`⚠ 该账号上次读取额度异常（${target.status}），若确认登录正常可手动切入重刷。`}
          </Text>
        ) : null}
        <Row justify="end" gap="xs">
          <Button
            size="xs"
            variant="outline"
            tone="neutral"
            disabled={locked}
            onPress={() => set(pendingSwitchAtom, null)}
          >
            取消
          </Button>
          <Button
            size="xs"
            variant="solid"
            tone={isForceRisk || isFull5h || isErrorAccount ? 'danger' : 'accent'}
            icon="check"
            disabled={locked}
            onPress={() => {
              set(pendingSwitchAtom, null)
              set(noticeInfoAtom, null)
              void runAction(async () => {
                const updated = await plugin.request(
                  'switcher.switchAll',
                  {
                    targetAccountId: target.id,
                    workingPolicy: snap.workingPolicy,
                    onlyOutdated: true
                  },
                  { timeoutMs: 90000, signal: panelSignal }
                )
                set(selectedTargetIdAtom, null)
                return updated
              })
            }}
          >
            {isErrorAccount ? '仍要切入' : confirm.mode === 'sync' || target.isActive ? '确认同步' : '确认换号'}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

export default function Panel() {
  const snap = read(snapshotAtom)
  const actionError = read(actionErrorAtom)
  const noticeInfo = read(noticeInfoAtom)
  const isRefreshing = read(refreshingAtom)
  const isPendingAction = read(pendingActionAtom)
  const confirmKey = read(confirmKeyAtom)
  const selectedTargetId = read(selectedTargetIdAtom)
  const pendingSwitch = read(pendingSwitchAtom)
  const activeTab = read(activeTabAtom)

  if (!snap) {
    return (
      <Stack gap="md">
        <Row justify="between" align="center">
          <Heading level={2}>反重力换号</Heading>
          <IconButton
            icon="refresh"
            label="刷新状态"
            variant="ghost"
            size="xs"
            onPress={() => void refreshState(true)}
          />
        </Row>
        {actionError ? (
          <Callout tone="danger" title="加载失败" icon="error">
            <Text size="xs">{actionError}</Text>
          </Callout>
        ) : (
          <Skeleton shape="block" lines={4} label="正在扫描账号与终端..." />
        )}
      </Stack>
    )
  }

  const locked = snap.busy || isPendingAction
  const totalOutdated = snap.outdatedCount + snap.externalOutdatedCount + snap.acpOutdatedCount
  const orcaTerminals = snap.terminals.filter((t) => t.processKind === 'cli' && !t.isExternal)
  const acpChats = snap.terminals.filter((t) => t.processKind === 'acp')
  const externalTerminals = snap.terminals.filter((t) => t.processKind === 'cli' && t.isExternal)
  const isConfirmingDrain = confirmKey === 'forceDrainQueue'
  const draftTarget =
    selectedTargetId !== null ? snap.accounts.find((a) => a.id === selectedTargetId) ?? null : null

  const openConfirmForPrimary = () => {
    set(actionErrorAtom, null)
    set(noticeInfoAtom, null)
    if (draftTarget) {
      if (draftTarget.isActive && snap.outdatedCount === 0 && !snap.drift) {
        const acpHint =
          snap.acpOutdatedCount > 0
            ? `（另有 ${snap.acpOutdatedCount} 个宿主 Chat 仍持旧号，请见终端页）`
            : ''
        set(
          noticeInfoAtom,
          `当前号 ${shortEmail(draftTarget.email)} 已全部对齐，无需重复切换；请在下方选其他账号。${acpHint}`
        )
        return
      }
      set(pendingSwitchAtom, {
        mode: 'selected',
        targetAccountId: draftTarget.id,
        targetEmail: draftTarget.email
      })
      return
    }
    const best = pickBestAccount(snap.accounts, snap.updatedAt)
    if (!best) {
      set(actionErrorAtom, '没有状态正常（ok）的可用 Antigravity 账号')
      return
    }
    if (best.isActive && snap.outdatedCount === 0 && !snap.drift) {
      const acpHint =
        snap.acpOutdatedCount > 0
          ? `（另有 ${snap.acpOutdatedCount} 个宿主 Chat 仍持旧号，请见终端页）`
          : ''
      set(
        noticeInfoAtom,
        `当前 ${shortEmail(best.email)} 已是最空闲可用号且全部终端已对齐，无需切换。${acpHint}`
      )
      return
    }
    set(pendingSwitchAtom, {
      mode: 'best',
      targetAccountId: best.id,
      targetEmail: best.email
    })
  }

  const openConfirmForSync = () => {
    set(actionErrorAtom, null)
    set(noticeInfoAtom, null)
    const target = resolveSyncTargetAccount(snap)
    if (!target) {
      set(actionErrorAtom, '未能确定目标 Antigravity 账号')
      return
    }
    set(pendingSwitchAtom, {
      mode: 'sync',
      targetAccountId: target.id,
      targetEmail: target.email
    })
  }

  // 当前账号置顶，其余按真实可用余量排序（过期窗口不被死缓存垫底，且实测 0% 优先于过期推算）
  const orderedAccounts = [...snap.accounts].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
    return compareAccountsByHeadroom(a, b, snap.updatedAt)
  })

  const activeUsageAt =
    snap.accounts.find((a) => a.isActive)?.usageUpdatedAt ?? snap.accountsUpdatedAt

  return (
    <Stack gap="md">
      {/* 极简顶栏 */}
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Heading level={2}>反重力换号</Heading>
          {locked ? (
            <Badge tone="accent">处理中</Badge>
          ) : totalOutdated > 0 ? (
            <Badge tone="warning">{`${totalOutdated} 旧号`}</Badge>
          ) : snap.unknownAuthCount > 0 ? (
            <Badge tone="warning">{`${snap.unknownAuthCount} 未知`}</Badge>
          ) : (
            <Badge tone="success">已对齐</Badge>
          )}
        </Row>
        <IconButton
          icon="refresh"
          label="刷新账号额度与终端"
          tooltip="立即拉取最新远程额度与本机 agy 进程"
          variant="ghost"
          size="xs"
          disabled={isRefreshing || locked}
          onPress={() => void refreshState(true)}
        />
      </Row>

      {snap.isPreview ? (
        <Callout tone="accent" title="预览模式" icon="info">
          <Text size="xs">当前展示的是静态检查预览数据。</Text>
        </Callout>
      ) : null}

      {snap.scanDegradedReason ? (
        <Callout tone="warning" title="扫描安全降级" icon="warning">
          <Text size="xs">{snap.scanDegradedReason}，已暂停自动补切与队列清理。</Text>
        </Callout>
      ) : null}

      {snap.drift ? (
        <Callout tone="danger" title="账号已被旧进程顶回" icon="warning">
          <Stack gap="xs">
            <Text size="xs">
              预期 {shortEmail(snap.drift.expectedEmail)}，当前漂移为{' '}
              {shortEmail(snap.drift.actualEmail)}。
            </Text>
            <Button
              size="xs"
              tone="danger"
              icon="zap"
              disabled={locked}
              onPress={openConfirmForSync}
            >
              切回预期号并同步旧终端
            </Button>
          </Stack>
        </Callout>
      ) : null}

      {!snap.drift && totalOutdated > 0 ? (
        <Callout tone="warning" title={`发现 ${totalOutdated} 个旧号进程`} icon="warning">
          <Stack gap="xs">
            <Text size="xs">
              {snap.outdatedCount > 0
                ? '每小时刷 Token 时可能顶掉当前账号。'
                : '宿主原生 Chat / 外部进程仍挂旧号，每小时刷 Token 时可能顶回旧号。'}
            </Text>
            {snap.outdatedCount > 0 ? (
              <Button
                size="xs"
                tone="warning"
                icon="zap"
                disabled={locked}
                onPress={openConfirmForSync}
              >
                {`一键同步 ${snap.outdatedCount} 个旧终端到 ${shortEmail(snap.currentEmail)}`}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                tone="warning"
                icon="terminal"
                onPress={() => set(activeTabAtom, 'terminals')}
              >
                查看旧号进程
              </Button>
            )}
          </Stack>
        </Callout>
      ) : null}

      {actionError || snap.error ? (
        <Callout tone="danger" title="操作提示" icon="error">
          <Stack gap="xs">
            <Text size="xs">{actionError ?? snap.error}</Text>
            {actionError ? (
              <Row justify="end">
                <Button size="xs" variant="ghost" onPress={() => set(actionErrorAtom, null)}>
                  关闭
                </Button>
              </Row>
            ) : null}
          </Stack>
        </Callout>
      ) : null}

      {/* 主控区：底部先选账号 -> 顶部闪电确认，或直接点自动选最空闲后确认，全链路防误触 */}
      <Stack gap="xs">
        <Row gap="xs" wrap align="center">
          <Button
            size="sm"
            variant={draftTarget ? 'solid' : 'outline'}
            tone="accent"
            icon="zap"
            disabled={locked || snap.accounts.length === 0}
            tooltip={
              draftTarget
                ? `点击先预览确认，再切换到 ${draftTarget.email}`
                : '点击先预览当前最空闲账号与影响终端，确认后才执行'
            }
            onPress={openConfirmForPrimary}
          >
            {draftTarget
              ? draftTarget.isActive
                ? `同步到 ${shortEmail(draftTarget.email)}`
                : `切到 ${shortEmail(draftTarget.email)} 并同步`
              : '自动切最空闲号并同步'}
          </Button>
          {draftTarget ? (
            <IconButton
              icon="close"
              label="取消选中的账号"
              tooltip="取消下方账号选择，恢复为自动选最空闲模式"
              variant="ghost"
              size="xs"
              disabled={locked}
              onPress={() => {
                set(selectedTargetIdAtom, null)
                set(pendingSwitchAtom, null)
                set(noticeInfoAtom, null)
              }}
            />
          ) : null}
          {snap.queuedCount > 0 ? (
            <>
              <Button
                size="sm"
                tone={isConfirmingDrain ? 'danger' : 'warning'}
                icon="play"
                disabled={locked}
                tooltip="若排队终端因 429 限流卡在 working，二次点击立刻强制原地重连"
                onPress={() => {
                  if (!requireConfirm('forceDrainQueue')) return
                  void runAction(() =>
                    plugin.request('switcher.forceDrainQueue', undefined, {
                      timeoutMs: 90000,
                      signal: panelSignal
                    })
                  )
                }}
              >
                {isConfirmingDrain
                  ? `再点确认强切 (${snap.queuedCount})`
                  : `强制立切排队 (${snap.queuedCount})`}
              </Button>
              <Button
                size="sm"
                variant="outline"
                tone="neutral"
                icon="close"
                disabled={locked}
                onPress={() =>
                  void runAction(() =>
                    plugin.request('switcher.cancelQueue', undefined, {
                      timeoutMs: 30000,
                      signal: panelSignal
                    })
                  )
                }
              >
                清空排队
              </Button>
            </>
          ) : null}
        </Row>

        <Select
          label="遇到正在干活的终端策略"
          labelHidden
          value={snap.workingPolicy}
          disabled={locked}
          options={[
            { value: 'queue', label: '干活中策略：等空闲自动换号（推荐）' },
            { value: 'skip', label: '干活中策略：跳过不动' },
            { value: 'force', label: '干活中策略：立刻中断强切' }
          ]}
          onChange={(val) => {
            const policy = val as WorkingPolicy
            void runAction(() =>
              plugin.request(
                'switcher.setPolicy',
                { workingPolicy: policy },
                { timeoutMs: 15000, signal: panelSignal }
              )
            )
          }}
        />
      </Stack>

      {/* 二次确认预览框 / 无需切换告知框 */}
      {pendingSwitch ? SwitchConfirmBox(pendingSwitch, snap, locked) : null}

      {!pendingSwitch && noticeInfo ? (
        <Callout tone="accent" title="无需切换" icon="info">
          <Row justify="between" align="center" gap="xs">
            <Text size="xs">{noticeInfo}</Text>
            <Button size="xs" variant="ghost" onPress={() => set(noticeInfoAtom, null)}>
              知道了
            </Button>
          </Row>
        </Callout>
      ) : null}

      {/* 手动恢复命令兜底区（永不截断） */}
      {snap.lastOperation && snap.lastOperation.recoveryCommands.length > 0 ? (
        <Callout tone="danger" title="以下终端需手动粘贴恢复原对话" icon="warning">
          <Stack gap="xs">
            {snap.lastOperation.recoveryCommands.map((rec, i) => (
              <Stack key={i} gap="xs">
                <Text size="xs" weight="semibold">
                  {`${rec.label}（${rec.reason}）`}
                </Text>
                <Code block>{rec.command}</Code>
              </Stack>
            ))}
          </Stack>
        </Callout>
      ) : null}

      {snap.lastOperation ? (
        <Card title="最近一次换号结果">
          <Stack gap="xs">
            <Text size="xs" weight="medium">
              {snap.lastOperation.message}
            </Text>
            {snap.lastOperation.details.slice(0, 6).map((line, i) => (
              <Text key={i} size="xs" muted>
                {line}
              </Text>
            ))}
          </Stack>
        </Card>
      ) : null}

      {/* 分栏视图：告别长瀑布堆砌 */}
      <Tabs
        label="视图切换"
        value={activeTab}
        onChange={(v) => set(activeTabAtom, v === 'terminals' ? 'terminals' : 'accounts')}
      >
        <Tab value="accounts" label={`账号 (${snap.accounts.length})`} icon="agent">
          <Stack gap="sm">
            {orderedAccounts.length === 0 ? (
              <EmptyState
                icon="agent"
                title="未检测到反重力账号"
                description="请在 Orca 设置 → AI Provider Accounts 中添加 Antigravity 账号。"
              />
            ) : (
              orderedAccounts.map((a) => AccountRow(a, snap, locked, draftTarget?.id ?? null))
            )}
            {activeUsageAt ? (
              <Row justify="end">
                <Text muted size="xs">
                  当前号额度更新于 <RelativeTime at={activeUsageAt} />
                </Text>
              </Row>
            ) : null}
          </Stack>
        </Tab>

        <Tab value="terminals" label={`终端 (${snap.terminals.length})`} icon="terminal">
          <Stack gap="sm">
            {snap.terminals.length === 0 ? (
              <EmptyState
                icon="terminal"
                title="当前没有运行中的 agy 终端或原生 Chat"
                description={
                  snap.chatBackendMode === 'orca-managed'
                    ? '新打开的 agy 终端会使用当前选中账号（注：Orca 托管原生 Chat 使用独立凭据）。'
                    : '新打开的 agy 终端或宿主原生 Chat 会自动使用当前选中的账号。'
                }
              />
            ) : (
              <>
                {orcaTerminals.length > 0 ? (
                  <Stack gap="xs">
                    {acpChats.length > 0 || externalTerminals.length > 0 ? (
                      <Text muted size="xs" weight="medium">
                        {`Orca 终端 (${orcaTerminals.length})`}
                      </Text>
                    ) : null}
                    {orcaTerminals.map((t) => TerminalRow(t, snap, locked, confirmKey))}
                  </Stack>
                ) : null}

                {acpChats.length > 0 ? (
                  <Stack gap="xs">
                    <Text muted size="xs" weight="medium">
                      {`原生 Chat 对话 (${acpChats.length})`}
                    </Text>
                    <Text muted size="xs">
                      {acpChats.every((c) => isManagedChatTerminal(c))
                        ? '托管引擎使用独立账号，不随面板切号；请勿强杀，无需干预。'
                        : acpChats.some((c) => isManagedChatTerminal(c))
                          ? '托管 Chat 使用独立账号；宿主 Chat 与终端共号，空闲者切号时由 Orca 释放。'
                          : '宿主模式与终端共号；切号时 Orca 将自动释放空闲 Chat，干活中需等待完成或重开。'}
                    </Text>
                    {acpChats.map((t) => TerminalRow(t, snap, locked, confirmKey))}
                  </Stack>
                ) : null}

                {externalTerminals.length > 0 ? (
                  <Stack gap="xs">
                    <Text muted size="xs" weight="medium">
                      {`外部独立终端 (${externalTerminals.length})`}
                    </Text>
                    {externalTerminals.map((t) => TerminalRow(t, snap, locked, confirmKey))}
                  </Stack>
                ) : null}
              </>
            )}
          </Stack>
        </Tab>
      </Tabs>
    </Stack>
  )
}
