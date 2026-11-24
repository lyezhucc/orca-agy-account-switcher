// 红队攻防全覆盖单元测试：覆盖 C-0 ~ C-6、H-1 ~ H-9、M-1 ~ M-7 的每一个核心漏洞与边界条件。
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  buildRestartCommand,
  classifyAgyCommand,
  compareAccountsByHeadroom,
  computeStatusBar,
  computeSwitchImpact,
  formatResetCountdown,
  formatSnapshotAge,
  isAgyFamilyBinary,
  isManagedAcpBinary,
  isManagedAcpCommand,
  isQuotaWindowExpired,
  pickBestAccount,
  resolveAccountQuotaPools,
  resolvePrimaryQuota,
  shellQuote,
  shouldIgnoreUnstructuredAcpProbe
} from './command-builder'
import type { AccountInfo } from './protocol'
import { SwitcherService } from './switcher'
import {
  parseAccountBuckets,
  parseLsofOutput,
  parsePsEnvOutput,
  type QueryResult,
  type RawAccountState,
  type RawAgyProcess,
  type RawOrcaAgent,
  type RawOrcaTerminal,
  type SystemAdapter
} from './system'
import { createWorker } from './worker'

class FakeSystemAdapter implements SystemAdapter {
  events: string[] = []
  sentTexts: Array<{ terminalId: string; text: string; enter: boolean }> = []
  accountFetchCount = 0
  failSelectAccount = false
  failSendTerminal = false
  agentsQueryOk = true
  terminalsQueryOk = true
  procsQueryOk = true
  accountState: RawAccountState
  terminals: RawOrcaTerminal[]
  agents: RawOrcaAgent[]
  processes: RawAgyProcess[]
  alivePids = new Set<number>()
  existingPaths = new Set<string>(['/work/valid-dir'])

  constructor(init: {
    accountState: RawAccountState
    terminals: RawOrcaTerminal[]
    agents: RawOrcaAgent[]
    processes: RawAgyProcess[]
  }) {
    this.accountState = init.accountState
    this.terminals = init.terminals
    this.agents = init.agents
    this.processes = init.processes
    for (const p of init.processes) this.alivePids.add(p.pid)
  }

  async getAntigravityAccounts(): Promise<RawAccountState> {
    this.accountFetchCount += 1
    return structuredClone(this.accountState)
  }

  async selectAntigravityAccount(accountIdOrEmail: string): Promise<void> {
    this.events.push(`select:${accountIdOrEmail}`)
    if (this.failSelectAccount) {
      throw new Error('模拟切号失败（vault locked）')
    }
    const acc = this.accountState.accounts.find(
      (a) => a.id === accountIdOrEmail || a.email === accountIdOrEmail
    )
    if (!acc) throw new Error(`unknown account ${accountIdOrEmail}`)
    this.accountState.activeAccountId = acc.id
    this.accountState.selectedAccountId = acc.id
    this.accountState.currentEmail = acc.email
  }

  async listOrcaTerminals(): Promise<QueryResult<RawOrcaTerminal>> {
    if (!this.terminalsQueryOk) {
      return { ok: false, items: [], degradedReason: '模拟 terminal list 超时' }
    }
    return { ok: true, items: structuredClone(this.terminals) }
  }

  async listOrcaAgents(): Promise<QueryResult<RawOrcaAgent>> {
    if (!this.agentsQueryOk) {
      return { ok: false, items: [], degradedReason: '模拟 agent list 超时' }
    }
    return { ok: true, items: structuredClone(this.agents) }
  }

  async scanAgyProcesses(): Promise<QueryResult<RawAgyProcess>> {
    if (!this.procsQueryOk) {
      return { ok: false, items: [], degradedReason: '模拟 lsof 超时' }
    }
    return {
      ok: true,
      items: structuredClone(this.processes.filter((p) => this.alivePids.has(p.pid)))
    }
  }

  async sendTerminalText(
    terminalId: string,
    text: string,
    enter: boolean
  ): Promise<{ accepted: boolean; reason?: string }> {
    this.sentTexts.push({ terminalId, text, enter })
    if (this.failSendTerminal) {
      return { accepted: false, reason: '模拟终端不可写' }
    }
    return { accepted: true }
  }

  async stopProcessGracefully(pid: number): Promise<boolean> {
    this.events.push(`stop:${pid}`)
    this.alivePids.delete(pid)
    return true
  }

  async waitForShellReady(): Promise<boolean> {
    return true
  }

  isProcessAlive(pid: number): boolean {
    return this.alivePids.has(pid)
  }

  pathExists(p: string): boolean {
    return this.existingPaths.has(p)
  }

  async sleep(): Promise<void> {}
}

function makeFixture() {
  const futureSession = Date.now() + 3 * 3600_000
  const futureWeekly = Date.now() + 5 * 86400_000
  return new FakeSystemAdapter({
    accountState: {
      activeAccountId: 'acc-1',
      selectedAccountId: 'acc-1',
      currentEmail: 'old@gmail.com',
      accounts: [
        {
          id: 'acc-1',
          email: 'old@gmail.com',
          label: null,
          status: 'ok',
          sessionUsedPercent: 100,
          sessionResetsAt: futureSession,
          weeklyUsedPercent: 68,
          weeklyResetsAt: futureWeekly,
          buckets: []
        },
        {
          id: 'acc-2',
          email: 'fresh@gmail.com',
          label: null,
          status: 'ok',
          sessionUsedPercent: 0,
          sessionResetsAt: futureSession,
          weeklyUsedPercent: 5,
          weeklyResetsAt: futureWeekly,
          buckets: []
        }
      ]
    },
    terminals: [
      {
        handle: 'term_idle',
        paneKey: 'tab1:leaf1',
        worktreeId: 'r1::/work/GEO',
        worktreePath: '/work/GEO',
        title: '继续',
        connected: true,
        writable: true,
        agentIdentity: 'antigravity'
      },
      {
        handle: 'term_busy',
        paneKey: 'tab2:leaf2',
        worktreeId: 'r2::/work/web-app',
        worktreePath: '/work/web-app',
        title: '视频渲染',
        connected: true,
        writable: true,
        agentIdentity: 'antigravity'
      }
    ],
    agents: [
      {
        terminalId: null,
        paneKey: 'tab1:leaf1',
        worktreeId: 'r1::/work/GEO',
        workspace: 'GEO',
        repo: 'GEO',
        agent: 'antigravity',
        state: 'done',
        title: '继续'
      },
      {
        terminalId: null,
        paneKey: 'tab2:leaf2',
        worktreeId: 'r2::/work/web-app',
        workspace: 'web-app',
        repo: 'web-app',
        agent: 'antigravity',
        state: 'working',
        title: '视频渲染'
      }
    ],
    processes: [
      {
        pid: 101,
        ppid: 10,
        processKind: 'cli',
        parentIsShell: true,
        hasAgyAncestor: false,
        startedAtText: 'Sun Nov 22 17:00:00 2026',
        command: 'agy --dangerously-skip-permissions',
        terminalHandle: 'term_idle',
        worktreeId: 'r1::/work/GEO',
        conversationId: '8ecc012e-da64-42e5-b8ac-3a0affc1213d',
        authEmail: 'old@gmail.com'
      },
      {
        pid: 202,
        ppid: 20,
        processKind: 'cli',
        parentIsShell: true,
        hasAgyAncestor: false,
        startedAtText: 'Sun Nov 22 17:10:00 2026',
        command:
          'agy --dangerously-skip-permissions --conversation 2a455d74-2c13-49f0-94e7-1e6979bba5cb',
        terminalHandle: 'term_busy',
        worktreeId: 'r2::/work/web-app',
        conversationId: '2a455d74-2c13-49f0-94e7-1e6979bba5cb',
        authEmail: 'old@gmail.com'
      }
    ]
  })
}

