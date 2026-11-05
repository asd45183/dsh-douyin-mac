import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousFollow } from '../autonomous-follow.mjs';

function fixture(t, { fans = [], followBack } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-autonomous-follow-'));
  const calls = [];
  const chat = {
    listFans: async () => { calls.push(['listFans']); return { fans, counters: { following: '0', fans: String(fans.length) }, end: true }; },
    followBack: async input => { calls.push(['followBack', input.userId]); return followBack ? followBack(input) : { confirmed: true, relation: '相互关注' }; },
  };
  const service = new AutonomousFollow({ chat, stateDir, now: () => Date.parse('2026-11-05T12:00:00.000Z') });
  t.after(async () => { await service.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { service, chat, stateDir, calls };
}

test('默认关闭：不读粉丝、不回关', async t => {
  const f = fixture(t, { fans: [{ userId: 'user_a', name: '甲', relation: '回关' }] });
  assert.deepEqual(await f.service.runOnce(), { ran: false, reason: 'disabled' });
  assert.deepEqual(f.calls, []);
});

test('开启必须给每日上限，且上限不能为 0', async t => {
  const f = fixture(t);
  assert.throws(() => f.service.configure({ enabled: true }, { explicit: true }), /每日上限/);
  assert.throws(() => f.service.configure({ enabled: true, dailyLimit: 21 }, { explicit: true }), /0 至 20/);
  assert.throws(() => f.service.configure({ enabled: true, dailyLimit: 2, perRunLimit: 6 }, { explicit: true }), /1 至 5/);
  assert.equal(f.service.configure({ enabled: true, dailyLimit: 2 }, { explicit: true }).enabled, true);
  f.service.stop();
});

test('只回关尚未回关的新粉丝，已关注与已处理过的跳过', async t => {
  const f = fixture(t, { fans: [
    { userId: 'user_a', name: '甲', relation: '回关' },
    { userId: 'user_b', name: '乙', relation: '相互关注' },
    { userId: 'user_c', name: '丙', relation: '回关' },
  ] });
  f.service.configure({ enabled: true, dailyLimit: 5, perRunLimit: 1 }, { explicit: true });
  f.service.stop();
  const first = await f.service.runOnce();
  assert.equal(first.ran, true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'followBack'), [['followBack', 'user_a']]);
  const second = await f.service.runOnce();
  assert.equal(second.ran, true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'followBack'), [['followBack', 'user_a'], ['followBack', 'user_c']]);
  const third = await f.service.runOnce();
  assert.deepEqual(third.results, []);
  assert.deepEqual(f.calls.filter(call => call[0] === 'followBack').length, 2);
});

test('点击后读不回结果：记为未确认并冻结后续运行，直到本人核对', async t => {
  const f = fixture(t, { fans: [{ userId: 'user_a', name: '甲', relation: '回关' }], followBack: async () => ({ confirmed: false, reason: 'unconfirmed' }) });
  f.service.configure({ enabled: true, dailyLimit: 5 }, { explicit: true });
  f.service.stop();
  const result = await f.service.runOnce();
  assert.equal(result.results[0].status, 'uncertain');
  assert.equal(f.service.state().paused, true);
  assert.equal(f.service.state().needsReview.length, 1);
  assert.deepEqual(await f.service.runOnce(), { ran: false, reason: 'needs-review' });
  const resolved = f.service.resolve({ operationIds: f.service.state().needsReview.map(item => item.operationId), outcome: 'confirmed' }, { explicit: true });
  assert.equal(resolved.paused, false);
  assert.equal(resolved.daily.used, 0, '人工核对不占自动预算');
});

test('让路失败不占每日预算，也不冻结后续运行', async t => {
  const f = fixture(t, { fans: [{ userId: 'user_a', name: '甲', relation: '回关' }], followBack: async () => { throw Object.assign(new Error('前台'), { code: 'CHAT_FOREGROUND' }); } });
  f.service.configure({ enabled: true, dailyLimit: 2 }, { explicit: true });
  f.service.stop();
  const result = await f.service.runOnce();
  assert.equal(result.results[0].status, 'not-sent');
  assert.equal(f.service.state().daily.used, 0);
  assert.equal(f.service.state().paused, false);
  // 让路不是一次真实动作：下一轮仍会重试，而不是被当成已处理。
  await f.service.runOnce();
  assert.equal(f.calls.filter(call => call[0] === 'followBack').length, 2);
});

test('人工核对为未回关后允许下一轮重试', async t => {
  const f = fixture(t, { fans: [{ userId: 'user_a', name: '甲', relation: '回关' }], followBack: async () => ({ confirmed: false, reason: 'unconfirmed' }) });
  f.service.configure({ enabled: true, dailyLimit: 5 }, { explicit: true });
  f.service.stop();
  await f.service.runOnce();
  f.service.resolve({ operationIds: f.service.state().needsReview.map(item => item.operationId), outcome: 'not-sent' }, { explicit: true });
  await f.service.runOnce();
  assert.equal(f.calls.filter(call => call[0] === 'followBack').length, 2);
});

test('预算用完后不再读取粉丝列表', async t => {
  const f = fixture(t, { fans: [{ userId: 'user_a', name: '甲', relation: '回关' }] });
  f.service.configure({ enabled: true, dailyLimit: 1 }, { explicit: true });
  f.service.stop();
  await f.service.runOnce();
  const reads = f.calls.filter(call => call[0] === 'listFans').length;
  assert.deepEqual(await f.service.runOnce(), { ran: false, reason: 'daily-limit' });
  assert.equal(f.calls.filter(call => call[0] === 'listFans').length, reads);
});
