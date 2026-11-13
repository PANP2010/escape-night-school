# Intro / clear 过场交接

本分支处理关卡开场与通关过场。开场由服务器同步驱动，固定 8 秒；通关继续使用既有 3 秒换关冻结，并增加关卡通过与用时显示。被抓镜头由独立 capture 工作流接入，本分支没有实现新的 capture / wipe 协议，也没有修改角色074模型文件。

## 行为与实现边界

- 真正的大厅房主 `start` 开启过场。之后正常换关及同关重来都会生成新的 intro id。直接创建的已运行测试房间保留原时钟行为；`lateObserve` 只管理观察者，不用于绕过真实房间的过场。
- intro 开始时确定参与者名单和服务器期限。Space / 触屏跳过只结束自己的演出；服务器仍冻结到全部现存参与者跳过，或原定期限到达。重复和过期 id 不改变会话。
- 迟到者接收同一 intro 及剩余时长，保持观察者，不扩充本次投票名单，也不延长期限。参与者断线从名单移除；剩下的人都跳过后即可结束。下一关加载时所有现存成员重新参与。
- 冻结期间服务器拒绝位置、视角与动作输入，以及 use / act / door / debug 世界修改；怪物、资源消耗与模拟计时暂停。聊天和位置标记仍可发送。网络快照继续到达，快照序号和每秒完整字段重发继续推进。
- intro 结束时服务器发送新的强制 `correct`，重置移动预算与计时，客户端必须回传新的 `c`。旧预测输入不能在解冻后补走。真实换关会分别产生一次出生点强制校正、一次 intro 结束强制校正。
- 相机路线来自当前关卡 nav 的连通、可走边。独立相机图将现有 nav 边按不超过 2 米细分，只保留在本关范围内、胶囊碰撞与脚底高度均合法的点和子边；从靠近出生点的可用分量选择至少 4 米飞行及 6–10 米远处剪影的路线，不修改怪物导航图。远处剪影位置检查静态碰撞、关闭的门与关卡阻挡物的视线。没有可用路线时仍显示标题卡与安全视角。客户端复用既有角色074模型，使用独立材质绘制剪影。
- 客户端等待服务器 `ended` 后释放输入；只跳过自己的演出仍显示等待提示。触控在清空输入时同步重置摇杆、视角和按钮各自保存的手指与视觉状态；跨 intro 的旧手指在解冻后继续隔离到释放，新手指可以立即操作，混合 `changedTouches` 只由控件处理其已接收的新标识。非可取消的原生触控事件继续完成隔离、跳过或释放控件，仅在 `cancelable` 时调用 `preventDefault()`。更新通知的触控手势仍可使用。减少动态效果时保留静止视角。
- clear 的 `elapsed` 是当前关卡的活跃模拟秒数，不含 intro 和后续淡出。clear 仍冻结 3 秒；既有淡出期间不连续发送 snap，因此专项 WS 检查换关时长，服务端单测直接检查位置、资源与怪物冻结。
- 同关重来的 intro 会触发客户端重新初始化这一关。全员出局仍沿用 `{ t: 'fade', restart: true }`，不伪装成通关 clear。

## 协议

`game/shared/intro.ts` 定义 `INTRO_S = 8`、`IntroEvent` 与 `ClearEvent`；`game/shared/protocol.ts` 将两种事件加入 `ServerMsg`，将跳过请求加入 `ClientMsg` 并验证正的安全整数 id。

```ts
// 服务器 → 全体；id 在本房间所有关卡与重来之间递增。
{
  t: 'event', kind: 'intro', id, level,
  startedAt, endsAt, now, skipped, ended, route,
  silhouette?,
}

// 客户端 → 服务器；只对本次参与者及当前 id 有效。
{ t: 'intro-skip', id }

// 服务器 → 全体；与既有 fade 同次发送。
{ t: 'event', kind: 'clear', id, level, elapsed, secs: 3 }
{ t: 'fade', secs: 3, restart: false }
```

`level` 从 0 开始。`startedAt`、`endsAt`、`now` 为服务器毫秒时钟，客户端用 `endsAt - now` 映射到本地单调时钟；迟到者沿用原 `startedAt` / `endsAt`。`route` / `silhouette` 使用世界坐标中的脚底位置，客户端增加相机眼高。clear 的 id 与 intro 的 id 各自递增。淡出途中加入时 clear / fade 的 `secs` 是剩余时长。