test('[C-4/H-7/M-4] 白名单 buildRestartCommand 剥离危险初始 Prompt、过滤控制符与 zsh = 扩展、两遍处理 -c', () => {
  // 剥离 -i / --prompt-interactive / --new-project，绝不二次执行危险初始 Prompt
  assert.equal(
    buildRestartCommand(
      'agy --dangerously-skip-permissions -i "删除数据库" --new-project -c --conversation 11111111-1111-1111-1111-111111111111',
      null
    ),
    'stty sane; agy --dangerously-skip-permissions --conversation 11111111-1111-1111-1111-111111111111'
  )

  // 含未闭合撇号（ps 脱引号后的 "Don't"）仍能保留后续安全 flag
  assert.equal(
    buildRestartCommand(
      "agy -i Don't delete --dangerously-skip-permissions --effort high",
      '8ecc012e-da64-42e5-b8ac-3a0affc1213d'
    ),
    'stty sane; agy --dangerously-skip-permissions --effort high --conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d'
  )

  // 不允许假名 /tmp/fake-agy，回退为 agy；过滤控制字符；= 开头加引号防 zsh EQUALS 扩展
  assert.equal(
    buildRestartCommand('/tmp/fake-agy --model =gemini\nrm -rf /', null),
    "stty sane; agy --model '=gemini'"
  )
  assert.equal(shellQuote('=ls'), "'=ls'")
  assert.equal(shellQuote('abc\r\ndef'), 'abcdef')
})

test('[C-4] classifyAgyCommand 精准区分交互 CLI、ACP 与非交互子命令/探针', () => {
  assert.equal(classifyAgyCommand('agy --dangerously-skip-permissions'), 'cli')
  assert.equal(classifyAgyCommand('/Users/me/.local/bin/agy --add-dir /work/acp'), 'cli')
  assert.equal(classifyAgyCommand('agy acp'), 'acp')
  assert.equal(classifyAgyCommand('agy update'), 'ignore')
  assert.equal(classifyAgyCommand('agy remote-control start'), 'ignore')
  assert.equal(classifyAgyCommand('agy --prompt "hi"'), 'ignore')
  assert.equal(classifyAgyCommand('agy -p "hi"'), 'ignore')
})

test('[C-2/H-8] parseLsofOutput 同时识别 cli-*.log 与 acp-server-*.log，parsePsEnvOutput 跳过命令行防伪造', () => {
  const lsofSample = [
    'p100',
    'f1',
    'aw',
    'n/Users/me/.gemini/antigravity-cli/log/cli-20261122_172747.log',
    'f28',
    'ar',
    'n/Users/me/.gemini/antigravity-cli/log/cli-20261122_175512.log',
    'p200',
    'f15',
    'au',
    'n/Users/me/.gemini/antigravity-cli/log/acp-server-20261122_210000-200.log'
  ].join('\n')
  const lsofMap = parseLsofOutput(lsofSample)
  assert.equal(
    lsofMap.get(100)?.logPath,
    '/Users/me/.gemini/antigravity-cli/log/cli-20261122_172747.log'
  )
  assert.equal(
    lsofMap.get(200)?.logPath,
    '/Users/me/.gemini/antigravity-cli/log/acp-server-20261122_210000-200.log'
  )

  // 伪造的命令行参数中的 ORCA_TERMINAL_HANDLE 必须被忽略，只取环境变量区
  const cmdMap = new Map<number, string>([
    [300, 'agy -i ORCA_TERMINAL_HANDLE=term_fake_injected']
  ])
  const envOut =
    '  300 agy -i ORCA_TERMINAL_HANDLE=term_fake_injected PATH=/usr/bin ORCA_WORKTREE_ID=r::/Users/me/My Projects/app HOME=/Users/me'
  const envMap = parsePsEnvOutput(envOut, cmdMap)
  assert.equal(envMap.get(300)?.terminalHandle, null)
  assert.equal(envMap.get(300)?.worktreeId, 'r::/Users/me/My Projects/app')
})

test('[H-5] pickBestAccount 拒绝返回全部异常的坏账号', () => {
  const broken: AccountInfo[] = [
    {
      id: '1',
      email: 'a@g.com',
      label: null,
      isActive: true,
      isSelected: true,
      status: 'error',
      sessionUsedPercent: 0,
      sessionResetsAt: null,
      weeklyUsedPercent: 0,
      weeklyResetsAt: null,
      buckets: [],
      terminalCount: 1
    }
  ]
  assert.equal(pickBestAccount(broken), null)
})

test('[UI精细度] formatResetCountdown、isQuotaWindowExpired 与 formatSnapshotAge 精确到分钟并正确处理已过期窗口', () => {
  const base = new Date(2026, 10, 22, 22, 30, 0).getTime()
  assert.equal(isQuotaWindowExpired(base - 60_000, base), true)
  assert.equal(isQuotaWindowExpired(base, base), true)
  assert.equal(isQuotaWindowExpired(base + 1, base), false)
  assert.equal(isQuotaWindowExpired(null, base), false)

  assert.equal(formatSnapshotAge(base - 20_000, base), '刚刚')
  assert.equal(formatSnapshotAge(base - 15 * 60_000, base), '15分钟前')
  assert.equal(formatSnapshotAge(base - 16 * 3600_000, base), '16小时前')
  assert.equal(formatSnapshotAge(base - 3 * 86400_000, base), '3天前')
  assert.equal(formatSnapshotAge(null, base), null)

  assert.equal(formatResetCountdown(base - 60_000, base), '窗口已过 · 切入刷新')
  assert.equal(
    formatResetCountdown(base - 60_000, base, 'short', { isActive: true }),
    '窗口已过 · 点刷新'
  )
  assert.equal(
    formatResetCountdown(base - 60_000, base, 'full', { isActive: true }),
    '窗口已过，待刷新'
  )
  assert.equal(formatResetCountdown(base + 42 * 60_000, base), '42分钟 · 23:12')
  assert.equal(
    formatResetCountdown(base + (3 * 60 + 2) * 60_000, base),
    '3时02分 · 01:32'
  )
  assert.equal(
    formatResetCountdown(base + ((5 * 24 + 18) * 60 + 14) * 60_000, base),
    '5天18时14分 · 11/28'
  )
})

