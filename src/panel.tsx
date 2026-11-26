// 反重力多账号一键切换 - Orca 原生 Components 侧边栏面板（原生对话框无损换号版 v0.2.9）：
// - 严格手动选号触发（不会在额度耗尽时自行替用户挑号），任意账号卡片直接点「切换」就地展开影响预览确认框；
// - 原生 Chat 对话框与 CLI 终端同为一等公民：未忙对话框无损跟进新号、忙中对话框等说完跟进同步、独立单账号模式主动指引；
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
  compareSemver,
  computeSwitchImpact,
  emailsEqual,
  formatResetCountdown,
  formatSnapshotAge,
  getSessionQueueKey,
  isAccountError,
  isAccountUnfetched,
  isManagedChatTerminal,
  isQuotaWindowExpired,
  pickBestAccount,
  resolveAccountQuotaPools,
  shortEmail,
  type ResolvedQuotaPool
} from './command-builder'
import type {
  AccountInfo,
  AgyTerminalInfo,
  FocusTerminalInput,
  SwitcherSnapshot,
  WorkingPolicy
} from './protocol'

interface PendingSwitchConfirm {
  mode: 'best' | 'selected' | 'sync'
  targetAccountId: string
  targetEmail: string
}

interface NoticeBanner {
  title: string
  body: string
}

const snapshotAtom = atom<SwitcherSnapshot | null>(null)
const actionErrorAtom = atom<string | null>(null)
const noticeInfoAtom = atom<NoticeBanner | null>(null)
const refreshingAtom = atom<boolean>(false)
const pendingActionAtom = atom<boolean>(false)
const updatingPluginAtom = atom<boolean>(false)
const confirmKeyAtom = atom<string | null>(null)
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

/** 修改运行中终端处理策略时保留当前已展开的切换确认框，实时刷新确认框内的影响预览。 */
async function updateWorkingPolicy(policy: WorkingPolicy): Promise<void> {
  if (read(pendingActionAtom)) return
  set(actionErrorAtom, null)
  try {
    const snap = await plugin.request(
      'switcher.setPolicy',
      { workingPolicy: policy },
      { timeoutMs: 15000, signal: panelSignal }
    )
    setSnapshotIfNewer(snap)
  } catch (err: unknown) {
    if (!panelSignal?.aborted) {
      set(actionErrorAtom, err instanceof Error ? err.message : String(err))
    }
  }
}

async function focusTerminal(target: FocusTerminalInput): Promise<void> {
  set(actionErrorAtom, null)
  try {
    const res = await plugin.request('switcher.focusTerminal', target, {
      timeoutMs: 10000,
      signal: panelSignal
    })
    if (!res.focused) {
      set(actionErrorAtom, '未能切换到该对话所在窗口（可能已被关闭或窗口处于后台）')
    }
  } catch (err: unknown) {
    if (!panelSignal?.aborted) {
      set(actionErrorAtom, err instanceof Error ? err.message : String(err))
    }
  }
}

