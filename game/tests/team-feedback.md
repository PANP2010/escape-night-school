# Team capture feedback acceptance

All commands run from `game/`, using the existing dependencies. Build the current checkout first:

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- node node_modules/vitest/vitest.mjs run tests/unit/team_feedback.test.ts tests/unit/student_down.test.ts tests/unit/warden_student.test.ts tests/unit/student_beam.test.ts tests/unit/room_mobs.test.ts tests/unit/spawn_grace.test.ts tests/unit/interact.test.ts tests/unit/room.test.ts --maxWorkers=1
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
```

For the renderer-free, real three-WebSocket regression, start the built server in a separate terminal:

```sh
PORT=4463 HOST=127.0.0.1 NODE_ENV=development node dist-server/index.js
```

Then run `node tests/team-feedback-ws.ts`. It tests actual Warden/monitor collisions, private victim messages, ordinary and spectator recipients, duplicate capture attempts, a three-second rescue, and snapshots beyond the original thirty-second expiry. Results and received-event evidence go to `test-results/team-feedback-ws.json`. Stop that server after the run.

The isolated Playwright config manages its own server on 4463, so the port must be free before this command:

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node node_modules/@playwright/test/cli.js test -c playwright.team-feedback.config.ts
```

It uses one Chromium process with Metal and muted audio. The touch scenario uses one 640×360 page and two real Node WebSocket teammates. It checks private central feedback, exact private-message routing, a single exact short teammate chat notice, 3.5 seconds of actual animation frames with fixed root position and the lying body inside the camera view, and a sustained successful rescue. Every authoritative snapshot from the page and both peers must remain active beyond the original thirty-second expiry. The original 640/1280 chat-layout regression retains its desktop settings and assertions, using an ordinary chat message after checking the private capture UI.

Screenshots are `test-results/team-feedback-mobile-{self,down,revived}.png`; animation measurements are in `test-results/team-feedback-mobile.json`. Video and test artifacts stay in `test-results/team-feedback-playwright/`. Screenshots need human inspection; the recording has no external Gemini score unless a later review supplies one.

## 集成交接

产品切片为 `ef6f75a`（抓捕来源与队友短通知）、`4a8295f`（远端倒地微呼吸）、`da77b41`（倒地清除旧姿态）、`cb7d286`（左膝贴地接触边界修复与确定性回归）。与 capture lane 的最新集成参照 `5727cef` 合并时，`main.ts` 的本人 `caught` 必须保留 `game?.onMsg(m)` 和 Game 内部去重，不得在外层无条件更新标题；引入 `TeamFeedback` 并保留独立 `team-caught` 分支。`room.ts` 必须保留 capture 先私发扩展 `CaughtEvent` 再发送 `correct` 的顺序，以及实际怪物位置的第三个 `source` 参数，在该流程中追加队友 episode 通知。capture `seq` 按玩家递增，队友通知 `episode` 按房间递增，两者不可合并。

`punish` 的姿态标志修复也必须保留：清除 `F_HIDE | F_CROUCH | F_RUN`，保留 `F_LIGHT`，避免蹲着被抓后远端根节点仍被压低 0.5 米；调试倒地同样清除旧姿态。

`team_feedback.test.ts`、真实 WS 脚本和手机 spec 对本人 `caught` 的精确断言要按扩展字段和实际 source 参数同步；不能放宽收件人数、来源、hold 或序号断言。真实 WS 覆盖换关后的 episode；关卡重试及客户端重复 episode 去重由 unit 覆盖。全量 `check` 和部署由集成代理串行执行。

## 本轮验证记录（2026-11-05）

子审计曾未经 gate 执行 `student_down` 并得到 12/12；该结果不计入验收。下列最终单测、typecheck、build 和浏览器验收均通过对应 gate 执行；无渲染真实 WS 按前文独立 Node 命令执行。生成的 JSON、日志、截图和视频保留在 `test-results/`，不提交。

合规 gate 的首轮定向单测为 7 文件通过、1 文件失败（57 passed / 1 failed，含当时的临时诊断测试）。新增确定性倒地回归测得完整蒙皮最低点 `-0.02257474468332335 m`，未通过原有 `>-0.02 m` 约束。归因为左膝蒙皮超出既有接触 pad，静态无呼吸对照也存在；`cb7d286` 仅将 `GROUND` 的 `shinL` pad 从 `.06` 调至 `.085`。约束保持不变，修复后的合规单文件回归为 `student_down.test.ts` 14/14 通过（4.21 秒），覆盖 seed `0/.3/.7` 的冷/暖起始姿态及 30/60 FPS 比较；其余 7 文件 43 个测试保持首轮通过记录。

最终产品 HEAD `cb7d286` 的合规 typecheck、client/server/nav build 均通过，nav 为 4069 nodes / 0 failures。命令与红绿记录保存在 `test-results/team-feedback-validation.json`，日志为 `team-feedback-typecheck.log` 和 `team-feedback-build.log`。

真实三 WS 验证通过：角色074与无脸值日生的私发收件人数均为 `[0,1,0]`，队友短通知为 `[1,0,1]`，真实换关后 episode 从 `1` 增至 `2`。warden抓捕 tick `28`，救起耗时 `3053 ms`，救起后 tick `104–653` 三端各 `550` 份权威快照持续正常，越过原倒地截止点且没有第二条通知。自起的 4463 验证服务器已关闭。

合规浏览器验收为 3/3 通过（55.8 秒）：一个 Metal、静音 Chromium 会话依次执行 640×360 touch 手机场景及 640×360 / 1280×720 桌面聊天布局回归。手机 DOM 确认触屏模式、中央本人提示和唯一队友短通知。远端倒地连续 `212` 帧、`3500.6 ms`，胸部转角范围 `.047999994 rad`、胸部相对髋部高度范围 `.003974998 m`，完整身体顶点高度 `.53128–.53674 m`、最低点 `-.001447–-.001226 m`，根位置固定且模型在镜头内。蹲跑标志由 `7` 清为保留手电的 `4`。

队友救起耗时 `3044 ms`、恢复站立高度 `1.63120 m`；手机和两真实 WS 各检查 `472` 份队友救起后快照及 `632` 份本人救起后快照，持续正常并跨过原倒地截止点。页面异常与 console error 均为 0，4463 已无监听。

验证代理与主代理亲见新手机 self/down/revived 三张截图：本人只有中央抓捕倒计时，无重复长聊天；远端躺地清楚、短通知一条且可读，救起后站立。主代理另审阅两张 `iter-211-hint` 截图，确认两种宽度的提示布局没有倒计时或聊天遮挡。视频保存在 Playwright artifact；本轮没有外部 Gemini 评分，不声称取得该评分。

## 改动文件

产品代码（5）：

- `game/client/src/main.ts`
- `game/client/src/teamFeedback.ts`
- `game/client/src/warden/student.ts`
- `game/server/room.ts`
- `game/shared/protocol.ts`

单测（2）：

- `game/tests/unit/team_feedback.test.ts`
- `game/tests/unit/student_down.test.ts`

验证配置、脚本与交接文档（7）：

- `game/playwright.team-feedback.config.ts`
- `game/tests/team-feedback-peer.ts`
- `game/tests/team-feedback-ws.ts`
- `game/tests/e2e/team-feedback.spec.ts`
- `game/tests/e2e/x-hint.spec.ts`
- `game/tests/shot-hint-chat.mjs`
- `game/tests/team-feedback.md`
