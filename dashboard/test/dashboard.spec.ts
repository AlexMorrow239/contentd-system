import { actionsUnit } from '../../daemon/src/features/actions/worker'
import { channelToml, writeChannelsDir } from '../../daemon/testing/channel'
import { seedAction, seedDaemonState } from '../../daemon/testing/db'
import { expect, resetFixture, test } from './fixtures'

test.beforeEach(({ dashboard }) => resetFixture(dashboard))

test('overview shows the global default and optional channel limits', async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.url)
  await expect(page.getByRole('row', { name: /^Global / })).toContainText('$25.00')
  await expect(page.getByRole('row', { name: /^chan-a / })).toContainText('Global limit only')
  await expect(page.getByText('Includes estimated usage costs.')).toBeVisible()
  const original = channelToml({ name: 'chan-a', platforms: ['youtube', 'tiktok'] })
  try {
    writeChannelsDir(
      { 'chan-a.toml': original + 'per_day_usd = 10\n' },
      dashboard.paths.channelsDir,
    )
    await page.reload()
    await expect(page.getByRole('row', { name: /^chan-a / })).toContainText('$10.00')
  } finally {
    writeChannelsDir({ 'chan-a.toml': original }, dashboard.paths.channelsDir)
  }
})

test('all pages, navigation, filters and job details work', async ({ page, dashboard }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const [path, heading] of [
    ['/', 'Overview'],
    ['/post', 'Post'],
    ['/topics', 'Topics'],
    ['/actions', 'Actions'],
    ['/jobs', 'Jobs'],
  ]) {
    await page.goto(dashboard.url + path)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  await page.getByRole('combobox', { name: 'Job status', exact: true }).selectOption('failed')
  await expect(page.getByText('Recover this job')).toBeVisible()
  await expect(page.getByText('A video to post')).toHaveCount(0)
  await page.getByRole('link', { name: 'job-failed', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Stages', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('inline submission failures do not enqueue', async ({ page, dashboard }) => {
  await page.goto(dashboard.url + '/post')
  const platform = page.locator('.post-platform').first()
  seedDaemonState(dashboard.db, { lastSeenAt: new Date(0) })
  await platform.getByRole('button', { name: 'mark posted', exact: true }).click()
  await expect(platform.getByRole('alert')).toContainText('nothing was queued')
  expect(dashboard.db.prepare('SELECT * FROM operator_actions').all()).toHaveLength(0)
})

test('polling preserves the video element, then shows completion', async ({ page, dashboard }) => {
  const id = seedAction(dashboard.db, { kind: 'digest.run', args: '{}' })
  await page.goto(`${dashboard.url}/post?action=${id}`)
  const video = page.locator('video').first()
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).readyState))
    .toBeGreaterThan(0)
  await video.evaluate((v) => {
    v.dataset.identity = 'preserve-me'
    ;(v as HTMLVideoElement).currentTime = 4
  })
  await expect
    .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(3)
  dashboard.db
    .prepare("UPDATE operator_actions SET status='done', result='finished' WHERE id=?")
    .run(id)
  await expect(page.getByText('finished', { exact: true })).toBeVisible()
  await expect(video).toHaveAttribute('data-identity', 'preserve-me')
  expect(await video.evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(3)
})

test('posting and unmarking work without a live-link input', async ({ page, dashboard }) => {
  const tick = actionsUnit(dashboard.db, 'fast', {
    channelsDir: dashboard.paths.channelsDir,
    runsRoot: dashboard.paths.runsRoot,
  })
  await page.goto(dashboard.url + '/post')
  const platform = page.locator('.post-platform').first()
  await expect(page.getByLabel('Live link (optional)')).toHaveCount(0)
  await platform.getByRole('button', { name: 'mark posted', exact: true }).click()
  await expect(page).toHaveURL(/action=\d+/)
  await tick()
  await expect(page.getByRole('heading', { name: 'youtube — posted', exact: true })).toBeVisible()
  expect(dashboard.db.prepare('SELECT url FROM posts').get()).toEqual({ url: null })
  await page.getByRole('button', { name: 'unmark…', exact: true }).click()
  await page.getByRole('button', { name: 'unmark', exact: true }).click()
  await expect(page).toHaveURL(/\/post\?action=\d+/)
  await tick()
  await expect(page.getByRole('heading', { name: 'youtube — posted', exact: true })).toHaveCount(0)
  expect(dashboard.db.prepare('SELECT * FROM posts').all()).toHaveLength(0)
})

test('untrusted links stay inert and clipboard falls back to selection', async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.url + '/topics')
  await expect(page.getByText('<script>untrusted topic</script>', { exact: true })).toBeVisible()
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0)
  await page.goto(dashboard.url + '/post')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  })
  await page.getByRole('button', { name: 'Copy', exact: true }).first().click()
  await expect(page.getByText('Select and copy the text manually')).toBeVisible()
  await expect(page.locator('textarea').first()).toBeFocused()
})

test('video route supports seeking and refuses traversal', async ({ request, dashboard }) => {
  const response = await request.get(dashboard.url + '/library/job-video/video', {
    headers: { range: 'bytes=0-99' },
  })
  expect(response.status()).toBe(206)
  expect(response.headers()['content-range']).toMatch(/^bytes 0-99\//)
  expect((await response.body()).length).toBe(100)
  dashboard.db.prepare("UPDATE library SET video_path='/etc/passwd' WHERE job_id='job-video'").run()
  expect((await request.get(dashboard.url + '/library/job-video/video')).status()).toBe(403)
})

test('failed actions retain their recovery notice', async ({ page, dashboard }) => {
  const id = seedAction(dashboard.db, { status: 'pending' })
  await page.goto(`${dashboard.url}/actions?action=${id}`)
  dashboard.db
    .prepare(
      "UPDATE operator_actions SET status='failed', error='Interrupted', notice='Resume job-recovery', error_kind='internal' WHERE id=?",
    )
    .run(id)
  await expect(page.getByText('Resume job-recovery').first()).toBeVisible()
  await expect(page.getByText('Interrupted (internal)').first()).toBeVisible()
})

test('responsive layout stays within the viewport', async ({ page, dashboard }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(dashboard.url + '/post')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(dashboard.url)
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true })
})
