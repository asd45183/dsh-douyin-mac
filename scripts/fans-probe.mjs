#!/usr/bin/env node
/**
 * 抖音粉丝列表只读探针。
 *
 * 目的：在实现“自动回关”之前，确认网页版能否读到——粉丝列表本身、每个粉丝的稳定
 * 用户 id（/user/<id>）、行内按钮文案（关注 / 已关注 / 相互关注）、以及滚动后是否还有更多。
 *
 * 只读：会打开个人页并在需要时点开“粉丝”面板，但**不会点击任何关注按钮**，
 * 也不会读取私信、修改设置或写入任何状态文件。
 *
 * 用法：
 *   node scripts/fans-probe.mjs                 # 只读探针，默认滚动 3 次
 *   node scripts/fans-probe.mjs --scrolls 0     # 不滚动，只看首屏
 *   node scripts/fans-probe.mjs --endpoint http://127.0.0.1:9227 --limit 30
 *
 * 依赖专用 Chrome 在 9227 端口运行（插件里点“打开抖音”）。
 */
import { createRequire } from 'node:module'

const require = createRequire(new URL('../node_modules/', import.meta.url))
const { chromium } = require('playwright-core')

const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined }
const endpoint = option('endpoint') || 'http://127.0.0.1:9227'
const limit = Math.max(1, Math.min(100, Number(option('limit') || 20)))
const scrolls = Math.max(0, Math.min(10, Number(option('scrolls') ?? 3)))
const profileUrl = 'https://www.douyin.com/user/self?from_tab_name=main'

const report = value => console.log(JSON.stringify(value, null, 2))
const fail = message => { report({ ok: false, error: message }); process.exit(1) }

const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 })
  .catch(() => fail(`无法连接专用 Chrome（${endpoint}）；请先在插件里点“打开抖音”`))

const close = () => browser.close().catch(() => {})
const page = browser.contexts().flatMap(context => context.pages())
  .find(item => /^https:\/\/www\.douyin\.com/.test(item.url()))
if (!page) { await close(); fail('没有找到抖音页面；请先在插件里点“打开抖音”') }

const blockers = () => page.evaluate(() => ({
  loginRequired: Boolean(document.querySelector('[data-e2e="login-panel"],[data-e2e="login-modal"]')) || /扫码登录|手机号登录/.test(document.body.innerText || ''),
  verificationRequired: Boolean(document.getElementById('captcha_container')) || /请完成下列验证|拖动滑块/.test(document.body.innerText || ''),
}))

/**
 * 读取粉丝列表容器与行。只读，不点击任何按钮。
 * 真实结构（2026-11 实测）：[data-e2e="user-fans-container"] > div > div.OlxToPIh，
 * 每行含 a[href*="/user/"]（稳定 id）与一个主按钮（回关 / 相互关注）+ 一个“移除”按钮；
 * 列表末尾有“暂时没有更多了”。
 */