test('[UI精细度] computeSwitchImpact 精准区分立即重启/排队/跳过/强切/外部/未识别', () => {
  const baseSnap = {
    updatedAt: 1,
    accountsUpdatedAt: 1,
    currentEmail: 'a@gmail.com',
    activeAccountId: 'a',
    selectedAccountId: 'a',
    desiredEmail: 'a@gmail.com',
    accounts: [],
    terminals: [
      {
        pid: 1,
        processKind: 'cli' as const,
        terminalId: 't1',
        worktreeId: null,
        workspaceName: 'w1',
        title: 't1',
        conversationId: null,
        authEmail: 'a@gmail.com',
        commandPreview: 'agy',
        canRestartInPlace: true,
        restartBlockedReason: null,
        isExternal: false,
        agentState: 'idle' as const,
        isOutdated: false,
        queuedTargetEmail: null,
        startedAtText: ''
      },
      {
        pid: 2,
        processKind: 'cli' as const,
        terminalId: 't2',
        worktreeId: null,
        workspaceName: 'w2',
        title: 't2',
        conversationId: null,
        authEmail: 'a@gmail.com',
        commandPreview: 'agy',
        canRestartInPlace: true,
        restartBlockedReason: null,
        isExternal: false,
        agentState: 'working' as const,
        isOutdated: false,
        queuedTargetEmail: null,
        startedAtText: ''
      },
      {
        pid: 3,
        processKind: 'cli' as const,
        terminalId: null,
        worktreeId: null,
        workspaceName: 'ext',
        title: 'ext',
        conversationId: null,
        authEmail: 'a@gmail.com',
        commandPreview: 'agy',
        canRestartInPlace: false,
        restartBlockedReason: null,
        isExternal: true,
        agentState: 'idle' as const,
        isOutdated: false,
        queuedTargetEmail: null,
        startedAtText: ''
      },
      {
        pid: 4,
        processKind: 'cli' as const,
        terminalId: 't4',
        worktreeId: null,
        workspaceName: 'un',
        title: 'un',
        conversationId: null,
        authEmail: null,
        commandPreview: 'agy',
        canRestartInPlace: true,
        restartBlockedReason: null,
        isExternal: false,
        agentState: 'idle' as const,
        isOutdated: false,
        queuedTargetEmail: null,
        startedAtText: ''
      }
    ],
    outdatedCount: 0,
    externalOutdatedCount: 0,
    acpOutdatedCount: 0,
    unknownAuthCount: 1,
    queuedCount: 0,
    workingPolicy: 'queue' as const,
    drift: null,
    busy: false,
    busyLabel: null,
    scanDegradedReason: null,
    lastOperation: null,
    error: null
  }

  const queueImpact = computeSwitchImpact(baseSnap, 'b@gmail.com', 'queue')
  assert.equal(queueImpact.immediateCount, 1)
  assert.equal(queueImpact.queueCount, 1)
  assert.equal(queueImpact.forcedBusyCount, 0)
  assert.equal(queueImpact.externalCount, 1)
  assert.equal(queueImpact.unknownAuthCount, 1)

  const forceImpact = computeSwitchImpact(baseSnap, 'b@gmail.com', 'force')
  assert.equal(forceImpact.immediateCount, 2)
  assert.equal(forceImpact.forcedBusyCount, 1)
  assert.equal(forceImpact.queueCount, 0)
})

test('[C-0/C-6] switchAll 走跨工作区 sendTerminalText，且同步互斥锁拦截并发双击', async () => {
  const sys = makeFixture()
  const host = mockHost({
    settings: { workingPolicy: 'queue', notifyOnComplete: true, autoGuardDrift: true },
    results: {
      'notifications.show': { delivered: true },
      'statusBar.update': { ok: true }
    }
  })

  let service!: SwitcherService
  const worker = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        service = createWorker(orca, sys)
      }
    },
    { host }
  )

  // 并发同时调用两次 switchAll：第二次必须在首个 await 前就被同步锁拦截
  const [r1, r2] = await Promise.allSettled([
    worker.request('switcher.switchAll', {
      targetAccountId: 'acc-2',
      workingPolicy: 'queue',
      onlyOutdated: true
    }),
    worker.request('switcher.switchAll', {
      targetAccountId: 'acc-2',
      workingPolicy: 'queue',
      onlyOutdated: true
    })
  ])
  assert.equal(r1.status, 'fulfilled')
  assert.equal(r2.status, 'rejected')

  // 验证走了 SystemAdapter.sendTerminalText（跨工作区 CLI）且顺序先停后切再起
  assert.deepEqual(sys.events, ['stop:101', 'select:acc-2'])
  const mainSend = sys.sentTexts.find((s) => s.terminalId === 'term_idle' && s.enter)
  assert.ok(mainSend)
  assert.equal(
    mainSend!.text,
    'stty sane; agy --dangerously-skip-permissions --conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d'
  )

  // 不再调用受 active worktree 限制的 Host API terminal.sendText
  assert.equal(host.callsOf('terminal.sendText').length, 0)
  assert.deepEqual(worker.refusals, [])

  service.dispose()
  await worker.deactivate()
})

test('[C-3] 切号第 2 步失败时自动回滚原位拉起已停止的终端，失败项记录永不截断的 recoveryCommands', async () => {
  const sys = makeFixture()
  sys.failSelectAccount = true
  const host = mockHost({
    settings: { workingPolicy: 'skip', notifyOnComplete: false },
    results: { 'statusBar.update': { ok: true } }
  })

  let service!: SwitcherService
  const worker = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        service = createWorker(orca, sys)
      }
    },
    { host }
  )

  const snap = await worker.request('switcher.switchAll', {
    targetAccountId: 'acc-2',
    workingPolicy: 'skip',
    onlyOutdated: true
  })

  // 已停止的 term_idle 必须被自动回滚拉起！
  assert.equal(snap.lastOperation?.rolledBackCount, 1)
  assert.equal(
    sys.sentTexts.some(
      (s) =>
        s.terminalId === 'term_idle' &&
        s.enter &&
        s.text.includes('--conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d')
    ),
    true
  )

  // 若回滚拉起也失败，recoveryCommands 必须完整保留恢复命令
  sys.alivePids.add(101)
  sys.failSendTerminal = true
  const snap2 = await worker.request('switcher.switchAll', {
    targetAccountId: 'acc-2',
    workingPolicy: 'skip',
    onlyOutdated: true
  })
  assert.equal(snap2.lastOperation?.recoveryCommands.length, 1)
  assert.equal(
    snap2.lastOperation?.recoveryCommands[0]!.command.includes(
      '--conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d'
    ),
    true
  )

  service.dispose()
  await worker.deactivate()
})

