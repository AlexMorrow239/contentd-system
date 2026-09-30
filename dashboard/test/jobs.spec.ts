import { test, expect, resetFixture } from './fixtures'
import { seedAction, seedDaemonState, seedJob, seedPost } from '../../daemon/testing/db'
import { actionsUnit } from '../../daemon/src/loop/actions-worker'
import { existsSync } from 'node:fs'

test.beforeEach(({ dashboard }) => resetFixture(dashboard))

test('Post uses the same delete modal and retirement operation', async ({ page, dashboard }) => {
  const tick = actionsUnit(dashboard.db, 'fast', {
    channelsDir: dashboard.paths.channelsDir,
    runsRoot: dashboard.paths.runsRoot,
  })
  await page.goto(dashboard.url + '/post')
  await expect(page.getByRole('button', { name: 'discard', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'delete', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('A video to post')
  await expect(dialog).toContainText('job-video')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(dashboard.db.prepare('SELECT * FROM operator_actions').all()).toHaveLength(0)
  await page.getByRole('button', { name: 'delete', exact: true }).click()
  await dialog.getByRole('button', { name: 'delete', exact: true }).click()
  await expect(page).toHaveURL(/\/post\?action=/)
  expect(dashboard.db.prepare('SELECT kind FROM operator_actions').get()).toEqual({
    kind: 'jobs.delete',
  })
  await tick()
  await expect(
    page.getByText('Nothing to post — no ready videos with unposted platforms.'),
  ).toBeVisible()
  expect(existsSync(dashboard.videoPath)).toBe(true)
})

test('fully posted jobs have one removal action that retains the local video', async ({
  page,
  dashboard,
}) => {
  for (const platform of ['youtube', 'tiktok'])
    seedPost(dashboard.db, { jobId: 'job-video', platform })
  const tick = actionsUnit(dashboard.db, 'fast', {
    channelsDir: dashboard.paths.channelsDir,
    runsRoot: dashboard.paths.runsRoot,
  })
  await page.goto(dashboard.url + '/jobs?posting=full')
  const row = page.getByRole('row').filter({ hasText: 'A video to post' })
  await expect(row.getByRole('button')).toHaveCount(1)
  await row.getByRole('button', { name: 'delete', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(
    'Recorded costs and local artifacts are kept',
  )
  await page.getByRole('dialog').getByRole('button', { name: 'delete', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await tick()
  await expect(row).toHaveCount(0)
  expect(dashboard.db.prepare('SELECT * FROM library').all()).toHaveLength(0)
  expect(dashboard.db.prepare('SELECT * FROM posts').all()).toHaveLength(0)
  expect(existsSync(dashboard.videoPath)).toBe(true)
})

test('resume queues in one click on rows and details, without changing filters', async ({
  page,
  dashboard,
}) => {
  seedJob(dashboard.db, 'another-failed', { topic: 'Another recovery', status: 'failed' })
  await page.goto(dashboard.url + '/jobs?status=failed')
  const first = page.getByRole('row').filter({ hasText: 'Recover this job' })
  await first.getByRole('button', { name: 'resume', exact: true }).click()
  await expect(first).toHaveCount(0)
  await expect(page).toHaveURL(dashboard.url + '/jobs?status=failed')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'job-failed' })).toContainText('Queued')
  await page
    .getByRole('row')
    .filter({ hasText: 'Another recovery' })
    .getByRole('button', { name: 'resume', exact: true })
    .click()
  await expect(page.getByText('No jobs match these filters.')).toBeVisible()
  expect(
    dashboard.db.prepare("SELECT * FROM operator_actions WHERE kind='jobs.resume'").all(),
  ).toHaveLength(2)
  await page.goto(dashboard.url + '/jobs/job-failed')
  await expect(page.getByRole('button', { name: 'resume', exact: true })).toHaveCount(0)
  await expect(page.locator('dd .status-queued')).toBeVisible()
  dashboard.db
    .prepare("UPDATE operator_actions SET status='failed', error='Worker unavailable'")
    .run()
  await page.reload()
  await page.getByRole('button', { name: 'resume', exact: true }).click()
  await expect(page.locator('dd .status-queued')).toBeVisible()
})

test('delete requires its modal and preserves focus, filters, and cancellation', async ({
  page,
  dashboard,
}) => {
  const tick = actionsUnit(dashboard.db, 'fast', {
    channelsDir: dashboard.paths.channelsDir,
    runsRoot: dashboard.paths.runsRoot,
  })
  await page.goto(dashboard.url + '/jobs?status=failed')
  const trigger = page.getByRole('button', { name: 'delete', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Recover this job')
  await expect(dialog).toContainText('job-failed')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'delete', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  expect(dashboard.db.prepare('SELECT * FROM operator_actions').all()).toHaveLength(0)
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(dashboard.db.prepare('SELECT * FROM operator_actions').all()).toHaveLength(0)
  await trigger.click()
  await dialog.getByRole('button', { name: 'delete', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeDisabled()
  expect(dashboard.db.prepare('SELECT kind, lane FROM operator_actions').get()).toEqual({
    kind: 'jobs.delete',
    lane: 'fast',
  })
  await tick()
  await expect(page.getByText('No jobs match these filters.')).toBeVisible()
  await expect(page).toHaveURL(dashboard.url + '/jobs?status=failed')
})

test('review icons approve and delete without a separate screen', async ({ page, dashboard }) => {
  dashboard.db.prepare("UPDATE library SET state='needs-review'").run()
  const tick = actionsUnit(dashboard.db, 'fast', {
    channelsDir: dashboard.paths.channelsDir,
    runsRoot: dashboard.paths.runsRoot,
  })
  await page.goto(dashboard.url + '/jobs?review=needs-review')
  await page.getByRole('button', { name: 'approve', exact: true }).click()
  await expect(page.getByRole('button', { name: 'delete', exact: true })).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: 'Queued approve' })).toBeVisible()
  await tick()
  await expect(page.getByText('No jobs match these filters.')).toBeVisible()
  await page.getByRole('combobox', { name: 'Video review', exact: true }).selectOption('ready')
  await page.getByRole('button', { name: 'delete', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'delete', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await tick()
  await expect(page.getByText('No jobs match these filters.')).toBeVisible()
  expect(dashboard.db.prepare('SELECT * FROM library').all()).toEqual([])
  expect(
    dashboard.db.prepare("SELECT deleted_at FROM jobs WHERE id='job-video'").get(),
  ).toMatchObject({ deleted_at: expect.any(String) })
})

test('filters persist through navigation, reload, and browser sessions until cleared', async ({
  page,
  browser,
  dashboard,
}) => {
  await page.goto(dashboard.url + '/jobs')
  await page.getByRole('combobox', { name: 'Job status', exact: true }).selectOption('failed')
  await expect(page).toHaveURL(/status=failed/)
  await page.getByRole('link', { name: 'job-failed', exact: true }).click()
  await page.getByRole('link', { name: 'Back to jobs', exact: true }).click()
  await expect(page).toHaveURL(/status=failed/)
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Post', exact: true })
    .click()
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Jobs', exact: true })
    .click()
  await expect(page).toHaveURL(/status=failed/)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Job status', exact: true })).toHaveValue(
    'failed',
  )
  const storageState = await page.context().storageState()
  const reopened = await browser.newContext({ storageState })
  try {
    const fresh = await reopened.newPage()
    await fresh.goto(dashboard.url + '/jobs')
    await expect(fresh).toHaveURL(/status=failed/)
    await fresh.goto(dashboard.url + '/jobs?status=done')
    await expect(fresh.getByRole('combobox', { name: 'Job status', exact: true })).toHaveValue(
      'done',
    )
    await fresh.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expect(fresh).toHaveURL(dashboard.url + '/jobs')
    await fresh.reload()
    await expect(fresh.getByText('Recover this job', { exact: true })).toBeVisible()
    await expect(fresh.getByText('A video to post', { exact: true })).toBeVisible()
  } finally {
    await reopened.close()
  }
})

test('search and combined filters work when local storage is unavailable', async ({
  page,
  dashboard,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('Storage disabled')
      },
    })
  })
  await page.goto(dashboard.url + '/jobs')
  await page.getByRole('searchbox', { name: 'Search jobs' }).fill('RECOVER')
  await expect(page.getByText('A video to post', { exact: true })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Job status', exact: true }).selectOption('failed')
  await expect(page).toHaveURL(/q=RECOVER.*status=failed/)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByText('A video to post', { exact: true })).toBeVisible()
})

test('details consolidate QC, video, and all posting history; old pages redirect', async ({
  page,
  dashboard,
}) => {
  dashboard.db
    .prepare('UPDATE library SET qc_json=?')
    .run(JSON.stringify({ checks: [{ name: 'duration', passed: false, detail: 'Too short' }] }))
  seedPost(dashboard.db, {
    jobId: 'job-video',
    platform: 'instagram',
    url: null,
    postedAt: '2026-09-01T12:00:00.000Z',
  })
  await page.goto(dashboard.url + '/library?state=ready&channel=chan-a')
  await expect(page).toHaveURL(/\/jobs\?.*review=ready/)
  await page.goto(dashboard.url + '/posts')
  await expect(page).toHaveURL(/\/jobs\?posting=has-posts/)
  await page.getByRole('link', { name: 'job-video', exact: true }).click()
  await expect(page.getByText('duration: Too short')).toBeVisible()
  await expect(page.locator('video')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Posting history' })).toBeVisible()
  await expect(page.getByText('No link saved', { exact: true })).toBeVisible()
  await expect(page.getByText('instagram', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'delete', exact: true })).toBeVisible()
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^(Posts|Library)$/ }),
  ).toHaveCount(0)
})