async function applyPluginUpdate(expectedVersion: string): Promise<void> {
  if (read(updatingPluginAtom) || read(pendingActionAtom)) return
  clearConfirm()
  set(updatingPluginAtom, true)
  set(actionErrorAtom, null)
  try {
    const res = await plugin.request('switcher.applyUpdate', undefined, {
      timeoutMs: 65000,
      signal: panelSignal
    })
    if (res.status === 'updated') {
      const snap = await plugin.request(
        'switcher.getState',
        { refresh: false },
        { timeoutMs: 15000, signal: panelSignal }
      )
      setSnapshotIfNewer(snap)
      set(noticeInfoAtom, {
        title: '更新完成',
        body: res.message || `已更新到最新版本 v${res.newVersion ?? expectedVersion}`
      })
      return
    }
    if (res.status === 'approval_required') {
      const snap = await plugin.request(
        'switcher.getState',
        { refresh: false },
        { timeoutMs: 15000, signal: panelSignal }
      )
      setSnapshotIfNewer(snap)
      return
    }
    set(actionErrorAtom, res.message)
  } catch (err: unknown) {
    if (panelSignal?.aborted) return
    // 热升级成功时 Orca 会重启当前旧 Worker 导致本次 IPC 断开；等待新 Worker 就绪后复核版本
    await new Promise((r) => setTimeout(r, 1500))
    if (panelSignal?.aborted) return
    try {
      const nextSnap = await plugin.request(
        'switcher.getState',
        { refresh: false },
        { timeoutMs: 15000, signal: panelSignal }
      )
      setSnapshotIfNewer(nextSnap)
      if (
        !nextSnap.updateInfo ||
        (nextSnap.pluginVersion && compareSemver(nextSnap.pluginVersion, expectedVersion) >= 0)
      ) {
        set(noticeInfoAtom, {
          title: '更新完成',
          body: `已更新到最新版本 v${nextSnap.pluginVersion ?? expectedVersion}`
        })
        return
      }
    } catch {
      // ignore fallback probe error
    }
    set(actionErrorAtom, err instanceof Error ? err.message : String(err))
  } finally {
    set(updatingPluginAtom, false)
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
      if (t.agentState === 'working') return { text: '独立·回复中', tone: 'accent' }
      if (t.agentState === 'blocked') return { text: '独立·待确认', tone: 'warning' }
      return { text: '独立账号', tone: 'neutral' }
    }
    if (t.queuedTargetEmail) return { text: '等待切换', tone: 'accent' }
    if (t.agentState === 'working') return { text: '对话框·回复中', tone: 'accent' }
    if (t.agentState === 'blocked') return { text: '对话框·待确认', tone: 'warning' }
    if (t.agentState === 'done' || t.agentState === 'idle' || t.agentState === 'waiting') {
      return { text: '对话框·空闲', tone: 'success' }
    }
    return { text: '对话框', tone: 'warning' }
  }
  if (t.isExternal) return { text: '外部终端', tone: 'warning' }
  if (t.queuedTargetEmail) return { text: '等待切换', tone: 'accent' }
  if (t.agentState === 'working') return { text: '回复中', tone: 'accent' }
  if (t.agentState === 'blocked') return { text: '待确认', tone: 'warning' }
  if (t.agentState === 'unknown') return { text: '状态未知', tone: 'warning' }
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

/** 格式化副池（如 Claude/GPT）活跃窗口的紧凑重置提示；全 0 或已重置返回 null 保持卡片极简。 */
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

/** 将副模型池格式化为展示视图，识别各自窗口已重置状态，绝不让旧周期峰值误报红警或把 0% 未用池标为已重置。 */
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
    const sTxt = sExpired ? '已重置' : s === null ? '—' : `${clampPercent(s)}%`
    const wTxt = wExpired ? '已重置' : w === null ? '—' : `${clampPercent(w)}%`
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
        set(updatingPluginAtom, false)
        set(refreshingAtom, false)
        set(pendingActionAtom, false)
        panelSignal = undefined
      }
    }
  )
  void refreshState(false)
}

function policyDisplayName(policy: WorkingPolicy): string {
  if (policy === 'force') return '立即中断并同步到新号'
  if (policy === 'skip') return '跳过忙中对话'
  return '等当前回复结束后跟进同步到已选新号'
}