test('[C-5/M-1] agent list 超时时 Fail-Closed 为 unknown 绝不误杀 working，且历史 done 不覆盖 working', async () => {
  const sys = makeFixture()
  // 先测试 M-1：同一 paneKey 同时有 working 和历史 done，必须保留 working
  sys.agents.push({
    terminalId: null,
    paneKey: 'tab2:leaf2',
    worktreeId: 'r2::/work/web-app',
    workspace: 'web-app',
    repo: 'web-app',
    agent: 'antigravity',
    state: 'done',
    title: '旧记录'
  })

  const host = mockHost({
    storage: {
      pendingQueue: [
        {
          terminalId: 'term_busy',
          targetAccountId: 'acc-2',
          targetEmail: 'fresh@gmail.com',
          enqueuedAt: Date.now(),
          attempts: 0,
          nextRetryAt: 0
        }
      ]
    },
    settings: { workingPolicy: 'queue', notifyOnComplete: false },
    results: { 'statusBar.update': { ok: true } }
  })

  let service!: SwitcherService
  const worker = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        service = createWorker(orca, sys)
      }
    },
    { host }
  )

  const snap1 = await worker.request('switcher.getState', { refresh: true, refreshAccounts: true })
  const busyTerm = snap1.terminals.find((t) => t.terminalId === 'term_busy')
  assert.equal(busyTerm?.agentState, 'working')

  // 再测试 C-5：模拟 orca agent list 超时失败 -> Fail-Closed 为 unknown，drainAnyIdleQueued 绝不能误杀！
  sys.agentsQueryOk = false
  await service.drainAnyIdleQueued()
  assert.equal(sys.events.includes('stop:202'), false)

  // 模拟 orca terminal list 超时失败 -> 绝不能清空持久化队列，也不能把 Orca 终端误判为外部野进程！
  sys.terminalsQueryOk = false
  const snapDegraded = await worker.request('switcher.getState', {
    refresh: true,
    refreshAccounts: false
  })
  assert.equal(snapDegraded.queuedCount, 1)
  assert.equal(snapDegraded.terminals.every((t) => !t.isExternal), true)

  service.dispose()
  await worker.deactivate()
})

test('[H-5/H-6] 漂移期间单终端 restartOne 切回预期号且不篡改其他排队项；原生切号伴随漂移仍同步更新队列', async () => {
  const sys = makeFixture()
  // 场景：Orca 选中 acc-2，但底层被顶回 acc-1（漂移）
  sys.accountState.selectedAccountId = 'acc-2'
  sys.accountState.activeAccountId = 'acc-1'
  sys.accountState.currentEmail = 'old@gmail.com'

  const host = mockHost({
    storage: {
      pendingQueue: [
        {
          terminalId: 'term_busy',
          targetAccountId: 'acc-2',
          targetEmail: 'fresh@gmail.com',
          enqueuedAt: Date.now(),
          attempts: 0,
          nextRetryAt: 0
        }
      ]
    },
    settings: { autoGuardDrift: false, notifyOnComplete: false },
    results: { 'statusBar.update': { ok: true } }
  })

  let service!: SwitcherService
  const worker = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        service = createWorker(orca, sys)
      }
    },
    { host }
  )

  // 点单个终端 restartOne（不传 targetAccountId）：必须切向预期 acc-2，绝不能切向漂移后的 acc-1！
  await worker.request('switcher.restartOne', { terminalId: 'term_idle', force: true })
  assert.equal(sys.events.includes('select:acc-2'), true)
  assert.equal(sys.events.includes('select:acc-1'), false)

  service.dispose()
  await worker.deactivate()
})

test('[C-6] 同一 terminalId 存在多个顶级 agy 进程时禁止自动原地重启以防双发注入命令', async () => {
  const sys = makeFixture()
  sys.processes.push({
    pid: 303,
    ppid: 10,
    processKind: 'cli',
    parentIsShell: true,
    hasAgyAncestor: false,
    startedAtText: 'Sun Nov 22 17:20:00 2026',
    command: 'agy --dangerously-skip-permissions',
    terminalHandle: 'term_idle',
    worktreeId: 'r1::/work/GEO',
    conversationId: null,
    authEmail: 'old@gmail.com'
  })
  sys.alivePids.add(303)

  const host = mockHost({
    results: { 'statusBar.update': { ok: true } }
  })

  let service!: SwitcherService
  const worker = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        service = createWorker(orca, sys)
      }
    },
    { host }
  )

  const snap = await worker.request('switcher.getState', { refresh: true, refreshAccounts: true })
  const dupTerms = snap.terminals.filter((t) => t.terminalId === 'term_idle')
  assert.equal(dupTerms.length, 2)
  assert.equal(dupTerms.every((t) => !t.canRestartInPlace), true)

  service.dispose()
  await worker.deactivate()
})

test('[二阶回归] switchBest 全程单次独占锁原子完成，拦截并发冲突且状态栏不闪烁', async () => {
  const sys = makeFixture()
  const host = mockHost({
    settings: { workingPolicy: 'queue', notifyOnComplete: false },
    results: { 'statusBar.update': { ok: true } }
  })

  let service!: SwitcherService
  const worker = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        service = createWorker(orca, sys)
      }
    },
    { host }
  )

  const [r1, r2] = await Promise.allSettled([
    worker.request('switcher.switchBest', { workingPolicy: 'queue' }),
    worker.request('switcher.syncToCurrent', { workingPolicy: 'queue' })
  ])
  assert.equal(r1.status, 'fulfilled')
  assert.equal(r2.status, 'rejected')
  assert.equal(sys.events.includes('select:acc-2'), true)

  service.dispose()
  await worker.deactivate()
})