test('pagination preserves filters and returns from details to the exact page', async ({
  page,
  dashboard,
}) => {
  for (let i = 0; i < 51; i++)
    seedJob(dashboard.db, `page-job-${String(i).padStart(2, '0')}`, {
      status: 'failed',
      topic: `Paged recovery ${i}`,
    })
  await page.goto(dashboard.url + '/jobs?status=failed')
  await page.getByRole('link', { name: 'Next page' }).click()
  await expect(page).toHaveURL(/status=failed&page=2/)
  await expect(page.locator('tbody tr')).toHaveCount(2)
  await page.locator('tbody tr').first().getByRole('link').first().click()
  await page.getByRole('link', { name: 'Back to jobs', exact: true }).click()
  await expect(page).toHaveURL(/status=failed&page=2/)
  dashboard.db.prepare("UPDATE jobs SET status='done'").run()
  await page.reload()
  await expect(page).toHaveURL(dashboard.url + '/jobs?status=failed')
})

test('row submission failures stay local and active actions prevent conflicting clicks', async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.url + '/jobs?status=failed')
  seedDaemonState(dashboard.db, { lastSeenAt: new Date(0) })
  await page.getByRole('button', { name: 'resume', exact: true }).click()
  await expect(
    page.getByRole('row').filter({ hasText: 'Recover this job' }).getByRole('alert'),
  ).toContainText('nothing was queued')
  expect(dashboard.db.prepare('SELECT * FROM operator_actions').all()).toHaveLength(0)
  seedDaemonState(dashboard.db, { lastSeenAt: new Date() })
  seedAction(dashboard.db, { kind: 'jobs.delete', args: '{"jobId":"job-failed"}' })
  await page.reload()
  await expect(page.getByRole('button', { name: 'resume', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'delete', exact: true })).toBeDisabled()
})

