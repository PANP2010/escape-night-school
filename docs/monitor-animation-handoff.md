# 值日生专属僵直动作交接

原产品提交：`7b3b922`，基于 `57a05ea`。本轮补充包括 idle 停止、语音坐标兼容修复和本文档，与原提交顺序合入。以下只记录本任务增量，不表示已合入或上线。

## 改动与接线

- `game/client/src/warden/monitorAnim.ts`：新增独立 `MonitorAnimator`，仅依赖 `root / mesh / bones` 结构接口。立正时双手贴裤缝、直肘伸指；冲刺只驱动双腿 IK，躯干与手臂保持僵直。步相按实际渲染地速和模型水平缩放推进。
- `game/client/src/mobs.ts`：只给 `isMonitor()` 判定的实体建立独立控制器，不再调用该实体的 `Warden.update()`。freeze、idle、眨眼和三维距离大于 3 m 的瞬移直接落到权威坐标与朝向，清位置缓冲、播放时钟和步长平滑器，落位不推进步相。idle 同样清插值，避免停止后立正滑行。
- `game/tests/unit/monitor_anim.test.ts`：真实模型骨骼、鞋底 FK、冻结与跳跃位移回归；新增真实 running 回放转 idle 的立即权威落位、持续多帧不漂移、双手立正和步相不推进回归。
- `game/tests/shot-monitor-animation.mjs`：独立构建服 `4434`、单个静音 Metal Chromium，先验证真实 L2，再用相同构建模块受控回放并取证；产物只写 `game/test-results/monitor-animation/`，结束关闭自己启动的服务。
- `game/client/src/game.ts`：语音横向距离的 z 分量由 `mob.at[1]` 改读 `mob.at[2]`，保留 300 ms 延迟和新声音逻辑。
- `docs/monitor-animation-handoff.md`：本文档，记录兼容边界、验证与集成责任。

`Mob.at` 现在是 `[x, y, z]`，不再是原来的 `[x, z]`。集成时按此语义合并 `game.ts` 语音索引修复，并保留目标树的 forms、remoteMotion 和新声音实现，不能整文件覆盖；不要把值日生重新接回老师的动画更新。

Warden 树 `820df03` 的兼容边界是 `Warden.root / Warden.mesh / Warden.bones` 结构接口与 `new Warden(materials, false, 'monitor')` 构造调用保持不变。本任务未修改 Warden 代理独占的 `warden/model.ts`、`warden/anim.ts`、`warden/textures.ts`；合入时保留其 monitor build、纸脸及左臂红袖章造型。

## 已完成验证

- 所有测试和构建均经共享资源 gate 串行运行。初轮 heavy gate 下 `npm run typecheck` 通过；`monitor_anim`、`mob_interp`、`mobs_blink`、`mobs_prewarm`、`warden_anim`、`warden_model` 共 6 文件 / 53 项通过，完整 `npm run build` 通过。
- 最终 idle 与语音修复后，heavy gate 下 `npm run typecheck` 通过；`monitor_anim`、`warden-voice`、`voice-gate` 共 3 文件 / 35 项通过（monitor_anim 11 项、voice 24 项）；`npm run build:client` 通过。
- 真实鞋底 FK 覆盖 7.8 / 3.9 m/s，中央支撑段鞋底世界滑速小于身体地速的 10%；鞋底不穿地，摆动脚有可见离地。
- 唯一一次静音 Metal 浏览器取证在 Apple M4 上通过：18 个真实 L2 run 帧、645 个受控回放帧，15 张 PNG、`session.webm`、`replay.webm` 与报告均位于 `game/test-results/monitor-animation/`；报告 `errors=[]`，blink / teleport 的位置精确落位且步相不变。
- 根代理亲看 8 张 PNG，以及从 `replay.webm` 抽出的 3.0 / 3.2 / 6.5 / 7.5 s 四帧；验证代理亲看全部 15 张 PNG。视频没有外部评分，本会话没有可调用的 Gemini 视频工具。

浏览器取证发生在最后的 idle 停止与语音索引修复之前。最终 idle 差异由新增行为回归验证，语音差异经现有声音单测验证；没有重新打开浏览器会话。`4434` 取证服务关闭已确认。

## 集成与部署

集成代理负责按语义合入、全量 check 与实际部署。本树没有部署操作，也未宣称已上线；本轮补充提交可由本文档的提交历史定位。
