# macOS Chrome 移植验证（0.1.0，2026-11-04）

本记录对应 `dsh-douyin-mac` 0.1.0：基于上游 `dsh-douyin-agent` 1.4.6 源码，移植为 macOS 上只运行 Google Chrome 的 DSH 插件形态。

## 环境

- macOS（Apple Silicon / Intel 通用），Google Chrome 156.0.8078.79
- DSH 0.2.2-alpha.3（本地构建），web profile 与独立测试 profile 共用同一份状态目录
- Node.js 22.22.2（测试）；插件宿主由 DSH 自带运行时提供
- 专用浏览器：Playwright `channel: 'chrome'`，独立资料目录 `~/.dsh/douyin-browser/cli-profile`，CDP 端口 9227

## 已实测通过

| 项目 | 证据 |
| --- | --- |
| 插件加载 | web profile 安装后设置页出现“刷抖音”分类，34 个 `douyin_*` 工具注册进会话 |
| 设置页 | 基础设置 / 视频观看 / 自检与用量 / 好友互动 / 公开评论 / 音频与密钥 / 观看日报 / DSH 模型全部渲染（（截图已删除：含本机账号与会话信息，不随仓库发布）） |
| 抖音登录 | 扫码后专用 Chrome 保持登录；`douyin_status` 返回 `loginRequired:false`、真实作品 ID/作者/时长（截图已删除：含本机桌面与会话信息，不随仓库发布） |
| 自主观看 | 观察 → 分镜/画面采样 → DSH 模型决策（`skip` 等）→ 换片/停留 → 按每日额度停止；单轮累计观看 231.7 秒、模型请求 15 次后正常停止 |
| 静默观看 | 最小化专用窗口后播放进度、画面采样和模型决策继续；关闭静默可恢复窗口 |
| 诊断与控制 | 设置页“打开抖音”“刷新插件状态”“一键自检”可用；`/api/douyin-browser/state` 正常返回 |
| 额度与暂停 | 达到每日请求上限时以 `limited` 停止并提示次日恢复；停止后清理运行锁，不残留预算变化 |

## 并发与平台修复

- 静默设置与观看启动共用 `watch-mode` 控制锁：等待 15 秒、回收已退出进程留下的锁、拒绝接管无法核对内容的外来锁；窗口/静默应用串行化。
- 修复串行化引入的自锁：`apply()` 不再等待自己所属的 `applyBrowser()`。
- Chrome 在 DSH 沙箱下需要 `--no-sandbox` 才能启动；macOS 会显示一条不受支持的命令行标记提示，不影响功能。
- Chrome 136 起默认资料目录不允许开启远程调试，本移植始终使用独立资料目录。
- macOS `os.tmpdir()` 经过 `/var → /private/var` 符号链接：日报目录校验保持严格，测试夹具改用真实路径。
- 测试默认超时调整为 180 秒，避免 Mac 上真实 Chrome 用例在并行时误判。

## 测试结果与已知失败

完整套件（`npm test`，`--test-timeout=180000`）：**1223 项，1193 通过，15 失败，7 取消，8 跳过**。失败分类：

| 类别 | 项目 | 原因 |
| --- | --- | --- |
| 可选音频（6） | 媒体合成、MiMo/MiniMax、本地 Whisper 用例 | 本机未安装 ffmpeg 与本地 Whisper 依赖；音频功能默认关闭，不影响观看与聊天 |
| Mac 无头窗口语义（2） | 隔离宿主焦点、连续截图 | 无头 Chrome 在 macOS 上有时不区分页面焦点，或截图期间出现滚动事件；单独运行可通过 |
| 聊天/评论浏览器（2） | `chat-browser`、`comment-browser` | 并行负载下 180 秒超时；单独运行可通过 |
| 后台建页（1） | 有界面 Chrome 后台建页并最小化 | macOS 窗口行为差异，测试断言依赖 Windows 的最小化语义 |
| 级联取消（4） | 共享 worker/收据相关用例 | 上游用例在并行取消时互相等待，属测试编排问题 |

未覆盖：真实公开评论发布确认、推荐流长时间连续播放、真实群聊与多收件人分享、Windows 以外宿主版本矩阵。历史 Windows 记录的结论不自动适用于本移植。

## 复现

```sh
cd dsh-douyin-mac
npm install
npm test
# 单文件复跑
node --test tests/watch-mode.test.mjs tests/autonomous-share.test.mjs
```

插件安装：

```sh
dsh plugin --profile web add .
```

状态目录 `~/.dsh/douyin-browser/`，专用 Chrome 资料目录 `~/.dsh/douyin-browser/cli-profile`。删除资料目录会丢失登录态，但不会影响人格与记忆。
