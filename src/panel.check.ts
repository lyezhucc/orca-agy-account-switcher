// `orca plugin check` 与 `orca plugin shot --scenario` 多场景 UI 验收配置。
import type { JsonValue } from 'orca'
import { defineCheck } from 'orca/testing'
import type { SwitcherSnapshot } from './protocol'

const now = Date.now()

const syncedSnapshot: SwitcherSnapshot = {
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
      sessionResetsAt: now - 3600_000,
      weeklyUsedPercent: 68,
      weeklyResetsAt: now + (5 * 24 + 18) * 3600_000 + 14 * 60_000,
      buckets: [
        {
          group: 'Gemini Models',
          sessionUsedPercent: 100,
          sessionResetsAt: now - 3600_000,
          weeklyUsedPercent: 68,
          weeklyResetsAt: now + (5 * 24 + 18) * 3600_000 + 14 * 60_000
        },
        {
          group: 'Claude and GPT models',
          sessionUsedPercent: 0,
          sessionResetsAt: now + 3600_000,
          weeklyUsedPercent: 50,
          weeklyResetsAt: now + 6 * 86400_000
        }
      ],
      terminalCount: 0,
      usageUpdatedAt: now - 16 * 3600_000
    },
    {
      id: 'acc-2',
      email: 'alice@example.com',
      label: null,
      isActive: true,
      isSelected: true,
      status: 'ok',
      sessionUsedPercent: 48,
      sessionResetsAt: now + 2 * 3600_000 + 35 * 60_000,
      weeklyUsedPercent: 93,
      weeklyResetsAt: now + (4 * 24 + 16) * 3600_000 + 14 * 60_000,
      buckets: [
        {
          group: 'Gemini Models',
          sessionUsedPercent: 48,
          sessionResetsAt: now + 2 * 3600_000 + 35 * 60_000,
          weeklyUsedPercent: 28,
          weeklyResetsAt: now + (6 * 24 + 5) * 3600_000 + 10 * 60_000
        },
        {
          group: 'Claude and GPT models',
          sessionUsedPercent: 0,
          sessionResetsAt: now + 4 * 3600_000,
          weeklyUsedPercent: 93,
          weeklyResetsAt: now + (4 * 24 + 16) * 3600_000 + 14 * 60_000
        }
      ],
      terminalCount: 2,
      usageUpdatedAt: now - 60_000
    },
    {
      id: 'acc-3',
      email: 'charlie@example.com',
      label: null,
      isActive: false,
      isSelected: false,
      status: 'ok',
      sessionUsedPercent: 0,
      sessionResetsAt: now + 4 * 3600_000 + 55 * 60_000,
      weeklyUsedPercent: 5,
      weeklyResetsAt: now + (5 * 24 + 20) * 3600_000 + 43 * 60_000,
      buckets: [],
      terminalCount: 0,
      usageUpdatedAt: now - 2 * 3600_000
    }
  ],
  terminals: [
    {
      pid: 1001,
      processKind: 'cli',
      terminalId: 'term_aaa',
      worktreeId: 'repo1::/work/web-app',
      workspaceName: 'web-app',
      title: '重构登录模块',
      conversationId: '2a455d74-2c13-49f0-94e7-1e6979bba5cb',
      authEmail: 'alice@example.com',
      commandPreview: 'agy --dangerously-skip-permissions --conversation 2a455d74-2c13-49f0-94e7-1e6979bba5cb',
      canRestartInPlace: true,
      restartBlockedReason: null,
      isExternal: false,
      agentState: 'working',
      isOutdated: false,
      queuedTargetEmail: null,
      startedAtText: 'Sun Nov 22 17:27:47 2026'
    },
    {
      pid: 1002,
      processKind: 'cli',
      terminalId: 'term_bbb',
      worktreeId: 'repo2::/work/data-tools',
      workspaceName: 'data-tools',
      title: '分析接口性能',
      conversationId: 'f1cb546d-0145-4c7d-9d45-06d78b3ae946',
      authEmail: 'alice@example.com',
      commandPreview: 'agy --dangerously-skip-permissions',
      canRestartInPlace: true,
      restartBlockedReason: null,
      isExternal: false,
      agentState: 'idle',
      isOutdated: false,
      queuedTargetEmail: null,
      startedAtText: 'Sun Nov 22 17:30:27 2026'
    }
  ],
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
  error: null,
  isPreview: true
}

