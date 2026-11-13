# L1–L4 内存与 Metal 实机独立审计

审计日期：2026-11-05。基线：`57a05ea537a25f9ac470c98dc863aa58601e3b40`（已集成 L1–L4、声音、画面与更新通知）；资源释放修复：`9e44a4a1b8e0beb9a684a5cad5b55776005cda4c`。本审计不修改 `todo.md`、`loop/` 或主工作区，不把历史 SwiftShader 结果当作本机 Metal 结果，不宣称商业质量达标。

已完整分段阅读 `/Users/local-user/escape/docs/design.md`（94 行）与 `/Users/local-user/escape/todo.md`（596 行）；本工作树与适用祖先目录没有找到 `AGENTS.md`。

## 审计方法与边界

- 浏览器审计只使用一个 Chromium 会话，ANGLE Metal、headless 静音；修后增加两个真实绘制页面各运行两分钟的阶段，四人阶段另用一页加三个 Node WS 对端。真实构建服务固定端口 4423，与现有全量 Playwright 配置隔离。
- 稳态与循环分别记录 `renderer.info.memory.geometries/textures`、CDP 强制 GC 后 JS heap、渲染调用/三角形、逐帧时序与页面错误。桌面采样为 1280×720、DPR 1；本机固定机位的两分钟帧率不能证明 design.md 的集显 1080p 预算达标。GPU 计数是资源数量，不是显存字节数；JS heap 不能替代进程 RSS 或 GPU 内存。双页阶段新增浏览器所属 PID 的 RSS 总和，包含共享页，不能当作系统唯一物理内存。
- 分开验证真实服务器 L1 同 seed 全灭重开、客户端同关换 seed 重建、L1–L4 跨关资源重建。直接调用客户端方法属于生命周期压力复现，不能冒充完整通关；当前 harness 没有驱动权威 L2→L3，因此值日生移除路径另由定向单测覆盖，不能算本次浏览器已验。
- 必须先让待测物品/关卡设施实际绘制，再比较相同机位的稳定计数。首次预热和一次性缓存单独列出。
- 手机视口只代表 Chromium 触屏模拟，不代表实体手机、iOS Safari 或低端安卓的帧率与触控质量。遵守静音要求，不作扬声器听感验收。
- 基线原始数据与截图保存在 `game/test-results/metal-audit/baseline/`，不覆盖。修后增加双页、可信音频解锁等场景，比较相同阶段的增长斜率；不同场景的绝对 heap 不作直接前后对比。
- 同步补充复核仅运行轻量 Node：直接调用生产 `SnapClock`、`InterpBuffer`、`Mobs`、`Student`，以及从源码提取的服务端救援方法体。它们证明给定输入下的算法行为，不冒充真实网络、键盘长按或可见画面实测。
- 审计 harness 的退出 0 只说明采集及其中明示的页面错误、帧率/移动样本覆盖断言通过；泄漏消除、同步流畅或产品质量是否达标须分别读数据，不能由 capture 成功推出。

## 已修复的资源释放缺口

以下缺口在基线源码中成立，`9e44a4a` 已加入对应释放；修后实测另列，不能由源码修复直接推算显存大小或 OOM 时间。

| 路径 | 基线缺口与修复 | 保留的共享资源 |
| --- | --- | --- |
| `Game.showItems` / `dropItems` | 每次 `items` 消息新建道具 BoxGeometry，基线只移除 mesh；现在替换、拾取时同时释放实例几何。服务端同 seed 重开也重新发送 items，相同 seed 的 `loadLevel` 早退不保护此路径。 | 游戏级 `itemMat` 材料仍给其他道具使用。 |
| `Game.buildBlackout` / `buildBarriers` | index 或 seed 改变时重建设施/地标，基线未释放旧几何和 CanvasTexture；现在 `disposeLevelProps` 遍历旧批次，按 Set 去重释放几何、material 与 map，并清除旧 `fuseLamp` 引用。 | 同批 clone/重复材料只释放一次；Sprite 的模块共享几何保留。当前设施材料只有 map 贴图，不能据此声称 helper 已覆盖任意材质的 normal/bump 等贴图。校园本体、持久门和全局纹理不属于这一批。 |
| `Mobs.onSnap` 的缺失 ID | L2→L3 时值日生可从快照消失，基线只 remove/delete；现在同时释放每实例 skinned geometry 与 skeleton/boneTexture。 | 值日生 material/texture、红袖章 geometry/material 有模块缓存，不随实例销毁。当前 Room 始终输出角色074 ID 1 并 reset 复用，不能声称每次重开都会新建角色074。 |

