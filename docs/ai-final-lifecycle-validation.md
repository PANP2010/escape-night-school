# 最终开场合并后的 AI 验证

基于主集成 `2af5df9`，本切片仅修改 AI 测试夹具，不改产品保护、导演时序或任何安全阈值。

- 从真实服务端 `event/intro` 读取本次开场 id，全体参与者通过 `intro-skip` 完成后再发送当前 incarnation 的 `ready`。保留服务端结束开场时产生的 correction epoch，后续摄像机输入读取玩家当前 epoch。
- 覆盖 `difficulty_campus`、`room_difficulty`、`room_tension`、`sighting_room`、`exam_room`，五文件 **48/48 通过**。证据：`game/test-results/ai-final-lifecycle-2.json`。
- 导演连续位移 `<= 0.191m/tick`、首见最短可见时间、最小安全距离、复活和开局保护等原断言均保留。
- 考试追逐第一个 tick 会近距离真实打开未锁门。测试改为每 tick 使用当前权威门板检查完整胶囊，另外验证实际开门 delta、开门位置距离和真实穿门；不再用开门前的冻结门板判定后续位置。
- `game/test-results/ai-final-fixtures-typecheck.log`：类型检查退出 0。所有重检查经 parallel_sprint heavy gate，Vitest 单 worker。

此切片未执行浏览器、真实 WS 或最终全量 check；主集成树继续负责统一验收和 todo 勾选。
