# 抓捕与罚站表现交接

> 以下 v040 记录仅供历史追溯。用户最新要求已由 `f4b4c94` 实现：抓捕后身体保留在接触点；没有站立队友可救援时立即转观察并触发本关重试；仍有站立队友时保留 30 秒救援窗口。下文“回罚站点”、相机与身体分离 6.715 m、单人等待 30 秒的旧记录均已被取代，不能用于当前验收。

## v050 抓捕规则、手机布局与真实救援复验

本轮在独立工作树 `/private/tmp/escape-review-capture-finals` 继续验收，源码基线为 `9cb7e4c`，另含抓捕原地与立即全灭规则 `f4b4c94`（本树 `f1a05c1`）、直接点柜交互修复 `83352a5`（本树 `972146a`）、串行单元闸门 `998cd0c`（本树 `c8c8a31`）、手机倒地安全区 CSS `8706020`（本树 `999c56d`）。`e0bb9dd` 只让非生产 `debug('warden')` 显式召唤越过上一轮路线恢复暂停，不改变自然 AI 的暂停规则。`8128384` 修复关闭的原生 settings dialog 恒阻塞聊天：原生 dialog 只在 open 时拦截，自定义 modal 需要实际可见。

本轮已实际通过的定向证据：

- 首轮核心浏览器 9 项中的 7 项通过，日志 `/tmp/escape-capture-finals-browser-core-1.log`：640×360 三名真实客户端抓捕与救援、键盘真实 3 秒救援、单人以 30 秒 down 计时触发但 1 秒内立即全灭并同 seed / level 新 incarnation 重试、640×360 / 1280×720 抓捕提示布局、三台真实 WebSocket 的 1 fps 键盘续期与取消。
- 触屏断线用例在第三轮通过，日志 `/tmp/escape-capture-finals-browser-core-3.log`。通过真实 WebSocket close 与真实离线 context 阻止自动续接；离线无搀扶续期、`initialQueue` 严格为空，旁观客户端仍连续收到超过 10 个快照，患者保持倒地，离线救援者按相同 id 保留并显示 `online:false`。保留原 tap / touchCancel / settings 取消与真实完整 3 秒长按断言。
- 带手机修复 CSS 的完整三人用例在第五轮通过，日志 `/tmp/escape-capture-finals-browser-core-5.log`。本机与远端抓捕身体均与接触点相距不到 0.015 m；远端倒地呼吸、脚底贴地、视野内真实模型、持续救援及超过原 30 秒截止时间后的双方存活快照断言全部保留。标题与计时整行严格分开、计时在整行内、视口与安全边距内、无横向溢出；倒地隐藏目标/线索本/动作按钮，聊天保持可见，复活后 HUD 恢复。
- 已亲自查看最新 `game/test-results/team-feedback-mobile-self.png`、`team-feedback-mobile-down.png`、`team-feedback-mobile-revived.png`。640×360 自身倒地标题、29 秒与说明无遮挡，原地躺倒队友可见，救起后站立及 HUD 恢复。此结论仅针对本切片状态与布局，不替代最终集成树的美术验收。
- 真实脚步、受控心跳与静音用例在第七轮通过，日志 `/tmp/escape-capture-finals-browser-core-7.log`。无手势准备现在全部走 `Runtime.evaluate { userGesture:false }`；保留 `navigator.userActivation` 均为 false、尚未创建 AudioContext、可信按键解锁、实际行走触发脚步、倒地触发有界心跳、静音清源及不再播放的完整断言。`activation-checkpoints.json` 记录阶段状态。
- 完整真实抓捕长用例在第八轮通过，日志 `/tmp/escape-capture-finals-browser-core-8.log`。Apple M4 / ANGLE Metal 采到 90 帧、1483.3 ms 的真实 contact 时间轴，整个采样中身体与服务器精确接触点距离最大 0 m；有站立队友时 30450.3 ms 后成为观察者。双方真实 3 秒救援、旧/重复/远端事件不重演、同页新身份迟到观察者无历史演出、30 秒 down 计时却 1 秒内立即全队 fade 并同 seed / level 重试、reduced motion 90 帧 pitch/roll 均为零、零音量/静音不增加播放计数且活动源为零，全部通过；浏览器错误为空。
- 聊天原生模态回归与完整教学复合用例在第九轮 `3 passed (1.1m)`、exit 0，日志 `/tmp/escape-capture-finals-browser-core-9.log`。桌面与触屏均验证设置从未打开时可发消息、打开时阻止聊天并暂停游戏输入、Escape 关闭后又可发送并恢复输入。教学改用真实渲染与 `openingComplete` 后启动，保留所有实际教学步骤、移动/蹲行、手机标记、直接点门和物品的双端权威同步、输入法组合、横竖屏/模拟键盘视口、聊天触摸屏蔽、极小屏罚站与结算滚动断言。
- 最新 typecheck 通过，日志 `/tmp/escape-capture-finals-typecheck-4.log`。完整 client/server/nav build 通过，日志 `/tmp/escape-capture-finals-build.log`；手机 CSS 追加后 client 与预压缩构建通过，日志 `/tmp/escape-capture-finals-mobile-build.log`；显式召唤改动后 server 构建通过，日志 `/tmp/escape-capture-finals-summon-build.log`；聊天修复后 client 与预压缩构建通过，日志 `/tmp/escape-capture-finals-chat-build.log`。显式召唤单元回归 1/1 通过，日志 `/tmp/escape-capture-finals-summon-unit-1.log`。