`buildDoors` 有单例保护，`barrierIds` 会复用/停放碰撞盒；它们不是每次切关无界新增的相同问题。L3 `buildLoopView.dispose`、L4 `BroadcastView.dispose` 已有明确清理。校园几何与角色预热池是常驻/有界资源，不能要求每次重开回到零。

独立源码复核未发现当前释放路径的阻塞项。边界：若未来快照真的移除角色074实例，其独立 `makeMaterials` 仍需另查；不能将当前仅释放 geometry/skeleton 推广为所有角色全部资源均已覆盖。AnimationMixer/clip 没有全局实例池或事件引用，随已分离实例闭环可被 GC，未发现必须追加 `uncacheRoot` 的依据。

## 实测结果

修后采集于 **2026-11-05 10:21:53 UTC** 完成：实际 Playwright 退出 **0**、1 passed（6.1 min），耗时 367330 ms，共 59 个资源采样，`errors=[]`；本次 harness typecheck 实际退出 **0**。基线为 `baseline/results.json`（2026-11-05 09:37:29 UTC），修后证据为同目录 `results.json`、`summary.json`、`verified-run.log`、`harness-typecheck.log` 与 `lowfps-raw.json`。

下表的 `g/t` 为 geometry/texture 数量。跨关行比较第 1、4 轮的相同关卡采样阶段，不把初次预热与稳定阶段混为一谈；同 seed 行比较重开前与第 4 次重开后。heap 是各自运行内相同阶段的强制 GC 后值，不作不同场景的绝对 heap 前后比较。

| 场景 | 基线 g/t | 修后 g/t | 修后 heap（bytes） |
| --- | --- | --- | --- |
| 真实 L1 同 seed 全灭重开 4 次 | 235/39→259/39，每次 geometry +6 | 233/37→233/37，四次均相同 | 38,236,596→39,135,924（+899,328） |
| 客户端跨关 L1，第 1→4 轮 | 575/99→1265/246 | 313/48，四轮相同 | 41,779,700→42,130,156（+350,456） |
| 客户端跨关 L2，第 1→4 轮 | 638/113→1328/260 | 295/48，四轮相同 | 41,889,292→42,036,196（+146,904） |
| 客户端跨关 L3，第 1→4 轮 | 702/134→1392/281 | 296/55，四轮相同 | 41,836,840→41,947,480（+110,640） |
| 客户端跨关 L4，第 1→4 轮 | 753/143→1443/290 | 293/52，四轮相同 | 41,919,464→42,023,700（+104,236） |
| 客户端同关换 seed，第 1→4 次 | 1495/295→1738/337，每次 +81/+14 | 313/48，四次相同 | 42,140,660→42,184,280（+43,620） |

真实重开事件保存了四组 `fade restart=true → room → items`，房间 seed 始终为 154324410，最后 `down=false/spectate=false`。基线 L4 初次预热为 523/94，之后每完整循环增加 230 geometry/49 texture；修后 L4 初次预热为 293/52，后续四轮保持该值。结果支持本切片修复了这些已覆盖重建路径的 GPU 资源计数增长；重开和跨关仍有 JS heap 增量，不能写成“所有内存泄漏消除”。跨关数据来自客户端生命周期夹具，不能证明服务器 L1–L4 通关或权威 L2→L3 的值日生移除已验。

单页 L1 固定机位两分钟：geometry/texture 恒为 **233/37**；heap 39,166,648→39,277,260（+110,612 bytes），六个 20 s 区间为 59.9683–60.0386 fps。相同机位 calls/triangles 始终为 110/63,016；基线为 111/63,028。这里的约 60 fps 仅适用于 Apple M4、Metal、720p/DPR 1 和该固定场景；不证明集显 1080p 预算或追逐场景性能达标。

双页面均真实绘制两分钟，两个页面约 60 fps。A 的 geometry/texture 恒为 230/40，heap 39,728,964→40,127,896（+398,932 bytes）；B 为 **119/27→120/29**，最后一个采样发生一次增量，heap 38,522,928→39,319,868（+796,940 bytes），同时 program 32→37、calls 125→136、triangles 80,851→89,679。增量特征与角色首次上传相符，但缺少可见性与纹理 UUID 追踪，来源尚未定位，不能称双页资源全部稳定，仍需长时间 soak。跨关的 program 也有一次预热变化：L1 第 1 轮 72、第 2–4 轮 75；L2/L3 为 78、L4 为 76，各轮固定。浏览器所属进程 RSS 总和首尾为 907,328→893,360 KiB，采样范围 871,456–907,328 KiB，包含共享页。此短时实测未发生 OOM，但不关闭历史 SwiftShader 双页 OOM 风险。