function AccountRow(
  account: AccountInfo,
  snap: SwitcherSnapshot,
  locked: boolean,
  pendingSwitch: PendingSwitchConfirm | null
) {
  const { primary, secondary } = resolveAccountQuotaPools(account)
  const sessionPct = primary.sessionUsedPercent
  const weeklyPct = primary.weeklyUsedPercent
  const sessionExpired = isQuotaWindowExpired(primary.sessionResetsAt, snap.updatedAt)
  const weeklyExpired = isQuotaWindowExpired(primary.weeklyResetsAt, snap.updatedAt)
  const manageableOutdated = snap.outdatedCount + snap.acpOutdatedCount
  const allOutdated = manageableOutdated + snap.externalOutdatedCount
  const isCurrentAndAllClean =
    account.isActive &&
    !snap.drift &&
    allOutdated === 0 &&
    snap.unknownAuthCount === 0 &&
    snap.queuedCount === 0
  const onlyExternalLeft =
    account.isActive && !snap.drift && manageableOutdated === 0 && snap.externalOutdatedCount > 0
  const isUnfetched = isAccountUnfetched(account)
  const isErrorAccount = isAccountError(account)
  const isConfirmingThisCard =
    pendingSwitch?.mode === 'selected' && pendingSwitch.targetAccountId === account.id

  const rawSessionReset = formatResetCountdown(primary.sessionResetsAt, snap.updatedAt, 'short', {
    isActive: account.isActive
  })
  const rawWeeklyReset = formatResetCountdown(primary.weeklyResetsAt, snap.updatedAt, 'short', {
    isActive: account.isActive
  })
  const sessionReset = rawSessionReset === '—' ? '' : rawSessionReset
  const weeklyReset = rawWeeklyReset === '—' ? '' : rawWeeklyReset
  const extraPools = formatSecondaryPools(secondary, snap.updatedAt, account.isActive)
  const primaryPrefix = primary.name && extraPools.length > 0 ? `${primary.name} ` : ''

  const statusMeta = account.isActive
    ? '当前使用'
    : account.terminalCount > 0
      ? `${account.terminalCount} 个对话`
      : ''

  const snapshotAge = !account.isActive ? formatSnapshotAge(account.usageUpdatedAt, snap.updatedAt) : null
  const footerLeft = [account.label ? account.email : null, snapshotAge ? `更新于 ${snapshotAge}` : null]
    .filter(Boolean)
    .join(' · ')

  const canSwitchToThis = !locked && !isCurrentAndAllClean && !onlyExternalLeft
  const showFooterRow = Boolean(footerLeft) || !isCurrentAndAllClean

  return (
    <Stack key={account.id} gap="xs">
      <Box
        direction="column"
        gap="sm"
        padding="md"
        border={isConfirmingThisCard ? 'accent' : true}
        radius="md"
        background={isConfirmingThisCard ? 'accent' : 'card'}
      >
        {/* 卡头：用户名 + 当前使用 / 残留终端数 / 未读取 / 异常标注 */}
        <Row justify="between" align="center" gap="xs">
          <Text weight="semibold" size="sm" truncate>
            {account.label || shortEmail(account.email)}
          </Text>
          {isErrorAccount ? (
            <Badge tone="danger">读取异常</Badge>
          ) : isUnfetched ? (
            <Badge tone="neutral">未读取</Badge>
          ) : statusMeta ? (
            <Text size="xs" tone={account.isActive ? 'success' : 'warning'} weight="medium">
              {statusMeta}
            </Text>
          ) : null}
        </Row>

        {/* 主额度区：未读取新号给出友好提示，其余分别处理活跃与已重置窗口 */}
        {isUnfetched && sessionPct === null && weeklyPct === null ? (
          <Text muted size="xs">
            尚未读取额度，切换到此账号后自动更新
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
                    ? `${primaryPrefix}5h 已重置`
                    : `${primaryPrefix}5h ${sessionPct === null ? '—' : `${clampPercent(sessionPct)}%`}`}
                </Text>
                <Text muted size="xs">
                  {sessionExpired ? (account.isActive ? '待刷新' : '切换后更新') : sessionReset}
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
                    ? `${primaryPrefix}周 已重置`
                    : `${primaryPrefix}周 ${weeklyPct === null ? '—' : `${clampPercent(weeklyPct)}%`}`}
                </Text>
                <Text muted size="xs">
                  {weeklyExpired ? (account.isActive ? '待刷新' : '切换后更新') : weeklyReset}
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

        {/* 副模型池（如 Claude/GPT）：清晰展示，有活跃用量时附紧凑重置倒计时 */}
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

        {/* 底部行：直接点击「切换」即在当前卡片正下方就地展开确认条，无需翻回顶部 */}
        {showFooterRow ? (
          <Row justify="between" align="center" gap="xs">
            <Text muted size="xs" truncate>
              {footerLeft}
            </Text>
            {isCurrentAndAllClean ? null : onlyExternalLeft ? (
              <Button size="xs" variant="ghost" disabled>
                请见对话页
              </Button>
            ) : (
              <Button
                size="xs"
                variant={isConfirmingThisCard ? 'ghost' : 'outline'}
                tone={isConfirmingThisCard ? 'neutral' : 'accent'}
                icon={isConfirmingThisCard ? 'close' : 'zap'}
                disabled={!canSwitchToThis}
                tooltip={
                  isConfirmingThisCard
                    ? '收起下方切换确认框'
                    : isErrorAccount
                      ? '上次读取额度异常，点击展开确认框手动切换并刷新'
                      : account.isActive
                        ? '将旧账号对话框与终端更新到此当前账号'
                        : `切换到 ${account.email}（先展开确认框预览影响）`
                }
                onPress={() => {
                  set(actionErrorAtom, null)
                  set(noticeInfoAtom, null)
                  if (isConfirmingThisCard) {
                    set(pendingSwitchAtom, null)
                  } else {
                    set(pendingSwitchAtom, {
                      mode: 'selected',
                      targetAccountId: account.id,
                      targetEmail: account.email
                    })
                  }
                }}
              >
                {isConfirmingThisCard ? '收起' : account.isActive ? '更新对话' : '切换'}
              </Button>
            )}
          </Row>
        ) : null}
      </Box>

      {/* 就地内联确认框：紧贴被点击的账号卡片正下方展开，视线与鼠标零跨屏跳转 */}
      {isConfirmingThisCard && pendingSwitch ? SwitchConfirmBox(pendingSwitch, snap, locked) : null}
    </Stack>
  )
}

