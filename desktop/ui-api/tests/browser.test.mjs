import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('独立界面自动保存每日观看与许可名单，保护迟到回包且好友共用即时总开关', { timeout: 60_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const root = fileURLToPath(new URL('../.test-temp/', import.meta.url)); await fs.mkdir(root, { recursive: true });
  const calls = [], nativeCalls = [], errors = [];
  let configured = false, task = null, taskRunning = false, revision = 0, forwardCount = 0, opened = 0, videoSaveGate = null, videoReadGate = null, failInteractions = false;
  const prefs = () => ({ configured, baseUrl: 'https://api.example.invalid', model: '合成模型', remember: false, memoryFolder: 'C:\\合成共享记忆' });
  const video = { allowed: true, now: Date.now(), window: { expiresAt: Date.now() + 600_000 }, remainingSeconds: 300, session: { status: 'active' }, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 }, reason: '' };
  video.policy = { windows: ['00:00-24:00'], dailyMinutes: 10, dailyRequests: 30 }; video.daily = { usedSeconds: 12, requests: 2 };
  const schedule = { policy: { enabled: false } }, interactions = { policy: { enabled: true }, friend: { replyRunning: false, shareEnabled: true }, rows: [] };
  const friendA = { id: `conv:${'a'.repeat(64)}`, name: '合成好友', followed: true, isGroup: false, identityVersion: 2, identityKind: 'native-conversation', identityVerified: true, identityHash: 'a'.repeat(64), identityBinding: `binding:${'1'.repeat(64)}`, verifiedAt: '2026-10-24T01:00:00Z', authorizationKind: 'following' };
  const friendB = { ...friendA, id: `conv:${'b'.repeat(64)}`, name: '合成好友乙', identityHash: 'b'.repeat(64), identityBinding: `binding:${'2'.repeat(64)}` };
  const chat = { running: false, policy: { allowlist: [friendA], dailyReplyLimit: 40 }, daily: { requests: 0, limit: 40 }, contacts: [], events: [] };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let raw = ''; for await (const chunk of request) raw += chunk;
        calls.push({ route: request.url, method: request.method, body: raw, token: request.headers['x-session-token'] });
        const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (url.pathname === '/api/bootstrap') return reply({ service: 'douyin-api-local', token: 'synthetic-session', config: { configured, model: '合成模型' }, videoTime: { enabled: true }, media: { available: true }, forward: { available: true }, limits: { maxToolCalls: 20, taskTimeoutSeconds: 180 } });
        if (request.headers['x-session-token'] !== 'synthetic-session') { response.writeHead(403); response.end('{"error":"合成鉴权失败"}'); return; }
        if (url.pathname === '/api/state') return reply({ running: taskRunning, task, events: Number(url.searchParams.get('since')) < revision ? [{ revision, type: 'tool.result', tool: 'douyin_observe', result: { ok: true, synthetic: true } }] : [], revision, browser: null });
        if (url.pathname === '/api/video/status') { const snapshot = structuredClone(video); if (videoReadGate) { const gate = videoReadGate; videoReadGate = null, failInteractions = false; if (gate.marker) snapshot.reason = gate.marker; gate.received(); await gate.wait; } return reply(snapshot); }
        if (url.pathname === '/api/chat/state') return reply(chat);
        if (url.pathname === '/api/chat/contacts') return reply({ contacts: [friendA, friendB] });
        if (url.pathname === '/api/chat/configure') { const input = JSON.parse(raw); chat.policy = { ...chat.policy, allowlist: input.recipientIds.map(id => id === friendA.id ? friendA : friendB), groupMentionNames: input.groupMentionNames, dailyReplyLimit: null }; return reply(chat); }
        if (url.pathname === '/api/chat/start') { chat.running = true; return reply(chat); }
        if (url.pathname === '/api/chat/stop') { chat.running = false; return reply(chat); }
        if (url.pathname === '/api/watch/schedule') { if (request.method === 'POST') schedule.policy = JSON.parse(raw); return reply(schedule); }
        if (url.pathname === '/api/interactions/state') return reply(interactions);
        if (url.pathname === '/api/interactions/configure') { if (failInteractions) { response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({error:'合成好友互动写入失败。'})); return; } interactions.policy.enabled = JSON.parse(raw).enabled; interactions.friend.replyRunning = interactions.policy.enabled; return reply(interactions); }
        if (url.pathname === '/api/media/state') return reply({ enabled: false, backend: 'local-whisper', backends: { 'local-whisper': { available: false } } });
        if (url.pathname === '/api/memory') return reply({ result: { entries: [{ id: 'synthetic-memory', origin: 'video', content: '合成视频笔记内容' }] } });
        if (url.pathname === '/api/task') { const instruction = JSON.parse(raw).instruction; taskRunning = instruction.includes('停止'); task = { id: `synthetic-task-${revision + 1}`, instruction, ...(taskRunning ? {} : { message: '**合成结果**：已读取测试画面。' }), status: taskRunning ? 'running' : 'completed' }; revision++; return reply({ id: task.id, status: 'running' }); }
        if (url.pathname === '/api/stop') { taskRunning = false; task.status = 'stopped'; task.message = '合成任务已停止'; return reply({ stopping: true }); }
        if (url.pathname === '/api/video/policy') { video.policy = JSON.parse(raw); if (videoSaveGate) { const gate = videoSaveGate; videoSaveGate = null; gate.received(); await gate.wait; } return reply(video); }
        if (url.pathname === '/api/forward/contacts') return reply({ contacts: chat.policy.allowlist });
        if (url.pathname === '/api/forward') { forwardCount++; return reply({ confirmed: false, deliveryUncertain: true }); }
        return reply({ ok: true });
      }
      const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''));
      if (!path.resolve(file).startsWith(path.resolve(dist) + path.sep)) throw new Error('合成静态路径越界');
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      const contents = await fs.readFile(file);
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); response.end(contents);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__nativeGet', prefs);
  await page.exposeFunction('__nativeSave', input => { nativeCalls.push(input); configured = true; return prefs(); });
  await page.exposeFunction('__nativeClear', () => { configured = false; return prefs(); });
  await page.exposeFunction('__nativeOpen', () => { opened++; });
  await page.addInitScript(() => { window.douyinDesktop = { getSettings: () => window.__nativeGet(), saveSettings: input => window.__nativeSave(input), clearApiKey: () => window.__nativeClear(), openMemoryFolder: () => window.__nativeOpen() }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: '先连接你的 DeepSeek' }).waitFor();
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('synthetic-only-secret');
  await page.getByRole('textbox', { name: 'API Key', exact: true }).press('Tab'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(nativeCalls.length, 1); assert.equal(nativeCalls[0].apiKey, 'synthetic-only-secret');
  await page.getByRole('tab', { name: '视频观看', exact: true }).click();
  await page.getByText('高级选项', { exact: true }).click();
  const minutes = page.getByRole('spinbutton', { name: '每日观看上限', exact: true }), unlimited = page.getByRole('switch', { name: '不限每日观看时长', exact: true });
  await minutes.fill(''); const beforeInvalid = calls.filter(item => item.route === '/api/video/policy').length; await page.waitForTimeout(750); assert.equal(calls.filter(item => item.route === '/api/video/policy').length, beforeInvalid);
  await minutes.fill('5'); await page.waitForTimeout(850); assert.equal(video.policy.dailyMinutes, 5);
  let releaseVideoSave;
  const videoSaveReceived = new Promise(received => { videoSaveGate = { received, wait: new Promise(resolve => { releaseVideoSave = resolve; }) }; });
  await unlimited.click(); await videoSaveReceived;
  await minutes.fill('25'); releaseVideoSave(); await page.waitForTimeout(250);
  assert.equal(await minutes.inputValue(), '25'); assert.equal(video.policy.dailyMinutes, null);
  await page.waitForTimeout(700); assert.equal(video.policy.dailyMinutes, 25);
  let releaseOldRead, releaseFreshRead;
  const oldReadReceived = new Promise(received => { videoReadGate = { marker: '合成旧轮询回包', received, wait: new Promise(resolve => { releaseOldRead = resolve; }) }; });
  await oldReadReceived;
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/video/policy') && response.request().method() === 'POST'), unlimited.click()]);
  assert.equal(video.policy.dailyMinutes, null);
  const freshReadReceived = new Promise(received => { videoReadGate = { received, wait: new Promise(resolve => { releaseFreshRead = resolve; }) }; });
  releaseOldRead(); await page.getByText(/合成旧轮询回包/).waitFor();
  assert.equal(await minutes.inputValue(), ''); assert.equal(await unlimited.getAttribute('aria-checked'), 'true');
  await freshReadReceived; releaseFreshRead(); await page.getByText(/合成旧轮询回包/).waitFor({ state: 'hidden' });
  video.policy = { ...video.policy, dailyMinutes: 35 }; await page.waitForFunction(() => document.querySelector('[aria-label="每日观看上限"]').value === '35');
  await page.getByRole('switch', { name: '允许自动观看', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="允许自动观看"]').getAttribute('aria-checked') === 'true');
  assert.equal(schedule.policy.enabled, true); assert.equal(await page.getByRole('button', { name: /保存时间|开始新一轮|停止自主观看/ }).count(), 0);
  assert.equal(await page.getByRole('button',{name:'开始自主观看',exact:true}).count(),1); assert.equal(await page.getByRole('button',{name:'暂停观看',exact:true}).count(),1);
  await page.getByRole('tab', { name: '好友互动', exact: true }).click();
  const friend = page.getByRole('switch', { name: '允许好友互动', exact: true }); assert.equal(await friend.getAttribute('aria-checked'), 'true'); assert.equal(await page.getByRole('spinbutton').count(), 0);
  assert.equal(await page.getByRole('button', { name: /启用自动回复|保存许可名单|保存自主分享|自动问候/ }).count(), 0);
  await page.getByRole('button', { name: '读取联系人与群聊', exact: true }).click(); await page.getByRole('checkbox', { name: /合成好友乙/ }).check();
  await page.getByRole('textbox', { name: '群聊响应昵称', exact: true }).fill('大肥鱼,小肥鱼'); await page.getByRole('textbox', { name: '群聊响应昵称', exact: true }).press('Tab'); await page.waitForTimeout(300);
  const saved = JSON.parse(calls.filter(item => item.route === '/api/chat/configure').at(-1).body); assert.deepEqual(saved, { recipientIds: [friendA.id, friendB.id], allowConversationOnly: false, groupMentionNames: ['大肥鱼', '小肥鱼'] });
  chat.running = true;
  await page.getByRole('tab', { name: '基础设置', exact: true }).click(); await page.getByRole('button', { name: '配置模型与 API Key', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).isEnabled(), true); await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  assert.equal(nativeCalls.length, 1); await page.getByRole('tab', { name: '好友互动', exact: true }).click();
  failInteractions = true; await friend.click(); await page.getByRole('alert').filter({ hasText: '合成好友互动写入失败' }).waitFor(); assert.equal(await friend.getAttribute('aria-checked'), 'true');
  failInteractions = false; await friend.click(); await page.waitForFunction(() => document.querySelector('[aria-label="允许好友互动"]').getAttribute('aria-checked') === 'false'); assert.equal(interactions.policy.enabled, false);
  assert.equal(calls.some(item => /\/api\/(?:spark\/|chat\/(?:start|stop)|share\/configure)/.test(item.route)), false);
  await page.getByRole('button', { name: /新任务/ }).click(); await page.getByRole('textbox', { name: '视频任务' }).fill('读取合成猫咪视频'); await page.getByRole('button', { name: '开始任务 ↑' }).click(); await page.getByText('合成结果', { exact: true }).waitFor();
  assert.equal(calls.some(call => call.body.includes('synthetic-only-secret') || call.route.includes('synthetic-only-secret')), false); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, 'synthetic-auto-settings.png') });
});