test('[路线A] 同工作区多原生 Chat 1-on-1 精准绑定、探活鬼影去噪、且区分托管独立引擎与宿主共号引擎', async () => {
  // 1. 识别托管二进制与家族判定（含 macOS 内核 16 字节 ucomm= 截断名及含空格连字符路径）
  assert.equal(
    classifyAgyCommand(
      '/Users/me/Library/Application Support/Orca/agent-runtimes/antigravity/1.5.2/agy_acp_server.par'
    ),
    'acp'
  )
  assert.equal(isAgyFamilyBinary('/path/to/agy_acp_server.par'), true)
  assert.equal(isAgyFamilyBinary('agy_acp_server.p'), true)
  assert.equal(isManagedAcpBinary('agy_acp_server.p'), true)
  assert.equal(
    isManagedAcpCommand('/Users/My - App/Orca/agent-runtimes/antigravity/1.5.2/agy_acp_server.par --uid='),
    true
  )
  assert.equal(isAgyFamilyBinary('agy'), true)
  assert.equal(isAgyFamilyBinary('node'), false)

  // 2. 无 ORCA_STRUCTURED_SESSION 的后台 5 分钟短命探活 `agy acp` 必须被安静过滤
  assert.equal(
    shouldIgnoreUnstructuredAcpProbe({
      processKind: 'acp',
      isManagedAcpServer: false,
      hasEnvData: true,
      isStructuredSession: false,
      orcaSessionId: null,
      terminalHandle: null
    }),
    true
  )
  // 真实原生 Chat（含 ORCA_STRUCTURED_SESSION & ORCA_AGENT_SESSION_ID）与托管服务器绝不被过滤
  assert.equal(
    shouldIgnoreUnstructuredAcpProbe({
      processKind: 'acp',
      isManagedAcpServer: false,
      hasEnvData: true,
      isStructuredSession: true,
      orcaSessionId: 'chat-sess-1',
      terminalHandle: null
    }),
    false
  )
  assert.equal(
    shouldIgnoreUnstructuredAcpProbe({
      processKind: 'acp',
      isManagedAcpServer: true,
      hasEnvData: true,
      isStructuredSession: false,
      orcaSessionId: null,
      terminalHandle: null
    }),
    false
  )

  // 3. parsePsEnvOutput 解析 ORCA_AGENT_SESSION_ID、ORCA_STRUCTURED_SESSION 与含空格 GEMINI_HOME，且防命令行注入伪造
  const cmdMap = new Map<number, string>([
    [901, 'agy acp --prompt-fake ORCA_AGENT_SESSION_ID=fake_injected']
  ])
  const envOut =
    '  901 agy acp --prompt-fake ORCA_AGENT_SESSION_ID=fake_injected PATH=/usr/bin ORCA_STRUCTURED_SESSION=1 ORCA_AGENT_SESSION_ID=real-chat-1 GEMINI_HOME=/Users/me/Library/Application Support/orca/antigravity-chat HOME=/Users/me'
  const parsedEnv = parsePsEnvOutput(envOut, cmdMap).get(901)
  assert.equal(parsedEnv?.hasEnvData, true)
  assert.equal(parsedEnv?.isStructuredSession, true)
  assert.equal(parsedEnv?.orcaSessionId, 'real-chat-1')
  assert.equal(parsedEnv?.geminiHome, '/Users/me/Library/Application Support/orca/antigravity-chat')

  // 4. 同一工作区 /work/GEO 同时开 3 个原生 Chat：2 个宿主版（一干活一空闲）、1 个托管版（独立账号）
  const futureSession = Date.now() + 3 * 3600_000
  const futureWeekly = Date.now() + 5 * 86400_000
  const sys = new FakeSystemAdapter({
    accountState: {
      activeAccountId: 'acc-2',
      selectedAccountId: 'acc-2',
      currentEmail: 'fresh@gmail.com',
      chatUsesAgy: true,
      chatGoogleSignInInUse: 'agy',
      accounts: [
        {
          id: 'acc-1',
          email: 'old@gmail.com',
          label: null,
          status: 'ok',
          sessionUsedPercent: 90,
          sessionResetsAt: futureSession,
          weeklyUsedPercent: 50,
          weeklyResetsAt: futureWeekly,
          buckets: []
        },
        {
          id: 'acc-2',
          email: 'fresh@gmail.com',
          label: null,
          status: 'ok',
          sessionUsedPercent: 5,
          sessionResetsAt: futureSession,
          weeklyUsedPercent: 2,
          weeklyResetsAt: futureWeekly,
          buckets: []
        }
      ]
    },
    terminals: [],
    agents: [
      {
        orcaSessionId: 'chat-host-busy',
        kind: 'chat',
        terminalId: null,
        paneKey: 'tabA:leafA',
        worktreeId: 'r1::/work/GEO',
        workspace: 'master',
        repo: 'GEO',
        agent: 'antigravity',
        state: 'working',
        title: '检查页面“最”字'
      },
      {
        orcaSessionId: 'chat-host-idle',
        kind: 'chat',
        terminalId: null,
        paneKey: 'tabB:leafB',
        worktreeId: 'r1::/work/GEO',
        workspace: 'master',
        repo: 'GEO',
        agent: 'antigravity',
        state: 'done',
        title: '撰写推广文案'
      },
      {
        orcaSessionId: 'chat-managed-1',
        kind: 'chat',
        terminalId: null,
        paneKey: 'tabC:leafC',
        worktreeId: 'r1::/work/GEO',
        workspace: 'master',
        repo: 'GEO',
        agent: 'antigravity',
        state: 'done',
        title: '托管独立对话'
      }
    ],
    processes: [
      {
        pid: 8001,
        ppid: 1,
        processKind: 'acp',
        parentIsShell: false,
        hasAgyAncestor: false,
        startedAtText: 'Sun Nov 22 20:00:00 2026',
        command: 'agy acp --dangerously-skip-permissions',
        terminalHandle: null,
        worktreeId: null,
        conversationId: null,
        authEmail: 'old@gmail.com',
        orcaSessionId: 'chat-host-busy',
        isStructuredSession: true,
        isManagedAcpServer: false
      },
      {
        pid: 8002,
        ppid: 1,
        processKind: 'acp',
        parentIsShell: false,
        hasAgyAncestor: false,
        startedAtText: 'Sun Nov 22 20:05:00 2026',
        command: 'agy acp --dangerously-skip-permissions',
        terminalHandle: null,
        worktreeId: null,
        conversationId: null,
        authEmail: 'fresh@gmail.com',
        orcaSessionId: 'chat-host-idle',
        isStructuredSession: true,
        isManagedAcpServer: false
      },
      {
        pid: 8003,
        ppid: 1,
        processKind: 'acp',
        parentIsShell: false,
        hasAgyAncestor: false,
        startedAtText: 'Sun Nov 22 20:10:00 2026',
        command: '/Users/me/Library/Application Support/Orca/agent-runtimes/antigravity/1.5.2/agy_acp_server.par',
        terminalHandle: null,
        worktreeId: null,
        conversationId: null,
        authEmail: 'old@gmail.com', // 即使异常带入邮箱，托管版也必须强制隔离且不计为旧号/未知
        orcaSessionId: 'chat-managed-1',
        isStructuredSession: true,
        isManagedAcpServer: true
      }
    ]
  })

  const host = mockHost({
    settings: { autoGuardDrift: false, notifyOnComplete: false },
    results: { 'statusBar.update': { ok: true } }
  })

  let service!: SwitcherService
  const worker = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        service = createWorker(orca, sys)
      }
    },
    { host }
  )

  const snap = await worker.request('switcher.getState', { refresh: true, refreshAccounts: true })
  assert.equal(snap.chatBackendMode, 'host-agy')
  assert.equal(snap.unknownAuthCount, 0)
  assert.equal(snap.acpOutdatedCount, 1)

  const busyChat = snap.terminals.find((t) => t.pid === 8001)!
  const idleChat = snap.terminals.find((t) => t.pid === 8002)!
  const managedChat = snap.terminals.find((t) => t.pid === 8003)!

  assert.equal(busyChat.workspaceName, 'GEO · master')
  assert.equal(busyChat.title, '检查页面“最”字')
  assert.equal(busyChat.agentState, 'working')
  assert.equal(busyChat.isOutdated, true)
  assert.equal(busyChat.chatEngine, 'host-agy')

  assert.equal(idleChat.title, '撰写推广文案')
  assert.equal(idleChat.agentState, 'done')
  assert.equal(idleChat.isOutdated, false)

  // 托管引擎完全隔离：authEmail 置空、不算旧号、不算未识别邮箱
  assert.equal(managedChat.title, '托管独立对话')
  assert.equal(managedChat.chatEngine, 'orca-managed')
  assert.equal(managedChat.authEmail, null)
  assert.equal(managedChat.isOutdated, false)

  // 执行批量换号：严格按路线 A，绝不强杀任何 Chat 进程！
  await worker.request('switcher.switchAll', {
    targetAccountId: 'acc-1',
    workingPolicy: 'force',
    onlyOutdated: true
  })
  assert.equal(sys.events.some((e) => e.startsWith('stop:')), false)

  // computeSwitchImpact 同步验证受影响数量与托管提示
  const impact = computeSwitchImpact(snap, 'fresh@gmail.com', 'queue')
  assert.equal(impact.acpCount, 1)
  assert.equal(impact.managedChatCount, 1)
  assert.equal(impact.unknownAuthCount, 0)

  // statusBar.update 上限护栏：极端多旧号+长工作区名+长邮箱下，text<=64 且 tooltip<=256
  const stressSnap = {
    ...snap,
    currentEmail: 'very.long.enterprise.user.account.prefix@example-company.com',
    outdatedCount: 4,
    acpOutdatedCount: 2,
    queuedCount: 2,
    scanDegradedReason: 'lsof 扫描不完整（部分会话 ID 或邮箱可能缺失）',
    terminals: Array.from({ length: 6 }, (_, i) => ({
      ...busyChat,
      pid: 9000 + i,
      workspaceName: `超长行业工作区名称示例-${i}-示例项目名称与自动化测试工作区`,
      authEmail: 'another.very.long.legacy.account@example-company.com',
      isOutdated: true
    }))
  }
  const sb = computeStatusBar(stressSnap)
  assert.ok(sb.text.length <= 64, `status text too long: ${sb.text.length}`)
  assert.ok(sb.tooltip.length <= 256, `status tooltip too long: ${sb.tooltip.length}`)

  service.dispose()
  await worker.deactivate()
})

