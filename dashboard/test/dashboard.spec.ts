import { test, expect, resetFixture } from './fixtures'
import { seedAction, seedDaemonState } from '../../src/testing/db'
import { actionsUnit } from '../../src/loop/actions-worker'

test.beforeEach(({ dashboard }) => resetFixture(dashboard))

test('all pages, navigation, filters and job details work', async ({ page, dashboard }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const [path, heading] of [
    ['/', 'Overview'],
    ['/post', 'Post'],
    ['/posts', 'Posts'],
    ['/library', 'Library'],
    ['/topics', 'Topics'],
    ['/actions', 'Actions'],
    ['/jobs', 'Jobs'],
  ]) {
    await page.goto(dashboard.url + path)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  await page.getByRole('combobox', { name: 'status', exact: true }).selectOption('failed')
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await expect(page.getByText('Recover this job')).toBeVisible()
  await expect(page.getByText('A video to post')).toHaveCount(0)
  await page.getByRole('link', { name: 'job-failed', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Stages', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('confirmation preserves filters and queues only after explicit submission', async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.url + '/jobs?status=failed')
  await page.getByRole('button', { name: 'resume…', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Confirm: resume' })).toBeVisible()
  expect(dashboard.db.prepare('SELECT * FROM operator_actions').all()).toHaveLength(0)
  await page.getByRole('button', { name: 'resume', exact: true }).click()
  await expect(page).toHaveURL(/\/jobs\?status=failed&action=\d+/)
  expect(dashboard.db.prepare('SELECT kind, status FROM operator_actions').all()).toEqual([
    { kind: 'jobs.resume', status: 'pending' },
  ])
})

test('inline submission failures preserve input and do not enqueue', async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.url + '/post')
  const platform = page.locator('.post-platform').first()
  const input = platform.getByLabel('Live link (optional)')
  await input.fill('https://example.com/my-video')
  seedDaemonState(dashboard.db, { lastSeenAt: new Date(0) })
  await platform.getByRole('button', { name: 'mark posted', exact: true }).click()
  await expect(platform.getByRole('alert')).toContainText('nothing was queued')
  await expect(input).toHaveValue('https://example.com/my-video')
  expect(dashboard.db.prepare('SELECT * FROM operator_actions').all()).toHaveLength(0)
})

test('polling preserves draft input and the video element, then shows completion', async ({
  page,
  dashboard,
}) => {
  const id = seedAction(dashboard.db, { kind: 'digest.run', args: '{}' })
  await page.goto(`${dashboard.url}/post?action=${id}`)
  const input = page.getByLabel('Live link (optional)').first()
  await input.fill('https://example.com/draft')
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
  await expect(input).toHaveValue('https://example.com/draft')
  await expect(video).toHaveAttribute('data-identity', 'preserve-me')
  expect(await video.evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(3)
})

test('posting and unmarking run through the worker and show saved links', async ({
  page,
  dashboard,
}) => {
  const tick = actionsUnit(dashboard.db, 'fast', {
    channelsDir: dashboard.paths.channelsDir,
    runsRoot: dashboard.paths.runsRoot,
  })
  await page.goto(dashboard.url + '/post')
  const platform = page.locator('.post-platform').first()
  await platform.getByLabel('Live link (optional)').fill('https://example.com/live')
  await platform.getByRole('button', { name: 'mark posted', exact: true }).click()
  await expect(page).toHaveURL(/action=\d+/)
  await tick()
  await expect(page.getByRole('link', { name: 'https://example.com/live ↗' })).toBeVisible()
  await page.getByRole('button', { name: 'unmark…', exact: true }).click()
  await page.getByRole('button', { name: 'unmark', exact: true }).click()
  await expect(page).toHaveURL(/\/post\?action=\d+/)
  await tick()
  await expect(page.getByRole('link', { name: 'https://example.com/live ↗' })).toHaveCount(0)
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

test('clearing filters updates both the rows and the selected controls', async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.url + '/jobs?status=failed')
  const status = page.getByRole('combobox', { name: 'status', exact: true })
  await expect(status).toHaveValue('failed')
  await page.getByRole('link', { name: 'Clear', exact: true }).click()
  await expect(page).toHaveURL(dashboard.url + '/jobs')
  await expect(page.getByText('A video to post', { exact: true })).toBeVisible()
  await expect(status).toHaveValue('')
})
