# 怪物播放 pace 接线验证

2026-11-05，本轮修复 todo:484。`Mobs` 改用已有 `InterpBuffer.paceSpeed()`；普通快照断流使播放时钟重定位时，保留画面位置并调用已有 `catchUp()`。首次出现、blink 与明确传送仍 reset 后直接落位，原有 blink/teleport 用例保持原样，没有另造测试。

回放调用真实 `Mobs.onSnap()`、`Mobs.update()`，并沿用 `Game.frame` 的 `frameSlices()`。修前模块取自 `a2ddfb25f97db9f686f886ab4a64c6a8fab9a4d8:game/client/src/mobs.ts`，修前和修后使用相同最终 fixtures。

| 场景 | 修前 | 修后 |
|---|---|---|
| 巡逻 2 m/s，每 500 ms 更新位置；500 ms 渲染帧总落在更新后 350 ms，错过短速度窗口 | 最大单步 2.5 m，6 次 snap，最大播放差 1.5 m | 最大单步 1.05 m，0 次 snap，最大播放差 0 m |
| 巡逻 2 m/s，快照断流 2 s 后按序补齐，4 fps 渲染 | 恢复时最大单步 4.428187 m，1 次 snap | 最大单步 0.975 m，0 次 snap，最终收敛到 8 m |
| 独立停止回放 | 通过 | 收敛到 3 m，末 1 s 位移为 0 |

同样的 500 ms 位置突发在 60 fps 下，最初探针没有复现 snap；最长约 267 ms 的静帧来自快照位置本身的平段，本次不宣称消除了所有静帧。修复没有新增速度上限或修改阈值；既有 `StepSmoother` 普通远跳距离 2 m、`catchUp` 追赶范围 6 m，超过该范围仍保留远跳策略。

实际验证命令（工作目录 `game/`）：

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- python3 test-results/pace-before-after.py
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- ./node_modules/.bin/vitest run tests/unit/mob_interp.test.ts --maxWorkers=1 --no-cache --no-fsModuleCache --configLoader runner --reporter verbose --silent=false
```

第一条临时工具先加载旧模块验证两个新回归均失败，再清理临时模块并验证当前 `mob_interp`、`mobs_prewarm`、`remote_walk`：3 文件 34 用例全绿。第二条输出修后数字，7/7 通过。工具和日志位于本树忽略的 `game/test-results/pace-before-after.py`、`pace-before.log`、`pace-after.log`；常规回归可直接运行上述 vitest 命令。未运行浏览器或全量 `npm run check`。

集成注意：本 lane 保留 `Mob.at` 现有 `[x,z]` 语义；若 monitor lane 将其合并为 `[x,y,z]`，须同步所有使用该坐标计算距离的调用者。合并时保留 `paceSpeed()` 接线，以及普通播放时钟重定位调用 `catchUp()`、首次出现／blink／明确传送调用 `reset()` 的区别；不改动 `monitorAnim`、`forms` 或 `warden` 文件。
