import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { inspectBrowserDemo, loadBrowserDemo, signInDemo } from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] || 'http://localhost:5199')
await inspectBrowserDemo(demo)
mkdirSync('scripts/shots', { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1560, height: 940 } })
const logs = []
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e}`))
page.on('console', (m) => logs.push(`${m.type().toUpperCase()}: ${m.text()}`))
page.on('requestfailed', (r) => logs.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText}`))

await page.goto(`${demo.base}/app/~/board/all`)
await page.waitForSelector('input[type=email]', { timeout: 20000 })
await page.screenshot({ path: 'scripts/shots/dbg-1-initial.png' })
console.log('--- after load:')
console.log(logs.join('\n') || '(no logs)')

const hasEmail = await page.locator('input[type=email]').count()
console.log('email inputs:', hasEmail)
if (hasEmail) {
  logs.length = 0
  await signInDemo(page, demo)
  await page.waitForSelector('[data-card]', { timeout: 30000 })
  await page.screenshot({ path: 'scripts/shots/dbg-2-after-signin.png' })
  console.log('--- after sign-in click:')
  console.log(logs.join('\n') || '(no logs)')
  const bodyText = (await page.locator('body').innerText()).slice(0, 600)
  console.log('--- body text:')
  console.log(bodyText)
}
await browser.close()