test('clearing filters cancels an in-flight filter navigation', async ({ page, dashboard }) => {
  await page.goto(dashboard.url + '/jobs')
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let intercepted = false
  await page.route('**/jobs?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('status') === 'failed') {
      intercepted = true
      await gate
    }
    await route.continue()
  })
  try {
    await page.getByRole('combobox', { name: 'Job status', exact: true }).selectOption('failed')
    await expect.poll(() => intercepted).toBe(true)
    await page.getByRole('button', { name: 'Clear filters' }).click()
  } finally {
    release()
  }
  // No work is active here; wait for the deliberately delayed navigation to settle.
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('link', { name: 'A video to post', exact: true })).toBeVisible()
  await expect(page).toHaveURL(dashboard.url + '/jobs')
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Job status', exact: true })).toHaveValue('')
})

test('in-flight submission locks the row and rapid repeated clicks queue once', async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.url + '/jobs?status=failed')
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/actions', async (route) => {
    await gate
    await route.continue()
  })
  try {
    await page
      .getByRole('button', { name: 'resume', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click()
        button.click()
      })
    await expect(page.getByRole('button', { name: 'delete', exact: true })).toBeDisabled()
  } finally {
    release()
  }
  await expect(page.getByText('No jobs match these filters.')).toBeVisible()
  expect(dashboard.db.prepare('SELECT * FROM operator_actions').all()).toHaveLength(1)
})

