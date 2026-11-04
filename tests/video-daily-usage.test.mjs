import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {VideoLimits,validateVideoPolicy} from '../video-limits.mjs';
import {AutonomousWatch} from '../autonomous-watch.mjs';
const playing={video:{id:'7579432563794584933',time:0,duration:60,readyState:4,paused:false}};
function fixture(t,at='2026-10-24T02:00:00Z'){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-daily-usage-'));let now=Date.parse(at);const limits=new VideoLimits({stateDir:directory,now:()=>now});
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^douyin-daily-usage-/);fs.rmSync(directory,{recursive:true,force:true});});
  return{directory,limits,advance:ms=>{now+=ms;},now:()=>now,enable:(extra={})=>limits.savePolicy({enabled:true,windows:['00:00-24:00'],dailyMinutes:10,dailyRequests:30,...extra},{explicit:true})};
}
test('每日规则不要求手动新轮，旧分钟与schedule请求迁移且没有隐藏大数cap',t=>{
  const f=fixture(t);assert.equal(f.limits.state().allowed,false);f.enable();assert.equal(f.limits.state().allowed,true);assert.equal(f.limits.state().session,null);assert.equal(f.limits.beforeAction('api','douyin_open').allowed,true);assert.ok(f.limits.state().session.id);
  fs.writeFileSync(f.limits.policyFile,JSON.stringify({version:1,windows:['00:00-24:00'],sessionMinutes:null}));fs.writeFileSync(f.limits.scheduleFile,JSON.stringify({enabled:true,maxRequests:100001}));
  assert.equal(f.limits.state().policy.dailyMinutes,null);assert.equal(f.limits.state().policy.dailyRequests,100001);assert.equal(f.limits.state().daily.remainingSeconds,null);
  assert.equal(validateVideoPolicy({enabled:true,windows:['00:00-24:00'],dailyMinutes:1_000_001,dailyRequests:100001}).dailyMinutes,1_000_001);
});
test('只累计实际播放区间，空闲不扣时，实时state含尚未settle的用量',t=>{
  const f=fixture(t);f.enable();f.advance(100_000);assert.equal(f.limits.state().daily.usedSeconds,0);f.limits.notePlayback('api',playing);f.advance(1000);assert.equal(f.limits.state().daily.usedSeconds,1);
  f.limits.notePlayback('api',{video:{...playing.video,paused:true}});f.advance(100_000);assert.equal(f.limits.state().daily.usedSeconds,1);
  f.limits.notePlayback('api',{...playing,privateChatVisible:true});f.advance(1000);assert.equal(f.limits.state().daily.usedSeconds,1);
});
test('软件和插件共用活动时钟，轮次与重启不能清除当天计时和请求',t=>{
  const f=fixture(t);f.enable();f.limits.markSession('api',{explicit:true});f.limits.notePlayback('api',playing);f.advance(1000);const second=new VideoLimits({stateDir:f.directory,now:f.now});second.notePlayback('dsh',playing);f.advance(1000);assert.equal(f.limits.state().daily.usedSeconds,2);
  f.limits.reserveRequest({source:'api'});second.reserveRequest({source:'dsh'});second.endSession({explicit:true});second.markSession('dsh',{explicit:true});assert.equal(second.state().daily.usedSeconds,2);assert.equal(second.state().daily.requests,2);
});
test('上海午夜切分各日真实区间，重启与新日查询不重写旧账',t=>{
  const f=fixture(t,'2026-10-24T15:59:59Z');f.enable();f.limits.reserveRequest();f.limits.notePlayback('api',playing);f.advance(1500);assert.equal(f.limits.state().daily.date,'2026-10-25');assert.equal(f.limits.state().daily.usedSeconds,0.5);assert.equal(f.limits.state().daily.requests,0);
  f.limits.settleWatching('api');const usage=JSON.parse(fs.readFileSync(f.limits.usageFile,'utf8'));assert.equal(usage.days['2026-10-24'],1);assert.equal(usage.days['2026-10-25'],0.5);assert.equal(JSON.parse(fs.readFileSync(f.limits.budgetFile,'utf8')).days['2026-10-24'],1);
});
test('失去真实采样后活动租约到期，不把关机空闲整段算作观看',t=>{
  const f=fixture(t);f.enable();f.limits.notePlayback('api',playing);f.advance(120_000);assert.equal(f.limits.state().daily.usedSeconds,2);f.limits.settleWatching();assert.equal(f.limits.state().daily.usedSeconds,2);
});