100× CPU 节流校准为 3.2434 fps，随后 12.158 s 往返运动实测 **2.9469 fps**：保留全部 37 帧，其中 35 帧移动量 >0.005 m，最大间隔 **433.4 ms**、最大单步 1.6749 m，总路径 36.2913 m、净位移 6.9781 m；全帧 `step − 3.4×1.5×dt` 最大值 −0.3176 m，低于 0.84 m 阈值。实际 fps≤10 与移动帧>8 的采集断言通过，这条轨迹没有超阈值步长；本次没有出现 >500 ms 间隔，不能声称验证了所有长停顿恢复。两秒扣留快照的确定性怪物反例另见下文，不能用这次正常轨迹否定。基线 20× 节流实际为 26.926 fps、325 帧，不属于≤10 fps 覆盖。

主代理已亲看修后 `desktop-contact.png` 与 `touch-contact.png`，内容正常绘制，触屏 L4 的面板/目标重叠仍可见；四人截图的队友较暗。静态截图不证明移动自然度、恐怖感或商业质量。触屏样本的 `frameCount=0` 源于该 context 未安装帧计数 instrumentation，不能解读为 0 fps。

## 同步与质量风险

本次资源修复未改同步算法、音频状态机或 UI。以下区分确定反例与尚待真实交互验证的风险，不改变已有断言，不把历史跳变/OOM 自动归因到本次发现。