全部浏览器命令使用 `playwright.capture-final.config.ts`、端口 4473、真实构建服务、单 worker、零重试、静音 Metal；所有 heavy/browser 操作均通过 `parallel_sprint.py gate`。本切片未运行完整 `npm run check`，该闸门由集成代理负责。

本切片 13 项定向浏览器 case 已分轮通过，不能替代最终集成树完整 `npm run check`。长用例保留完整 1500 ms 逐帧动画、30 秒救援窗口、迟到观察者、立即全队重试、reduced motion 与静音断言；证据为 `capture-evidence.json` 与持久化 `capture-final-probe.json`。最后只调整 wipe 截图时机：先等真实 fade opacity > .95 再截图，避免把第一帧透明状态当作完成画面；此截图等待由最终集成 check 继续覆盖。已亲看新的 threat / shoulder / lowered / observer / reduced-penalty 关键帧；本树救援 bot 紧靠相机会在 shoulder 帧边缘出现模型截面，观察者条与其他 HUD 仍挤在上方，因此不以本轮绿色断言宣称全部美术终验通过。未做外部 Gemini 视频评分。

## v040 历史交接（已被最新抓捕规则取代）

本切片沿用已 review 的 v040，保留现有 L1–L4、声音、画面和更新通知。恢复时已有的 WIP 均保留；没有修改角色074 model/anim、todo、loop、凭据、用户配置或其他工作树。

## 集成范围

切片基线为 `57a05ea`；最终复测源码为 `5727cef84d67c794b1d8dfc434b39fe60931245a`。按顺序核对以下五个提交，只挑集成树尚未包含的精确提交，不整分支重放：

- `f96f204`：独立 `CapturePresentation` / `CaptureTimeline`，按真实近身抓捕来源决定肩部暗影方向，单次 1500 ms 下压镜头，去色、暗角与覆盖位置交接的单次黑场；不插入脸部贴图。
- `cc2f76b`：服务器先向被抓者私发 `caught { id, seq, tick, by, at, source, hold }`，再纠正身体到罚站点；客户端仅接受本机新事件。重复快照、旧事件、远端被抓、迟到观察者不会启动演出。快照 `downUntil` 保持服务器的 30 秒救援截止时间。
- `1481a3a`：抓捕、罚站、恢复时隐藏开场横幅与教学，避免手机倒计时重叠。
- `fed26ee`：按真实抓捕来源显示罚站标题；单纯 down 快照用中性标题，避免沿用上一次怪物名。灰度、对比度、亮度分档渐变恢复，只在档位改变时更新滤镜。
- `5727cef`：加入独立真实构建服 Playwright 配置和抓捕、救援、观察者、同 seed 全灭重来、偏好设置的端到端回归。

`fade` / `complete` / `loadLevel` 清理本地抓捕效果；`LevelTransitions` 保留全灭黑场，同 seed 本关重来。救起恢复 600 ms，观察者清除抓捕效果。

从基线到上述复测 HEAD 的精确改动文件（不含软链或生成物）：

```text
docs/capture-handoff.md
game/client/src/capturePresentation.css
game/client/src/capturePresentation.ts
game/client/src/game.ts
game/client/src/main.ts
game/client/src/transitions.css
game/client/src/transitions.ts
game/playwright.capture.config.ts
game/server/room.ts
game/shared/protocol.ts
game/tests/e2e/x-capture-presentation.spec.ts
game/tests/unit/capture_client.test.ts
game/tests/unit/capture_presentation.test.ts
game/tests/unit/client_loop.test.ts
game/tests/unit/room_mobs.test.ts
game/tests/unit/transitions.test.ts
```

## 接线边界

- 共享文件：`game.ts` 的 caught/snap、camera/update、resetCapture、setDown；`main.ts` 的 caught 分发；`transitions.ts/.css` 的 wipe 标记；`room.ts` 的 punish/快照；`protocol.ts` 的 caught/downUntil。
- 后续关卡新增 `punish` 调用时，需要传入真实抓捕怪物的位置作为第三个参数，保留先 caught、后 correct 的发送顺序。
- 抓捕短音与罚站心跳经现有 `Sound`，尊重音量为零与静音。`prefers-reduced-motion` 禁用俯仰/侧倾、暗影移动与边缘脉动，保留可读的罚站状态。
- 需要保留 voice_preferences lane 的总静音与后台取消接线。当前 v040 的 `Voice` 使用独立 AudioContext，本切片没有改动其他 lane 所有的 voice.ts；浏览器对 Sound 的静音验证不能代表独立人声也被静音。
- 需要保留 cinematic lane 的 intro/clear；本切片仅接真实抓捕与既有全灭 handoff，不修改角色074模型与动作。

