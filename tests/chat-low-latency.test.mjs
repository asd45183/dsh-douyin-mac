import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatService } from '../chat-service.mjs';

const contact = { id: `conv:${'c'.repeat(64)}`, name: '合成许可好友', followed: true, isGroup: false, identityVerified: true, identityBinding: `binding:${'d'.repeat(64)}`, identityVersion: 2, identityKind: 'rendered-user', identityHash: 'c'.repeat(64) };
const incoming = (id, text) => ({ id, text, sender: 'incoming', eligibleForReply: true, arrivalClassification: 'new-tail' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message = '合成调度没有在预算内完成') {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= end) throw new Error(message); await pause(5); }
}
async function idle(service) { await until(() => !service.busy && !service.pollScheduled && !service.pollRequested); }
function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-wakeup-'));
  const messages = [incoming('baseline-old', '启动前旧消息')], sent = [], inputs = [];
  let reads = 0;
  const browser = {
    listContacts: async () => ({ contacts: [contact] }),
    readConversation: async id => { reads++; return { conversation: { id }, contact: { ...contact }, messages: structuredClone(messages) }; },
    sendMessage: async (id, text) => { sent.push({ id, text }); return { confirmed: true, messageId: `confirmed-${sent.length}` }; },
    ...extra.browser,
  };
  const agent = { replyTokens: 512, reply: async value => { inputs.push(value); return { text: '合成及时回复' }; }, ...extra.agent };
  const service = new ChatService({ browser, agent, config: { apiKey: 'synthetic-key', model: 'synthetic-model' }, stateDir: directory, ...extra.options });
  t.after(async () => {
    await service.close();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error('合成目录清理越界');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { service, browser, agent, directory, messages, sent, inputs, reads: () => reads };
}
async function start(f, schedule = false) {
  await f.service.configure({ recipientIds: [contact.id] });
  await f.service.start({ schedule });
  await idle(f.service);
}

test('默认两秒检查，但未启用时通知不会启动服务、读取消息或调用模型', async t => {
  const f = fixture(t);
  assert.equal(f.service.pollIntervalMs, 2000);
  assert.equal(f.service.state().pollSeconds, 2);
  assert.equal(f.service.notifyIncoming(contact.id), false);
  await pause(20);
  assert.equal(f.service.running, false); assert.equal(f.reads(), 0); assert.equal(f.inputs.length, 0);
});

test('同一批许可通知只合并为一次检查，不读名单外会话且新消息只发送一次', async t => {
  const f = fixture(t); await start(f);
  let polls = 0; const poll = f.service.poll.bind(f.service);
  f.service.poll = async () => { polls++; return poll(); };
  f.messages.push(incoming('new-burst', '新的合成问题'));
  assert.equal(f.service.notifyIncoming('not-authorized'), false);
  for (let i = 0; i < 30; i++) assert.equal(f.service.notifyIncoming(contact.id), true);
  await until(() => f.sent.length === 1); await idle(f.service);
  assert.equal(polls, 1); assert.equal(f.inputs.length, 1); assert.equal(f.sent[0].id, contact.id);
  for (let i = 0; i < 20; i++) f.service.notifyIncoming(contact.id);
  await idle(f.service);
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 1);
});

test('通知订阅在旧消息基线后启用，停止时清理且迟到通知不能再回复', async t => {
  let listener, subscribed, cleaned = 0;
  const f = fixture(t, { options: { pollIntervalMs: 60_000 }, browser: {
    subscribeIncoming: async (callback, options) => { listener = callback; subscribed = options; return async () => { cleaned++; }; },
  } });
  await start(f, true);
  assert.deepEqual(subscribed.recipientIds, [contact.id]); assert.ok(subscribed.signal instanceof AbortSignal);
  assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
  f.messages.push(incoming('arrived-event', '由DOM通知触发的合成新消息'));
  listener({ recipientId: contact.id }); listener({ recipientId: contact.id });
  await until(() => f.sent.length === 1); await idle(f.service);
  f.service.stop(); await until(() => cleaned === 1);
  const before = f.reads(); f.messages.push(incoming('after-stop', '停止后不应回复')); listener({ recipientId: contact.id });
  await pause(20);
  assert.equal(f.reads(), before); assert.equal(f.sent.length, 1); assert.equal(f.service.timer, null);
});