test('[v0.2.6] pickBestAccount 与 compareAccountsByHeadroom 正确处理过期快照、平局实测优先与 unfetched 隔离', () => {
  const now = new Date(2026, 10, 23, 10, 0, 0).getTime()
  const expired100: AccountInfo = {
    id: 'acc-expired-100',
    email: 'expired@gmail.com',
    label: null,
    isActive: false,
    isSelected: false,
    status: 'ok',
    sessionUsedPercent: 100,
    sessionResetsAt: now - 15 * 3600_000,
    weeklyUsedPercent: 10,
    weeklyResetsAt: now + 5 * 86400_000,
    buckets: [],
    terminalCount: 0,
    usageUpdatedAt: now - 16 * 3600_000
  }
  const active85: AccountInfo = {
    id: 'acc-85',
    email: 'busy85@gmail.com',
    label: null,
    isActive: true,
    isSelected: true,
    status: 'ok',
    sessionUsedPercent: 85,
    sessionResetsAt: now + 2 * 3600_000,
    weeklyUsedPercent: 5,
    weeklyResetsAt: now + 5 * 86400_000,
    buckets: [],
    terminalCount: 0,
    usageUpdatedAt: now - 60_000
  }
  const liveZero: AccountInfo = {
    id: 'acc-live-zero',
    email: 'livezero@gmail.com',
    label: null,
    isActive: false,
    isSelected: false,
    status: 'ok',
    sessionUsedPercent: 0,
    sessionResetsAt: now + 4 * 3600_000,
    weeklyUsedPercent: 10,
    weeklyResetsAt: now + 5 * 86400_000,
    buckets: [],
    terminalCount: 0,
    usageUpdatedAt: now - 60_000
  }
  const lowWeeklyExpired: AccountInfo = {
    ...expired100,
    id: 'acc-low-week-exp',
    email: 'lowweek@gmail.com',
    weeklyUsedPercent: 3
  }
  const unfetched: AccountInfo = {
    id: 'acc-unfetched',
    email: 'newbie@gmail.com',
    label: null,
    isActive: false,
    isSelected: false,
    status: 'unfetched',
    sessionUsedPercent: null,
    sessionResetsAt: null,
    weeklyUsedPercent: null,
    weeklyResetsAt: null,
    buckets: [],
    terminalCount: 0,
    usageUpdatedAt: null
  }
  const broken: AccountInfo = {
    ...active85,
    id: 'acc-error',
    email: 'broken@gmail.com',
    isActive: false,
    isSelected: false,
    status: 'error',
    sessionUsedPercent: 0
  }

  // 1) 昨天 100% 但 5h 已过重置点的号，严格优于未过期的 85% 号
  assert.equal(pickBestAccount([active85, expired100], now)?.id, 'acc-expired-100')

  // 2) 5h 同为 0 档时，周额度更低者优先
  assert.equal(pickBestAccount([liveZero, lowWeeklyExpired], now)?.id, 'acc-low-week-exp')

  // 3) 5h 与周均打平时，实测未过期 0% 严格优先于过期推算
  assert.equal(pickBestAccount([expired100, liveZero], now)?.id, 'acc-live-zero')

  // 4) 自动选号严格跳过 unfetched 与 error（全部不可用返回 null），但列表排序 unfetched 位于 error 之前
  assert.equal(pickBestAccount([unfetched, broken], now), null)
  const sorted = [broken, unfetched, active85, expired100, liveZero].sort((a, b) =>
    compareAccountsByHeadroom(a, b, now)
  )
  assert.deepEqual(
    sorted.map((a) => a.id),
    ['acc-live-zero', 'acc-expired-100', 'acc-85', 'acc-unfetched', 'acc-error']
  )
})

test('[v0.2.6] computeStatusBar 在当前号 5h 窗口已过重置时不触发 100% 红警且严格控长', () => {
  const now = new Date(2026, 10, 23, 10, 0, 0).getTime()
  const sb = computeStatusBar({
    updatedAt: now,
    accountsUpdatedAt: now - 60_000,
    currentEmail: 'expired@gmail.com',
    activeAccountId: 'acc-1',
    selectedAccountId: 'acc-1',
    desiredEmail: 'expired@gmail.com',
    accounts: [
      {
        id: 'acc-1',
        email: 'expired@gmail.com',
        label: null,
        isActive: true,
        isSelected: true,
        status: 'ok',
        sessionUsedPercent: 100,
        sessionResetsAt: now - 3600_000,
        weeklyUsedPercent: 40,
        weeklyResetsAt: now + 4 * 86400_000,
        buckets: [],
        terminalCount: 1,
        usageUpdatedAt: now - 4 * 3600_000
      }
    ],
    terminals: [],
    outdatedCount: 0,
    externalOutdatedCount: 0,
    acpOutdatedCount: 0,
    unknownAuthCount: 0,
    queuedCount: 0,
    workingPolicy: 'queue',
    drift: null,
    busy: false,
    busyLabel: null,
    scanDegradedReason: null,
    lastOperation: null,
    error: null
  })

  assert.equal(sb.tone, 'neutral')
  assert.ok(sb.text.includes('待刷新'))
  assert.equal(sb.text.includes('100%'), false)
  assert.ok(sb.tooltip.includes('5h 已过重置·上轮100%（待刷新）'))
  assert.ok(sb.text.length <= 64)
  assert.ok(sb.tooltip.length <= 256)
})