本轮触控修复只调整客户端手势与资源生命周期，intro / clear / skip 协议及服务器冻结时序不变。

## 精确文件分组

产品代码：

- `game/server/intro.ts`：固定期限、参与者、跳过与断线状态机。
- `game/server/room.ts`：start / loadLevel 接入、冻结、网络与模拟时钟拆分、预测 epoch、clear 用时与迟到同步。
- `game/shared/intro.ts`、`game/shared/protocol.ts`：intro / clear 类型与 intro-skip 解析。
- `game/client/src/intro.ts`、`game/client/src/intro.css`：标题卡、路线相机、剪影 / stinger、独立跳过、减少动态效果、手势与资源清理；隔离跨 intro 的旧手指，允许新手指及混合触控事件恢复操作。
- `game/client/src/input.ts`、`game/client/src/touch.ts`：`Input.clear()` 通知触控控件重置摇杆、视角、按住 / 切换按钮及视觉状态；`TouchControls.dispose()` 解除重置订阅并移除控件。
- `game/client/src/game.ts`：演出与输入锁、相机归还、目标显示、同关重来重置。
- `game/client/src/main.ts`：event 分发及换关展示接线；大厅的可信用户手势解锁 `sessionSound`，并将同一音频实例交给 Game；保存触控控件实例，在断线与页面离开时执行清理。
- `game/client/src/transitions.ts`：既有淡出中的通关标题与用时；与后续 intro 展示衔接。

新增验证与说明：

- `game/tests/unit/intro.test.ts`：固定期限、独立 skip、断线、非法 id。
- `game/tests/unit/intro_room.test.ts`：输入 / debug / AI / 资源冻结、连续快照序号、到期 / 校正 epoch、迟到者、clear 精确 3 秒与 elapsed、重来及直接运行房间兼容；真实校园四关均验证多点飞行、至少 4 米路线、安全胶囊路径及可见远处剪影。
- `game/tests/unit/intro_touch.test.ts`：6 项触控生命周期回归，覆盖 intro 中释放旧手指后的控件恢复、all-skip / deadline 后旧指隔离、新旧手指混合事件、更新通知手势、非可取消事件的隔离 / 跳过 / 控件释放，以及 dispose 取消订阅。
- `game/tests/cinematic/intro.spec.ts`：6 项真实 WS / 桌面 / 触屏专项。原 5 项覆盖同步 / 冻结 / skip / 期限 / 迟到 / clear、两个独立桌面 context、触屏减少动态效果及可读性、L2 多点路线与实际剪影截图；新增真实 CDP 多指回归跨 clear → L2 intro deadline、wipe → 同关 intro 全员 skip，检查旧指隔离、新控件恢复与混合 `changedTouches`。
- `game/playwright.cinematic.config.ts`：独立端口 4435、单 Chromium worker、无重试、Metal、静音，启动构建产物服务器且不复用占用端口的进程。
- `game/tests/cinematic/README.md`：专项命令、证据位置与覆盖边界。
- `docs/cinematic-sprint-handoff.md`：本交接说明。

既有测试的协议适配：

