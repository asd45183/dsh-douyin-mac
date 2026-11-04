import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApiServer } from '../app.mjs';
import { UsageLedger } from '../usage-ledger.mjs';
import { VideoLimits } from '../video-limits.mjs';

test('真实本机HTTP用量在观看未结束时即时刷新跨入口记账、播放秒数和请求数', { timeout: 15_000 }, async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-usage-refresh-http-'));
  let clock = Date.now(), server;
  t.after(async () => {
    if (server) { await server.stop(); server.closeAllConnections(); }
    assert.equal(path.dirname(path.resolve(stateDir)), path.resolve(os.tmpdir())); assert.match(path.basename(stateDir), /^douyin-usage-refresh-http-/);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const limits = new VideoLimits({ stateDir, now: () => clock });
  limits.savePolicy({ enabled: true, windows: ['00:00-24:00'], dailyMinutes: 10, dailyRequests: 100 }, { explicit: true });
  const sessionId = limits.markSession('api', { explicit: true }).session.id;
  const watch = { running: true, status: 'running', pendingRequests: 1 }, chat = { running: false, policy: { allowlist: [] }, contacts: [] };
  let watchStopped = 0, modelCalls = 0; const toolCalls = [];
  const agent = { config: { apiKey: 'synthetic-http-usage-key', model: 'synthetic-model' }, runTask: async () => { modelCalls += 1; assert.fail('用量刷新不能发起模型请求'); } };
  server = createApiServer({
    port: 0, config: agent.config, agent, videoLimits: limits,
    controller: { execute: async name => { toolCalls.push(name); return {}; }, close: async () => {} },
    watchService: { state: () => structuredClone(watch), stop: async () => { watchStopped += 1; watch.running = false; }, cancel() {}, close: async () => {} },
    chatService: { state: () => structuredClone(chat), close: async () => {} },
    // 测试不调度真实观看；播放证据由合成快照驱动真实VideoLimits计数。
    watchSchedule: { start() {}, state: () => ({ policy: { enabled: false } }), close: async () => {} },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrapResponse = await fetch(`${base}/api/bootstrap`, { cache: 'no-store' });
  assert.equal(bootstrapResponse.headers.get('cache-control'), 'no-store');
  const bootstrap = await bootstrapResponse.json(), headers = { 'x-session-token': bootstrap.token };
  assert.equal(typeof bootstrap.token, 'string'); assert.ok(bootstrap.token.length > 20);
  assert.equal(JSON.stringify(bootstrap).includes(agent.config.apiKey), false);
  const ledger = agent.usageLedger; assert.ok(ledger instanceof UsageLedger); ledger.now = () => clock;
  const pluginLedger = new UsageLedger({ stateDir, now: () => clock });
  async function readUsage() {
    const response = await fetch(`${base}/api/usage`, { headers, cache: 'no-store' });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), null);
    const value = await response.json();
    assert.equal(value.protocol, 'usage-ledger-v1'); assert.ok(Number.isFinite(Date.parse(value.checkedAt)));
    assert.equal(JSON.stringify(value).includes(bootstrap.token), false); assert.equal(JSON.stringify(value).includes(agent.config.apiKey), false);
    return value;
  }
  for (const forbiddenHeaders of [{}, { 'x-session-token': 'synthetic-wrong-token' }, { ...headers, origin: 'https://example.invalid' }]) {
    const rejected = await fetch(`${base}/api/usage`, { headers: forbiddenHeaders, cache: 'no-store' }); assert.equal(rejected.status, 403); await rejected.json();
  }
  const empty = await readUsage(); assert.equal(empty.today.totalTokens, 0); assert.equal(empty.today.requests, 0); assert.deepEqual(empty.inProgress, { watch: 1, chat: 0, total: 1 });
  limits.reserveRequest({ source: 'api', sessionId });
  limits.notePlayback('api', { video: { paused: false, readyState: 4 } }); clock += 1000;
  limits.notePlayback('api', { video: { paused: false, readyState: 4 } });
  ledger.record({ id: 'synthetic-api-response-one', source: 'api', kind: 'watch', model: 'synthetic-model', usage: { prompt_tokens: 12, completion_tokens: 3 } });
  const first = await readUsage(); assert.equal(first.today.totalTokens, 15); assert.equal(first.today.requests, 1); assert.equal(first.today.promptTokens, 12); assert.equal(first.today.completionTokens, 3);
  assert.equal(first.videoDaily.usedSeconds, 1); assert.equal(first.videoDaily.requests, 1); assert.equal(first.videoDaily.remainingSeconds, 599); assert.equal(first.inProgress.total, 1);
  clock += 1000; limits.notePlayback('api', { video: { paused: false, readyState: 4 } });
  ledger.record({ id: 'synthetic-api-response-two', source: 'api', kind: 'watch', model: 'synthetic-model', usage: { prompt_tokens: 20, completion_tokens: 5 } });
  const second = await readUsage(); assert.equal(second.today.totalTokens, 40); assert.equal(second.today.requests, 2); assert.equal(second.videoDaily.usedSeconds, 2);
  assert.equal(watch.running, true); assert.equal(watch.pendingRequests, 1); assert.equal(watchStopped, 0, '整轮未停止时即可读到第二次响应');
  const pluginLimits = new VideoLimits({ stateDir, now: () => clock });
  pluginLimits.reserveRequest({ source: 'dsh', sessionId }); pluginLimits.notePlayback('dsh', { video: { paused: false, readyState: 4 } });
  clock += 1000; pluginLimits.notePlayback('dsh', { video: { paused: false, readyState: 4 } });
  pluginLedger.record({ id: 'synthetic-dsh-response-one', source: 'dsh', kind: 'watch', model: 'synthetic-plugin-model', usage: { promptTokens: 8, completionTokens: 2 } });
  const shared = await readUsage(); assert.equal(shared.today.totalTokens, 50); assert.equal(shared.today.requests, 3); assert.equal(shared.videoDaily.usedSeconds, 3); assert.equal(shared.videoDaily.requests, 2);
  assert.equal(shared.groups.find(item => item.source === 'dsh').totalTokens, 10); assert.equal(shared.groups.find(item => item.source === 'api').totalTokens, 40);
  chat.contacts = [{ pending: { phase: 'model' } }];
  ledger.record({ id: 'synthetic-api-unknown-usage', source: 'api', kind: 'chat', model: 'synthetic-model' });
  const unknown = await readUsage(); assert.equal(unknown.today.totalTokens, 50, '未报告Token不能伪造或估算'); assert.equal(unknown.today.unknownRequests, 1); assert.equal(unknown.today.requests, 4); assert.deepEqual(unknown.inProgress, { watch: 1, chat: 1, total: 2 });
  watch.pendingRequests = 0; chat.contacts = [];
  const betweenRequests = await readUsage(); assert.equal(betweenRequests.inProgress.total, 0); assert.equal(betweenRequests.today.totalTokens, 50); assert.equal(watch.running, true); assert.equal(watchStopped, 0);
  assert.equal(modelCalls, 0); assert.deepEqual(toolCalls, []);
});
