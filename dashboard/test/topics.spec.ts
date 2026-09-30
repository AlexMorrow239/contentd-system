import { test, expect, resetFixture } from './fixtures'
import { seedTopic } from '../../daemon/testing/db'

test.beforeEach(({ dashboard }) => resetFixture(dashboard))

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
