import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatService } from '../chat-service.mjs';

const contact = {
  id: 'conv:' + '4'.repeat(64), name: '合成许可群', isGroup: true, followed: null,
  identityVersion: 2, identityKind: 'rendered-conversation', identityHash: '4'.repeat(64),
  identityBinding: 'binding:' + '5'.repeat(64), identityVerified: true,
  authorizationKind: 'manual', verifiedAt: '2026-11-05T00:00:00.000Z',
};

function fixture(t, { code }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-deferred-'));
  fs.writeFileSync(path.join(directory, 'friend-interactions-policy.json'), JSON.stringify({ version: 1, enabled: true }));
  fs.writeFileSync(path.join(directory, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: true, allowlist: [contact] }));
  const browser = {
    listContacts: async () => { throw Object.assign(new Error('合成启动失败'), { code }); },
    readConversation: async () => { throw new Error('不应读取会话'); },
    sendMessage: async () => { throw new Error('不应发送'); },
  };
  const service = new ChatService({ stateDir: directory, browser, config: { apiKey: 'synthetic-key' }, agent: { reply: async () => ({ text: '不应调用模型' }) } });
  t.after(async () => { await service.close().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true }); });
  const policyFile = path.join(directory, 'chat-policy.json');
  return { directory, service, policyFile, stored: () => JSON.parse(fs.readFileSync(policyFile, 'utf8')) };
}

test('前台让路失败保留用户的开关，不把策略文件写成关闭', async t => {
  const f = fixture(t, { code: 'CHAT_FOREGROUND' });
  await assert.rejects(f.service.start({ schedule: false }), error => error.code === 'CHAT_FOREGROUND');
  assert.equal(f.stored().enabled, true, '让路等待不是用户关闭，策略文件必须保持开启');
  assert.equal(f.service.state().policy.enabled, true);
  assert.equal(fs.existsSync(path.join(f.directory, 'chat-loop.lock')), false, '失败后仍要释放运行锁');
});

test('浏览器未运行同样按让路处理', async t => {
  const f = fixture(t, { code: 'BROWSER_NOT_RUNNING' });
  await assert.rejects(f.service.start({ schedule: false }), error => error.code === 'BROWSER_NOT_RUNNING');
  assert.equal(f.stored().enabled, true);
});

test('真正的启动失败仍写回关闭，避免下次自动启动', async t => {
  const f = fixture(t, { code: 'CHAT_LOGIN_REQUIRED' });
  await assert.rejects(f.service.start({ schedule: false }), error => error.code === 'CHAT_LOGIN_REQUIRED');
  assert.equal(f.stored().enabled, false);
  assert.equal(f.service.state().policy.enabled, false);
});
