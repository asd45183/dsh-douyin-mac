import test from 'node:test';
import assert from 'node:assert/strict';
import { dedicatedHostReadiness } from '../core.mjs';

const options = { pid: 200, profile: 'synthetic-dedicated-profile', port: 9227, processAlive: pid => pid === 200 };
const state = { pid: 200, profile: options.profile, port: 9227, ready: true };

test('新宿主尚未覆盖旧状态文件时继续等待，不把旧进程退出误判为新启动失败', () => {
  assert.equal(dedicatedHostReadiness({ ...state, pid: 100 }, options), 'pending');
  assert.equal(dedicatedHostReadiness(null, options), 'pending');
  assert.equal(dedicatedHostReadiness({ ...state, ready: false }, options), 'pending');
  assert.equal(dedicatedHostReadiness(state, options), 'ready');
});

test('仅本次目标进程退出才报告失败，不接受另一宿主或资料目录的就绪记录', () => {
  assert.equal(dedicatedHostReadiness({ ...state, pid: 300 }, options), 'pending');
  assert.equal(dedicatedHostReadiness({ ...state, profile: 'foreign-profile' }, options), 'foreign');
  assert.equal(dedicatedHostReadiness({ ...state, port: 9228 }, options), 'foreign');
  assert.equal(dedicatedHostReadiness(state, { ...options, processAlive: () => false }), 'failed');
  assert.equal(dedicatedHostReadiness(state, { ...options, pid: null }), 'failed');
});
