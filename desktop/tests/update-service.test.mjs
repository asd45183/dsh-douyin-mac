import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UpdateService, newerVersion, parseVersion } from '../src/update-service.mjs';
async function fixture(t,{badHash=false,badUrl=false,split=false}={}){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-updater-'));t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});const bytes=Buffer.concat([Buffer.from('MZ'),Buffer.alloc(2046,27)]),hash=createHash('sha256').update(bytes).digest('hex'),name='Dafeiyu-Douyin-API-1.4.2-win-x64.exe',url=`https://github.com/LockyBee/dsh-douyin-agent/releases/download/v1.4.2/${name}`,calls=[];const updater=new UpdateService({version:'1.4.1',directory,fetchImpl:async(address,options)=>{calls.push({address,options});if(address.includes('/releases/latest'))return Response.json({tag_name:'v1.4.2',draft:false,prerelease:false,assets:[{name,size:bytes.length,browser_download_url:badUrl?'https://evil.invalid/payload.exe':url},{name:name+'.sha256',size:100,browser_download_url:url+'.sha256'}]});if(address.endsWith('.sha256'))return new Response((badHash?'0'.repeat(64):hash)+'  '+name);if(split)return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,1));controller.enqueue(bytes.subarray(1));controller.close();}}));return new Response(bytes);}});return{directory,updater,calls,hash,bytes};}
test('检查只访问固定官方仓库，完整正式版本可下载，校验后允许使用且不回显本地路径',async t=>{const f=await fixture(t);assert.equal((await f.updater.check()).status,'available');const downloaded=await f.updater.download();assert.equal(downloaded.status,'downloaded');assert.equal(downloaded.executable,undefined);const verified=await f.updater.verifiedExecutable();assert.equal(verified.sha256,f.hash);assert.deepEqual(await fs.readFile(verified.file),f.bytes);assert.equal(f.calls.every(item=>!item.options.headers.authorization),true);await fs.writeFile(verified.file,'被改变');await assert.rejects(f.updater.verifiedExecutable(),/已改变/);});
test('没有正式软件发布明确返回未发布，版本比较不降级、不接受不完整版本',async()=>{assert.equal(newerVersion('1.4.0','1.4.1'),false);assert.equal(newerVersion('1.5.0','1.4.1'),true);assert.equal(newerVersion('1.4.2-rc.1','1.4.1'),false);const updater=new UpdateService({version:'1.4.1',directory:path.resolve(os.tmpdir()),fetchImpl:async()=>new Response('',{status:404})});assert.equal((await updater.check()).status,'unpublished');});
test('外站下载地址、校验不符与未检查下载均被拒绝，没有留下部分EXE',async t=>{const bad=await fixture(t,{badUrl:true});assert.equal((await bad.updater.check()).status,'error');assert.equal(bad.calls.length,1);const f=await fixture(t,{badHash:true});assert.equal((await f.updater.check()).status,'available');assert.equal((await f.updater.download()).status,'error');assert.deepEqual(await fs.readdir(f.directory),[]);await assert.rejects(f.updater.verifiedExecutable(),/先完成/);});
test('检查与下载重复点击不重复发起任务',async t=>{const f=await fixture(t);await Promise.all([f.updater.check(),f.updater.check()]);assert.equal(f.calls.length,1);await Promise.all([f.updater.download(),f.updater.download()]);assert.equal(f.calls.filter(item=>!item.address.endsWith('.sha256')&&!item.address.includes('/latest')).length,1);});
test('下载首个网络块只有一个字节时仍正确核对EXE头和SHA256',async t=>{const f=await fixture(t,{split:true});await f.updater.check();assert.equal((await f.updater.download()).status,'downloaded');assert.deepEqual(await fs.readFile((await f.updater.verifiedExecutable()).file),f.bytes);});

test('当前测试版可初始化，同核心正式版优于beta，较低正式版不降级且远端仍只接受正式版本',()=>{
  const version='1.4.5-beta.1',updater=new UpdateService({version,directory:path.resolve(os.tmpdir()),fetchImpl:()=>assert.fail('初始化不访问远端')});assert.equal(updater.state().currentVersion,version);
  assert.equal(newerVersion('1.4.5',version),true);assert.equal(newerVersion('v1.4.5',version),true);assert.equal(newerVersion('1.4.4',version),false);assert.equal(newerVersion('1.4.6',version),true);assert.equal(newerVersion('2.0.0',version),true);assert.equal(newerVersion('1.4.5-beta.2',version),false);assert.equal(parseVersion(version),null);
  assert.equal(newerVersion('1.4.5','1.4.5-beta.1+local.001'),true);assert.equal(newerVersion('1.4.5','1.4.5+local.001'),false);
});

test('当前app只接受完整合法SemVer，测试标识数字不能带前导零',()=>{
  for(const version of ['1.4.5-beta.1','1.4.5-rc.0','1.4.5-0','1.4.5-alpha-beta.2+local.001'])assert.doesNotThrow(()=>new UpdateService({version,directory:path.resolve(os.tmpdir())}));
  for(const version of ['1.4','01.4.5-beta.1','1.04.5-beta.1','1.4.05-beta.1','1.4.5-beta.01','1.4.5-01','1.4.5-beta..1','1.4.5-beta.','1.4.5-','1.4.5+','1.4.5+build..1','1.4.5-beta_1','1.4.5-beta.1\n',' 1.4.5-beta.1','9007199254740992.4.5-beta.1']){assert.throws(()=>new UpdateService({version,directory:path.resolve(os.tmpdir())}),/版本或下载目录无效/);assert.equal(newerVersion('2.0.0',version),false);}
});

test('测试版没有正式更新时明确分别显示当前测试版与GitHub最新正式版，不下载',async()=>{
  let calls=0;const updater=new UpdateService({version:'1.4.5-beta.1',directory:path.resolve(os.tmpdir()),fetchImpl:async()=>{calls++;return Response.json({tag_name:'v1.4.4',draft:false,prerelease:false,assets:[]});}});
  const state=await updater.check();assert.equal(state.status,'current');assert.equal(state.currentVersion,'1.4.5-beta.1');assert.equal(state.latestVersion,'1.4.4');assert.match(state.message,/当前测试版 1\.4\.5-beta\.1/);assert.match(state.message,/GitHub 最新正式版为 1\.4\.4/);assert.doesNotMatch(state.message,/当前已是.*最新版本/);assert.equal(calls,1);assert.equal(updater.candidate,undefined);
});

test('测试版只发现符合稳定包名的正式更新，draft与prerelease仍拒绝',async()=>{
  const version='1.4.5',name=`Dafeiyu-Douyin-API-${version}-win-x64.exe`,url=`https://github.com/LockyBee/dsh-douyin-agent/releases/download/v${version}/${name}`;
  const release={tag_name:`v${version}`,draft:false,prerelease:false,assets:[{name,size:2048,browser_download_url:url},{name:name+'.sha256',browser_download_url:url+'.sha256'}]};let calls=0;
  const updater=new UpdateService({version:'1.4.5-beta.1',directory:path.resolve(os.tmpdir()),fetchImpl:async()=>{calls++;return Response.json(release);}});const state=await updater.check();assert.equal(state.status,'available');assert.equal(state.name,name);assert.equal(calls,1);
  for(const extra of [{draft:true},{prerelease:true},{tag_name:'v1.4.6-beta.1'}]){const rejected=new UpdateService({version:'1.4.5-beta.1',directory:path.resolve(os.tmpdir()),fetchImpl:async()=>Response.json({...release,...extra})});assert.equal((await rejected.check()).status,'error');assert.equal(rejected.candidate,undefined);}
  const missing=new UpdateService({version:'1.4.5-beta.1',directory:path.resolve(os.tmpdir()),fetchImpl:async()=>new Response('',{status:404})});assert.match((await missing.check()).message,/当前测试版.*GitHub 暂未发布.*正式版本/);
});