1. **P1，SnapClock 积压批时间倒退，确定算法反例。** `interp.ts:110` 在 offset 差超过 1000 ms 时直接 snap；新建 `SnapClock(50)`，连续执行 `stamp(tick, 2000)`、tick=0…21：tick 20 返回 3000 ms，tick 21 返回 2000 ms，倒退 **1000 ms**。`Game.onMsg`（`game.ts:1189`）同一 stamp 喂给远端和怪物；`InterpBuffer.push` 不排序，而 `at`/`lastT`/`speed` 假定时间递增。合成 x=tick 时，加入 tick 21 前后 `at(2500).x` 从 10 变 21，说明缓冲读取确受影响；这是合成轨迹，不能当真实玩家瞬移距离。原 `tests/audit/repro-snapclock.mjs` 退出 **1**，trace 保留在 `baseline/snapclock-repro.json`。独立 `repro-sync.mjs` 的 `clockBacklog` 再次复现相同时间倒退，保存了两组逐 tick trace 与 buffer 前后读数。现有 `snapclock.test.ts:55` 的 backlog 循环（:58）没有内部断言，其自身输入就在 tick 21 发生 2398.2→1402 ms 倒退，后续 live 段才开始断言，故当前绿测漏掉反例。最小回归需对每次 backlog stamp 都检查单调性，并覆盖已初始化时钟的长断流后批量到达；仅在 buffer 排序会掩盖时钟缺陷。
2. **P1，同 seed 重开音效总线可能停留在静音。** `fade` 调用 `Sound.transition()` 将 master 淡到 0、`transitioning=true`；`loadLevel` 同 index/seed 早退又跳过恢复该过渡所需的 `sound.reset()`。普通队员进出也发送同关 room 消息，修复时不能无条件重置整个声音系统。本次可信点击已解锁 AudioContext，但 warmLevel/camera 设置 `g.view`，`Game.update` 的 active 条件要求 `!view`，故重开前后 `Sound.frame.active=false`；实测 gain 都约 0.65，transitioning 从 false 变 true。`Sound.transition.ready()` 因 active=false 未进入淡出分支，这个音频夹具无效，**没有复现声音静音**。它只能支持同 seed 重开后 transition 标记未 reset 的状态观察；仍需 active=true 的真实游玩专门验证，不追加本轮音频重跑，也不声称已听过效果。
3. **P1，低帧率救援无法完成，确定服务端节拍反例；真实键盘待验。** `Game.tickRevive`（`game.ts:1320–1326`）只在 rAF 驱动的 update 中发 act；分步 update 共用同一个 now，不能补齐失去的网络节拍。服务端 `room.ts:405` 在 `tick - seen > 12` 时清掉 hold（20 TPS 下连续约 0.65 s 未刷新即过期，精确边界取决于消息与 tick 顺序）。独立 Node 执行生产 `tickRevive`/`revive`/`stepRevives` 方法体、合成合法距离的静止玩家（同步注入发送，先 send 后 stepRevives；没有真实 target 射线、act 门闸或完整 Room.step）：每 50/500 ms 刷新，均 3000 ms 救起；每 1000 ms 刷新，9 s 内清零 9 次，目标仍为 ST_DOWN。前端圆环按本地 `reviveSince` 显示，仍可能画满，与权威进度不一致。`x-down.spec.ts:41–43` 用 Node WS bot 每 50 ms 发 act；`shot-revive.mjs:73–76` 明确关闭绘制提高 fps，均绕过受影响的真实客户端路径。最小端到端复测应限制绘制到约 1 fps，真实按住 E，并同时保留发送时刻、权威 st 和正常帧率对照；应保证发送节拍独立于绘制，同时保留松键/离距清零语义。
4. **P1，蹲着被抓可使远端倒地身体在地面下；普通蹲姿偏移为 P2，CPU 几何已量化，画面待验。** `game.ts:1219` 把权威脚底 p.y 再减 0.5 m，`warp`（:1136）同样处理；`Student.update` 自己还叠加蹲姿（`student.ts:245–249`）。服务端 `punish`（`room.ts:490`）只清 F_HIDE，倒地输入分支（:719–725）也不更新 crouch flag，故蹲着被抓后偏移可持续到救起。以实际 Student 几何、p.y=0 和固定初始呼吸相位在 CPU 复核：站立最低点 +0.0044 m；蹲姿 root=-0.5 后最低点 −0.4678 m，同姿态 root=p.y 对照为 +0.0322 m；随后倒地最低/最高点 −0.5225/−0.0305 m，固定初始呼吸相位下，蒙皮身体几何全部在地面下；此 bounds 仅覆盖 `student.warden.mesh`，不含独立 hair/lamp/cone/label。相同倒地姿态若 root=p.y，则 −0.0225/+0.4695 m，坐标转换造成的额外 0.5 m 下沉明确。复现断言按完全相同姿态的权威 root 对照检查新增穿地误差≤1 cm，保留现有生产安全测试原样；不依赖放宽绝对地板容差。`student_down.test.ts` 把 root 放在正确地面测试，`x-multi` 只断言 crouch flag，均未覆盖 Game 的坐标转换。客户端救援候选也取 mesh root（`game.ts:624`），与服务端权威 p.y 的救援框相差 0.5 m；实际瞄准影响待端到端验证。最低修复方向是保持 root 为权威脚底，把姿态高度完全留在 Student 内处理，并覆盖站→蹲→倒地→救起与 L3 warp。
5. **P1，怪物断流恢复可瞬跳，确定算法反例；网络画面待验。** `mobs.ts:124–125` 在 PlaybackClock fresh 时 reset smoother，参考速度仍用 300 ms 的 `buf.speed()`；远端（`game.ts:1536–1537`）已有 paceSpeed/catchUp。直接调用生产 Mobs、用单调时间戳与 4.6 m/s 轨迹，60 Hz update 始终继续，先正常收包至 1 s，再扣留接收至 3 s、一次排空全部有序快照（相邻样本位移始终 0.23 m，未触发 3 m 传送规则）：下一 16.67 ms update 从 x=4.991 到 13.34，单步 **8.349 m**；相同输入经 Game.update 当前远端 clock/buffer/smoother 源码片段重放（保留生产类，擦除 TS 非空断言、将空缓冲 continue 改为函数 return）单步为 **0.1495 m**；`sync-repro.json` 的 `mobDeliveryGap.remoteControl` 保存原片段、SHA 与前后坐标。这模拟接收扣留后的有序批量排空，不是服务器停 tick、全客户端冻结或丢包后只收到 latest。该反例独立于 SnapClock 倒退。现有 `mob_interp.test.ts` 只覆盖约 250 ms hiccup，未覆盖跨过 1.5 s clock snap 阈值的断流。修复应区分真实 teleport/blink 与晚到批的平滑追赶，保留瞬移机制；不能一律取消 reset。
6. **现有低帧测试有明确盲区，新增审计也须区分采集与质量。** `x-lowfps-remote.spec.ts:74–79` 排除大于 500 ms 停顿后 400 ms 窗口，以 `excess !== 0` 计数会把静止帧的负 excess 算作有效帧；没有断言实际 fps≤10，并且 bot 只走约 2.4 s，之后的静止帧可满足样本数。因此它通过不能代表长停顿恢复或完整低帧运动已验。`remote_walk.test.ts:245` 的断流模型直接用理想时间戳，也不经过 SnapClock。基线 20× CPU 节流在 Apple M4 仍约 27 fps，不是≤10 fps 证据。修后 harness 改为 100/200/400× 校准、12 s 往返移动、保留全部停顿帧，并明示断言实际 fps≤10、移动帧>8；质量结论仍须看所有原始步长、最大 excess、服务端轨迹与 clock/smoother 原因，不能靠覆盖断言通过代替。
7. **P2，手机 L4 广播状态与开场目标重叠。** 主代理与实测代理已查看基线 `baseline/touch-l4.png` 及修后 `touch-contact.png`：844×390 中左上广播状态面板盖到中间横幅的目标文本。截图来自客户端生命周期压力场景，房间顶栏仍是 L1，不是权威 L4 全流程的证明；可用相同 viewport、真实进入 L4 后复核 DOM 矩形相交和触屏点击区。本切片不改 UI。

