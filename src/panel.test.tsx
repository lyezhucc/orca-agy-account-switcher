// 面板交互与红队防误触测试：验证二次确认、永不截断的恢复命令、定位与一键同步。
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { SwitcherSnapshot } from './protocol'

function makeSnapshot(overrides: Partial<SwitcherSnapshot> = {}): SwitcherSnapshot {
  const now = Date.now()
  return {
    updatedAt: now,
    accountsUpdatedAt: now,
    currentEmail: 'alice@example.com',
    activeAccountId: 'acc-2',
    selectedAccountId: 'acc-2',
    desiredEmail: 'alice@example.com',
    accounts: [
      {
        id: 'acc-1',
        email: 'bob@example.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'ok',
        sessionUsedPercent: 100,
        sessionResetsAt: now + 3600_000,
        weeklyUsedPercent: 68,
        weeklyResetsAt: now + (5 * 24 + 18) * 3600_000 + 14 * 60_000,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 100,
            sessionResetsAt: now + 3600_000,
            weeklyUsedPercent: 68,
            weeklyResetsAt: now + (5 * 24 + 18) * 3600_000 + 14 * 60_000
          }
        ],
        terminalCount: 1
      },
      {
        id: 'acc-2',
        email: 'alice@example.com',
        label: null,
        isActive: true,
        isSelected: true,
        status: 'ok',
        sessionUsedPercent: 3,
        sessionResetsAt: now + 3 * 3600_000 + 5 * 60_000,
        weeklyUsedPercent: 1,
        weeklyResetsAt: now + 86400_000,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 3,
            sessionResetsAt: now + 3 * 3600_000 + 5 * 60_000,
            weeklyUsedPercent: 1,
            weeklyResetsAt: now + 86400_000
          },
          {
            group: 'Claude and GPT models',
            sessionUsedPercent: 0,
            sessionResetsAt: 0,
            weeklyUsedPercent: 0,
            weeklyResetsAt: 0
          }
        ],
        terminalCount: 1
      }
    ],
    terminals: [
      {
        pid: 16920,
        processKind: 'cli',
        terminalId: 'term_geo',
        worktreeId: 'r::/work/GEO',
        workspaceName: 'GEO',
        title: '继续',
        conversationId: '8ecc012e-da64-42e5-b8ac-3a0affc1213d',
        authEmail: 'bob@example.com',
        commandPreview: 'agy --dangerously-skip-permissions',
        canRestartInPlace: true,
        restartBlockedReason: null,
        isExternal: false,
        agentState: 'idle',
        isOutdated: true,
        queuedTargetEmail: null,
        startedAtText: 'Sat Nov 21 21:37:46 2026'
      }
    ],
    outdatedCount: 1,
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
    error: null,
    ...overrides
  }
}

