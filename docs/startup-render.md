校园现在在临时场景中按帧构建：默认每个浏览器任务处理约 8 ms 的阶段工作，家具进一步按楼层与空间单元拆分；单个几何、Canvas 或 GPU 操作仍可能超过预算。进度覆盖完整校园构建，碰撞、权威出生位置与首次画面都准备好后才启动本地模拟并上传 input。原同步构建入口继续供既有工具和测试使用。

换关、换 seed 或断线会取消未完成的构建并释放其临时资源。相同房间的成员变化不会重启构建。消息按线序补放；服务器先于 room 发送的出生 correct 会保留，以免下一关的 input 使用旧修正纪元。加载期间的 fade 按实时过场时钟处理，避免构建完成后重复冻结三秒。正式游戏继续复用同一份校园。

本机 Apple M4、ANGLE Metal、960×540、DPR 1、正常 WebGL 绘制，headless 全程带 --mute-audio。以下是同一 lane 保留的真实测量，均启用 CPU sampling；共享机器负载存在变化，不能把单次下降当成稳定上限。

|记录|最长启动长任务|最大 rAF 间隔|首次画面/ready 观测|稳定段 FPS|ready 前 input|
|---|---:|---:|---:|---:|---:|
|同步基线|713 ms|783.4 ms|823.5 ms|60.00|0|
|首次分帧复测|289 ms|416.6 ms|1130.5 ms|60.00|0|
|最终构建复测|743 ms|1099.9 ms|2787.1 ms|60.00|0|

最终复测在更高共享负载下进行（测量结束 load average 10.24）。进度在 11.4 ms 左右出现，并持续从 0 推进至 95%；到 95% 前的最长长任务为 216 ms。最长 743 ms 出现在进度 95% 之后，CPU profile 主要指向 Three.js 的 getProgramInfoLog/getShaderInfoLog 首次链接检查。校园分帧已消除连续构建整片校园的同步任务，但首次着色器与资源上传仍可能造成短暂停顿。最终最大帧间隔 1.10 s；本机没有复现旧记录的 7–10 s 冻结。

最终稳定段 10.003 s 内真实完成 600 个 WebGL render frame，约 60 fps；不是 nodraw，也不是 SwiftShader。录像 startup-after.webm 的编码帧率为 25 fps，不能用编码帧率替代实机渲染帧率。录像未做外部 Gemini 评分。基线、两次复测 JSON/CPU profile/截图/WebM 和录像元数据保存在本 lane 的 game/test-results/，按要求不提交生成证据。所有截图已亲自查看。

实际验证：最终 npm run typecheck 通过；6 个定向 vitest 文件共 41 个测试通过，--maxWorkers=1；npm run build:client 通过。真实服务器的 x-startup.spec.ts 通过（6.8 s），在首关仍加载时用真实 debug key/tp 触发二楼，验证取消旧构建、加载期间可继续出帧、旧校园不发布、仅一份校园与地面、碰撞完整、ready 前无 input、修正纪元正确，以及服务端确实接受首次移动。已有 L3 客户端、过场、校园视觉与碰撞快照回归均保留。

可复跑命令（cwd 为 game，所有重命令继续使用共享 gate）：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- sh -c 'npm run typecheck && npx vitest run tests/unit/campus_build_stages.test.ts tests/unit/client_loop.test.ts tests/unit/transitions.test.ts tests/unit/campus_colliders_data.test.ts tests/unit/campus_visual.test.ts tests/unit/campus.test.ts --maxWorkers=1 && npm run build:client'
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test -c playwright.startup.config.ts
```

独立配置固定 4449，覆写 webServer/baseURL，自动关闭自己启动的测试服务。tests/probe-startup.mjs 则需要在 browser gate 内由调用方先启动 4449 服务器，并在 finally 关闭；探针会验证实际 Apple Metal backend，采集长任务、输入、真实渲染帧、CPU profile 和录像。测量结束本 lane 的 4449 服务已关闭。

改动文件：

- game/client/src/campus/buildStages.ts：调度、帧间让出、AbortSignal 与进度。
- game/client/src/campus/world/campus.ts：同步/异步共用的构建生成器、家具阶段和里程碑。
- game/client/src/campus/scene.ts：临时场景构建、完整移交与取消释放。
- game/client/src/loading.ts、loading.css：加载进度展示。
- game/client/src/main.ts、game.ts：消息缓冲、取消构建、首次画面和输入门控。
- game/tests/unit/campus_build_stages.test.ts、client_loop.test.ts：完整几何与碰撞一致性、取消释放、首帧门控和已有回归。
- game/tests/e2e/x-startup.spec.ts、game/playwright.startup.config.ts：真实换关取消回归及独立服务配置。
- game/tests/probe-startup.mjs：可复跑的真实 Metal 启动测量。
- docs/startup-render.md：本交接。

剩余风险：单次几何/Canvas 操作和首次 GPU 链接仍不可被本调度器抢占；本轮没有验证其他 GPU、手机或软件渲染性能。未运行全量 npm run check（按任务规则由集成代理串行负责）。本 lane 未直接部署，提交须由集成代理合入、完成全量验收并部署；保留当前 L1–L4、声音、画面、直接触摸交互与更新通知。