test('递增时钟采样只取时一次，写出的播放租约始终恰好两秒',t=>{
  const f=fixture(t);f.enable();const start=f.now();let reads=0;f.limits.now=()=>start+reads++;
  const result=f.limits.notePlayback('api',playing),usage=JSON.parse(fs.readFileSync(f.limits.usageFile,'utf8'));
  assert.equal(reads,1);assert.equal(usage.active.fromAt,start);assert.equal(usage.active.verifiedAt,start);assert.equal(usage.active.expiresAt,start+2000);assert.equal(usage.active.expiresAt-usage.active.verifiedAt,2000);assert.equal(result.daily.usedSeconds,0);
  assert.equal(f.limits.state(start+120_000).daily.usedSeconds,2);
});

test('旧采样只多出一至五毫秒时收短内存租约，读取不改盘或增加days已记用量',t=>{
  const f=fixture(t);f.enable();const fromAt=f.now(),date=f.limits.state().daily.date;
  for(const [offset,lease]of [[0,2001],[0,2005],[5,2001],[5,2005]]){
    const value={version:1,days:{[date]:263.0680000000005,'2026-10-23':17.125},active:{source:'api',pid:process.pid,ownerId:'synthetic-legacy-clock',fromAt,verifiedAt:fromAt+offset,expiresAt:fromAt+offset+lease}},before=JSON.stringify(value,null,3);
    fs.writeFileSync(f.limits.usageFile,before);const usage=f.limits.usage();
    assert.deepEqual(usage.days,value.days);assert.equal(usage.active.expiresAt,usage.active.verifiedAt+2000);assert.equal(usage.active.fromAt,fromAt);assert.equal(usage.active.verifiedAt,fromAt+offset);assert.equal(usage.active.ownerId,value.active.ownerId);
    assert.equal(f.limits.state(fromAt).daily.usedSeconds,value.days[date]);assert.equal(fs.readFileSync(f.limits.usageFile,'utf8'),before);
  }
});

