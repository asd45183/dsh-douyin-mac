import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatAgent} from '../chat-agent.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatService} from '../chat-service.mjs';

test('私信每次读取最新共用手编人格，不向模型带出兴趣生成区或观看来源',async()=>{
  let version=1;const requests=[];
  const personaMemory={snapshot:()=>({manualText:`合成人格版本${version}：语气简洁。`,personaText:'不得外发的合成作品与兴趣',interests:[{topic:'合成内部兴趣'}],recentObservations:[{url:'https://synthetic-private.example'}]})};
  const agent=new ChatAgent({config:{apiKey:'synthetic-key',baseUrl:'https://synthetic.example',model:'synthetic'},personaMemory,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'合成回复'}}]}));}});
  await agent.reply({messages:[{sender:'incoming',text:'合成新消息'}]});version=2;await agent.reply({messages:[{sender:'incoming',text:'第二条合成新消息'}]});
  assert.match(requests[0].messages[0].content,/合成人格版本1/);assert.match(requests[1].messages[0].content,/合成人格版本2/);
  const text=JSON.stringify(requests);assert.doesNotMatch(text,/不得外发的合成作品|合成内部兴趣|synthetic-private/);assert.equal(requests[0].tools,undefined);
});

test('人格决定角色表达而非客服身份，已核对会话仅以有界显示名进入提供器', async () => {
  let request;
  const agent = new ChatAgent({ config: { apiKey: '', model: 'synthetic-persona' }, personaMemory: { snapshot: () => ({ manualText: '合成角色小鲸：嘴硬又温柔，接话自然。', personaText: 'PRIVATE_GENERATED_INTEREST', interests: ['PRIVATE_TOPIC'] }) }, replyProvider: async value => { request = value; return { text: '认得这个昵称呀。' }; } });
  await agent.reply({ messages: [{ id: 'new', sender: 'incoming', text: '现在能正常识别我吗' }], conversation: { displayName: '  合成\n昵称\u0000  ', isGroup: false, id: 'PRIVATE_STABLE_ID', avatarRef: 'PRIVATE_AVATAR', others: ['PRIVATE_OTHER_PERSON'] } });
  assert.match(request.system, /手编人格卡决定本轮的角色称呼、性格、情绪与关系表达习惯/); assert.match(request.system, /不主动介绍自己是 AI、自动回复或服务/); assert.match(request.system, /被明确问是否 AI 时如实说明/);
  assert.match(request.system, /历史中自己发过的话只作为对话上下文/); assert.match(request.system, /不要求沿用旧回复中的“自动回复助手”等机械自称或模板/);
  assert.match(request.system, /没有本轮明确提供的运行证据时，不编造卡顿、网络延迟、刚收到消息、已经修好等状态或原因/);
  assert.match(request.system, /"displayName":"合成 昵称","isGroup":false/); assert.match(request.system, /不代表核验了真人身份/); assert.match(request.system, /不向对方复述整张卡/);
  assert.doesNotMatch(request.system, /你是用户在抖音私信中的 AI 自动回复助手|只作为表达风格参考|PRIVATE_STABLE_ID|PRIVATE_AVATAR|PRIVATE_OTHER_PERSON|PRIVATE_GENERATED_INTEREST|PRIVATE_TOPIC/);
  assert.equal(request.messages.at(-1).content, '现在能正常识别我吗');
});

test('没有人格卡时明确自然聊天回退，群名按同一会话处理且不伪造人格', async () => {
  let request; const agent = new ChatAgent({ config: { apiKey: '' }, replyProvider: async value => { request = value; return { text: '在呢。' }; } });
  await agent.reply({ messages: [{ id: 'new', sender: 'incoming', text: '@大肥鱼 在吗' }], conversation: { displayName: '合成讨论群', isGroup: true } });
  assert.match(request.system, /当前没有可用的共同手编人格卡/); assert.match(request.system, /不声称已加载人格或虚构设定/); assert.match(request.system, /"displayName":"合成讨论群","isGroup":true/); assert.doesNotMatch(request.system, /共同手编人格卡决定本轮/);
});

test('会话显示名最多200个Unicode字符，格式不合法时不调用模型', async () => {
  let request, calls = 0; const agent = new ChatAgent({ config: { apiKey: '' }, replyProvider: async value => { calls++; request = value; return { text: '合成回应。' }; } });
  const messages = [{ id: 'new', sender: 'incoming', text: '合成问题' }]; await agent.reply({ messages, conversation: { displayName: '🐳'.repeat(210), isGroup: false } });
  assert.ok(request.system.includes(JSON.stringify({ displayName: '🐳'.repeat(200), isGroup: false }))); assert.ok(!request.system.includes('🐳'.repeat(201)));
  for (const conversation of [null, { displayName: '', isGroup: false }, { displayName: '合成昵称', isGroup: null }, { displayName: 1, isGroup: false }]) await assert.rejects(agent.reply({ messages, conversation }), /会话/);
  assert.equal(calls, 1);
});

test('服务只把当前强身份核对后的显示名和类型交模型，不带稳定ID、头像或其他联系人', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-persona-'));
  const contact = { id: `conv:${'a'.repeat(64)}`, name: '合成许可昵称', followed: true, isGroup: false, identityVerified: true, identityVersion: 2, identityKind: 'rendered-user', identityHash: 'a'.repeat(64), identityBinding: `binding:${'b'.repeat(64)}`, avatarRef: 'PRIVATE_AVATAR', otherContact: 'PRIVATE_OTHER_PERSON' };
  const messages = [{ id: 'old', sender: 'incoming', text: '合成基线', eligibleForReply: false }]; let request, sent = 0;
  const browser = { listContacts: async () => ({ contacts: [structuredClone(contact)] }), readConversation: async () => ({ conversation: { id: contact.id, isGroup: false }, contact: structuredClone(contact), messages: structuredClone(messages) }), sendMessage: async () => { sent++; assert.fail('此用例只能到模型前，不得发送。'); } };
  const service = new ChatService({ browser, stateDir: directory, config: { apiKey: 'synthetic-persona-key' }, agent: { reply: async value => { request = value; throw new Error('合成检查在模型入口结束，不调用真实模型或发送。'); } } });
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-chat-persona-/); fs.rmSync(directory, { recursive: true, force: true }); });
  await service.configure({ recipientIds: [contact.id] }); await service.start({ schedule: false }); messages.push({ id: 'new', sender: 'incoming', text: '现在能正常识别我吗', eligibleForReply: true, arrivalClassification: 'new-tail' }); await service.poll();
  assert.deepEqual(request.conversation, { displayName: contact.name, isGroup: false }); assert.equal(sent, 0); assert.doesNotMatch(JSON.stringify(request), /PRIVATE_AVATAR|PRIVATE_OTHER_PERSON|conv:|binding:/);
});
