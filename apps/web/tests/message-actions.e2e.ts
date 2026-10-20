// Web e2e scenario: message IconActions + clocks. Cold-seeds a deterministic
// two-turn transcript (zero model calls), pins that the settled assistant row
// carries copy and react beside its timing/token reading, and forks through the
// session-row action — the surface package jsdom tests cannot substitute for
// (docs/testing.md snapshot rule).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/message-actions', import.meta.url))
// Borrowed read-only: this scenario needs any settled user+assistant pair, not
// a new recording (workspace-management / sidebar-scrollbar pattern).
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const FORK_EXPECTED = join(SNAPSHOT_DIR, 'fork.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'message-actions-web-e2e'

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'
const MID_TURN_TEXT = 'I will read both files before answering.'
const SECOND_PROMPT = 'Now give the final answer.'

/**
 * Adapt the borrowed recording into response -> tools -> interrupted Think,
 * followed by one ordinary completed response. The first response keeps
 * copy/clock but is not a legal branch point; the second is the real turn tail.
 * @param raw - Recorded seeded-history JSONL.
 * @returns A contiguous, closed two-turn fixture.
 */
function completedTailFixture(raw: string): string {
  const kept: string[] = []
  for (const line of raw.trimEnd().split('\n')) {
    const row = JSON.parse(line) as {
      type: string
      seq?: number
      seq0?: number
      data?: { content?: unknown[] }
    }
    const firstSeq = row.seq ?? row.seq0
    if (firstSeq !== undefined && firstSeq >= 101) break
    if (row.type === 'assistant/message' && row.seq === 64) {
      const content = row.data?.content
      if (!Array.isArray(content)) throw new Error('borrowed step-one assistant message has no content')
      content.splice(1, 0, { type: 'text', text: MID_TURN_TEXT })
      kept.push(JSON.stringify(row))
    } else {
      kept.push(line)
    }
  }
  const tail = [
    { type: 'step/end', seq: 101, time: 1784974102749, data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 102, time: 1784974102750, data: { turn: 1, reason: { kind: 'aborted' } } },
    { type: 'turn/start', seq: 103, time: 1784974103000, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user', rpcId: '{{rpcId}}' } } } },
    { type: 'user/message', seq: 104, time: 1784974103001, data: { content: [{ type: 'text', text: SECOND_PROMPT }], source: { kind: 'user', rpcId: '{{rpcId}}' } }, surfaceOp: 'append' },
    { type: 'step/start', seq: 105, time: 1784974103002, data: { turn: 2, step: 1 } },
    { type: 'assistant/message', seq: 106, time: 1784974103003, data: { turn: 2, step: 1, content: [{ type: 'text', text: 'DONE' }], provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, sourceEventSeqs: [], surfaceOp: 'append' },
    { type: 'step/end', seq: 107, time: 1784974103004, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: 108, time: 1784974103005, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  return `${[...kept, ...tail.map(row => JSON.stringify(row))].join('\n')}\n`
}

describe('web e2e: message IconActions and clocks on settled history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    const raw = completedTailFixture(await readFile(SEED, 'utf8'))
    expect(fixtureUserPrompts(raw), 'adapted seed must carry both prompts').toEqual([PROMPT, SECOND_PROMPT])
    await seedSession(scaffold, raw, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('keeps copy as the only control on the settled message row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-actions'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(MID_TURN_TEXT, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // Focus-reveal the footers (hover:hover keeps them opacity-hidden until
    // hover/focus-within). Every message row carries copy and react; nothing
    // else does.
    const copyButtons = page.getByRole('button', { name: 'Copy' })
    await expect.poll(() => copyButtons.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(4)
    await copyButtons.first().focus()
    // The assistant footer row: copy and react beside the timing/token reading.
    const row = page.locator('[data-turn-tail] div[class*="actions"]').last()
    await expect.poll(() => row.getByRole('button', { name: 'Copy' }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => row.getByRole('button', { name: 'React' }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => row.locator('button').count(), { timeout: 5_000 }).toBe(2)
    await expect.poll(() => row.getByText(/Ran for|TTFT|tok\/s/u).count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
    // Neither removed affordance survives anywhere in the transcript.
    await expect.poll(() => page.getByRole('button', { name: 'Branch into a new conversation' }).count(), {
      timeout: 5_000,
    }).toBe(0)
    await expect.poll(
      () => page.getByRole('button', { name: /^(Good response|Bad response|Remove rating)$/u }).count(),
      { timeout: 5_000 },
    ).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: 'Edit' }).count(), { timeout: 5_000 }).toBe(0)
  }, 60_000)

  it.skipIf(MODE === 'record')('matches the conversation aria golden with IconActions and clocks', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-actions-aria'))
    await page.getByRole('button', { name: /^Select model, current/ })
      .waitFor({ timeout: 10_000 })
    await page.getByText(/Cache hit \d+%/u).first().waitFor({ timeout: 10_000 })
    // Keep a footer focused so opacity-hidden actions stay in the a11y tree
    // as an active/focused control during the capture.
    await page.getByRole('button', { name: 'Copy' }).first().focus()
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('forks through the session-row action', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-fork'))
    // The session row owns the only remaining fork action: message rows no
    // longer offer one.
    const sourceRow = page.locator('[role="treeitem"][aria-selected="true"]')
    const rowBox = await sourceRow.boundingBox()
    if (rowBox === null) throw new Error('fork source row has no layout box')
    const actionButton = sourceRow.locator('button[aria-label^="Session actions for "]')
    await sourceRow.hover({ position: { x: rowBox.width - 16, y: rowBox.height / 2 } })
    await expect.poll(() => actionButton.isVisible(), { timeout: 2_000 }).toBe(true)
    const buttonBox = await actionButton.boundingBox()
    if (buttonBox === null) throw new Error('fork source row action has no layout box')
    await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
    await page.getByRole('menuitem', { name: 'Fork session' }).click()
    await expect.poll(
      () => scaffold.ctx.agents.list().filter(agent => agent.session.header.parentSession !== undefined).length,
      { timeout: 15_000 },
    ).toBe(1)
    await expect.poll(
      () => page.locator('[role="treeitem"]').count(),
      { timeout: 10_000 },
    ).toBe(3)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    // The child row is published before its inherited title rename settles;
    // wait for that second RPC projection before freezing the ARIA tree.
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').textContent(),
      { timeout: 10_000 },
    ).toContain('Use the read tool twice (2)')
    const tree = await captureStableAria(
      page,
      '[role="tree"][aria-label="Sessions"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(FORK_EXPECTED, tree, MODE)
  })

  it.skipIf(MODE === 'record')('issued zero model calls and kept a closed inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['fork.expected.md', 'ui.expected.md'])
  })
})