test('旧租约超过五毫秒、时序反转和其他账本损坏都不能借兼容逻辑放行',t=>{
  const f=fixture(t);f.enable();const fromAt=f.now(),date=f.limits.state().daily.date;
  const base={version:1,days:{[date]:263.0680000000005},active:{source:'api',pid:process.pid,ownerId:'synthetic-invalid-clock',fromAt,verifiedAt:fromAt,expiresAt:fromAt+2001}};
  const variants=[{active:{expiresAt:fromAt+2006}},{active:{verifiedAt:fromAt+6,expiresAt:fromAt+2007}},{active:{verifiedAt:fromAt-1,expiresAt:fromAt+2000}},{active:{expiresAt:fromAt-1}},{active:{fromAt:fromAt+0.5,verifiedAt:fromAt+0.5,expiresAt:fromAt+2001.5}},{active:{source:'other'}},{active:{pid:0}},{active:{ownerId:''}},{days:{[date]:-1}},{days:{unknown:1}},{days:{[date]:null}}];
  for(const mutation of variants){
    const value={...base,...mutation,active:{...base.active,...mutation.active}},before=JSON.stringify(value);fs.writeFileSync(f.limits.usageFile,before);
    assert.throws(()=>f.limits.usage(),/每日观看时长账本损坏/);assert.equal(fs.readFileSync(f.limits.usageFile,'utf8'),before);
  }
});
test('采样遇到短暂设置锁只延后入账，不抢锁或使状态读取失败',t=>{
  const f=fixture(t);f.enable();f.limits.notePlayback('api',playing);f.advance(1000);fs.writeFileSync(f.limits.guardFile,JSON.stringify({pid:process.pid,token:'synthetic-editor'}));
  assert.equal(f.limits.notePlayback('api',playing).accountingDeferred,true);assert.equal(f.limits.state().daily.usedSeconds,1);assert.equal(JSON.parse(fs.readFileSync(f.limits.guardFile,'utf8')).token,'synthetic-editor');fs.unlinkSync(f.limits.guardFile);f.limits.notePlayback('api',playing);assert.equal(f.limits.state().daily.usedSeconds,1);
});
test('修改时段、额度和内部session均保留今天的账，缩短时段立即停表',t=>{
  const f=fixture(t);f.enable();f.limits.notePlayback('api',playing);f.advance(1000);f.limits.reserveRequest();f.limits.savePolicy({windows:['20:00-21:00'],dailyMinutes:20},{explicit:true});assert.equal(f.limits.state().allowed,false);f.advance(60_000);assert.equal(f.limits.state().daily.usedSeconds,1);assert.equal(f.limits.state().daily.requests,1);
});
test('保存仍允许的每日额度不重置活动租约，不把自动保存间隙算成空闲',t=>{
  const f=fixture(t);f.enable();f.limits.notePlayback('api',playing);f.advance(1000);f.limits.savePolicy({dailyMinutes:20},{explicit:true});f.advance(1000);assert.equal(f.limits.state().daily.usedSeconds,2);assert.equal(f.limits.state().daily.timeLimitMinutes,20);
});
test('每日时间和请求各自限制，null无限可越过原20000请求限制且不双计',t=>{
  const f=fixture(t);f.enable({dailyMinutes:null,dailyRequests:null});const date=f.limits.state().daily.date;fs.writeFileSync(f.limits.budgetFile,JSON.stringify({version:1,sessions:{legacy:{requests:7,maxRequests:1}},days:{[date]:20000}}));assert.equal(f.limits.reserveRequest({sessionId:'legacy',source:'dsh'}).requests,20001);assert.equal(f.limits.budget().sessions.legacy.requests,8);assert.equal(f.limits.state().daily.remainingRequests,null);
  f.limits.savePolicy({dailyRequests:20002},{explicit:true});f.limits.reserveRequest();assert.equal(f.limits.state().daily.remainingRequests,0);assert.throws(()=>f.limits.reserveRequest(),/次数/);assert.equal(f.limits.state().daily.requests,20002);
});
test('总允许关闭覆盖旧video enabled，损坏总开关拒绝观看',t=>{
  const f=fixture(t);f.enable();fs.writeFileSync(f.limits.scheduleFile,JSON.stringify({enabled:false}));assert.equal(f.limits.state().allowed,false);assert.equal(f.limits.state().reasonCode,'disabled');fs.writeFileSync(f.limits.scheduleFile,'坏记录');assert.throws(()=>f.limits.state());
});
test('每日时长耗尽时暂停两个入口，重新内部开轮不能重置时长',async t=>{
  const f=fixture(t);f.enable({dailyMinutes:1});const date=f.limits.state().daily.date;fs.writeFileSync(f.limits.usageFile,JSON.stringify({version:1,days:{[date]:59},active:null}));f.limits.notePlayback('api',playing);f.advance(1000);assert.equal(f.limits.state().daily.usedSeconds,60);const paused=[];await f.limits.enforce({pause:async source=>paused.push(source)});assert.deepEqual(paused.sort(),['api','dsh']);assert.throws(()=>f.limits.markSession('dsh',{explicit:true}),/今天/);assert.equal(f.limits.state().daily.usedSeconds,60);
});
test('进行中的模型请求立即占用每日次数并显示phase，finally清零且失败不退次数',async t=>{
  const f=fixture(t);f.enable({dailyRequests:2});const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const watch=new AutonomousWatch({stateDir:f.directory,videoLimits:f.limits,now:f.now,config:{apiKey:'synthetic'},personaMemory:{context:()=>'',recordViewing:()=>null},controller:{execute:async name=>name==='douyin_observe'?{state:playing,frames:[{videoId:playing.video.id,mimeType:'image/png',data:'eA=='}],personaEvidenceId:'synthetic-evidence'}:playing,pauseForLimits:async()=>{}},agent:{decideWatch:async()=>{entered.resolve();await release.promise;throw new Error('合成HTTP失败');}}});
  t.after(()=>watch.close());watch.start({startSession:true,maxRequests:1},{explicit:true});await entered.promise;const pending=watch.state();assert.equal(pending.phase,'model');assert.equal(pending.pendingRequests,1);assert.equal(pending.counts.dailyRequests,1);assert.equal(pending.counts.dailyLimit,2);assert.equal(pending.counts.maxRequests,null);
  const other=new AutonomousWatch({stateDir:f.directory,videoLimits:new VideoLimits({stateDir:f.directory,now:f.now}),now:f.now,source:'dsh',config:{},personaMemory:{context:()=>''},controller:{execute:async()=>playing}});assert.equal(other.state().phase,'model');assert.equal(other.state().pendingRequests,1);assert.equal(other.state().owned,false);await other.close();
  release.resolve();await watch.completion;assert.equal(watch.state().pendingRequests,0);assert.equal(watch.state().phase,'idle');assert.equal(f.limits.state().daily.requests,1);assert.equal(watch.state().status,'failed');
});

