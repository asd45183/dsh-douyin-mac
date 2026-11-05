import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { clickFanFollowBack, readFansDom } from '../chat-browser.mjs';

const html = `<p>关注 1 粉丝 2</p><div data-e2e="user-fans-container"><div>
  <div class="OlxToPIh">
    <div><a href="//www.douyin.com/user/USER_A_8chars"></a></div>
    <div class="ipQHe_cs"><div class="Zce7SWd3"><a href="//www.douyin.com/user/USER_A_8chars"><span>甲</span></a></div></div>
    <div><button class="semi-button semi-button-primary" onclick="window.clicked=(window.clicked||[]).concat('follow:USER_A_8chars')"><div>回关</div></button>
         <button class="semi-button semi-button-secondary" onclick="window.clicked=(window.clicked||[]).concat('remove:USER_A_8chars')"><div>移除</div></button></div>
  </div>
  <div class="OlxToPIh">
    <div><a href="//www.douyin.com/user/USER_C_8chars"></a></div>
    <div class="ipQHe_cs"><div class="Zce7SWd3"><a href="//www.douyin.com/user/USER_C_8chars"><span>丙</span></a></div></div>
    <div><button class="semi-button semi-button-secondary" onclick="window.clicked=(window.clicked||[]).concat('follow:USER_C_8chars')"><div>已关注</div></button>
         <button class="semi-button semi-button-secondary"><div>移除</div></button></div>
  </div>
  <div class="OlxToPIh">
    <div><a href="//www.douyin.com/user/USER_B_8chars"></a></div>
    <div class="ipQHe_cs"><div class="Zce7SWd3"><a href="//www.douyin.com/user/USER_B_8chars"><span>乙</span></a></div></div>
    <div><button class="semi-button semi-button-primary" onclick="window.clicked=(window.clicked||[]).concat('follow:USER_B_8chars')"><div>相互关注</div></button>
         <button class="semi-button semi-button-secondary" onclick="window.clicked=(window.clicked||[]).concat('remove:USER_B_8chars')"><div>移除</div></button></div>
  </div>
</div><div>暂时没有更多了</div></div>`;

async function fixture(t) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent(html);
  t.after(async () => { await browser.close().catch(() => {}); });
  return page;
}

test('读取粉丝行：稳定 id、昵称、关系与末尾标记', async t => {
  const page = await fixture(t);
  const snapshot = await page.evaluate(readFansDom);
  assert.equal(snapshot.found, true);
  assert.deepEqual(snapshot.rows.map(row => [row.userId, row.name, row.relation]), [
    ['USER_A_8chars', '甲', '回关'],
    ['USER_C_8chars', '丙', '已关注'],
    ['USER_B_8chars', '乙', '相互关注'],
  ]);
  assert.deepEqual(snapshot.counters, { following: '1', fans: '2' });
  assert.equal(snapshot.end, true);
});

test('回关只点主按钮，绝不点同一行的移除', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(clickFanFollowBack, { userId: 'USER_A_8chars' });
  assert.equal(result.clicked, true);
  assert.deepEqual(await page.evaluate(() => window.clicked), ['follow:USER_A_8chars']);
});

test('已互关、已关注或未知的粉丝不点击任何按钮', async t => {
  const page = await fixture(t);
  assert.deepEqual(await page.evaluate(clickFanFollowBack, { userId: 'USER_C_8chars' }), { clicked: false, reason: 'not-pending' });
  assert.deepEqual(await page.evaluate(clickFanFollowBack, { userId: 'USER_B_8chars' }), { clicked: false, reason: 'not-pending' });
  assert.deepEqual(await page.evaluate(clickFanFollowBack, { userId: 'USER_D_8chars' }), { clicked: false, reason: 'not-found' });
  assert.equal(await page.evaluate(() => window.clicked), undefined);
});
