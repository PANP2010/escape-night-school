SnapClock 积压快照修复已完成，可交集成代理合并并部署。本 lane 未部署，未运行全量 `npm run check`。

可合并提交：`6acb922143c76cbd3f1665095f6b150cc45bc57b`（产品最小修复与回归）、`647f3de942f30fcab222dbba99c6e40d68007afb`（真实 Metal 到达序列）。本文件随补充浏览器审计与完整链路回放切片提交。保留既有提交和 WIP，没有重放旧分支。

根因是负向偏移超过 1000 ms 时直接重置，积压批内 tick 20 的 3000 ms 会变成 tick 21 的 2000 ms。修复仅涉及 `client/src/interp.ts` 的 SnapClock：负向大误差进入快速 settling，下调同时受本地经过时间和服务端 tick 进度约束；未还清的 settling 跨越丢包与 1.5 s 宽限继续生效，正向重连恢复保留。没有修改 PlaybackClock、StepSmoother、Warden、monitor 或 remote pacing。

改动文件如下：

- 产品：`game/client/src/interp.ts`。
- 回归：`game/tests/unit/snapclock.test.ts`、`game/tests/unit/snapclock_replay.test.ts`。
- 夹具：`game/tests/fixtures/metal-lowfps-authority.json`、`metal-backlog-arrivals.json`、`metal-backlog-playback.json`。
- 浏览器取证：`game/playwright.clock.config.ts`、`game/tests/audit/clock-monotonic.spec.ts`、`clock-lowfps-original.spec.ts`、`capture-fixture.mjs`、`README.md`。
- 交接：本文件。生成的 dist、node_modules、.green、test-results 均不提交。

2026-11-05 20:05–20:13 CST 实际验证：

| 验证 | 结果 |
| --- | --- |
| 相关 SnapClock / interp / remote_walk / mob_interp / shared | 6 文件，59 项通过 |
| 全部 unit，`--maxWorkers=1` | 82 文件，702 项通过，39.32 s |
| TypeScript | `npm run typecheck` 通过 |
| client / server / nav 构建 | `npm run build` 通过；仅既有大包体积警告 |
| 原 low-fps 场景，断言未改 | 通过；Metal 上实际 60.1 fps，maxStep 0.131 m，maxExcess 0.05 m |
| 真双 WS、双渲染客户端、静音 headless Metal | 通过；观察端 8.04 fps，77 帧，29 条积压，移动 22.05 m |
| 双 WS 时间戳与运动 | 最小步进 5 ms；后续平滑器瞬移 0；maxExcess −0.039 m；实际 slice 预算最大误差 3.33e−15 m；最终播放时差 98.84 ms；pageerror 0 |
| 原回调顺序完整链路回放 | 164 条真实快照、73 帧；新时钟通过；初始化后无位置瞬移；所有帧保留原 0.84 m 阈值 |
| v040 旧实现反证 | 从 `f5986aa` 取旧 interp 到本树 test-results，4 项回放全部预期失败；22 条同刻 tick 精确复现 −1000 ms，新实录复现约 −952.12 ms |

所有 typecheck / vitest / build 均经 `parallel_sprint.py gate heavy`，浏览器经 `gate browser`；仅一个浏览器会话、串行两用例，Metal 且 mute-audio。独立服务器固定 4461，Playwright 已关闭；复查端口无监听。截图 `game/test-results/clock-monotonic/two-ws-metal.png` 已亲自查看，能看到走廊及远端队友。

本地证据均在 `game/test-results/clock-monotonic/`：`resumed-target.txt`、`resumed-replay.txt`、`resumed-typecheck-build.txt`、`resumed-unit.txt`、`resumed-browser.txt`、`resumed-legacy-red.txt`、`two-ws-raw.json`、`two-ws-metal.png`。夹具保存原始文件 SHA-256，可用 `node tests/audit/capture-fixture.mjs` 从实录复现。原低帧用例副本只有静音参数与说明注释不同；没有删除测试、放宽 0.84 m 或单步阈值。

证据局限：这次浏览器使用已运行的 warm clock，验证的是积压恢复兼容性；首次加入/加载的真实反例由 fresh-clock 实录回放和旧红新绿覆盖。原性能实录没有接收时刻，其到达分组明确标为合成，不能混称原始网络时序。新夹具用实际每帧已消费条数保存事件顺序，避免 rAF 时间戳落后造成错误分组。没有进行公网长时压测或外部视频评分。

集成后仍需由集成代理串行完成全量 check、部署和线上字节一致性验收；本 lane 的通过不能替代整包上线验收。