- `game/tests/unit/spawn_grace.test.ts`、`game/tests/unit/bandwidth.test.ts`：先全员 skip，测量完整的活跃游戏时长，保留原安全与带宽阈值。
- `game/tests/unit/client_loop.test.ts`：绕过构造函数的 fixture 补齐 inactive intro、横幅与教学协作者；保留换关校正 epoch，并验证 intro 重置。
- `game/tests/e2e/draw.ts`：点击画布前等待 intro 解冻。
- `game/tests/e2e/x-debug.spec.ts`、`game/tests/e2e/x-l2-dark.spec.ts`：L2 准备状态后显式等待 intro 解冻，再发送 debug。
- `game/tests/e2e/x-l3-loop.spec.ts`、`game/tests/e2e/x-l3-four.spec.ts`：开局与换关后显式等待 intro 解冻；按 clear 新文案验证；L4 精确验证出生点与 intro 结束两次 forced 校正，其位置相同、epoch 连续，无预测纠错。
- `game/tests/e2e/x-lobby.spec.ts`、`game/tests/e2e/x-lowfps-remote.spec.ts`：WS 机器人接收并回传 `correct.c`。
- `game/tests/e2e/x-mobs.spec.ts`、`game/tests/e2e/x-voice.spec.ts`、`game/tests/e2e/x-audio-transition.spec.ts`：按新 intro / clear 展示与期限适配原测试流程。
- `game/tests/e2e/x-rubber.spec.ts`、`game/tests/e2e/x-mob-sync.spec.ts`：起局后显式等待 intro 解冻，再执行移动 / 怪物同步验证，保留原阈值。
- `game/tests/e2e/x-bounds.spec.ts`、`game/tests/e2e/x-map-mobile.spec.ts`：L2 换关后显式等待 intro 解冻，再设置 debug 或操作地图。
- `game/tests/e2e/x-feedback.spec.ts`：先等待 intro 解冻；无手势的准备流程使用真实网络及 `Runtime.evaluate(userGesture: false)`，随后验证真实键盘 / 触屏首次解锁音频。检查锁定态时同时断言没有 AudioContext、没有浏览器用户激活；Chromium 使用静音参数。

## 与 capture 分支集成

按上述路径逐文件审查、合并必要差异；禁止将任一工作树整体重放到另一工作树。`game/server/room.ts`、`game/shared/protocol.ts`、`game/client/src/game.ts`、`game/client/src/main.ts` 是潜在冲突入口，必须保留双方各自的功能。

协议使用 `t: 'event'` 的可判别联合。保留既有 line、intro、clear，并把 capture 工作流实际新增的事件类型合并进同一 `ServerMsg`；不要用 capture 的 event 联合覆盖 intro / clear，或反过来删掉 capture 类型。

`main.ts` 有显式 `case 'event'`：clear 交给 `transitions.cleared()`，其他 event 继续进入 `game.onMsg()`，intro 同时完成换关展示的 arrive / spawned 接线。capture 的 event 分支必须继续转发或按自身设计处理，不能被 clear 分支或新增 switch 吞掉。`Game.onMsg()` 中同样按 `kind` 保留各个分支。

intro 锁定、恢复输入与镜头时，应与 capture 的输入锁 / 镜头归还逻辑一起审查。尤其保留服务器权威 `ended`、同关重来重置及强制校正 epoch；不要仅因客户端本地计时结束就放开服务器冻结。

触控整合须保留 `Input.clear()` → `TouchControls.reset()` 的订阅、`LevelIntro` 对旧手指的持续隔离，以及 `main.ts` 在断线 / 页面离开时的 `TouchControls.dispose()`。capture 若清空输入或归还控制，应沿用同一清理入口，避免只清键盘集合而留下摇杆、视角或按钮保存的手指标识；也要保留更新通知手势和新手指立即恢复操作的行为。

保留 `loadLevel` 的发送顺序：`room → fresh intro → loop / items / keys / bag / power / station / doors / nav / trip`。同关重来时客户端由 fresh intro 触发重建；如果将 intro 移到权威初态之后，会丢失已经到达的个人 loop 表或广播站状态。真正的首次 `start` 继续先发初态再开始演出，因为该路径不需要同关重建。

既有 `presentationReady` 表示已收到出生点，本分支测试另显式检查 `!game.intro.active`。不能把 `snaps > n`、关卡号变化或淡出隐藏当作 intro 已解冻的证据。按整合后的实际 getter 与展示代码再检查调用点，避免用语义变化掩盖等待缺失。

只交付精确产品、测试与说明文件。`game/node_modules` 仅为本地共享只读依赖；构建目录、`.green`、`node_modules` 与 `test-results` 不纳入提交。本工作流不改 todo / loop、用户配置或凭据。部署与发布由集成代理执行。

## 验证命令与当前状态

