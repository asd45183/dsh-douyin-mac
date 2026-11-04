import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireBrowserOperationLock as acquire } from '../core.mjs';

function temporary(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-browser-lock-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  return directory;
}
const options=directory=>({directory,timeoutMs:1500});

test('浏览器操作按FIFO轮候，聊天连续申请不能越过已排队的分享',async t=>{
  const directory=temporary(t),name='tab-api-chat',order=[],holder=await acquire(name,options(directory));
  const run=label=>acquire(name,options(directory)).then(release=>{try{order.push(label);}finally{release();}});
  const share=run('分享'),chats=Array.from({length:6},(_,index)=>run(`后续聊天${index}`));
  await delay(10);assert.deepEqual(order,[]);holder();await Promise.all([share,...chats]);
  assert.deepEqual(order,['分享',...Array.from({length:6},(_,index)=>`后续聊天${index}`)]);
  assert.equal(fs.existsSync(path.join(directory,`${name}.lock`)),false);
});

test('取消排队请求不越过当前持锁者，后续请求仍可取得锁且队列不泄漏',async t=>{
  const directory=temporary(t),name='tab-api-chat',file=path.join(directory,`${name}.lock`),holder=await acquire(name,options(directory));
  const original=fs.readFileSync(file,'utf8'),abort=new AbortController();let nextEntered=false;
  const cancelled=acquire(name,{...options(directory),signal:abort.signal}).then(()=>assert.fail('已取消的等待者不可取得锁'),error=>error);
  const next=acquire(name,options(directory)).then(release=>{nextEntered=true;return release;});
  abort.abort(new Error('合成测试取消排队。'));assert.match((await cancelled).message,/取消排队/);
  await delay(15);assert.equal(nextEntered,false);assert.equal(fs.readFileSync(file,'utf8'),original);
  holder();const release=await next;assert.equal(nextEntered,true);release();
  const final=await acquire(name,options(directory));final();assert.equal(fs.existsSync(file),false);
});

test('带不同query的动态模块复用全局FIFO队列，不能各自插队',async t=>{
  const directory=temporary(t),name='tab-api-chat',other=await import(`../core.mjs?synthetic-lock-copy=${Date.now()}`);
  const holder=await acquire(name,options(directory)),order=[];
  const earlier=other.acquireBrowserOperationLock(name,options(directory)).then(release=>{order.push('另一模块先排队');release();});
  const later=acquire(name,options(directory)).then(release=>{order.push('原模块后排队');release();});
  holder();await Promise.all([earlier,later]);assert.deepEqual(order,['另一模块先排队','原模块后排队']);
});

test('释放时token被替换会拒绝删除其他锁，但仍释放本进程排队位置',async t=>{
  const directory=temporary(t),name='tab-api-chat',file=path.join(directory,`${name}.lock`),release=await acquire(name,options(directory));
  const replacement=JSON.stringify({pid:process.pid,token:'synthetic-replacement-token'});fs.writeFileSync(file,replacement);
  assert.throws(release,error=>error.code==='BROWSER_LOCK_CHANGED');assert.equal(fs.readFileSync(file,'utf8'),replacement);
  release();assert.equal(fs.readFileSync(file,'utf8'),replacement);
  fs.unlinkSync(file);const later=await acquire(name,options(directory));later();
});

test('仅确定已退出的PID可回收；正常新锁包含当前PID与独立token',async t=>{
  const directory=temporary(t),name='tab-api-chat',file=path.join(directory,`${name}.lock`);
  const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});
  await once(child,'exit');assert.ok(Number.isSafeInteger(child.pid));
  assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');
  fs.writeFileSync(file,JSON.stringify({pid:child.pid,token:'synthetic-dead-owner'}));
  const release=await acquire(name,options(directory)),owner=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(owner.pid,process.pid);assert.equal(typeof owner.token,'string');assert.notEqual(owner.token,'synthetic-dead-owner');release();
});

test('无效PID、EPERM与无法判断存活的系统错误均不能删除原锁',async t=>{
  const directory=temporary(t),name='tab-api-chat',file=path.join(directory,`${name}.lock`);
  for(const pid of [null,0,'123']){
    const original=JSON.stringify({pid,token:'synthetic-unknown-owner'});fs.writeFileSync(file,original);
    await assert.rejects(acquire(name,options(directory)),error=>error.code==='BROWSER_LOCK_RECOVERY');assert.equal(fs.readFileSync(file,'utf8'),original);
  }
  const realKill=process.kill,syntheticPid=900000001;
  let code='EPERM';t.mock.method(process,'kill',(pid,signal)=>{if(pid===syntheticPid)throw Object.assign(new Error('合成系统错误'),{code});return realKill(pid,signal);});
  const original=JSON.stringify({pid:syntheticPid,token:'synthetic-unknown-owner'});fs.writeFileSync(file,original);
  await assert.rejects(acquire(name,{directory,timeoutMs:80}),error=>error.code==='BROWSER_LOCK_BUSY');assert.equal(fs.readFileSync(file,'utf8'),original);
  code='EIO';await assert.rejects(acquire(name,options(directory)),error=>error.code==='BROWSER_LOCK_RECOVERY');assert.equal(fs.readFileSync(file,'utf8'),original);
});

test('刚创建尚未写完的空锁等待原持锁者完成，不误报损坏也不抢删',async t=>{
  const directory=temporary(t),name='tab-api-chat',file=path.join(directory,`${name}.lock`);fs.writeFileSync(file,'');
  const outcome=acquire(name,options(directory)).then(release=>({release}),error=>({error}));
  await delay(10);assert.equal(fs.readFileSync(file,'utf8'),'');
  const original=JSON.stringify({pid:process.pid,token:'synthetic-still-writing'});fs.writeFileSync(file,original);
  await delay(70);assert.equal(fs.readFileSync(file,'utf8'),original);fs.unlinkSync(file);
  const result=await outcome;assert.equal(result.error,undefined);result.release();
});

test('陈旧损坏记录保留供自检，拒绝相对目录或非法锁名',async t=>{
  const directory=temporary(t),name='tab-api-chat',file=path.join(directory,`${name}.lock`);fs.writeFileSync(file,'{');
  const old=new Date(Date.now()-5000);fs.utimesSync(file,old,old);
  await assert.rejects(acquire(name,options(directory)),error=>error.code==='BROWSER_LOCK_RECOVERY');assert.equal(fs.readFileSync(file,'utf8'),'{');
  await assert.rejects(acquire('../escape',options(directory)),TypeError);await assert.rejects(acquire(name,{directory:'relative'}),TypeError);
});