## 验证与交付

验证记录放在本树 `game/test-results/`，不提交生成物。所有 typecheck / vitest / build 经 `parallel_sprint.py gate heavy`，浏览器经 `gate browser`；未运行 `npm run check`。

`capture-validation-final.log` 于 2026-11-05 18:15:11 +0800 留下最终 heavy 通过记录：typecheck 通过；定向 vitest 7 文件、61 项通过（`--maxWorkers=1`，覆盖 capture presentation/client、room mobs/campus、transitions、client loop、spawn/catch 保护）；完整 client / server / nav build 通过，仅有既有大包提示。`fed26ee..5727cef` 的 client/server/shared/scripts/package/tsconfig 无改动，后续只有测试、配置与文档，因此本轮复用该同代码记录，不重复 heavy。

最终浏览器复测于 2026-11-05 19:41:42–19:43:29 +0800 执行，工作目录为本树 `game/`：

```sh
ESC_SOFTWARE_GL=0 python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test --config=playwright.capture.config.ts --workers=1 --retries=0
```

结果为 `1 passed (1.1m)`、exit 0、零重试。配置固定 4417、`reuseExistingServer=false`、真实 `dist-server/index.js` 静态服务与 dist 客户端；单个 headless Chromium 使用 `--use-angle=metal` 和 `--mute-audio`。本轮结束后 `lsof` 确认 4417 无监听，本次测试服及 Playwright worker 均已退出。

本轮 `capture-evidence.json` 与精简的 `capture-final-summary.json` 记录：

- 渲染器为 Apple M4 / ANGLE Metal。
- 首次真实角色074抓捕仅启动一次（`starts=1`），来源与玩家水平距离 0.58 m；1500 ms 时间轴采到 91 帧，采样跨度 1498.9 ms。
- 抓捕 150 ms 后相机与抓捕锚点水平偏差最大 0 m；身体已回罚站点时，相机与身体水平最大分离 6.715 m，黑场交接后进入罚站。
- 服务器 30 秒救援截止时间有效，实测 30434.9 ms 后转为观察者；3 秒救援与 600 ms 恢复、渐进恢复颜色断言通过。
- 重复事件/快照、旧事件、他人被抓、迟到观察者均不额外启动本机抓捕；全员出局显示既有黑场，同 level / seed 重开。
- 844×390 的 reduced-motion 真实抓捕采到 90 帧，pitch / roll 均为 0；音量为零与静音时，既有 `Sound` 播放计数不增长、活动声源为零。此项不涵盖独立 `Voice` AudioContext。
- 浏览器错误列表为空，`capture-playwright/.last-run.json` 为 passed。日志为 `capture-browser-final.log`。

本轮关键帧清单（均位于 `game/test-results/`）：

```text
capture-threat.png
capture-shoulder.png
capture-lowered.png
capture-revived.png
capture-observer.png
capture-wipe.png
capture-reduced-threat.png
capture-reduced-shoulder.png
capture-reduced-lowered.png
capture-reduced-penalty.png
```

恢复时已有的 WIP 历史记录仍保留：更早一轮 Metal 实机为 passed，89 帧、1483.3 ms、相机与身体最大分离 6.715 m、30448.2 ms 转观察者、浏览器错误为空，当时近身/按肩/压低/观察者/全灭黑场截图已亲自查看；该轮早于标题遮挡与颜色恢复收尾，不作为本轮结论。本轮最终记录以 19:43:29 生成的日志、证据和截图为准。未做 Gemini 视频外部评分。

## 审查与待集成事项

独立只读审查未发现 capture 阻塞，结论为可合并；合并时必须保留 voice_preferences lane 的总静音与后台取消接线。

主代理已用 `view_image` 亲自查看本轮全部 10 张截图：近身威胁 → 侧边手影 → 视角压低/去色的连续关键帧可辨，未出现无故贴脸贴图；救起后恢复正常视角与颜色，观察者条和队友清楚，全灭标题卡清楚；844×390 罚站标题与 29 秒倒计时完整可读，无 intro / tutorial 重叠。reduced-motion 下肩影静态，pitch / roll 为零以逐帧采样断言为准。

`capture-threat.png` 在开手电极近距离时现有 Warden 脸部高光偏亮/过曝，需集成 Warden 模型与光照 lane 后复看；本 lane 按边界不改 Warden model/anim 或手电。非必要 HUD 在 1.5 秒期间淡出由集成既有 CSS 负责，本树仍可见。独立 Voice 的总静音仍须保留对应 lane 接线。此轮不打商业画面分，未做外部 Gemini 评分。

部署由集成代理在完整串行闸门后负责；本 lane 未部署，未操作线上服务。
