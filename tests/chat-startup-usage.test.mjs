import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserController} from '../core.mjs';
import {VideoLimits} from '../video-limits.mjs';
import {UsageLedger} from '../usage-ledger.mjs';

test('原生自动回复未打开设置页也立即记录用量，两个入口只读共用同一账本',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-chat-startup-usage-'));
  const controller=new BrowserController({source:'dsh',videoLimits:new VideoLimits({stateDir:root}),personaMemory:{snapshot:()=>({manualText:'合成测试角色'})}});
  t.after(async()=>{await(await controller.getChatService()).close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const chat=await controller.getChatService();assert.equal(chat.stateDir,root);assert.equal(chat.agent.source,'dsh');assert.ok(chat.agent.usageLedger);
  chat.agent.config={model:'synthetic-startup'};chat.agent.replyProvider=async()=>({text:'合成回复，不实际发送。',usage:{promptTokens:11,completionTokens:3}});
  await chat.agent.reply({messages:[{id:'synthetic-new',sender:'incoming',text:'合成提问。'}]});
  const view=new UsageLedger({stateDir:root}).state();assert.equal(view.today.requests,1);assert.equal(view.today.totalTokens,14);assert.equal(view.groups[0].source,'dsh');assert.equal(view.groups[0].kind,'chat');
});