## 待办对照与未验范围

- 历史“双页面两分钟 OOM”不能只凭 geometry 增长就判定同根因；本次 Metal 双页两分钟完成且无 OOM，但 B 页有一次未归因资源增量，JS heap 与 RSS 观察时间有限，不关闭该项。
- 本次确定的时钟、救援节拍、远端脚底、怪物断流算法反例可对应既有 M7 同类待办；不将它们写成已修。已有三人救起后未变旁观的人工结果，只说明那些正常节拍场景未复现，不覆盖约 1 fps 长按或倒地后持续两秒的完整回归。
- 不关闭完整 L1–L4 新玩家通关、难度/追逐节奏、实体手机虚拟键盘、不同网络环境、公网联机、长时间 soak 或所有八关的验收。
- 最新要求中的角色074年龄/压迫感与慢动作、手机直接点物体、L7 镜中取钥匙、跳吓/罚站过场属于其他产品切片，本次保留当前集成行为，不把本次审计当作这些功能完成证明。
- 本次不运行全量 `npm run check`；集成代理仍需串行验收、部署并核对服务版本。没有 Gemini 工具，不提供视频外部评分。

## 集成与部署交接

本产品切片的源码改动仅为 `9e44a4a` 的资源释放与对应回归测试；同步/声音/UI 发现未在此提交修复。本轮实际验证命令如下，均从 `game/` 执行，browser 与 heavy 工作通过共享资源 gate 串行运行：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node node_modules/@playwright/test/cli.js test -c tests/audit/playwright.metal.config.ts
node tests/audit/repro-sync.mjs
```

前两条实际退出 **0**，日志为 `harness-typecheck.log`、`verified-run.log`；浏览器 1 passed（6.1 min），结果状态 `complete`、`errors=[]`。本次浏览器复用先前构建，未重跑 build：服务为 4423 上的 bundled `dist-server/index.js`，`NODE_ENV=development`；结束后自有服务 PID 已退出、端口无监听。`results.json.facts.build` 记录 client `index-Be6AMFvK.js`/`index-DedNRwx5.css`、客户端 mtime `2026-11-05T09:55:33.132Z`、服务端 mtime `2026-11-05T09:29:50.721Z`、index SHA-256 `f5ffcf680048c13e44c951d67450afb824c09a4029f33d959762d3d192a2be29`、server SHA-256 `f3592249d4fa71ac9e5f9f7edd1c44f41036970954431cea84d43e5112f84ddc` 与产品版本 `0.4.0`。先前 attempt 已完成 `npm run build:client`、`npm run typecheck` 及 `npm test -- --maxWorkers=1 tests/unit/client_dispose.test.ts tests/unit/mobs_dispose.test.ts tests/unit/client_loop.test.ts tests/unit/mob_interp.test.ts`（4 文件 15/15 通过，1.32 s），对应 `build-client.log`、`typecheck.log`、`unit.log`；这些先前检查与新增浏览器实测分开记录。

独立确定性复现最终运行退出 **1**、`executionCompleted=true`、`errors=[]`，五条产品不变量失败，正常/500 ms 救援与远端平滑对照均通过；`test-results/metal-audit/sync-repro.json`（`startedAt=2026-11-05T10:15:41.809Z`）保存源码 SHA、时钟逐 tick trace、每次救援发送/清零时刻、CPU 几何 bounds 及怪物/远端对照步长。脚本不进入默认闸门；成功完成且新 JSON 的 `errors=[]` 时，退出 1 表示刻意暴露反例；已捕获夹具失败退出 2，均不是通过。顶层 import/read 失败也可能由 Node 退出 1，须看 stderr、`startedAt` 与 `executionCompleted`，旧 JSON 不作本次证据。方法体提取器只适用于当前没有字符串/注释花括号干扰的具体方法，数字常量提取只接受字面数字；源码形状改变时需更新夹具，不能当作产品修复。

生成 `dist/`、`dist-server/`、`.cache/`、`node_modules`、`test-results/` 不提交。没有运行全量 `npm run check`，也未部署；集成方仍需串行验收并核对实际服务版本。此报告不将未修同步/音频/UI、完整通关、实体手机、公网联机或长期 soak 标为完成。
