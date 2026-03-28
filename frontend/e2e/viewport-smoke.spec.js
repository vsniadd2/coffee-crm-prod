import { test, expect } from '@playwright/test'

/** Матрица ширин из плана проверки адаптивности */
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
]

/** Альбомная ориентация на «планшетной» ширине */
const LANDSCAPE = { width: 768, height: 390 }

function assertNoDocHorizontalOverflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement
    const body = document.body
    const docDelta = d.scrollWidth - d.clientWidth
    const bodyDelta = body ? body.scrollWidth - body.clientWidth : 0
    return { docDelta, bodyDelta, scrollWidth: d.scrollWidth, clientWidth: d.clientWidth }
  })
}

test.describe('viewport: страница входа', () => {
  for (const vp of VIEWPORTS) {
    test(`нет лишнего горизонтального скролла документа (${vp.width}×${vp.height})`, async ({ page }) => {
      await page.setViewportSize(vp)
      await page.goto('/', { waitUntil: 'domcontentloaded' })
      await page.locator('.login-page').waitFor({ state: 'visible', timeout: 15_000 })
      const r = await assertNoDocHorizontalOverflow(page)
      expect(
        r.docDelta,
        `documentElement scrollWidth=${r.scrollWidth} clientWidth=${r.clientWidth}`
      ).toBeLessThanOrEqual(1)
      expect(r.bodyDelta, 'body overflow').toBeLessThanOrEqual(1)
    })
  }

  test('альбом 768×390: нет лишнего горизонтального скролла', async ({ page }) => {
    await page.setViewportSize(LANDSCAPE)
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.locator('.login-page').waitFor({ state: 'visible', timeout: 15_000 })
    const r = await assertNoDocHorizontalOverflow(page)
    expect(r.docDelta).toBeLessThanOrEqual(1)
    expect(r.bodyDelta).toBeLessThanOrEqual(1)
  })
})
