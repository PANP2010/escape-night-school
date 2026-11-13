# 角色074形态接线交接 · 2026-11-05

本 lane 在原提交 `f9c5bd7f4e42052a536f7b329f80dc5e8ec3bd89` 上续作，没有重放旧分支。部署由集成代理负责。

已接入真实行为：

- 服务器按每位玩家各自连续的 2 秒凝视计时，校验 yaw、pitch、头部/上胸采样和无遮挡视线。转开、遮挡、藏身、倒地、值日生眨眼会中断，几人的短暂注视不累加。
- 触发时保持角色074当前位置，通过公开 `forceChase` 进入追击，发用户原文的 `likeme` 台词一次；快照沿用现有 `mob.form` 增量字段。
- 客户端变脸覆盖过宽笑与白镜片，颈部在 1.15 秒内歪转、回正；不增加随机帧跳，保持用户最新要求的缓慢、清晰动作。材质和姿态可还原，附件不污染学生或值日生。
- L2 夜巡有灰绿帽、持灯姿态和一盏无阴影 SpotLight；灯随实际骨骼世界变换扫动，`decay=2` 能通过现有室内材质光照闸。本次把强度从 10 调到 48、半角从 0.32 调到 0.43、俯角中心从 0.17 调到 0.23。
- 本树 L2 听觉 1.5 倍通过真实 `warden.hear` 生效，其他噪声订阅者收到原事件，穿墙衰减保留。
- L4 保持 `rollcall`，持点名册并低头；沿用广播站的自然 60–90 秒点名、真实玩家名和位置暴露提示。L8 `finale` 的形态优先级和客户端身高处理保留，凝视不覆盖这两种形态。

尚未完成与集成约束：

- **夜巡减速未接入。** 本树 AI 不读取 `patrolSpeed`。本次移除了仅写在 Room 里的无效字段及对应伪验证，未改独占的 `server/ai/warden.ts`。Warden 已交付的 `820df03` 普通巡逻是 1.4 m/s，不能用绝对 1.5 作为更慢夜巡。建议 AI 所有者提供 `WardenEnv.patrolMultiplier?: () => number`，只用于实际巡逻移动距离及其 speed accessor；Room 夜巡传 0.75（新基线下为 1.05 m/s）。不要整体缩放 `step(dt)`，否则感知、冷却、抓捕计时也会变慢。
- **听觉合并只放大一次。** `820df03` 已提供真实 `hearingMultiplier?: () => number`，每次 `hear` 动态读取。集成时建议把夜巡 1.5 与现有人数倍率相乘放到这个 hook，并将本树噪声订阅器改回 `warden.hear(ev, noiseBlocked)` 原事件；不要同时保留事件半径乘 1.5 和 hook 的夜巡 1.5。
- `mobs.ts` 在本树仍用 `[x,z]` 的 `at`；其他 lane 已升级 `[x,y,z]` 时，按语义合并 forms 增量，保留集成树三维元组及 monitor 专属动画。不要整文件覆盖。
- 形态附件已用 1.14 缩放/转身骨骼单测；成年模型、慢速 AI、所有新关卡合并后仍需集成验收。本树的 L8 断言验证形态优先级，没有宣称终章全流程通过。
- 视频已录在本树 test-results；本会话没有 Gemini 工具，**未做视频外部评分**。浏览器全部静音，未以扬声器试听。

实际验证（均经指定闸门）：

- `npm run typecheck` 通过。
- `npx vitest run tests/unit/warden_forms_room.test.ts tests/unit/warden_forms_client.test.ts tests/unit/room_mobs.test.ts tests/unit/monitor.test.ts tests/unit/mob_interp.test.ts tests/unit/mobs_prewarm.test.ts --maxWorkers=1`：6 文件、48 用例通过。
- `npm run build:client`、`npm run build:server` 通过；未跑全量 `npm run check`，由集成代理串行负责。
- 真实构建服务器、Metal、960×540、静音、单浏览器、端口 4447：凝视→追击/原文台词→L2 夜巡和值日生保留最终复测通过（23.8 秒）。32 强度版本曾因平均增益 0.101 < 0.15 失败；修正后最终平均增益 0.367、明显变亮像素 5445、最大增益 123、过曝像素占比 0；121 帧、两秒扫动 0.412 rad。原亮度阈值保留并增加过曝约束。真实快照的连续注视起点 tick 52、变脸 tick 91，相差 39 tick（首尾共 40 个采样）。
- L4 真实房间预览最终复测通过（约 1.1 分钟），确认点名册、低头世界方向、夜巡附件关闭，并等原定时器自然点到测试玩家，HUD 显示其真实昵称及位置暴露。
- 已亲自查看变脸歪颈、回正、手电开/关、夜巡帽、L4 点名册截图。
- 结果 JSON 与截图分别保存在 `game/test-results/warden-forms-final/` 和 `game/test-results/warden-forms-rollcall-final/`。收尾发现 `defineConfig(base, overrides)` 会合并启动基配置的额外服务器，已改成对象覆盖；最后普通形态用例确认只起 4447，所有本 lane 测试进程与服务器均已自动退出。

复测入口（在本树 `game/`）：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test -c playwright.forms.config.ts --output=test-results/warden-forms-final
WARDEN_FORMS_PREVIEW=rollcall python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test -c playwright.forms.config.ts --output=test-results/warden-forms-rollcall-final
```

独立 config 自动起停自己的 4447 构建服务器；`reuseExistingServer=false`，不复用或终止其他分工的服务。截图、视频和 JSON 证据仅留本树 `game/test-results/`，不提交生成物、node_modules、dist 或 .green。
