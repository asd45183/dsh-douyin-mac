import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SparkService } from '../spark-service.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const contact = (name, isGroup = false) => ({ id: `conv:${hash(name)}`, name, displayName: name, followed: null, relationshipStatus: 'unavailable', isGroup, identityVerified: true, identityBinding: `binding:${hash(`${name}:头像与会话`)}`, authorizationKind: isGroup ? 'existing-group' : 'existing-conversation', verifiedAt: '2026-10-24T00:00:00.000Z' });
function fixture(t, contacts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-spark-permissions-')), reads = [], sends = [], requests = [];
  const now = () => Date.parse('2026-10-24T04:00:00Z');
  const saveContacts = values => fs.writeFileSync(path.join(directory, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: false, allowlist: values, dailyReplyLimit: 40 }));
  saveContacts(contacts);
  const browser = {
    async listContacts() { return { contacts: structuredClone(contacts) }; },
    async readConversation(id) { reads.push(id); const current = contacts.find(value => value.id === id); return { conversation: { id }, contact: structuredClone(current), messages: [{ id: 'synthetic-yesterday', sender: 'outgoing', kind: 'text', text: '昨天的合成问候', sentAt: '2026-10-23 12:00', dateEvidence: { raw: '2026-10-23 12:00', kind: 'absolute' } }], dayEvidence: { observedAt: new Date(now()).toISOString(), latestEndVerified: true, chronology: 'oldest-first' } }; },
    async sendMessage(id, text, settings) { settings.signal.throwIfAborted(); assert.deepEqual(settings.expectedContact, contacts.find(value => value.id === id)); await settings.authorize(); const release = settings.authorize.beginDispatch(); try { sends.push({ id, text }); } finally { release(); } return { confirmed: true, deliveryUncertain: false, messageId: `synthetic-greeting-${sends.length}`, conversation: { id } }; },
  };
  const greetingProvider = async request => { requests.push(request); return { text: '今天也记得喝水呀，过来打个招呼。' }; };
  const service = new SparkService({ browser, config: { apiKey: 'synthetic-spark-key', model: 'synthetic' }, greetingProvider, stateDir: directory, now });
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-spark-permissions-/); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, service, browser, reads, sends, requests, saveContacts };
}
async function start(f) { f.service.configure({ enabled: true, windows: ['09:00-22:00'], dailyLimit: 2 }, { explicit: true }); await f.service.start({ schedule: false, explicit: true }); }

test('只有一位已核对个人联系人也能续火，每天只发一次', async t => {
  const person = contact('合成唯一好友'), f = fixture(t, [person]); await start(f); await f.service.tick(); await f.service.tick();
  assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].id, person.id); assert.equal(f.service.state().daily.confirmed, 1);
});

test('共用名单含群聊时，续火只读取及问候许可个人，群聊不调用模型', async t => {
  const person = contact('合成续火好友'), group = contact('合成群聊不续火', true), f = fixture(t, [group, person]); await start(f); await f.service.tick();
  assert.deepEqual(f.service.recipients().map(value => value.id), [person.id]); assert.equal(f.requests.length, 1); assert.deepEqual(f.sends.map(value => value.id), [person.id]); assert.ok(f.reads.every(id => id === person.id));
});

test('许可名单仅有群聊时拒绝启动续火，既不读正文也不生成问候', async t => {
  const f = fixture(t, [contact('合成唯一群聊', true)]); f.service.configure({ enabled: true }, { explicit: true });
  await assert.rejects(f.service.start({ schedule: false, explicit: true }), /个人联系人|群聊/); assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0);
});

test('未知类型或未核对群聊污染名单时拒绝，而不是当个人续火', async t => {
  const person = contact('合成正常个人'), f = fixture(t, [person]);
  for (const bad of [{ ...contact('合成未知类型'), isGroup: null }, { ...contact('合成未核对群', true), identityVerified: false }, { ...contact('合成未授权群', true), authorizationKind: 'following', followed: true }]) { f.saveContacts([person, bad]); assert.throws(() => f.service.recipients(), /核对/); }
  assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0);
});