const readRows = () => page.evaluate(() => {
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const roots = [...document.querySelectorAll('[data-e2e="user-fans-container"],[data-e2e="follow-list"],[data-e2e="following-list"]')].filter(visible)
  const seen = new Set(), rows = []
  for (const root of roots) {
    // 行是“直接含 /user/ 链接的块”，不依赖混淆类名；主按钮文案决定关系状态。
    const blocks = [...root.querySelectorAll('div')].filter(block => visible(block)
      && block.querySelector('a[href*="/user/"]')
      && block.querySelector('button'))
    for (const block of blocks) {
      const link = block.querySelector('a[href*="/user/"]')
      const href = link.getAttribute('href') || ''
      const userId = (/\/user\/([^/?#]+)/.exec(href) || [])[1] || null
      if (!userId || seen.has(userId)) continue
      seen.add(userId)
      const name = (block.querySelector('.Zce7SWd3')?.textContent || link.textContent || '').trim().slice(0, 60)
      const buttons = [...block.querySelectorAll('button')].map(button => (button.textContent || '').trim()).filter(Boolean)
      const relation = buttons.find(label => ['回关', '已关注', '相互关注'].includes(label)) || ''
      rows.push({ userId, href: href.replace(/^https?:/, ''), name, relation, buttons: [...new Set(buttons)].slice(0, 6) })
    }
  }
  const text = (document.body.innerText || '').replace(/\s+/g, ' ')
  const counters = (() => {
    const following = /关注 (\d+(?:\.\d+)?万?)/.exec(text), fans = /粉丝 (\d+(?:\.\d+)?万?)/.exec(text)
    return { following: following?.[1] || null, fans: fans?.[1] || null }
  })()
  return { containers: roots.length, rows, counters, end: /暂时没有更多了/.test(text) }
})

/** 滚动列表容器，触发懒加载；只读。 */
const scrollList = () => page.evaluate(() => {
  const roots = [...document.querySelectorAll('[data-e2e="user-fans-container"],[data-e2e="follow-list"],[data-e2e="following-list"]')]
    .filter(element => element.scrollHeight > element.clientHeight + 4)
  for (const root of roots) root.scrollTop = root.scrollHeight
  if (!roots.length) window.scrollTo(0, document.body.scrollHeight)
  return roots.length
})

await page.bringToFront().catch(() => {})
await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {})

/** 页面诊断：给选择器对不上时用，只读。 */
const diagnose = () => page.evaluate(() => ({
  url: location.href,
  title: document.title,
  visibility: document.visibilityState,
  focus: document.hasFocus(),
  htmlLength: document.body?.innerHTML?.length || 0,
  hasFansText: /粉丝/.test(document.body.innerText || ''),
  hooks: [...new Set([...document.querySelectorAll('[data-e2e]')].map(element => element.getAttribute('data-e2e')))].slice(0, 120),
  counts: (() => {
    const text = (document.body.innerText || '').replace(/\s+/g, ' ');
    const match = /粉丝\s*(\d+(?:\.\d+)?万?)/.exec(text);
    return match ? match[1] : null;
  })(),
}))

// 个人页是 SPA：等到“粉丝”入口真正出现再点，最多 15 秒。
let waited = 0
for (; waited < 15_000; waited += 500) {
  const ready = await page.evaluate(() => Boolean(document.querySelector('[data-e2e="user-info-fans"]')))
  if (ready) break
  await page.waitForTimeout(500)
}
const diagnostics = await diagnose()

const initialBlockers = await blockers()
if (initialBlockers.loginRequired || initialBlockers.verificationRequired) {
  await close()
  report({ ok: false, stage: 'profile', blockers: initialBlockers, error: '个人页需要登录或验证，探针未继续。' })
  process.exit(1)
}

// 打开“粉丝”面板：优先 data-e2e 钩子，其次按文案找可点的入口；点不开也只报告，不硬找。
const opened = await page.evaluate(() => {
  const usable = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }
  const hooked = document.querySelector('[data-e2e="user-info-fans"]')
  if (hooked && usable(hooked)) { hooked.click(); return { via: 'user-info-fans', ok: true } }
  const candidates = [...document.querySelectorAll('a,button,div,span')]
    .filter(element => usable(element) && /^粉丝\s*\d*/.test((element.textContent || '').trim()))
  const target = candidates[candidates.length - 1]
  if (target) { target.click(); return { via: 'text', ok: true } }
  return { via: null, ok: false }
})
// 等粉丝面板真正出现（点开是懒加载，可能再点一次才展开）。
let panelOpened = false
for (let attempt = 0; attempt < 10; attempt += 1) {
  const present = await page.evaluate(() => {
    const root = document.querySelector('[data-e2e="user-fans-container"]')
    if (!root) return false
    const rect = root.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  if (present) { panelOpened = true; break }
  await page.evaluate(() => document.querySelector('[data-e2e="user-info-fans"]')?.click())
  await page.waitForTimeout(600)
}

const first = await readRows()
for (let index = 0; index < scrolls; index += 1) {
  await scrollList()
  await page.waitForTimeout(700)
}
const last = await readRows()
const afterBlockers = await blockers()
const snapshot = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
}))

await close()
report({
  ok: last.rows.length > 0,
  probe: 'fans-read-only',
  endpoint,
  profile: snapshot,
  fansEntry: { ...opened, panelOpened },
  containers: last.containers,
  rows: last.rows.slice(0, limit),
  counts: { firstRead: first.rows.length, afterScroll: last.rows.length, scrolledToEnd: last.scrolledToEnd, counters: last.counters, end: last.end },
  fields: {
    stableUserId: last.rows.every(row => /^[A-Za-z0-9_-]{6,}$/.test(row.userId || '')),
    followBackButton: last.rows.some(row => row.relation === '回关'),
    relations: [...new Set(last.rows.map(row => row.relation))].filter(Boolean),
  },
  blockers: afterBlockers,
  diagnostics,
  note: last.rows.length ? '只读探针完成：未点击任何关注按钮。' : '没有读到粉丝列表；上面的 diagnostics 是真实 DOM 结构（hooks/文本/等待时长），据此调整选择器。',
})
