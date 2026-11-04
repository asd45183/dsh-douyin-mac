#!/usr/bin/env node
/**
 * 抖音网页版资料编辑（昵称 / 简介 / 头像）。
 *
 * 用法：
 *   node scripts/profile-edit.mjs --nickname "新昵称" --bio "新简介"
 *   node scripts/profile-edit.mjs --avatar /path/to/avatar.png --nickname "新昵称" --apply
 *
 * 默认预演（只填/只预览，不保存）。只有显式 --apply 才会点保存。
 * 依赖专用 Chrome 在 9227 端口运行（插件里点“打开抖音”）。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../node_modules/', import.meta.url))
const { chromium } = require('playwright-core')

const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined }
const nickname = option('nickname')
const bio = option('bio')
const avatar = option('avatar')
const apply = args.includes('--apply')
const endpoint = option('endpoint') || 'http://127.0.0.1:9227'
const profileUrl = 'https://www.douyin.com/user/self?from_tab_name=main'

const fail = message => { console.error(JSON.stringify({ ok: false, error: message })); process.exit(1) }
if (!nickname && !bio && !avatar) fail('至少提供 --nickname、--bio 或 --avatar')
if (nickname !== undefined && (nickname.trim() === '' || nickname.length > 20)) fail('昵称必须是 1–20 个字符')
if (avatar !== undefined && !fs.existsSync(avatar)) fail(`头像文件不存在：${avatar}`)

const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 }).catch(() => fail(`无法连接专用 Chrome（${endpoint}）；请先点插件里的“打开抖音”`))
const page = browser.contexts().flatMap(context => context.pages()).find(item => /^https:\/\/www\.douyin\.com/.test(item.url()))
if (!page) { await browser.close().catch(() => {}); fail('没有找到抖音页面') }

const close = () => browser.close().catch(() => {})
const visible = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
// 点击最上层、可被鼠标命中的按钮（弹窗叠层时只认真正能点到的那个）。
const clickTopText = async buttonText => page.evaluate(text => {
  const usable = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' }
  const hit = element => { const rect = element.getBoundingClientRect(); const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return top === element || element.contains(top) }
  const candidates = [...document.querySelectorAll('button,div[role="button"],span')].filter(element => usable(element) && (element.innerText || '').trim() === text && hit(element))
  const target = candidates[candidates.length - 1]
  if (!target) return false
  target.click(); return true
}, buttonText).catch(() => false)

await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(3000)
const pencil = page.locator('[data-e2e="user-info"] span[role="img"]').first()
if (!await pencil.count()) { await close(); fail('没有找到“编辑资料”入口，可能未登录或页面结构变化') }
await pencil.click({ timeout: 8000 }).catch(() => {})
const nicknameInput = page.locator('input[placeholder="记得填写昵称"]').first()
await nicknameInput.waitFor({ timeout: 10_000 }).catch(() => { close(); fail('编辑资料弹窗没有出现') })
const before = await nicknameInput.inputValue().catch(() => '')

// 1) 先填昵称/简介（此时弹窗没有遮挡）。
if (nickname !== undefined) {
  await nicknameInput.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.type(nickname.trim(), { delay: 30 })
}
let bioFilled = false
if (bio !== undefined) {
  const editor = page.locator('div[contenteditable="true"]').first()
  if (!await editor.count()) { await close(); fail('没有找到简介输入框') }
  await editor.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.type(bio.trim(), { delay: 20 })
  bioFilled = true
}

// 2) 头像：上传后会出现预览弹窗；预演只截图，保存时才点该弹窗的“保存”。
let avatarPreview = false, avatarSaved = false, avatarMessage = ''
if (avatar !== undefined) {
  const fileInput = page.locator('input[type=file]').first()
  if (!await fileInput.count()) { await close(); fail('没有找到头像上传控件') }
  await fileInput.setInputFiles(avatar)
  avatarPreview = await page.getByText('头像预览', { exact: false }).first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)
  if (!avatarPreview) { await close(); fail('头像预览没有出现，可能文件格式不支持') }
  await page.waitForTimeout(1200)
  await page.screenshot({ path: '/tmp/douyin-avatar-preview.png' })
  if (apply) {
    if (!await clickTopText('保存')) { await close(); fail('没有找到头像弹窗的保存按钮') }
    await page.waitForTimeout(3500)
    const text = await visible()
    if (/身份验证|接收短信验证码/.test(text)) {
      avatarSaved = false
      avatarMessage = '头像已提交，但抖音触发了身份验证；需要短信验证码完成后才会生效。'
    } else {
      avatarSaved = true
      avatarMessage = /审核/.test(text) ? '头像已提交，等待平台审核后展示。' : '头像已提交保存。'
    }
    await page.screenshot({ path: '/tmp/douyin-avatar-saved.png' })
  } else {
    await clickTopText('取消')
    await page.waitForTimeout(800)
  }
}

await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/douyin-profile-edit-preview.png' })
let saved = false, message = '预演完成：已填入但未保存。'
if (apply) {
  if (nickname === undefined && bio === undefined) {
    saved = avatarSaved
    message = avatarMessage || '已提交保存。'
  } else {
    const save = page.getByRole('button', { name: '保存', exact: true }).last()
    if (!await save.count()) { await close(); fail('没有找到“保存”按钮') }
    await save.click({ timeout: 8000 })
    await page.waitForTimeout(4000)
    const text = await visible()
    if (/身份验证|接收短信验证码/.test(text)) {
      saved = false
      message = '资料修改触发了抖音身份验证；需要短信验证码完成后才会生效。'
    } else {
      saved = (nickname === undefined || text.includes(nickname.trim())) && (bio === undefined || text.includes(bio.trim()))
      message = [avatarMessage, saved ? '昵称/简介已保存并回读。' : '昵称/简介已点保存，但未在页面确认到新内容，请打开浏览器核对。'].filter(Boolean).join(' ')
    }
    await page.screenshot({ path: '/tmp/douyin-profile-edit-result.png' })
  }
} else {
  // 预演后把头像预览和编辑弹窗都关掉，避免下次运行被残留弹窗挡住。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stillOpen = await page.evaluate(() => /编辑资料|头像预览/.test(document.body.innerText || ''))
    if (!stillOpen) break
    const clicked = await page.evaluate(() => {
      const vis = element => { const rect = element.getBoundingClientRect(), style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' }
      const buttons = [...document.querySelectorAll('button,div[role="button"],span')].filter(element => vis(element) && (element.innerText || '').trim() === '取消')
      const target = buttons[buttons.length - 1]
      if (!target) return false
      target.click(); return true
    }).catch(() => false)
    if (!clicked) break
    await page.waitForTimeout(900)
  }
}
await close()
console.log(JSON.stringify({ ok: true, applied: apply, saved, before, nickname: nickname ?? null, bioFilled, bio: bio ?? null, avatar: avatar ?? null, avatarPreview, avatarSaved, message, screenshots: apply ? ['/tmp/douyin-profile-edit-result.png'] : ['/tmp/douyin-profile-edit-preview.png', ...(avatar ? ['/tmp/douyin-avatar-preview.png'] : [])] }, null, 2))