test('deleting from details returns to the original filtered list', async ({ page, dashboard }) => {
  const tick = actionsUnit(dashboard.db, 'fast', {
    channelsDir: dashboard.paths.channelsDir,
    runsRoot: dashboard.paths.runsRoot,
  })
  await page.goto(dashboard.url + '/jobs?status=failed')
  await page.getByRole('link', { name: 'job-failed', exact: true }).click()
  await page.getByRole('button', { name: 'delete', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'delete', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await tick()
  await expect(page).toHaveURL(dashboard.url + '/jobs?status=failed')
  await expect(page.getByText('No jobs match these filters.')).toBeVisible()
})

test('Jobs fits narrow viewports and keeps icons reachable with tooltips', async ({
  page,
  dashboard,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(dashboard.url + '/jobs')
  const resume = page.getByRole('button', { name: 'resume', exact: true })
  await resume.focus()
  await expect(page.getByRole('tooltip', { name: 'resume', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/jobs-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(resume).toBeInViewport()
  await page.screenshot({ path: 'test-results/jobs-mobile.png', fullPage: true })
  await resume.click()
  await expect(page.getByRole('status').filter({ hasText: 'Queued resume' })).toBeVisible()
})

test('corrupt stored filters and invalid URL values do not break the list', async ({
  page,
  dashboard,
}) => {
  await page.addInitScript(() => localStorage.setItem('brainrot.jobs.filters.v1', '{broken'))
  await page.goto(dashboard.url + '/jobs')
  await expect(page.getByRole('link', { name: 'A video to post', exact: true })).toBeVisible()
  await page.goto(dashboard.url + '/jobs?status=invalid&review=invalid&posting=invalid&page=-5')
  await expect(page.getByRole('link', { name: 'Recover this job', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Job status', exact: true })).toHaveValue('')
})

test('clicking Jobs while on a filtered list preserves the remembered selection', async ({
  page,
  dashboard,
}) => {
  await page.goto(dashboard.url + '/jobs?status=failed')
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Jobs', exact: true })
    .click()
  await page.waitForLoadState('networkidle')
  await expect(page).toHaveURL(dashboard.url + '/jobs?status=failed')
  await expect(page.getByRole('combobox', { name: 'Job status', exact: true })).toHaveValue(
    'failed',
  )
})

test('Back interrupts a pending filter navigation without leaving stale controls', async ({
  page,
  dashboard,
}) => {
  for (let i = 0; i < 51; i++) seedJob(dashboard.db, `history-job-${i}`, { status: 'failed' })
  await page.goto(dashboard.url + '/jobs?status=failed')
  await page.getByRole('link', { name: 'Next page' }).click()
  await expect(page).toHaveURL(/status=failed&page=2/)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let intercepted = false
  await page.route('**/jobs?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('status') === 'blocked') {
      intercepted = true
      await gate
    }
    await route.continue()
  })
  try {
    await page.getByRole('combobox', { name: 'Job status', exact: true }).selectOption('blocked')
    await expect.poll(() => intercepted).toBe(true)
    await page.evaluate(() => window.history.back())
    await expect(page).toHaveURL(dashboard.url + '/jobs?status=failed')
    await expect(page.getByRole('combobox', { name: 'Job status', exact: true })).toHaveValue(
      'failed',
    )
  } finally {
    release()
  }
  await page.waitForLoadState('networkidle')
  await expect(page.locator('tbody tr')).toHaveCount(50)
})
