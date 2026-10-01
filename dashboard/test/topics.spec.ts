import { test, expect, resetFixture } from './fixtures'
import { seedTopic } from '../../daemon/testing/db'

test.beforeEach(({ dashboard }) => resetFixture(dashboard))

test('Topic summaries open source details and quick actions stay in place', async ({
  page,
  dashboard,
}) => {
  const id = seedTopic(dashboard.db, {
    title: 'A source-backed topic',
    rawTitle: 'Original headline',
    reason: 'Detailed scoring explanation',
  })
  dashboard.db.prepare('UPDATE topics SET source_context_json = ? WHERE id = ?').run(
    JSON.stringify({
      version: 1,
      title: 'Original headline',
      body: 'Original post text.\n\n<script>source data</script>',
      author: 'writer',
      publishedAt: '2026-09-30T12:00:00Z',
      sourceId: 'reddit:r/test',
      externalId: 't3_example',
      url: 'https://example.com/post',
      targetUrl: null,
      fetchedAt: '2026-10-01T12:00:00Z',
    }),
    id,
  )
  await page.goto(dashboard.url + '/topics?status=candidate')
  const row = page.getByRole('row').filter({ hasText: 'A source-backed topic' })
  await expect(row).toContainText('Post body saved')
  await expect(row).not.toContainText('Detailed scoring explanation')
  await expect(row.getByRole('button', { name: 'reject', exact: true })).toBeVisible()
  await row.getByRole('link', { name: 'A source-backed topic' }).click()
  await expect(page.getByRole('heading', { name: `Topic #${id}`, exact: true })).toBeVisible()
  await expect(page.getByText('Detailed scoring explanation')).toBeVisible()
  await expect(page.getByText('Original headline', { exact: true })).toBeVisible()
  await expect(
    page.locator('.topic-body').filter({ hasText: 'Original post text.' }),
  ).toContainText('<script>source data</script>')
  await page.getByRole('link', { name: 'Back to topics' }).click()
  await expect(page).toHaveURL(dashboard.url + '/topics?status=candidate')
  await row.getByRole('button', { name: 'reject', exact: true }).click()
  await expect(page).toHaveURL(dashboard.url + '/topics?status=candidate')
  await expect(row).toContainText('Action queued / running')
  await expect(row.getByRole('button', { name: 'reject', exact: true })).toBeDisabled()
  const action = dashboard.db
    .prepare('SELECT kind, args FROM operator_actions ORDER BY id DESC LIMIT 1')
    .get() as { kind: string; args: string }
  expect(action.kind).toBe('topics.reject')
  expect(JSON.parse(action.args)).toEqual({ ids: [id] })
  await page.screenshot({ path: 'test-results/topics-summary.png', fullPage: true })
})

test('Topic details handle missing source data, unsafe links and invalid IDs', async ({
  page,
  dashboard,
}) => {
  const row = dashboard.db.prepare('SELECT id FROM topics LIMIT 1').get() as { id: number }
  await page.goto(`${dashboard.url}/topics/${row.id}?from=https://evil.example`)
  await expect(page.getByRole('link', { name: 'Back to topics' })).toHaveAttribute(
    'href',
    '/topics',
  )
  await expect(page.getByText('No source snapshot saved for this topic.')).toBeVisible()
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  for (const id of ['invalid', '999999999']) {
    const response = await page.goto(`${dashboard.url}/topics/${id}`)
    expect(response?.status()).toBe(404)
  }
})

test('Topics shares immediate persistent filters with Jobs and keeps separate preferences', async ({
  page,
  browser,
  dashboard,
}) => {
  seedTopic(dashboard.db, { title: 'Ocean discovery', channel: 'ocean', status: 'rejected' })
  seedTopic(dashboard.db, { title: 'Ocean candidate', channel: 'ocean' })
  await page.goto(dashboard.url + '/jobs?status=failed')
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Topics', exact: true })
    .click()
  await page.getByRole('combobox', { name: 'Channel', exact: true }).selectOption('ocean')
  await page.getByRole('combobox', { name: 'Topic status', exact: true }).selectOption('rejected')
  await page.getByRole('searchbox', { name: 'Search topics' }).fill('DISCOVERY')
  await expect(page).toHaveURL(/q=DISCOVERY&channel=ocean&status=rejected/)
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole('searchbox', { name: 'Search topics' })).toHaveValue('DISCOVERY')
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Jobs', exact: true })
    .click()
  await expect(page).toHaveURL(dashboard.url + '/jobs?status=failed')
  const reopened = await browser.newContext({ storageState: await page.context().storageState() })
  try {
    const fresh = await reopened.newPage()
    await fresh.goto(dashboard.url + '/topics')
    await expect(fresh).toHaveURL(/q=DISCOVERY&channel=ocean&status=rejected/)
    await fresh.goto(dashboard.url + '/topics?status=candidate')
    await expect(fresh.getByRole('combobox', { name: 'Channel', exact: true })).toHaveValue('')
    await expect(fresh.getByRole('combobox', { name: 'Topic status', exact: true })).toHaveValue(
      'candidate',
    )
    await fresh.getByRole('button', { name: 'Clear filters' }).click()
    await expect(fresh).toHaveURL(dashboard.url + '/topics')
    await fresh.reload()
    await expect(fresh.locator('tbody tr')).toHaveCount(3)
  } finally {
    await reopened.close()
  }
})

test('Topics filters work without storage and reset pagination on change', async ({
  page,
  dashboard,
}) => {
  for (let i = 0; i < 51; i++)
    seedTopic(dashboard.db, { title: `Searchable topic ${i}`, score: 100 - i })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('Storage disabled')
      },
    })
  })
  await page.goto(dashboard.url + '/topics?q=Searchable')
  await expect(page.locator('tbody tr')).toHaveCount(50)
  await expect(page.locator('tbody tr').first()).toContainText('Searchable topic 0')
  await page.getByRole('link', { name: 'Next page' }).click()
  await expect(page).toHaveURL(/q=Searchable&page=2/)
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.getByRole('searchbox', { name: 'Search topics' }).fill('topic 50')
  await expect(page).toHaveURL(dashboard.url + '/topics?q=topic+50')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/topics-mobile.png', fullPage: true })
})