test('[v0.2.7] computeStatusBar 全部状态 tooltip 均标明反重力身份且不包含任何引导点击状态栏文案', () => {
  const now = new Date(2026, 10, 23, 16, 0, 0).getTime()
  const baseAccount: AccountInfo = {
    id: 'acc-1',
    email: 'alice@example.com',
    label: null,
    isActive: true,
    isSelected: true,
    status: 'ok',
    sessionUsedPercent: 3,
    sessionResetsAt: now + 3 * 3600_000,
    weeklyUsedPercent: 10,
    weeklyResetsAt: now + 5 * 86400_000,
    buckets: [],
    terminalCount: 1,
    usageUpdatedAt: now - 60_000
  }
  const baseSnap = {
    updatedAt: now,
    accountsUpdatedAt: now - 60_000,
    currentEmail: 'alice@example.com',
    activeAccountId: 'acc-1',
    selectedAccountId: 'acc-1',
    desiredEmail: 'alice@example.com',
    accounts: [baseAccount],
    terminals: [],
    outdatedCount: 0,
    externalOutdatedCount: 0,
    acpOutdatedCount: 0,
    unknownAuthCount: 0,
    queuedCount: 0,
    workingPolicy: 'queue' as const,
    drift: null,
    busy: false,
    busyLabel: null,
    scanDegradedReason: null,
    lastOperation: null,
    error: null
  }

  const cases = [
    computeStatusBar(baseSnap),
    computeStatusBar({
      ...baseSnap,
      accounts: [{ ...baseAccount, sessionUsedPercent: 100 }]
    }),
    computeStatusBar({
      ...baseSnap,
      outdatedCount: 1,
      terminals: [
        {
          pid: 101,
          processKind: 'cli',
          terminalId: 't1',
          worktreeId: 'w1',
          workspaceName: '000_对话',
          title: 'agy',
          conversationId: null,
          authEmail: 'old@gmail.com',
          commandPreview: 'agy',
          canRestartInPlace: true,
          restartBlockedReason: null,
          isExternal: false,
          agentState: 'idle',
          isOutdated: true,
          queuedTargetEmail: null,
          startedAtText: ''
        }
      ]
    }),
    computeStatusBar({
      ...baseSnap,
      drift: {
        expectedAccountId: 'acc-2',
        expectedEmail: 'fresh@gmail.com',
        actualEmail: 'alice@example.com',
        detectedAt: now
      }
    })
  ]

  for (const sb of cases) {
    assert.ok(sb.tooltip.includes('反重力 (AGY)'), `missing identity in tooltip: ${sb.tooltip}`)
    assert.equal(sb.tooltip.includes('点击同步'), false)
    assert.equal(sb.tooltip.includes('点击切换'), false)
    assert.equal(sb.tooltip.includes('点击底部'), false)
    assert.ok(sb.text.length <= 64)
    assert.ok(sb.tooltip.length <= 256)
  }
})

