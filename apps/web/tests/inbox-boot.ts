// The household inbox API, served to a page by the browser lane.
//
// This deployment's sidebar is the inbox (FORK-NOTES surface 8): one persistent
// row per agent the signed-in person may use, resolved from
// `GET /v1/browser/inbox` on the e-server origin. The browser e2e lane boots the
// harness host alone — there is no e-server behind it — so without a fixture
// every scenario would see the panel's retryable error row and could never open
// a conversation at all (the workspace picker that used to do it is gone).
//
// The fixture answers exactly the three endpoints the plugin calls, with the
// shapes `inbox-api.ts` parses (it refuses a row the server did not spell out,
// so these bodies are the wire contract, not a convenience): the row the test
// clicks, the conversation it resolves to, and an empty channel list. It never
// invents a session: the id it reports must already exist in the host's
// persistence root, which is what makes the click a real open of a real
// conversation over the real transport.
//
// `/v1/browser/inbox/brand.svg` is deliberately NOT served. The mark is a CSS
// mask over an e-server asset, and FORK-NOTES surface 10 records the 404 as
// survivable by design: the mask paints nothing and no exception escapes. A
// stand-in drawing here would prove the fixture, not the product.
import type { Page } from 'playwright'

/** Inbox list path: the caller's rows. */
const LIST_PATH = '**/v1/browser/inbox'
/** Open path: resolve-or-create one (person, agent) conversation. */
const OPEN_PATH = '**/v1/browser/inbox/open'
/** Read-receipt path the panel posts while a row is selected and unread. */
const SEEN_PATH = '**/v1/browser/inbox/seen'
/** Channel list path the panel reads beside the rows. */
const CHANNELS_PATH = '**/v1/browser/inbox/channels'

/** The agent identity one fixture row reports. */
export interface InboxRowTarget {
  /** Agent id the deployment composes (drives the row's test ids). */
  agent: string
  /** Display name the server would return for that agent. */
  name: string
  /** The conversation this (person, agent) pair already owns. */
  sessionId: string
  /** Whether that conversation holds no messages. */
  blank?: boolean
}

/** Install the inbox API onto one page and return the undo.
 * @param page - the page under test.
 * @param rows - the rows the fixture reports, in order.
 * @returns a function that removes every route this fixture installed.
 */
export async function installInboxApi(page: Page, rows: readonly InboxRowTarget[]): Promise<() => Promise<void>> {
  const listBody = {
    person: { id: 'e2e-person', name: 'E2E Person' },
    agents: rows.map(row => ({
      agent: row.agent,
      name: row.name,
      hasConversation: true,
      sessionId: row.sessionId,
      blank: row.blank ?? true,
      // No conversation activity: the row reads as an idle, online agent that
      // is not working, which is the state every scenario boots into.
      lastActivityAt: null,
      running: false,
      enabled: true,
      disabled: false,
      presence: 'online' as const,
      completion: 0,
    })),
  }
  await page.route(LIST_PATH, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listBody) })
  })
  await page.route(OPEN_PATH, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { agent?: string }
    const row = rows.find(candidate => candidate.agent === body.agent)
    if (row === undefined) {
      // A row this fixture never listed: refuse the way the real server would
      // rather than opening a conversation the person was not offered.
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'no such agent row' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agent: row.agent,
        sessionId: row.sessionId,
        created: false,
        blank: row.blank ?? true,
        lastActivityAt: null,
      }),
    })
  })
  await page.route(SEEN_PATH, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.route(CHANNELS_PATH, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"channels":[]}' })
  })
  return async () => {
    await page.unroute(LIST_PATH)
    await page.unroute(OPEN_PATH)
    await page.unroute(SEEN_PATH)
    await page.unroute(CHANNELS_PATH)
  }
}

/**
 * The panel's open control for one row. The row itself is a list item; the
 * button inside it is what a person clicks to restore the conversation.
 * @param row - the agent identity the fixture reported.
 * @returns the Playwright test-id selector of that row's open control.
 */
export function inboxOpenSelector(row: Pick<InboxRowTarget, 'agent'>): string {
  return `[data-testid="ui-inbox-open-${row.agent}"]`
}