const outdatedAlertSnapshot: SwitcherSnapshot = {
  ...syncedSnapshot,
  outdatedCount: 1,
  acpOutdatedCount: 1,
  queuedCount: 1,
  chatBackendMode: 'host-agy',
  pluginVersion: '0.2.9',
  updateInfo: {
    currentVersion: '0.2.9',
    latestVersion: '0.3.0',
    pluginKey: 'github.lyezhucc.agy-account-switcher',
    sourceKind: 'git',
    canOneClickUpdate: true
  },
  accounts: syncedSnapshot.accounts.map((a) => (a.id === 'acc-1' ? { ...a, terminalCount: 2 } : a)),
  terminals: [
    {
      pid: 16920,
      processKind: 'cli',
      terminalId: 'term_old_docs',
      worktreeId: 'repo3::/work/docs-site',
      workspaceName: 'docs-site',
      title: '继续',
      conversationId: '8ecc012e-da64-42e5-b8ac-3a0affc1213d',
      authEmail: 'bob@example.com',
      commandPreview: 'agy --dangerously-skip-permissions --conversation 8ecc012e-da64-42e5-b8ac-3a0affc1213d',
      canRestartInPlace: true,
      restartBlockedReason: null,
      isExternal: false,
      agentState: 'idle',
      isOutdated: true,
      queuedTargetEmail: null,
      startedAtText: 'Sat Nov 21 21:37:46 2026'
    },
    {
      ...syncedSnapshot.terminals[0]!,
      queuedTargetEmail: 'charlie@example.com'
    },
    {
      pid: 28801,
      processKind: 'acp',
      terminalId: null,
      worktreeId: 'repo3::/work/docs-site',
      workspaceName: 'docs-site · main',
      title: '检查页面文案',
      conversationId: null,
      authEmail: 'bob@example.com',
      commandPreview: 'agy acp --dangerously-skip-permissions',
      canRestartInPlace: true,
      restartBlockedReason: null,
      isExternal: false,
      agentState: 'working',
      isOutdated: true,
      queuedTargetEmail: 'alice@example.com',
      startedAtText: 'Sun Nov 22 18:10:00 2026',
      orcaSessionId: '6e29f04e-5ff0-4b8a-91c5-ed4aadab7a33',
      chatEngine: 'host-agy'
    }
  ],
  lastOperation: {
    at: now - 5000,
    targetEmail: 'alice@example.com',
    restartedCount: 3,
    queuedCount: 1,
    skippedCount: 0,
    failedCount: 0,
    rolledBackCount: 0,
    message: '已切换到 alice，已同步 3 个对话，1 个忙中对话等说完跟进新号',
    details: [
      '✓ web-app · 继续吧（对话框已同步到新号，发消息即续接）',
      '⏳ docs-site · 检查页面文案（正在回复，等当前回复结束后跟进同步到已选新号）'
    ],
    recoveryCommands: []
  }
}

const driftAlertSnapshot: SwitcherSnapshot = {
  ...outdatedAlertSnapshot,
  currentEmail: 'bob@example.com',
  activeAccountId: 'acc-1',
  drift: {
    expectedAccountId: 'acc-2',
    expectedEmail: 'alice@example.com',
    actualEmail: 'bob@example.com',
    detectedAt: now
  }
}

export default defineCheck({
  synced: {
    storage: { __previewSnapshot: syncedSnapshot as unknown as JsonValue }
  },
  outdatedAlert: {
    storage: { __previewSnapshot: outdatedAlertSnapshot as unknown as JsonValue }
  },
  driftAlert: {
    storage: { __previewSnapshot: driftAlertSnapshot as unknown as JsonValue }
  }
})