test('旧入口失去owner后不暂停或结束新owner的内部运行',async t=>{
  const f=fixture(t);f.enable();const entered=Promise.withResolvers(),release=Promise.withResolvers();let pauses=0;
  const watch=new AutonomousWatch({stateDir:f.directory,videoLimits:f.limits,now:f.now,config:{apiKey:'synthetic'},personaMemory:{context:()=>'',recordViewing:()=>null},controller:{execute:async name=>name==='douyin_observe'?{state:playing,frames:[{videoId:playing.video.id,mimeType:'image/png',data:'eA=='}],personaEvidenceId:'synthetic-evidence'}:playing,pauseForLimits:async()=>{pauses++;}},agent:{decideWatch:async()=>{entered.resolve();await release.promise;return{decision:{action:'stop',reason:'合成停止',reflection:'仅合成',topics:[]}};}}});
  t.after(()=>watch.close());watch.start({startSession:true},{explicit:true});await entered.promise;
  const sessions=JSON.parse(fs.readFileSync(f.limits.sessionsFile,'utf8'));sessions.current={...sessions.current,id:'synthetic-foreign-session',status:'active'};fs.writeFileSync(f.limits.sessionsFile,JSON.stringify(sessions));
  fs.writeFileSync(watch.files.lock,JSON.stringify({version:1,pid:process.pid,runId:'synthetic-foreign-run',sessionId:'synthetic-foreign-session',source:'dsh'}));release.resolve();await watch.completion;
  assert.equal(f.limits.state().session.id,'synthetic-foreign-session');assert.equal(f.limits.state().session.status,'active');assert.equal(JSON.parse(fs.readFileSync(watch.files.lock,'utf8')).runId,'synthetic-foreign-run');assert.equal(pauses,0);
});

test('最后一次HTTP响应正常记用量后按日限额停止，重复close不结束两次或重置账本',async t=>{
  const f=fixture(t);f.enable({dailyRequests:1});const entered=Promise.withResolvers(),release=Promise.withResolvers();let ends=0;
  const originalEnd=f.limits.endSession.bind(f.limits);f.limits.endSession=options=>{ends++;return originalEnd(options);};
  const watch=new AutonomousWatch({stateDir:f.directory,videoLimits:f.limits,now:f.now,config:{apiKey:'synthetic'},personaMemory:{context:()=>'',recordViewing:()=>null},controller:{execute:async name=>name==='douyin_observe'?{state:playing,frames:[{videoId:playing.video.id,mimeType:'image/png',data:'eA=='}],personaEvidenceId:'synthetic-evidence'}:playing,pauseForLimits:async()=>{}},decisionProvider:async()=>{entered.resolve();await release.promise;return{text:JSON.stringify({action:'stop',reason:'合成停止',reflection:'仅合成',topics:[]}),usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}};}});
  t.after(()=>watch.close());watch.start({},{explicit:true});await entered.promise;assert.equal(f.limits.state().allowed,true);assert.equal(f.limits.state().daily.remainingRequests,0);assert.throws(()=>f.limits.reserveRequest(),/次数/);release.resolve();await watch.completion;
  assert.equal(watch.state().status,'limited');assert.equal(watch.state().pendingRequests,0);assert.equal(f.limits.state().daily.requests,1);assert.equal(f.limits.state().session.status,'ended');assert.equal(watch.usageLedger.state().today.totalTokens,5);await watch.close();await watch.close();assert.equal(ends,1);assert.equal(f.limits.state().daily.requests,1);
});