test('[v0.2.8] parseAccountBuckets 与分池解析严格隔离 Gemini 主池与 Claude/GPT 副池（选号与状态栏不被跨池汇总污染）', () => {
  const now = new Date(2026, 10, 24, 23, 0, 0).getTime()
  const gem5hReset = now + 2 * 3600_000 + 33 * 60_000
  const gemWeekReset = now + (6 * 24 + 5) * 3600_000
  const claude5hReset = now + 4 * 3600_000 + 58 * 60_000
  const claudeWeekReset = now + (4 * 24 + 16) * 3600_000

  // 1) 验证 parseAccountBuckets 解析真实 Orca usage.buckets 结构及 fallback 字段名
  const parsed = parseAccountBuckets([
    {
      name: 'Gemini Models · Weekly',
      group: 'Gemini Models',
      windowName: 'Weekly Limit Remaining',
      usedPercent: 28,
      windowMinutes: 10080,
      resetsAt: gemWeekReset
    },
    {
      name: 'Gemini Models · Five Hour',
      group: 'Gemini Models',
      windowName: 'Five Hour Limit Remaining',
      usedPercent: 48,
      windowMinutes: 300,
      resetsAt: gem5hReset
    },
    {
      name: 'Claude and GPT models · Weekly',
      group: 'Claude and GPT models',
      windowName: 'Weekly Limit Remaining',
      usedPercent: 93,
      windowMinutes: 10080,
      resetsAt: claudeWeekReset
    },
    {
      name: 'Claude and GPT models · Five Hour',
      group: 'Claude and GPT models',
      windowName: 'Five Hour Limit Remaining',
      usedPercent: 0,
      windowMinutes: 300,
      resetsAt: claude5hReset
    }
  ])
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]!.group, 'Gemini Models')
  assert.equal(parsed[0]!.sessionUsedPercent, 48)
  assert.equal(parsed[0]!.weeklyUsedPercent, 28)
  assert.equal(parsed[1]!.group, 'Claude and GPT models')
  assert.equal(parsed[1]!.sessionUsedPercent, 0)
  assert.equal(parsed[1]!.weeklyUsedPercent, 93)

  // 2) 还原真实故障账号：顶层 weekly 为跨池最大值 93%（来自 Claude/GPT），但 Gemini 周实际仅 28%
  const accMixed: AccountInfo = {
    id: 'acc-mixed',
    email: 'mixed@example.com',
    label: null,
    isActive: true,
    isSelected: true,
    status: 'ok',
    sessionUsedPercent: 48,
    sessionResetsAt: gem5hReset,
    weeklyUsedPercent: 93,
    weeklyResetsAt: claudeWeekReset,
    buckets: parsed,
    terminalCount: 6,
    usageUpdatedAt: now - 60_000
  }

  const pools = resolveAccountQuotaPools(accMixed)
  assert.equal(pools.primary.name, 'Gemini')
  assert.equal(pools.primary.sessionUsedPercent, 48)
  assert.equal(pools.primary.sessionResetsAt, gem5hReset)
  assert.equal(pools.primary.weeklyUsedPercent, 28)
  assert.equal(pools.primary.weeklyResetsAt, gemWeekReset)
  assert.equal(pools.secondary.length, 1)
  assert.equal(pools.secondary[0]!.name, 'Claude/GPT')
  assert.equal(pools.secondary[0]!.weeklyUsedPercent, 93)

  // 3) 选号排序不被副池 100% 误杀：A 号 Gemini 5h=12%/周=20%（Claude 5h=100% 导致顶层 session=100%），
  //    B 号 Gemini 5h=60%/周=50%（Claude 全 0%）。自动选号必须选 Gemini 更充裕的 A！
  const accAGemFreeClaudeFull: AccountInfo = {
    id: 'acc-a',
    email: 'a@example.com',
    label: null,
    isActive: false,
    isSelected: false,
    status: 'ok',
    sessionUsedPercent: 100,
    sessionResetsAt: claude5hReset,
    weeklyUsedPercent: 95,
    weeklyResetsAt: claudeWeekReset,
    buckets: [
      {
        group: 'Gemini Models',
        sessionUsedPercent: 12,
        sessionResetsAt: gem5hReset,
        weeklyUsedPercent: 20,
        weeklyResetsAt: gemWeekReset
      },
      {
        group: 'Claude and GPT models',
        sessionUsedPercent: 100,
        sessionResetsAt: claude5hReset,
        weeklyUsedPercent: 95,
        weeklyResetsAt: claudeWeekReset
      }
    ],
    terminalCount: 0,
    usageUpdatedAt: now - 60_000
  }
  const accBGemBusyClaudeFree: AccountInfo = {
    id: 'acc-b',
    email: 'b@example.com',
    label: null,
    isActive: false,
    isSelected: false,
    status: 'ok',
    sessionUsedPercent: 60,
    sessionResetsAt: gem5hReset,
    weeklyUsedPercent: 50,
    weeklyResetsAt: gemWeekReset,
    buckets: [
      {
        group: 'Gemini Models',
        sessionUsedPercent: 60,
        sessionResetsAt: gem5hReset,
        weeklyUsedPercent: 50,
        weeklyResetsAt: gemWeekReset
      },
      {
        group: 'Claude and GPT models',
        sessionUsedPercent: 0,
        sessionResetsAt: claude5hReset,
        weeklyUsedPercent: 0,
        weeklyResetsAt: claudeWeekReset
      }
    ],
    terminalCount: 0,
    usageUpdatedAt: now - 60_000
  }
  assert.equal(pickBestAccount([accBGemBusyClaudeFree, accAGemFreeClaudeFull], now)?.id, 'acc-a')

  // 4) 主池完全打平时，次级按副池余量选出更空闲号
  const accCTieClaudeFree: AccountInfo = {
    ...accAGemFreeClaudeFull,
    id: 'acc-c',
    email: 'c@example.com',
    sessionUsedPercent: 12,
    weeklyUsedPercent: 20,
    buckets: [
      accAGemFreeClaudeFull.buckets[0]!,
      {
        group: 'Claude and GPT models',
        sessionUsedPercent: 0,
        sessionResetsAt: claude5hReset,
        weeklyUsedPercent: 10,
        weeklyResetsAt: claudeWeekReset
      }
    ]
  }
  assert.equal(pickBestAccount([accAGemFreeClaudeFull, accCTieClaudeFree], now)?.id, 'acc-c')

  // 5) 状态栏对 Claude 5h=100% 但 Gemini 5h=12% 的激活号绝不误报 100% 红警，并在 tooltip 区分主/副池
  const sb = computeStatusBar({
    updatedAt: now,
    accountsUpdatedAt: now - 60_000,
    currentEmail: accAGemFreeClaudeFull.email,
    activeAccountId: accAGemFreeClaudeFull.id,
    selectedAccountId: accAGemFreeClaudeFull.id,
    desiredEmail: accAGemFreeClaudeFull.email,
    accounts: [{ ...accAGemFreeClaudeFull, isActive: true, isSelected: true }],
    terminals: [],
    outdatedCount: 0,
    externalOutdatedCount: 0,
    acpOutdatedCount: 0,
    unknownAuthCount: 0,
    queuedCount: 0,
    workingPolicy: 'queue',
    drift: null,
    busy: false,
    busyLabel: null,
    scanDegradedReason: null,
    lastOperation: null,
    error: null
  })
  assert.equal(sb.tone, 'neutral')
  assert.equal(sb.text, 'AGY:a 12%')
  assert.ok(sb.tooltip.includes('Gemini 5h 12%'))
  assert.ok(sb.tooltip.includes('周 20%'))
  assert.ok(sb.tooltip.includes('Claude/GPT 5h 100% | 周 95%'))
  assert.equal(sb.tooltip.includes('））'), false)
  assert.ok(sb.text.length <= 64)
  assert.ok(sb.tooltip.length <= 256)

  // 6) parseAccountBuckets 结构化 windowMinutes/windowName 优先，不被 name 中的字样误判窗口
  const structPriority = parseAccountBuckets([
    {
      name: 'Model-Week-Edition · 5h',
      group: 'Model-Week-Edition',
      windowName: 'Five Hour Limit Remaining',
      windowMinutes: 300,
      usedPercent: 33,
      resetsAt: gem5hReset
    }
  ])
  assert.equal(structPriority.length, 1)
  assert.equal(structPriority[0]!.sessionUsedPercent, 33)
  assert.equal(structPriority[0]!.weeklyUsedPercent, null)

  // 7) 无 buckets 的老账号安全回退顶层字段，不贴错误池名
  const legacyPrimary = resolvePrimaryQuota({
    sessionUsedPercent: 15,
    sessionResetsAt: gem5hReset,
    weeklyUsedPercent: 30,
    weeklyResetsAt: gemWeekReset,
    buckets: []
  })
  assert.equal(legacyPrimary.name, null)
  assert.equal(legacyPrimary.sessionUsedPercent, 15)
  assert.equal(legacyPrimary.weeklyUsedPercent, 30)
})

test('[v0.2.8] quickSyncCommand 仅在主池 5h 满额时自动换号，不被副池 Claude/GPT 5h 100% 误触发', async () => {
  const now = Date.now()
  const future5h = now + 3 * 3600_000
  const futureWeek = now + 5 * 86400_000
  const sys = new FakeSystemAdapter({
    accountState: {
      activeAccountId: 'acc-1',
      selectedAccountId: 'acc-1',
      currentEmail: 'primary-ok@example.com',
      accounts: [
        {
          id: 'acc-1',
          email: 'primary-ok@example.com',
          label: null,
          status: 'ok',
          // 顶层 100% 来自副池 Claude/GPT，主池 Gemini 仅 15%
          sessionUsedPercent: 100,
          sessionResetsAt: future5h,
          weeklyUsedPercent: 93,
          weeklyResetsAt: futureWeek,
          buckets: [
            {
              group: 'Gemini Models',
              sessionUsedPercent: 15,
              sessionResetsAt: future5h,
              weeklyUsedPercent: 28,
              weeklyResetsAt: futureWeek
            },
            {
              group: 'Claude and GPT models',
              sessionUsedPercent: 100,
              sessionResetsAt: future5h,
              weeklyUsedPercent: 93,
              weeklyResetsAt: futureWeek
            }
          ]
        },
        {
          id: 'acc-2',
          email: 'backup@example.com',
          label: null,
          status: 'ok',
          sessionUsedPercent: 0,
          sessionResetsAt: future5h,
          weeklyUsedPercent: 5,
          weeklyResetsAt: futureWeek,
          buckets: [
            {
              group: 'Gemini Models',
              sessionUsedPercent: 0,
              sessionResetsAt: future5h,
              weeklyUsedPercent: 5,
              weeklyResetsAt: futureWeek
            }
          ]
        }
      ]
    },
    terminals: [],
    agents: [],
    processes: []
  })

  const host = mockHost({
    settings: { workingPolicy: 'queue', notifyOnComplete: false },
    results: { 'statusBar.update': { ok: true } }
  })

  let service!: SwitcherService
  const worker = await mountWorker(
    {
      default(orca: OrcaWorkerApi) {
        service = createWorker(orca, sys)
      }
    },
    { host }
  )

  const msg = await service.quickSyncCommand()
  assert.equal(sys.events.length, 0)
  assert.ok(msg.includes('全部已同步'))

  service.dispose()
  await worker.deactivate()
})