function TerminalRow(
  term: AgyTerminalInfo,
  _snap: SwitcherSnapshot,
  locked: boolean,
  confirmKey: string | null,
  pendingSwitch: PendingSwitchConfirm | null
) {
  const st = agentStateLabel(term)
  const sessionKey = getSessionQueueKey(term)
  const isBusyOrUnknown =
    term.agentState === 'working' ||
    term.agentState === 'blocked' ||
    term.agentState === 'unknown'
  const restartConfirmId = `restart:${sessionKey ?? term.pid}`
  const killConfirmId = `kill:${term.pid}`
  const isConfirmingRestart = confirmKey === restartConfirmId
  const isConfirmingKill = confirmKey === killConfirmId

  const explicitTarget =
    pendingSwitch && (!term.authEmail || !emailsEqual(term.authEmail, pendingSwitch.targetEmail))
      ? pendingSwitch
      : null
  const willSwitchAccount = term.isOutdated || Boolean(explicitTarget)
  const singleBtnLabel = isConfirmingRestart
    ? willSwitchAccount
      ? '确认切换'
      : '确认重连'
    : explicitTarget
      ? `切到 ${shortEmail(explicitTarget.targetEmail)}`
      : term.isOutdated
        ? isBusyOrUnknown
          ? '立即切到当前号'
          : '切到当前号'
        : '重连对话'

  const canSwitchSingle =
    Boolean(sessionKey) &&
    term.canRestartInPlace &&
    !term.isExternal &&
    !isManagedChatTerminal(term)
  const canLocate = Boolean(term.terminalId || term.worktreeId)
  const badgeTone = term.queuedTargetEmail ? 'accent' : term.isOutdated ? 'danger' : st.tone
  const badgeText = term.queuedTargetEmail ? '等待切换' : term.isOutdated ? '旧账号' : st.text

  return (
    <Box
      key={`${term.pid}-${sessionKey ?? term.processKind}`}
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
          <Badge tone={badgeTone}>{badgeText}</Badge>
        </Row>
        <Text muted size="xs">
          {isManagedChatTerminal(term)
            ? '独立账号'
            : term.authEmail
              ? shortEmail(term.authEmail)
              : '识别中'}
        </Text>
      </Row>

      <Text muted size="xs" truncate>
        {term.title}
      </Text>

      {term.restartBlockedReason && !term.isExternal && !isManagedChatTerminal(term) ? (
        <Text tone="warning" size="xs">
          {term.restartBlockedReason}
        </Text>
      ) : null}

      <Row justify="between" align="center" gap="xs">
        <Text muted size="xs">
          {term.processKind === 'acp'
            ? isManagedChatTerminal(term)
              ? 'Orca 独立单账号 · 不随本面板切换'
              : term.queuedTargetEmail
                ? `${st.text} · 说完跟进到 ${shortEmail(term.queuedTargetEmail)}`
                : '对话框 · 换号保留聊天记录'
            : term.conversationId
              ? `${st.text} · ${term.conversationId.slice(0, 8)}`
              : `${st.text} · 新会话`}
        </Text>
        <Row gap="xs">
          {canLocate ? (
            <Button
              size="xs"
              variant="ghost"
              icon={term.processKind === 'acp' ? 'folder' : 'terminal'}
              tooltip={
                term.processKind === 'acp'
                  ? '切换到该对话框所在的工作区'
                  : '定位聚焦到该终端面板'
              }
              onPress={() =>
                void focusTerminal({
                  ...(term.terminalId ? { terminalId: term.terminalId } : {}),
                  ...(term.worktreeId ? { worktreeId: term.worktreeId } : {})
                })
              }
            >
              定位
            </Button>
          ) : null}

          {canSwitchSingle ? (
            <Button
              size="xs"
              variant={willSwitchAccount || isConfirmingRestart ? 'solid' : 'outline'}
              tone={isConfirmingRestart ? 'danger' : willSwitchAccount ? 'warning' : 'neutral'}
              icon="refresh"
              disabled={locked}
              tooltip={
                term.processKind === 'acp'
                  ? willSwitchAccount
                    ? isBusyOrUnknown
                      ? '该对话框正在回复或卡住，再次点击确认将立即切换账号（历史记录完整保留，重发消息即走新号）'
                      : '无损释放该对话框的旧账号连接，在对话框发下一句话即走已选新账号'
                    : '刷新该对话框后台连接（聊天记录完整保留）'
                  : willSwitchAccount
                    ? isBusyOrUnknown
                      ? '该终端正在回复中，再次点击确认将立即切换账号并继续原对话'
                      : '在当前终端无缝切换账号并继续原对话'
                    : '使用当前账号重新连接该终端原对话'
              }
              onPress={() => {
                if (isBusyOrUnknown && !requireConfirm(restartConfirmId)) return
                const targetId = explicitTarget?.targetAccountId
                void runAction(() =>
                  plugin.request(
                    'switcher.restartOne',
                    {
                      ...(term.terminalId ? { terminalId: term.terminalId } : {}),
                      ...(sessionKey ? { sessionKey } : {}),
                      ...(targetId ? { targetAccountId: targetId } : {}),
                      force: true
                    },
                    { timeoutMs: 60000, signal: panelSignal }
                  )
                )
              }}
            >
              {singleBtnLabel}
            </Button>
          ) : null}

          {term.processKind === 'cli' && term.isExternal && (term.isOutdated || !term.authEmail) ? (
            <Button
              size="xs"
              variant={isConfirmingKill ? 'solid' : 'outline'}
              tone="danger"
              icon="stop"
              disabled={locked}
              tooltip="结束该外部旧终端进程（需点击两次确认）"
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
      ? `确认切换到推荐账号 ${shortEmail(target.email)}？`
      : confirm.mode === 'sync' || target.isActive
        ? `确认更新旧账号对话到 ${shortEmail(target.email)}？`
        : `确认切换到 ${shortEmail(target.email)}？`

  let impactText = ''
  if (isForceRisk) {
    impactText = `⚠ 将立即中断并切换 ${impact.forcedBusyCount} 个正在回复的对话/终端（共切换 ${impact.immediateCount} 个）。`
  } else if (impact.totalManagedCliCount === 0) {
    impactText = `切换默认账号（当前没有需要重启的旧账号对话，新发消息将直接使用此账号）。`
  } else {
    const immPart =
      impact.immediateCount > 0
        ? `立即同步 ${impact.immediateCount} 个未在回复的对话`
        : '暂不打断正在回复的对话'
    const tailParts: string[] = []
    if (impact.queueCount > 0) {
      tailParts.push(`${impact.queueCount} 个忙中对话将「${policyDisplayName(snap.workingPolicy)}」`)
    }
    if (impact.skipCount > 0) {
      tailParts.push(`${impact.skipCount} 个忙中对话跳过（暂不跟进）`)
    }
    impactText = `切换默认账号后，${[immPart, ...tailParts].join('，')}。`
  }
  if (impact.acpCount > 0) {
    impactText += ` 另有 ${impact.acpCount} 个受限对话框需手动重开。`
  }
  if (manualCliCount > 0) {
    impactText += ` 另有 ${manualCliCount} 个外部或受限终端需手动处理。`
  }
  if (impact.managedChatCount > 0) {
    impactText += `（${impact.managedChatCount} 个独立账号对话不受本次切换影响）`
  }

  let targetQuotaSummary: string
  if (isUnfetched && sPct === null && wPct === null) {
    targetQuotaSummary = `目标：${target.email}（尚未读取额度，切换后自动更新）`
  } else {
    const sPart = sessionExpired ? '已重置' : sTxt
    const wPart = weeklyExpired ? '已重置' : wTxt
    const ageSuffix = snapshotAge ? ` · ${snapshotAge}更新` : ''
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
            注：该账号上次记录的重置时间已过，切换后将刷新最新实时额度。
          </Text>
        ) : null}
        <Text size="xs" tone={isForceRisk ? 'danger' : undefined}>
          {impactText}
        </Text>
        {isErrorAccount ? (
          <Text size="xs" tone="danger">
            {`⚠ 该账号上次读取额度异常（${target.status}），若确认登录正常可手动切换并重刷。`}
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
                return plugin.request(
                  'switcher.switchAll',
                  {
                    targetAccountId: target.id,
                    workingPolicy: snap.workingPolicy,
                    onlyOutdated: true
                  },
                  { timeoutMs: 90000, signal: panelSignal }
                )
              })
            }}
          >
            {isErrorAccount ? '仍要切换' : confirm.mode === 'sync' || target.isActive ? '确认更新' : '确认切换'}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function ChatIsolationCallout(snap: SwitcherSnapshot) {
  const reason =
    snap.chatIsolationReason ??
    (snap.chatBackendMode === 'orca-managed' ? 'managed-only' : null)
  if (!reason) return null

  let body: string
  if (reason === 'api-key') {
    body =
      '当前在 Orca 设置中配置了 Gemini API Key，对话框固定使用该 Key，下方多账号切换仅对终端生效。如需在对话框换号，请前往 Orca 设置 → AI Provider Accounts → Antigravity 改回账号登录。'
  } else if (reason === 'agy-signed-out') {
    body =
      '检测到本机 Antigravity (agy) 尚未完成登录，对话框暂无法共用下方多账号。请前往 Orca 设置（Settings → AI Provider Accounts → Antigravity）检查登录状态或在终端运行一次 agy 完成登录，之后对话框即可直接换号。'
  } else {
    body =
      '检测到当前 Orca「对话框」正在使用独立单账号登录，点下方切换账号不会对对话框生效。请打开 Orca 设置（Settings → AI Provider Accounts → Antigravity），确认已安装 agy 并将 Antigravity Chat 改为使用本机 agy 账号，即可让对话框无缝一键换号。'
  }

  return (
    <Callout tone="warning" title="当前「对话框」未关联多账号池" icon="warning">
      <Text size="xs">{body}</Text>
    </Callout>
  )
}

export default function Panel() {
  const snap = read(snapshotAtom)
  const actionError = read(actionErrorAtom)
  const noticeInfo = read(noticeInfoAtom)
  const isRefreshing = read(refreshingAtom)
  const isPendingAction = read(pendingActionAtom)
  const isUpdatingPlugin = read(updatingPluginAtom)
  const confirmKey = read(confirmKeyAtom)
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
          <Skeleton shape="block" lines={4} label="正在加载账号与对话..." />
        )}
      </Stack>
    )
  }

  const locked = snap.busy || isPendingAction || isUpdatingPlugin
  const manageableOutdated = snap.outdatedCount + snap.acpOutdatedCount
  const totalOutdated = manageableOutdated + snap.externalOutdatedCount
  const orcaTerminals = snap.terminals.filter((t) => t.processKind === 'cli' && !t.isExternal)
  const acpChats = snap.terminals.filter((t) => t.processKind === 'acp')
  const externalTerminals = snap.terminals.filter((t) => t.processKind === 'cli' && t.isExternal)
  const isConfirmingDrain = confirmKey === 'forceDrainQueue'

  const openConfirmForPrimary = () => {
    set(actionErrorAtom, null)
    set(noticeInfoAtom, null)
    const best = pickBestAccount(snap.accounts, snap.updatedAt)
    if (!best) {
      set(actionErrorAtom, '没有可用的正常 Antigravity 账号')
      return
    }
    if (best.isActive && manageableOutdated === 0 && !snap.drift) {
      const extHint =
        snap.externalOutdatedCount > 0
          ? `（另有 ${snap.externalOutdatedCount} 个外部独立终端仍用旧账号，请见对话页）`
          : ''
      set(noticeInfoAtom, {
        title: '无需切换',
        body: `当前账号 ${shortEmail(best.email)} 已是余量最充足的最佳账号，无需切换。${extHint}`
      })
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

  // 当前账号置顶，其余按真实可用余量排序（已重置窗口不被旧缓存垫底，且实测 0% 优先于过期推算）
  const orderedAccounts = [...snap.accounts].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
    return compareAccountsByHeadroom(a, b, snap.updatedAt)
  })

  const activeUsageAt =
    snap.accounts.find((a) => a.isActive)?.usageUpdatedAt ?? snap.accountsUpdatedAt

  return (
    <Stack gap="md">
      {/* 极简顶栏：正常状态不贴多余绿标，仅在切换中或有旧账号待处理时提示 */}
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Heading level={2}>反重力换号</Heading>
          {locked ? (
            <Badge tone="accent">切换中</Badge>
          ) : totalOutdated > 0 ? (
            <Badge tone="warning">{`${totalOutdated} 个待切换`}</Badge>
          ) : snap.unknownAuthCount > 0 ? (
            <Badge tone="warning">{`${snap.unknownAuthCount} 个识别中`}</Badge>
          ) : null}
        </Row>
        <IconButton
          icon="refresh"
          label="刷新账号额度与终端"
          tooltip="立即刷新账号额度与当前运行的终端状态"
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

      {snap.updateInfo ? (
        <Callout
          tone="accent"
          title={`发现新版本 v${snap.updateInfo.latestVersion}`}
          icon="info"
        >
          <Stack gap="xs">
            {snap.updateInfo.approvalCommand ? (
              <>
                <Text size="xs">此版本新增了权限，请在终端运行以下命令确认升级：</Text>
                <Code block>{snap.updateInfo.approvalCommand}</Code>
              </>
            ) : snap.updateInfo.canOneClickUpdate ? (
              <Row justify="between" align="center" gap="xs">
                <Text size="xs">
                  {`当前版本 v${snap.updateInfo.currentVersion}，点击即可自动升级。`}
                </Text>
                <Button
                  size="xs"
                  variant="solid"
                  tone="accent"
                  icon="refresh"
                  disabled={locked}
                  onPress={() => void applyPluginUpdate(snap.updateInfo!.latestVersion)}
                >
                  {isUpdatingPlugin ? '正在更新...' : '立即更新'}
                </Button>
              </Row>
            ) : (
              <Text size="xs">
                {`当前为本地目录安装（v${snap.updateInfo.currentVersion}），拉取最新代码后点右上角刷新即可一键更新。`}
              </Text>
            )}
          </Stack>
        </Callout>
      ) : null}

      {ChatIsolationCallout(snap)}

      {snap.scanDegradedReason ? (
        <Callout tone="warning" title="状态检测受限" icon="warning">
          <Text size="xs">{snap.scanDegradedReason}，已暂停后台跟进同步以保护当前对话。</Text>
        </Callout>
      ) : null}

      {snap.drift ? (
        <Callout
          tone="danger"
          title={`账号被旧对话改回 ${shortEmail(snap.drift.actualEmail)}`}
          icon="warning"
        >
          <Stack gap="xs">
            <Text size="xs">
              原账号为 {shortEmail(snap.drift.expectedEmail)}，后台旧对话刷新登录态时把默认账号改了回去。
            </Text>
            <Button
              size="xs"
              tone="danger"
              icon="zap"
              disabled={locked}
              onPress={openConfirmForSync}
            >
              {`切回 ${shortEmail(snap.drift.expectedEmail)}`}
            </Button>
          </Stack>
        </Callout>
      ) : null}

      {!snap.drift && totalOutdated > 0 ? (
        <Callout tone="warning" title={`有 ${totalOutdated} 个对话仍在使用旧账号`} icon="warning">
          <Stack gap="xs">
            <Text size="xs">
              {manageableOutdated > 0
                ? '继续在旧账号对话里发消息仍会消耗旧账号额度，且后台可能把全局账号改回去。'
                : '外部独立终端仍在使用旧账号，后台刷新时可能会改回旧账号。'}
            </Text>
            {manageableOutdated > 0 ? (
              <Button
                size="xs"
                tone="warning"
                icon="zap"
                disabled={locked}
                onPress={openConfirmForSync}
              >
                {`更新 ${manageableOutdated} 个对话到 ${shortEmail(snap.currentEmail)}`}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                tone="warning"
                icon="terminal"
                onPress={() => set(activeTabAtom, 'terminals')}
              >
                查看详情
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

      {/* 主控区：需用户手动点选账号；顶部提供一键挑余量最多号，下方任意账号卡片直接点「切换」就地确认 */}
      <Stack gap="xs">
        <Row gap="xs" wrap align="center">
          <Button
            size="sm"
            variant="outline"
            tone="accent"
            icon="zap"
            disabled={locked || snap.accounts.length === 0}
            tooltip="手动挑出当前余量最多的账号，展开确认框点击确认后才会切换（平时不会自动替你换号）"
            onPress={openConfirmForPrimary}
          >
            一键选余量最多账号
          </Button>
          {snap.queuedCount > 0 ? (
            <>
              <Button
                size="sm"
                tone={isConfirmingDrain ? 'danger' : 'warning'}
                icon="play"
                disabled={locked}
                tooltip="若等待中的对话或终端因额度耗尽卡住，再次点击确认将立即中断并切换到新账号"
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
                  ? `再点确认切换 (${snap.queuedCount})`
                  : `立即切换等待项 (${snap.queuedCount})`}
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
                取消等待
              </Button>
            </>
          ) : null}
        </Row>

        <Select
          label="运行中终端处理方式"
          labelHidden
          value={snap.workingPolicy}
          disabled={locked}
          options={[
            { value: 'queue', label: '手动换号遇忙：说完跟进新号（推荐）' },
            { value: 'skip', label: '手动换号遇忙：跳过忙中对话' },
            { value: 'force', label: '手动换号遇忙：立即中断并换号' }
          ]}
          onChange={(val) => {
            const policy = val as WorkingPolicy
            void updateWorkingPolicy(policy)
          }}
        />
        <Text muted size="xs">
          需手动点切换；额度用完时不会自动替你选号
        </Text>
      </Stack>

      {/* 顶部全局动作（一键选余量最多账号 / 顶部警告条同步）确认预览框 */}
      {pendingSwitch && pendingSwitch.mode !== 'selected'
        ? SwitchConfirmBox(pendingSwitch, snap, locked)
        : null}

      {!pendingSwitch && noticeInfo ? (
        <Callout tone="accent" title={noticeInfo.title} icon="info">
          <Row justify="between" align="center" gap="xs">
            <Text size="xs">{noticeInfo.body}</Text>
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

      {/* 分栏视图 */}
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
              orderedAccounts.map((a) => AccountRow(a, snap, locked, pendingSwitch))
            )}
            {activeUsageAt ? (
              <Row justify="end">
                <Text muted size="xs">
                  额度更新于 <RelativeTime at={activeUsageAt} />
                </Text>
              </Row>
            ) : null}
          </Stack>
        </Tab>

        <Tab value="terminals" label={`对话 (${snap.terminals.length})`} icon="terminal">
          <Stack gap="sm">
            {snap.terminals.length === 0 ? (
              <EmptyState
                icon="terminal"
                title="当前没有活跃的对话框或终端"
                description={
                  snap.chatBackendMode === 'orca-managed'
                    ? '注：当前对话框处于独立单账号模式（详见面板顶部提示）；新开的终端将使用当前账号。'
                    : '已休眠的对话框及新开的对话框/终端，发消息时都会走当前已选账号（额度用完需手动来此面板切换）。'
                }
              />
            ) : (
              <>
                {acpChats.length > 0 ? (
                  <Stack gap="xs">
                    <Text muted size="xs" weight="medium">
                      {`对话框 (${acpChats.length})`}
                    </Text>
                    <Text muted size="xs">
                      {acpChats.every((c) => isManagedChatTerminal(c))
                        ? '当前使用 Orca 独立单账号，不随本面板切换（调整方式见面板顶部提示）。'
                        : '手动点切换账号后保留全部聊天记录：未在回复的对话框立即跟进新号，正在回复的对话框等说完跟进（或点右侧立即切）。'}
                    </Text>
                    {acpChats.map((t) => TerminalRow(t, snap, locked, confirmKey, pendingSwitch))}
                  </Stack>
                ) : null}

                {orcaTerminals.length > 0 ? (
                  <Stack gap="xs">
                    {acpChats.length > 0 || externalTerminals.length > 0 ? (
                      <Text muted size="xs" weight="medium">
                        {`终端 (${orcaTerminals.length})`}
                      </Text>
                    ) : null}
                    {orcaTerminals.map((t) => TerminalRow(t, snap, locked, confirmKey, pendingSwitch))}
                  </Stack>
                ) : null}

                {externalTerminals.length > 0 ? (
                  <Stack gap="xs">
                    <Text muted size="xs" weight="medium">
                      {`外部独立终端 (${externalTerminals.length})`}
                    </Text>
                    {externalTerminals.map((t) => TerminalRow(t, snap, locked, confirmKey, pendingSwitch))}
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
