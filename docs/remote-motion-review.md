# 远端队友动作复查（2026-11-05）

已修一处真实高度错误：`game.ts` 在远端快照和 `warp` 两条路径中，把蹲伏玩家的 `p[1]` 额外减去 0.5 m。协议的 `p` 来自客户端 `body.y`，服务端碰撞校验后原样存储并下发，指的是脚底，不是眼高；`Student` 本身已经降低髋部，因此这次减高重复了。现两条路径都保留权威脚底高度。

回归 `tests/unit/remote_motion.test.ts` 经过真实 `Room.applyInput → Room.step → Game.onMsg → InterpBuffer → Student`，覆盖站立、蹲伏、快照省略不变 `f`、恢复站立和蹲伏中传送；同时采样最终鞋底位置。`client_loop.test.ts` 原先把协议 y=7.2 错写成渲染 y=6.7，现严格断言 y=7.2，属于修正坐标语义，没有放宽误差。

验证：共享 heavy 闸门内 `remote_motion / client_loop / student_down / warden_student` 共 4 文件、18 用例通过（EXIT 0）；协调者统一执行的 typecheck 与完整 build 也均 EXIT 0。

## 可复验骨骼诊断

从 `game/` 运行 `node tests/probe-remote-motion.mjs`。这使用当前真实 `Student` 与 `WardenAnimator`，固定 `dt=1/30`，不启动浏览器，不能代替实际 30 fps 录像。保留模型自身的 0.93 缩放和骨骼 mesh 的 π 朝向修正；avatar yaw=0 时朝世界 −Z。

每段运行 5 s，排除前 2 s 过渡。把鞋底椭圆采成 180 点，以骨骼世界矩阵转换后取最低点；仅在 `anim.planted(i)` 连续两帧均为真时计算水平位移 / dt，避免把腾空帧算支撑。下表覆盖完整支撑相，包括脚跟着地和脚尖离地，不与只取中间 80% 相位的既有滑步单测直接比较。

| 动作 | 地速 m/s | 支撑脚滑速中位 m/s | 最大 m/s | 鞋底 y 中位 m |
|---|---:|---:|---:|---:|
| 前移 | 3.4 | 0.631 | 2.798 | −0.003 |
| 横移 | 3.4 | 4.385 | 4.808 | −0.003 |
| 后退 | 3.4 | 6.169 | 6.800 | −0.003 |
| 蹲伏前移 | 1.8 | 1.017 | 1.834 | +0.050 |

蹲伏前移鞋底 y 范围约 −0.019..+0.101 m；旧的额外减高使它变成 −0.519..−0.399 m，中位 −0.450 m，身体最低点约 −0.563 m。去掉重复减高修复了半米埋地，仍未解决蹲姿本身的支撑误差。

当前 idle 3 s 的胸部 x 角范围约 0.130 rad，头部约 0.150 rad；起停/转身能进入现有 `start/move/stop/turn` 状态。旧 3 fps 录像里的“完全冻结/没有过渡”不能作为当前实现结论。

## 仍需共用 Animator 接口的部分

横移/后退滑步是真实问题：`Game` 正确按实际渲染位移计算速度，但只给 `Student.update` 一个非负标量；`feet()` 地面变换固定沿模型前向 `v·dt`，无法区分 WASD 方向。蹲伏旋转和髋位移又在 Animator 完成脚部 IK 之后叠加，破坏其已经求好的脚底位置。本轮遵守共用动画文件的编辑边界，未改 `warden/model.ts`、`warden/anim.ts`，也未叠加第二套 IK。

未来最小接口可在现有 `update(..., speed, ...)` 末尾增加可选 `groundDelta: { x, z }`（每帧真实世界位移），保留不传时现有怪物的速度路径。Student 从两帧 root 世界位置取得该增量，由 Animator 按上一帧/本帧身体矩阵转换地面接触点；也可明确传入模型坐标下的二维位移，必须说明其坐标帧。`speed` 继续负责步频，二维增量负责支撑脚锁定，不能丢掉后退符号或横向分量。

蹲姿应以可选姿态参数/前置姿态钩子在 `mixer → posture → crouch → feet IK → lookAt` 的顺序应用，让 IK 看见最终髋位移和屈膝姿态。保持远端 root 在权威脚底高度；不能再靠降低整个 root 修补蹲姿。

## 真实录像与低帧复验工具

从本树 `game/` 执行：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node tests/record-remote-motion.mjs
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test -c playwright.motion.config.ts --repeat-each=5 --retries=0
```

录像脚本只启动一个 headless Chromium，显式 `--use-angle=metal --mute-audio`，建立两个真实 context，双方持续绘制并通过真实服务器 WebSocket 通信。脚本自起本树 `dist-server`，端口固定 4452，拒绝复用已占用端口，退出时只关闭自己启动的服务器。先使用本树构建产物；统一 heavy 闸门内 typecheck、完整 build（含 nav 4069 节点、0 failures）均 EXIT 0，新增独立配置与观察包装器的最终 typecheck 也已通过。

取景为 640×400，甲固定观察乙以真实键盘事件横移、后退、起停、站到蹲、蹲行与起身。直接 `canvas.captureStream(60)` 交给 MediaRecorder，保留原始时间戳，不使用虚拟时钟、回放、降速或复制帧。每个动作段分别记录双方实际 rAF/render 帧率，并以源 WebM 的视频帧唯一 PTS 分段计算编码帧率；两种实测都达到 30 fps 才报告通过。源录像、截图、阶段时间窗、骨骼和脚底世界位置、权威高度、播放时钟/缓冲末端、快照及 correct 原文保存在忽略的 `game/test-results/remote-motion/`。

`tests/webm-frame-times.mjs` 只统计已识别的视频轨，非视频 block 不参与帧率，重复 PTS 不增加有效帧数且会阻止质量验收。纯字节 fixture 复验 EXIT 0：跨 cluster、TimecodeScale、负相对时间戳均正确；3 个视频帧加 3 个音频 block 只计 3 帧（29.85 fps），6 个 block 中 3 个唯一 PTS 也只计 3 帧并报告 3 次重复；未知轨和多视频轨明确拒绝。该 fixture 位于本树忽略的 `game/test-results/check-webm-parser.mjs`，不是产品测试。

独立 Playwright 配置的观察包装器直接注册现有 `x-lowfps-remote.spec.ts`，原测试与 0.84 位移余量阈值均未修改；只补充原始 WebSocket、rAF、播放时钟与缓冲样本，以及实际 Chromium 命令行的 Metal/静音核实。

本次实机任务未能执行：唯一 browser gate 命令从 2026-11-05 18:15:40（上海）排队至 18:57:41.953，共 2521.953 秒（42 分 1.953 秒），一直未获得共享浏览器单槽。在协调者规定的收尾时间内，只终止本 lane 的等待 PID 73353（session 65729，EXIT 143）；终止前后均无子进程，录像脚本自己的 `server.log` 从未生成，关闭后 PID 已消失，127.0.0.1:4452 无监听。原始清理记录保存在忽略的 `game/test-results/remote-motion-cleanup.json`。

因此实际完成的浏览器录像为 0 次，截图拍摄/亲自查看为 0 次，低帧复验完成 0/5 次；没有实际 render/编码帧率可报告。现有低帧测试及 0.84 阈值未改，本次既未报告该测试通过，也未把未启动解释为测试失败。前述固定步长骨骼数字仅证明链路与方向缺陷，不能代替真实录像验收；横移/后退和蹲姿 IK 残留仍未关闭。没有可调用的 Gemini 视频评审工具，未取得外部评分。后续可直接使用上面两条已保存的命令补齐真实验收。
