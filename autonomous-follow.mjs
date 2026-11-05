import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', stop, { once: true });
});
const userPattern = /^[A-Za-z0-9_-]{6,}$/;

function read(file, fallback) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw Error();
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail('自动回关记录无法核对，未重置许可、预算或回执。'); }
}
function write(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

const defaults = () => ({ version: 1, enabled: false, dailyLimit: 0, perRunLimit: 3, minIntervalMs: 8_000 });
const emptyLedger = () => ({ version: 1, days: {}, seen: {}, operations: [] });

/**
 * 自动回关：只处理“本次新发现、且尚未回关”的粉丝。
 *
 * 许可默认关闭且每日上限为 0；每次动作前先落回执，动作后按粉丝行内主按钮的
 * 文案回读结果。未确认的记录会冻结后续运行，直到本人在设置页核对。
 */
export class AutonomousFollow {
  constructor({ chat, stateDir = resolveRuntimePaths().stateDir, intervalMs = 10 * 60_000, now = Date.now } = {}) {
    if (!chat?.listFans || !chat?.followBack) throw new TypeError('自动回关缺少粉丝读取或回关接口。');
    if (typeof now !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new TypeError('自动回关的检查间隔无效。');
    Object.assign(this, { chat, stateDir, intervalMs, now });
    this.files = { policy: path.join(stateDir, 'follow-policy.json'), ledger: path.join(stateDir, 'follow-ledger.json') };
    this.running = null;
    this.timer = null;
    this.lastRunAt = null;
    this.lastError = null;
    this.closed = false;
  }

  policy() {
    const value = read(this.files.policy, defaults());
    if (!value || value.version !== 1 || typeof value.enabled !== 'boolean'
      || !Number.isInteger(value.dailyLimit) || value.dailyLimit < 0 || value.dailyLimit > 20
      || !Number.isInteger(value.perRunLimit) || value.perRunLimit < 1 || value.perRunLimit > 5
      || !Number.isInteger(value.minIntervalMs) || value.minIntervalMs < 3_000 || value.minIntervalMs > 60_000) {
      throw fail('自动回关许可或次数上限损坏，未继续。');
    }
    return value;
  }

  ledger() {
    const value = read(this.files.ledger, emptyLedger());
    if (!value || value.version !== 1 || typeof value.days !== 'object' || typeof value.seen !== 'object' || !Array.isArray(value.operations)) {
      throw fail('自动回关回执损坏，未继续。');
    }
    return value;
  }

  /** 未核对的动作：点击后没有读回结果。存在时冻结后续运行。 */
  unresolved(ledger = this.ledger()) {
    return ledger.operations.filter(operation => operation.status === 'clicking' || operation.status === 'uncertain');
  }

  state() {
    const policy = this.policy();
    const ledger = this.ledger();
    const date = day(this.now());
    const used = ledger.days[date] || 0;
    return {
      protocol: 'autonomous-follow-v1',
      enabled: policy.enabled,
      policy: { enabled: policy.enabled, dailyLimit: policy.dailyLimit, perRunLimit: policy.perRunLimit, minIntervalMs: policy.minIntervalMs },
      daily: { date, used, remaining: Math.max(0, policy.dailyLimit - used) },
      paused: this.unresolved(ledger).length > 0,
      needsReview: this.unresolved(ledger).map(({ operationId, userId, name, status, startedAt }) => ({ operationId, userId, name, status, startedAt })),
      running: Boolean(this.running),
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      recent: ledger.operations.slice(-10).map(({ operationId, userId, name, status, startedAt, completedAt, relation }) => ({ operationId, userId, name, status, startedAt, completedAt, relation })),
      seen: Object.keys(ledger.seen).length,
    };
  }

  configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('自动回关只能由本人显式设置。', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['enabled', 'dailyLimit', 'perRunLimit'].includes(key))) {
      throw fail('自动回关只接受总开关、每日上限和每次上限。', 400);
    }
    const policy = this.policy();
    const next = {
      ...policy,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.dailyLimit === undefined ? {} : { dailyLimit: input.dailyLimit }),
      ...(input.perRunLimit === undefined ? {} : { perRunLimit: input.perRunLimit }),
    };
    if (typeof next.enabled !== 'boolean') throw fail('总开关必须是布尔值。', 400);
    if (!Number.isInteger(next.dailyLimit) || next.dailyLimit < 0 || next.dailyLimit > 20) throw fail('每日上限须为 0 至 20 的整数。', 400);
    if (!Number.isInteger(next.perRunLimit) || next.perRunLimit < 1 || next.perRunLimit > 5) throw fail('每次上限须为 1 至 5 的整数。', 400);
    if (next.enabled && next.dailyLimit < 1) throw fail('开启自动回关前须把每日上限设为 1 至 20。', 400);
    if (next.enabled && this.unresolved().length) throw fail('上次回关结果需要核对；核对前不能开启。', 409);
    write(this.files.policy, next);
    if (next.enabled) this.start(); else this.stop();
    return this.state();
  }

  /** 核对一条未确认的回关：只接受“已回关”或“未回关”。 */
  resolve({ operationIds, outcome } = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('回关结果只能由本人核对。', 403);
    const ids = Array.isArray(operationIds) ? operationIds.filter(id => typeof id === 'string') : [];
    if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw fail('请选择要核对的回关记录。', 400);
    if (!['confirmed', 'not-sent'].includes(outcome)) throw fail('核对结果只能是已回关或未回关。', 400);
    const ledger = this.ledger();
    const target = new Set(ids);
    let changed = 0;
    for (const operation of ledger.operations) {
      if (!target.has(operation.operationId) || !['clicking', 'uncertain'].includes(operation.status)) continue;
      operation.status = outcome === 'confirmed' ? 'resolved-confirmed' : 'resolved-not-sent';
      operation.completedAt = new Date(this.now()).toISOString();
      if (ledger.seen[operation.userId]) ledger.seen[operation.userId].status = outcome === 'confirmed' ? 'confirmed' : 'not-sent';
      changed += 1;
    }
    if (!changed) throw fail('没有找到待核对的回关记录。', 404);
    write(this.files.ledger, ledger);
    return this.state();
  }

  start() {
    if (this.closed || this.timer) return this.state();
    if (!this.policy().enabled) return this.state();
    this.timer = setInterval(() => { void this.runOnce().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    return this.state();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.state();
  }

  async close() { this.closed = true; this.stop(); }

  /** 单次运行：只回关本次新发现、尚未处理的粉丝。并发调用共享同一次运行。 */
  runOnce({ signal } = {}) {
    if (this.closed) return Promise.reject(fail('自动回关已关闭。'));
    if (this.running) return this.running;
    this.running = this.#run(signal).finally(() => { this.running = null; });
    return this.running;
  }

  async #run(signal) {
    const policy = this.policy();
    if (!policy.enabled) return { ran: false, reason: 'disabled' };
    if (policy.dailyLimit < 1) return { ran: false, reason: 'no-budget' };
    const before = this.ledger();
    if (this.unresolved(before).length) return { ran: false, reason: 'needs-review' };
    const date = day(this.now());
    const remaining = policy.dailyLimit - (before.days[date] || 0);
    if (remaining <= 0) return { ran: false, reason: 'daily-limit' };

    this.lastRunAt = new Date(this.now()).toISOString();
    let snapshot;
    try {
      snapshot = await this.chat.listFans({ signal });
    } catch (error) {
      this.lastError = error?.message || '读取粉丝列表失败';
      throw error;
    }
    this.lastError = null;
    const ledger = this.ledger();
    // 让路（not-sent）不是一次真实动作，下次运行要能重试；其余已见过的粉丝不再处理。
    const candidates = snapshot.fans.filter(fan => fan.relation === '回关' && userPattern.test(fan.userId)
      && (!ledger.seen[fan.userId] || ledger.seen[fan.userId].status === 'not-sent'));
    const plan = candidates.slice(0, Math.min(policy.perRunLimit, remaining));
    const results = [];
    for (const [index, fan] of plan.entries()) {
      if (index > 0) await sleep(policy.minIntervalMs, signal);
      if (!this.policy().enabled) break;
      if (signal?.aborted) break;
      const operationId = randomUUID();
      ledger.operations.push({ operationId, userId: fan.userId, name: fan.name, status: 'clicking', startedAt: new Date(this.now()).toISOString() });
      ledger.seen[fan.userId] = { name: fan.name, firstSeenAt: new Date(this.now()).toISOString(), status: 'clicking' };
      write(this.files.ledger, ledger);
      try {
        const outcome = await this.chat.followBack({ signal, userId: fan.userId, name: fan.name });
        const operation = ledger.operations.find(item => item.operationId === operationId);
        operation.completedAt = new Date(this.now()).toISOString();
        operation.relation = outcome.relation || null;
        if (outcome.confirmed && !outcome.already) {
          operation.status = 'confirmed';
          ledger.days[date] = (ledger.days[date] || 0) + 1;
          ledger.seen[fan.userId].status = 'confirmed';
        } else if (outcome.already) {
          operation.status = 'already';
          ledger.seen[fan.userId].status = 'already';
        } else {
          operation.status = 'uncertain';
          operation.reason = outcome.reason || 'unconfirmed';
          ledger.seen[fan.userId].status = 'uncertain';
        }
        results.push({ userId: fan.userId, status: operation.status });
      } catch (error) {
        const operation = ledger.operations.find(item => item.operationId === operationId);
        operation.completedAt = new Date(this.now()).toISOString();
        operation.reason = error?.code || error?.message || 'error';
        // 让路或被风控拦下：动作没发生，记 not-sent；页面状态异常记未确认。
        operation.status = ['CHAT_FOREGROUND', 'BROWSER_NOT_RUNNING', 'CHAT_PAGE_NOT_OPEN', 'FANS_LIST_UNAVAILABLE'].includes(error?.code) ? 'not-sent' : 'uncertain';
        ledger.seen[fan.userId].status = operation.status;
        write(this.files.ledger, ledger);
        results.push({ userId: fan.userId, status: operation.status });
        if (operation.status === 'uncertain' || error?.code === 'CHAT_LOGIN_REQUIRED' || error?.needsUserAction) break;
        continue;
      }
      write(this.files.ledger, ledger);
      if (ledger.operations.find(item => item.operationId === operationId)?.status === 'uncertain') break;
    }
    return { ran: true, planned: plan.length, results, state: this.state() };
  }
}