test('旧续火兼容名单不设人数cap，群聊不参与，重复ID仍拒绝', async t => {
  const contacts = Array.from({ length: 51 }, (_, index) => contact(`合成名单边界${index}`, index > 0)), f = fixture(t, contacts.slice(0, 50));
  assert.equal(f.service.recipients().length, 1); f.saveContacts(contacts);assert.equal(f.service.recipients().length,1);
  f.saveContacts([contacts[0], contacts[0]]); assert.throws(() => f.service.recipients(), /核对/);
});

test('启动后个人身份绑定变化，首次快照即停止，不生成、不发送或自动重试', async t => {
  const person = contact('合成运行中换身份'), f = fixture(t, [person]); await start(f);
  person.identityBinding = `binding:${hash('合成另一身份')}`;
  await assert.rejects(f.service.tick(), /身份|绑定/); assert.equal(f.service.state().running, false); assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0);
  const count = f.reads.length; await f.service.tick(); assert.equal(f.reads.length, count); assert.match(f.service.state().lastError, /身份|绑定/);
});

test('续火快照缺少完整contact或个人类型变群时拒绝，仅ID相同不够', async t => {
  for (const mode of ['missing-contact', 'group']) {
    const person = contact(`合成无身份快照${mode}`), f = fixture(t, [person]); await start(f); const original = f.browser.readConversation;
    f.browser.readConversation = async (...args) => { const value = await original(...args); if (mode === 'missing-contact') delete value.contact; else value.contact.isGroup = true; return value; };
    await assert.rejects(f.service.tick(), /身份|绑定/); assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.service.state().daily.attempts, 0);
  }
});

test('生成后快照绑定变化取消问候，保留本日尝试且明确重启也不补发', async t => {
  const person = contact('合成生成后换身份'), saved = structuredClone(person), f = fixture(t, [person]); await start(f);
  f.service.greetingProvider = async request => { f.requests.push(request); person.identityBinding = `binding:${hash('合成生成期间另一身份')}`; return { text: '合成问候，不应发出。' }; };
  await assert.rejects(f.service.tick(), /身份|绑定/);
  assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.service.state().recent[0].status, 'not-sent'); assert.equal(f.service.state().daily.attempts, 1);
  Object.assign(person, saved); await f.service.tick(); assert.equal(f.requests.length, 1);
  await f.service.start({ schedule: false, explicit: true }); await f.service.tick(); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0);
});

test('模型期间磁盘中同ID许可绑定被替换时停止，不采用替换后的联系人发送', async t => {
  const person = contact('合成磁盘许可换绑定'), f = fixture(t, [person]); await start(f);
  f.service.greetingProvider = async request => { f.requests.push(request); f.saveContacts([{ ...person, identityBinding: `binding:${hash('合成被替换的许可身份')}` }]); return { text: '合成问候，不应发出。' }; };
  await assert.rejects(f.service.tick(), /身份|绑定/); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.service.state().recent[0].status, 'not-sent');
});

test('进入发送适配器后许可绑定变化，最终authorize仍拒绝且不记为已发送', async t => {
  const person = contact('合成最终输入许可变化'), f = fixture(t, [person]); await start(f);
  f.browser.sendMessage = async (id, text, settings) => {
    assert.deepEqual(settings.expectedContact, person); f.saveContacts([{ ...person, identityBinding: `binding:${hash('合成最终输入变动')}` }]);
    await settings.authorize(); assert.fail('许可绑定变更后不能通过发送检查');
  };
  await assert.rejects(f.service.tick(), /身份|绑定/); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.service.state().recent[0].status, 'not-sent');
  await f.service.tick(); assert.equal(f.requests.length, 1);
});