test('面板支持底部先选账号再点闪电、所有批量换号先预览确认、二次强切与恢复命令', async () => {
  let current = makeSnapshot({ queuedCount: 1 })
  let focusedId: string | null = null
  let forceDrainCalls = 0
  let switchAllCalls = 0
  let lastSwitchTarget: string | null = null

  const host = mockHost({
    requests: {
      'switcher.getState': () => current,
      'switcher.switchAll': (input: { targetAccountId: string }) => {
        switchAllCalls += 1
        lastSwitchTarget = input.targetAccountId
        current = makeSnapshot({
          updatedAt: Date.now() + 10,
          outdatedCount: 0,
          queuedCount: 0,
          terminals: [
            {
              ...current.terminals[0]!,
              authEmail: 'alice@example.com',
              isOutdated: false
            }
          ],
          lastOperation: {
            at: Date.now(),
            targetEmail: 'alice@example.com',
            restartedCount: 1,
            queuedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            rolledBackCount: 0,
            message: '已切到 alice，原地换号 1 个',
            details: ['✓ GEO · 继续（已续接原对话）'],
            recoveryCommands: [
              {
                label: '示例兜底',
                command: 'stty sane; agy --conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d',
                reason: '测试显示'
              }
            ]
          }
        })
        return current
      },
      'switcher.forceDrainQueue': () => {
        forceDrainCalls += 1
        current = makeSnapshot({ updatedAt: Date.now() + 5, queuedCount: 0, outdatedCount: 1 })
        return current
      },
      'switcher.focusTerminal': (input: { terminalId?: string }) => {
        focusedId = input.terminalId ?? null
        return { focused: true }
      },
      'switcher.setPolicy': (input: { workingPolicy: 'queue' | 'skip' | 'force' }) => {
        current = { ...current, updatedAt: Date.now() + 2, workingPolicy: input.workingPolicy }
        return current
      }
    }
  })

  const view = await mount(panel, { host })

  assert.ok(view.find({ text: '1 个待切换' }))
  assert.ok(view.find({ text: /周\s+68%/ }))
  assert.ok(view.find({ text: /5天18时14分/ }))
  assert.ok(view.find({ text: 'Claude/GPT' }))
  // 验证 resetsAt: 0（未开启计时窗口的满血池）正常展示为 0%，绝不误报已重置
  assert.ok(view.find({ text: '5h 0% · 周 0%' }))
  assert.equal(view.findAll({ text: /已重置/ }).length, 0)

  // 1) 未选下方账号直接点顶部闪电「一键选余量最多账号」：绝不立刻切号，必须先弹出确认框
  await view.press({ text: '一键选余量最多账号' })
  assert.equal(switchAllCalls, 0)
  assert.ok(view.find({ text: /确认切换到/ }))
  // 点取消后零副作用
  await view.press({ text: '取消' })
  assert.equal(switchAllCalls, 0)

  // 2) 在下方账号卡片直接点「切换」：立即在卡片下方就地展开确认框（无需翻回顶部点第二下）
  await view.press({ type: 'Button', text: '切换' })
  assert.equal(switchAllCalls, 0)
  assert.ok(view.find({ text: /确认切换到 bob/ }))
  assert.ok(view.find({ text: /5h已满/ }))

  // 确认框展开期间修改「运行中终端」策略下拉框，确认框绝不被静默关掉
  await view.select({ label: '运行中终端处理方式' }, 'skip')
  assert.ok(view.find({ text: /确认切换到 bob/ }))
  assert.equal(switchAllCalls, 0)

  // 点收起或取消均零副作用关闭
  await view.press({ type: 'Button', text: '收起' })
  assert.equal(view.findAll({ text: /确认切换到 bob/ }).length, 0)

  // 切换到「终端 (1)」Tab 验证终端列表与定位按钮
  await view.select({ label: '视图切换' }, 'terminals')
  assert.ok(view.find({ text: 'GEO' }))

  await view.press({ text: '定位' })
  assert.equal(focusedId, 'term_geo')

  // 破坏性按钮「立即切换等待项 (1)」首次点击进入二次确认，不直接触发
  await view.press({ text: '立即切换等待项 (1)' })
  assert.equal(forceDrainCalls, 0)
  assert.ok(view.find({ text: '再点确认切换 (1)' }))

  // 二次点击才真正触发
  await view.press({ text: '再点确认切换 (1)' })
  assert.equal(forceDrainCalls, 1)

  // 3) 顶部预警框「更新 1 个对话到 alice」也必须先预览确认，点「确认更新」才真正执行
  await view.press({ text: '更新 1 个对话到 alice' })
  assert.equal(switchAllCalls, 0)
  assert.ok(view.find({ text: /确认更新旧账号对话到 alice/ }))
  await view.press({ text: '确认更新' })

  assert.equal(switchAllCalls, 1)
  assert.equal(lastSwitchTarget, 'acc-2')
  // 正常状态下顶栏不堆砌多余「已对齐」或「已全同步」噪音
  assert.equal(view.findAll({ text: '已对齐' }).length, 0)
  assert.equal(view.findAll({ text: /已全同步/ }).length, 0)
  assert.ok(view.find({ text: '已切到 alice，原地换号 1 个' }))
  assert.ok(
    view.find({ text: 'stty sane; agy --conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d' })
  )

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('面板「对话」Tab 支持宿主共号对话框定位与单点换号，区分托管独立号并在首页提醒独立通道隔离', async () => {
  const base = makeSnapshot()
  let restartedSessionKey: string | null = null
  let locatedWorktreeId: string | null = null
  let current = makeSnapshot({
    currentEmail: 'alice@example.com',
    activeAccountId: 'acc-2',
    selectedAccountId: 'acc-2',
    desiredEmail: 'alice@example.com',
    accounts: base.accounts,
    outdatedCount: 0,
    acpOutdatedCount: 1,
    chatBackendMode: 'host-agy',
    terminals: [
      {
        pid: 801,
        processKind: 'acp',
        terminalId: null,
        worktreeId: 'folder:ws-geo',
        workspaceName: 'GEO · master',
        title: '检查页面“最”字',
        conversationId: null,
        authEmail: 'bob@example.com',
        commandPreview: 'agy acp --dangerously-skip-permissions',
        canRestartInPlace: true,
        restartBlockedReason: null,
        isExternal: false,
        agentState: 'working',
        isOutdated: true,
        queuedTargetEmail: null,
        startedAtText: 'Sun Nov 22 20:00:00 2026',
        orcaSessionId: 'chat-1',
        chatEngine: 'host-agy'
      },
      {
        pid: 802,
        processKind: 'acp',
        terminalId: null,
        worktreeId: 'folder:ws-geo',
        workspaceName: 'GEO · master',
        title: '独立托管对话',
        conversationId: null,
        authEmail: null,
        commandPreview: 'agy_acp_server.par',
        canRestartInPlace: false,
        restartBlockedReason: 'Orca 独立账号对话（不受本面板换号影响）',
        isExternal: false,
        agentState: 'done',
        isOutdated: false,
        queuedTargetEmail: null,
        startedAtText: 'Sun Nov 22 20:05:00 2026',
        orcaSessionId: 'chat-2',
        chatEngine: 'orca-managed'
      }
    ]
  })

  const host = mockHost({
    requests: {
      'switcher.getState': () => current,
      'switcher.focusTerminal': (input: { worktreeId?: string }) => {
        locatedWorktreeId = input.worktreeId ?? null
        return { focused: true }
      },
      'switcher.restartOne': (input: { sessionKey?: string }) => {
        restartedSessionKey = input.sessionKey ?? null
        current = {
          ...current,
          updatedAt: Date.now() + 10,
          acpOutdatedCount: 0,
          terminals: current.terminals.filter((t) => t.pid !== 801)
        }
        return current
      }
    }
  })
  const view = await mount(panel, { host })

  // 1) 仅有对话框旧号（outdatedCount=0, acpOutdatedCount=1）时，首页也直接提供一键「更新 1 个对话到 alice」按钮
  assert.ok(view.find({ type: 'Button', text: '更新 1 个对话到 alice' }))

  // 2) 点顶部「一键选余量最多账号」：不会因 outdatedCount=0 误判“无需切换”，而是展开确认框把对话框纳入排队处理
  await view.press({ text: '一键选余量最多账号' })
  assert.ok(view.find({ text: /1 个忙中对话将/ }))
  assert.ok(view.find({ text: /额度用完时不会自动替你选号/ }))
  assert.ok(view.find({ text: /1 个独立账号对话不受本次切换影响/ }))
  await view.press({ text: '取消' })

  // 3) 切换到「对话 (2)」Tab：验证对话框定位按钮 + 单点立即切换（二次确认防误触）
  await view.select({ label: '视图切换' }, 'terminals')
  assert.ok(view.find({ text: '对话框 (2)' }))
  assert.ok(view.find({ text: '检查页面“最”字' }))
  assert.ok(view.find({ text: '独立托管对话' }))
  assert.ok(view.find({ text: '独立账号' }))
  assert.equal(view.findAll({ type: 'Button', text: '结束' }).length, 0)

  const locateButtons = view.findAll({ type: 'Button', text: '定位' })
  assert.equal(locateButtons.length, 2)
  await view.press(locateButtons[0]!)
  assert.equal(locatedWorktreeId, 'folder:ws-geo')

  // 正在回复的旧账号对话框提供「立即切到当前号」，首次点击变「确认切换」，二次点击执行
  await view.press({ type: 'Button', text: '立即切到当前号' })
  assert.equal(restartedSessionKey, null)
  await view.press({ type: 'Button', text: '确认切换' })
  assert.equal(restartedSessionKey, 'acp:chat-1')

  // 4) 当电脑处于独立单账号模式（orca-signin）时，首页最顶部直接弹出醒目设置引导横幅
  current = {
    ...current,
    updatedAt: Date.now() + 30,
    chatBackendMode: 'orca-managed',
    chatIsolationReason: 'orca-signin'
  }
  await view.press({ label: '刷新账号额度与终端' })
  assert.ok(view.find({ type: 'Callout', text: /当前「对话框」未关联多账号池/ }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('过期旧快照去红警并标注快照时间、副池识别过期、未读新号与异常号均可手动选中切入', async () => {
  const now = Date.now()
  const snap = makeSnapshot({
    updatedAt: now,
    accountsUpdatedAt: now - 30_000,
    outdatedCount: 0,
    terminals: [],
    accounts: [
      {
        id: 'acc-active',
        email: 'alice@example.com',
        label: null,
        isActive: true,
        isSelected: true,
        status: 'ok',
        sessionUsedPercent: 1,
        sessionResetsAt: now + 4 * 3600_000,
        weeklyUsedPercent: 7,
        weeklyResetsAt: now + 6 * 86400_000,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 1,
            sessionResetsAt: now + 4 * 3600_000,
            weeklyUsedPercent: 7,
            weeklyResetsAt: now + 6 * 86400_000
          }
        ],
        terminalCount: 0,
        usageUpdatedAt: now - 30_000
      },
      {
        id: 'acc-expired-100',
        email: 'bob@example.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'ok',
        sessionUsedPercent: 100,
        sessionResetsAt: now - 15 * 3600_000,
        weeklyUsedPercent: 68,
        weeklyResetsAt: now + 5 * 86400_000,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 100,
            sessionResetsAt: now - 15 * 3600_000,
            weeklyUsedPercent: 68,
            weeklyResetsAt: now + 5 * 86400_000
          },
          {
            group: 'Claude and GPT models',
            sessionUsedPercent: 100,
            sessionResetsAt: now - 15 * 3600_000,
            weeklyUsedPercent: 50,
            weeklyResetsAt: now + 5 * 86400_000
          }
        ],
        terminalCount: 0,
        usageUpdatedAt: now - 16 * 3600_000
      },
      {
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
      },
      {
        id: 'acc-err',
        email: 'broken@gmail.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'error',
        sessionUsedPercent: 10,
        sessionResetsAt: now + 3600_000,
        weeklyUsedPercent: 20,
        weeklyResetsAt: now + 3 * 86400_000,
        buckets: [],
        terminalCount: 0,
        usageUpdatedAt: now - 2 * 3600_000
      }
    ]
  })

  const host = mockHost({
    requests: {
      'switcher.getState': () => snap
    }
  })
  const view = await mount(panel, { host })

  // 1) 主池已重置窗口：清晰标注「已重置」+「切换后更新」+ 单卡更新时间，去掉拗口的「已过重置/上轮100%」
  assert.ok(view.find({ text: /5h 已重置/ }))
  assert.ok(view.find({ text: '切换后更新' }))
  assert.ok(view.find({ text: '更新于 16小时前' }))
  assert.equal(view.findAll({ text: /已可重置/ }).length, 0)
  assert.equal(view.findAll({ text: /已过重置/ }).length, 0)

  // 2) 副池 Claude/GPT 5h 已重置同步识别
  assert.ok(view.find({ text: '5h 已重置 · 周 50%' }))

  // 3) 未读取新号与异常号：均不锁死，展示清晰 Badge 并全部提供可点击「切换」
  assert.ok(view.find({ text: '未读取' }))
  assert.ok(view.find({ text: '尚未读取额度，切换到此账号后自动更新' }))
  assert.ok(view.find({ text: '读取异常' }))
  assert.equal(view.findAll({ type: 'Button', text: '账号异常' }).length, 0)

  // 3 个非当前账号（已重置号、未读取号、异常号）均应提供可点击的「切换」按钮
  const switchButtons = view.findAll({ type: 'Button', text: '切换' })
  assert.equal(switchButtons.length, 3)

  // 4) 点击已重置 100% 账号的「切换」直接就地展开确认框：不误报「⚠ 5h已满」，带更新时间
  await view.press(switchButtons[0]!)
  assert.equal(view.findAll({ text: /5h已满/ }).length, 0)
  assert.ok(view.find({ text: /16小时前更新/ }))
  await view.press({ type: 'Button', text: '取消' })

  // 5) 点击未读新号的「切换」直接展开确认框：确认框正常提示未读且允许点击「确认切换」
  const refreshedSwitchBtns = view.findAll({ type: 'Button', text: '切换' })
  await view.press(refreshedSwitchBtns[1]!)
  assert.ok(view.find({ text: /尚未读取额度，切换后自动更新/ }))
  assert.ok(view.find({ type: 'Button', text: '确认切换' }))
  await view.press({ type: 'Button', text: '取消' })

  // 6) 点击异常号的「切换」直接展开确认框：给出异常提示但按钮文案变为「仍要切换」且不被禁用
  const errSwitchBtns = view.findAll({ type: 'Button', text: '切换' })
  await view.press(errSwitchBtns[2]!)
  assert.ok(view.find({ text: /上次读取额度异常/ }))
  assert.ok(view.find({ type: 'Button', text: '仍要切换' }))
  await view.press({ type: 'Button', text: '取消' })

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('跨模型池隔离：顶层汇总为 Claude/GPT 93% 时，Gemini 周与确认框严格展示 Gemini 28% 且副池带重置倒计时', async () => {
  const now = new Date(2026, 10, 24, 23, 0, 0).getTime()
  const gem5hReset = now + (2 * 60 + 35) * 60_000
  const gemWeekReset = now + ((6 * 24 + 5) * 60 + 10) * 60_000
  const claudeWeekReset = now + ((4 * 24 + 16) * 60 + 14) * 60_000
  const claude5hReset = now + 4 * 3600_000

  const snap = makeSnapshot({
    updatedAt: now,
    accountsUpdatedAt: now - 120_000,
    currentEmail: 'alice@example.com',
    activeAccountId: 'acc-active',
    selectedAccountId: 'acc-active',
    desiredEmail: 'alice@example.com',
    outdatedCount: 0,
    terminals: [],
    accounts: [
      {
        id: 'acc-active',
        email: 'alice@example.com',
        label: null,
        isActive: true,
        isSelected: true,
        status: 'ok',
        // 模拟 Orca 顶层跨池取最严汇总：5h 来自 Gemini (48%)，周来自 Claude/GPT (93%)
        sessionUsedPercent: 48,
        sessionResetsAt: gem5hReset,
        weeklyUsedPercent: 93,
        weeklyResetsAt: claudeWeekReset,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 48,
            sessionResetsAt: gem5hReset,
            weeklyUsedPercent: 28,
            weeklyResetsAt: gemWeekReset
          },
          {
            group: 'Claude and GPT models',
            sessionUsedPercent: 0,
            sessionResetsAt: claude5hReset,
            weeklyUsedPercent: 93,
            weeklyResetsAt: claudeWeekReset
          }
        ],
        terminalCount: 2,
        usageUpdatedAt: now - 120_000
      },
      {
        id: 'acc-claude-full',
        email: 'dana@example.com',
        label: null,
        isActive: false,
        isSelected: false,
        status: 'ok',
        // 反向串值测试：顶层 session 为 100%（Claude 5h 满），但 Gemini 5h 仅 18%
        sessionUsedPercent: 100,
        sessionResetsAt: claude5hReset,
        weeklyUsedPercent: 90,
        weeklyResetsAt: claudeWeekReset,
        buckets: [
          {
            group: 'Gemini Models',
            sessionUsedPercent: 18,
            sessionResetsAt: gem5hReset,
            weeklyUsedPercent: 22,
            weeklyResetsAt: gemWeekReset
          },
          {
            group: 'Claude and GPT models',
            sessionUsedPercent: 100,
            sessionResetsAt: claude5hReset,
            weeklyUsedPercent: 90,
            weeklyResetsAt: claudeWeekReset
          }
        ],
        terminalCount: 0,
        usageUpdatedAt: now - 600_000
      }
    ]
  })

  const host = mockHost({
    requests: {
      'switcher.getState': () => snap
    }
  })
  const view = await mount(panel, { host })

  // 1) 主池必须严格显示 Gemini 周 28%（6天5时），绝不能把 Claude/GPT 周 93% 错标为 Gemini 周 93%
  assert.ok(view.find({ text: 'Gemini 5h 48%' }))
  assert.ok(view.find({ text: 'Gemini 周 28%' }))
  assert.ok(view.find({ text: /6天5时10分/ }))
  assert.equal(view.findAll({ text: /Gemini 周 93%/ }).length, 0)

  // 2) 副池清晰展示 5h 0% · 周 93% 以及自己的周重置倒计时
  assert.ok(view.find({ text: 'Claude/GPT' }))
  assert.ok(view.find({ text: '5h 0% · 周 93%' }))
  assert.ok(view.find({ text: /周重置\s+4天16时14分/ }))

  // 3) 点击 Claude 5h=100% 但 Gemini 5h=18% 账号的「切换」直接展开确认框：不误报 5h已满，且分别展示主池与副池
  await view.press({ type: 'Button', text: '切换' })
  assert.ok(view.find({ text: /Gemini 5h 18% · 周 22%/ }))
  assert.equal(view.findAll({ text: /5h已满/ }).length, 0)
  assert.ok(view.find({ text: /Claude\/GPT 5h 100% · 周 90%/ }))
  await view.press({ type: 'Button', text: '取消' })

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('发现新版本时展示一键更新横幅，支持点击立即升级及新权限命令兜底', async () => {
  let current = makeSnapshot({
    outdatedCount: 0,
    terminals: [],
    pluginVersion: '0.2.9',
    updateInfo: {
      currentVersion: '0.2.9',
      latestVersion: '0.3.0',
      pluginKey: 'github.lyezhucc.agy-account-switcher',
      sourceKind: 'git',
      canOneClickUpdate: true
    }
  })
  let applyCalls = 0
  let shouldRequireApproval = true

  const host = mockHost({
    requests: {
      'switcher.getState': () => current,
      'switcher.applyUpdate': () => {
        applyCalls += 1
        if (shouldRequireApproval) {
          const cmd =
            'orca plugin update github.lyezhucc.agy-account-switcher --approve sha256-xyz='
          current = {
            ...current,
            updatedAt: Date.now() + 10,
            updateInfo: {
              ...current.updateInfo!,
              approvalCommand: cmd
            }
          }
          return {
            status: 'approval_required' as const,
            message: '此版本申请了新权限',
            approvalCommand: cmd
          }
        }
        current = {
          ...current,
          updatedAt: Date.now() + 20,
          pluginVersion: '0.3.0',
          updateInfo: null
        }
        return {
          status: 'updated' as const,
          newVersion: '0.3.0',
          message: '已更新到最新版本 v0.3.0'
        }
      }
    }
  })

  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Callout', text: /发现新版本 v0\.3\.0/ }))
  assert.ok(view.find({ text: '当前版本 v0.2.9，点击即可自动升级。' }))
  assert.ok(view.find({ type: 'Button', text: '立即更新' }))

  // 1) 若遇到需要新权限审批的大版本，自动在横幅内展示完整可复制命令
  await view.press({ type: 'Button', text: '立即更新' })
  assert.equal(applyCalls, 1)
  assert.ok(
    view.find({
      text: 'orca plugin update github.lyezhucc.agy-account-switcher --approve sha256-xyz='
    })
  )

  // 2) 常规免审版本一键更新完成：清除新版本提示并弹出「更新完成」
  shouldRequireApproval = false
  current = {
    ...current,
    updatedAt: Date.now() + 15,
    updateInfo: {
      currentVersion: '0.2.9',
      latestVersion: '0.3.0',
      pluginKey: 'github.lyezhucc.agy-account-switcher',
      sourceKind: 'git',
      canOneClickUpdate: true
    }
  }
  await view.press({ label: '刷新账号额度与终端' })
  await view.press({ type: 'Button', text: '立即更新' })
  assert.equal(applyCalls, 2)
  assert.equal(view.findAll({ type: 'Callout', text: /发现新版本 v0\.3\.0/ }).length, 0)
  assert.ok(view.find({ type: 'Callout', text: /更新完成/ }))
  assert.ok(view.find({ text: '已更新到最新版本 v0.3.0' }))

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