test('生成期间到达新消息只补扫一次，不并行生成或发送过时回复', async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  let calls = 0, active = 0, maximum = 0;
  const f = fixture(t, { agent: { reply: async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    try { if (calls === 1) { entered.resolve(); await gate.promise; } return { text: `合成回复${calls}` }; }
    finally { active--; }
  } } });
  await start(f); f.messages.push(incoming('first', '先到问题')); f.service.notifyIncoming(contact.id);
  await entered.promise;
  f.messages.push(incoming('second', '生成期间补充问题'));
  for (let i = 0; i < 25; i++) f.service.notifyIncoming(contact.id);
  gate.resolve(); await until(() => f.sent.length === 1); await idle(f.service);
  assert.equal(calls, 2); assert.equal(maximum, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, '合成回复2'); assert.equal(f.service.state().daily.requests, 2);
});

test('异步通知订阅在停止之后才返回时立即清理，不挂回旧服务', async t => {
  const ready = Promise.withResolvers(); let cleaned = 0, listener;
  const f = fixture(t, { options: { pollIntervalMs: 60_000 }, browser: {
    subscribeIncoming: callback => { listener = callback; return ready.promise; },
  } });
  await start(f, true); f.service.stop();
  ready.resolve(async () => { await pause(5); cleaned++; });
  await until(() => cleaned === 1);
  f.messages.push(incoming('late-subscription', '过期通知不应启动回复')); listener({ recipientId: contact.id });
  await pause(15);
  assert.equal(f.service.incomingUnsubscribe, null); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
});

test('停止会取消正在生成的回复并清除补扫，不在停止后自动补发', async t => {
  const entered = Promise.withResolvers(); let calls = 0;
  const f = fixture(t, { agent: { reply: ({ signal }) => { calls++; entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } } });
  await start(f); f.messages.push(incoming('cancelled', '停止前新问题')); f.service.notifyIncoming(contact.id);
  await entered.promise; f.service.notifyIncoming(contact.id); f.service.stop(); await idle(f.service);
  assert.equal(calls, 1); assert.equal(f.sent.length, 0); assert.equal(f.service.pollRequested, false);
  await f.service.start({ schedule: false }); f.service.notifyIncoming(contact.id); await idle(f.service);
  assert.equal(calls, 1); assert.equal(f.sent.length, 0);
});

test('没有消息通知接口时仍定时检查，空轮询不调用模型', async t => {
  const f = fixture(t, { options: { pollIntervalMs: 20 } }); await start(f, true);
  await pause(70); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
  f.messages.push(incoming('fallback-new', '由定时检查发现的新消息'));
  await until(() => f.sent.length === 1); await idle(f.service);
  f.service.stop(); assert.equal(f.inputs.length, 1);
});

test('仅视频轮次锁存在时聊天不等待轮次结束，仍只处理许可新消息', async t => {
  const f = fixture(t); await start(f);
  fs.writeFileSync(path.join(f.directory, 'watch-loop.lock'), JSON.stringify({ version: 1, pid: process.pid, runId: 'synthetic-running-watch', source: 'api', sessionId: 'synthetic-session' }));
  f.messages.push(incoming('during-watch', '刷视频时的新消息')); f.service.notifyIncoming(contact.id);
  await until(() => f.sent.length === 1); await idle(f.service);
  assert.equal(f.inputs.length, 1); assert.equal(fs.existsSync(path.join(f.directory, 'watch-loop.lock')), true);
});