命令从本树 `game/` 目录执行，统一经过现有资源门。下列路径仅调用已有调度器，不修改该脚本：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run --maxWorkers=1
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test -c playwright.cinematic.config.ts
```

核心 intro / clear 切片已提交为 `07559d4`（33 个文件），包含独立相机图修复、四关合法路线 / 视线单测以及 L2 实际剪影截图断言。本轮补充跨 intro 触控生命周期修复、6 项单测和真实 CDP 多指专项，并更新最终验证证据；本轮增量独立于核心切片，实际提交号见本轮交接。

锁定产品已依序通过完整树 typecheck、705 项单测、构建和全部 6 项真实专项；浏览器检查保留未经筛除的 `errors = []`。最终 CDP 助手逐次核对原生 ended / active IDs，覆盖跨 intro 的旧指隔离、新控件恢复及非可取消事件处理。

触控修复前的相机基线另为 5 / 5 通过，45.1 秒，exit 0，QA 和主控已亲看当时全部 7 张关键帧；该轮证据保留在 `game/test-results/cinematic-final-baseline/`。历史失败尝试、原始日志和原生 ID 诊断均保留，最终结论以下表及最终归档为准。

| 检查 | 实际状态 |
| --- | --- |
| 最终完整树 Typecheck | exit 0，gate wall 2.57 秒 |
| 最终完整 Vitest，`--maxWorkers=1` | 83 个文件 / 705 个测试通过，32.84 秒，gate wall 33.28 秒，exit 0；包含四关合法路线 / 视线及 6 项触控生命周期回归 |
| 最终构建 | exit 0，gate wall 1.20 秒；nav 4069 nodes / 0 failures，144 ms，有既有大 chunk warning |
| 最终真实 WS / 桌面 / 触屏专项 | 6 / 6 通过，exit 0，runner 1.1 分钟，gate wall 79.49 秒；日志 `cinematic-touch-verified-browser.log`，`errors = []` 无过滤 |
| 最终关键帧截图目视检查 | QA 与主控均已亲看最终全部 7 张；L1 / L2 实际剪影可辨，标题、clear、等待提示及手机 reduced motion 标题 / 按钮均可读 |
| 开场视频与外部电影感 / 恐怖感评分 | 最终 `cinematic-intro-clear.webm` 为 1,346,091 bytes，收录在最终归档。无 Gemini 工具，未做外部评分，不宣称达到评分要求 |
| 专项服务清理 | 4435 已关闭，无遗留监听 |
| 部署 / 发布 | 本工作流不执行，交集成代理 |

最终协议证据：8 秒期限的实际墙钟为 8019 ms，期间收到 156 个新冻结快照；个人 skip 阶段分别检查了 12 和 15 个新冻结帧，迟到者收到剩余 6630 ms。clear 的 `elapsed` 为 1.4 秒，对应活跃墙钟 1.376 秒，换关 handoff 为 3069 ms。

最终 CDP 多指证据共 42 条可信原生事件，每次结束手指时均核对 ended / active IDs。deadline 和全员 skip 两种解冻后，新手指移动 20 px 的 yaw 变化均为 `-0.08000000000000007`，保留 6 位精度断言；CDP 场景 deadline 越过原定期限 50 ms 后解冻，全员 skip 在本次 intro 开始后 860 ms 结束。实际收到的 1 条非可取消事件正确完成控件释放，原始浏览器错误列表为空。

最终证据归档为 `game/test-results/cinematic-final-verified/`，共 22 个文件：`summary.json`、7 张关键帧、7 份协议 / 触控 JSON、视频、4 份最终验证日志、构建 manifest 和验证历史。`summary.json` 记录文件字节数与 SHA-256；构建 manifest 保留对应构建信息。触控证据为 `cinematic-mobile-touch-quarantine.json` 与 `cinematic-mobile-touch-diagnostic.json`。专项 README 已同步覆盖范围和证据名称，原失败尝试日志继续保留在 `game/test-results/`。

后续由集成代理逐文件整合 capture 分支，执行整合后的完整 `check` 并部署。外部视频评分仍未完成。本文确认本切片的上述检查通过，不宣称完整发布闸门或全部既有 E2E 已通过。

集成复核说明（2026-11-05）：合入既有 world touch 手势后，新手势先消耗共享的 10 px 拖动死区。当前 20 px 新手势应精确旋转 `(20 - TOUCH_DRAG_PX) × LOOK_SENS = 0.04` rad；上述 0.08 rad 是本 lane 独立版本的历史结果。单元测试与原生多指验收均保留六位小数精度，完整项目仍需在最终集成树验收。
