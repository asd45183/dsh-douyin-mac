import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserController } from '../core.mjs';

const A='7579432563794584933',B='7579432563794584934',C='7579432563794584935';
const state=(id=A,extra={})=>({url:'https://www.douyin.com/?recommend=1',loginRequired:false,verificationRequired:false,privateChatVisible:false,pageKind:'video',videoSelection:{candidateCount:1,ambiguous:false},video:{id,readyState:4,paused:false,viewport:{x:10,y:10,width:200,height:300}},...extra});
function fixture({before=[state()],after=[state(B)],postState}={}){
  let inputs=0,preReads=0,postReads=0,inputAt;
  const arrow={filter:()=>arrow,count:async()=>1,first:()=>arrow,isVisible:async()=>true,isEnabled:async()=>true,evaluate:async reader=>reader.toString().includes('getBoundingClientRect')?{x:400,y:100,width:70,height:40,clickX:435,clickY:120}:undefined};
  const controller=Object.create(BrowserController.prototype);
  Object.assign(controller,{source:'verification',checkVideoLimits:async()=>{},state:async()=>structuredClone(inputs?postState?postState(Date.now()-inputAt):after[Math.min(postReads++,after.length-1)]:before[Math.min(preReads++,before.length-1)]),page:{locator:()=>arrow,evaluate:async reader=>reader.toString().includes('return{blocked:')?{blocked:false,dispatched:true}:true,mouse:{click:async()=>{inputs++;inputAt=Date.now();},move:async()=>{},wheel:async()=>{throw new Error('有箭头时不应追加滚轮输入');}}}});
  return{controller,inputs:()=>inputs};
}

test('换片前短暂缺ID只等待，得到连续稳定就绪ID后仅输入一次',async()=>{
  const f=fixture({before:[state(null),state(null),state(A),state(A)]});
  const result=await f.controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});
  assert.equal(result.changed,true);assert.equal(result.before.id,A);assert.equal(result.after.id,B);assert.equal(f.inputs(),1);
});

test('单次换片后五秒才就绪仍等待确认，不重复输入或提前声称成功',async()=>{
  const f=fixture({postState:elapsed=>elapsed<5000?state(A):state(B)}),started=Date.now();
  const result=await f.controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});
  assert.ok(Date.now()-started>=5000);assert.equal(result.changed,true);assert.equal(result.before.id,A);assert.equal(result.after.id,B);assert.equal(f.inputs(),1);
});

test('过期观察与当前稳定ID不同则无输入，返回精确的stale回执',async()=>{
  const f=fixture({before:[state(B)]});const result=await f.controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});
  assert.equal(f.inputs(),0);assert.equal(result.changed,false);assert.equal(result.staleObservation,true);assert.equal(result.reasonCode,'observed-video-changed');assert.equal(result.expectedVideoId,A);assert.equal(result.before.id,B);assert.equal(result.after.id,B);assert.equal(result.state.video.id,B);
});

test('输入前最后回读已换片也不沿用旧观察点击',async()=>{
  const f=fixture({before:[state(A),state(A),state(B),state(B)]});const result=await f.controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});
  assert.equal(f.inputs(),0);assert.equal(result.staleObservation,true);assert.equal(result.expectedVideoId,A);assert.equal(result.state.video.id,B);
});

test('登录验证私信遮挡以及始终未知ID都不换片',async()=>{
  for(const extra of [{loginRequired:true},{verificationRequired:true},{privateChatVisible:true}]){
    const f=fixture({before:[state(A,extra)]}),result=await f.controller.switchVideo(1,undefined,{recordLearning:false});assert.equal(result.changed,false);assert.equal(result.reasonCode,'switch-blocked');assert.equal(f.inputs(),0);
  }
  const f=fixture({before:[state(null)]}),result=await f.controller.switchVideo(1,undefined,{recordLearning:false});assert.equal(result.changed,false);assert.equal(result.reasonCode,'video-identity-not-ready');assert.equal(result.staleObservation,undefined);assert.equal(f.inputs(),0);
});

test('新片ID闪现或未就绪不能立即确认，连续就绪后才成功',async()=>{
  const f=fixture({after:[state(B),state(C,{video:{...state(C).video,readyState:1}}),state(B),state(B)]});
  const result=await f.controller.switchVideo(1,undefined,{recordLearning:false});assert.equal(result.changed,true);assert.equal(result.after.id,B);assert.equal(f.inputs(),1);
});

test('一次输入后取消等待不会追加换片',async()=>{
  const f=fixture({after:[state(null)]});await assert.rejects(f.controller.switchVideo(1,AbortSignal.timeout(900),{recordLearning:false}));assert.equal(f.inputs(),1);
});

test('expectedVideoId只作换片宿主控制，不接收模型参数或其他工具用途',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-switch-controls-'));t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  const controller=new BrowserController({source:'verification',controlDirectory:directory});let received;
  controller.watchVideoLimits=()=>{};controller.page={url:()=> 'https://www.douyin.com/'};controller.connect=async()=>controller.page;
  controller.switchVideo=async(direction,signal,options)=>{received={direction,...options};return{changed:true};};
  for(const expectedVideoId of [123,'x123','123/456',''])await assert.rejects(controller.execute('douyin_next',{}, {expectedVideoId}),TypeError);
  await assert.rejects(controller.execute('douyin_status',{}, {expectedVideoId:A}),TypeError);
  await assert.rejects(controller.execute('douyin_next',{expectedVideoId:A}));
  assert.equal((await controller.execute('douyin_next',{}, {expectedVideoId:A})).changed,true);assert.equal(received.expectedVideoId,A);assert.equal(received.direction,1);
});
