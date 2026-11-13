# 八关集成修复复核 · 2026-11-05

本切片基于 `2534813`，只处理 campaign 接线、镜中人抓捕与关卡空间验收。未部署，未修改主工作区 `todo.md`。

## 产品修复

- 镜中人接触后会立即删除倒影，旧 Room 再从快照寻找倒影时找不到，实际抓捕事件被丢弃。MirrorAI 现保留当 tick 的准确接触位置，由 Room 送入公共倒地/救援流程；下 tick、forget 与 reset 均清理位置。
- L8 办公楼一层楼梯可把玩家带到关卡允许高度之外。首级之前新增实体栏杆，普通胶囊移动保持在一层，正门撤离继续畅通。
- 校园通用 4 米室外导航无法覆盖终章狭窄路线。新增 finale 专用图，沿实际区域与路线采样，每条连边双向走胶囊验碰撞，保留出生点连通分量，接入服务端关卡导航消息。规划按校门打开后的路线，关门期间的实际玩家移动仍受权威碰撞阻挡。
- 补齐 L6、L7 的缺失地标，调整 L8 倒桌位置，防止地标占据通路或藏进墙中。
- 关卡索引统一查询八关有序注册表，避免 L7 旁路注册与正式顺序表不一致。

## 验收维护

旧章节独立发布时的测试曾假定 L4/L5/L6/L7 是当前终章。现验证真实后继关卡；需要测试无后继回退的用例使用 `withCampaignEndingAt`，并在 finally 恢复注册表。保留结束冻结、晚加入、复活、跨关身份等行为断言。

补齐跨切片 Game 生命周期测试的依赖桩。L7 重开测试保留真实 Game 载入与消息路径，仅替换依赖 WebGL/DOM 的镜面视图。

## 已实际执行

全部命令通过 `/Users/local-user/escape/loop/parallel_sprint.py gate heavy` 获取资源锁。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npx vitest run --maxWorkers=1` | 106 文件、1026/1026 通过，46.49 秒 |
| `npm run build` | 客户端、服务器、4069 节点导航构建通过 |
| `node tests/l8-native-authority.mjs` | 13/13 通过 |
| `git diff --check` | 通过 |

原生 L8 验收：使用实际缓存导航和 4 Hz 引导、普通跑步/恢复耐力输入，33.15 秒撤离，0 个移动纠正，角色074实际行进 152.18 米；沿作者路线连续转弯为 32.85 秒，0 个移动纠正，角色074行进 150.79 米。覆盖校门关闭阻挡、开启后到出口连通、整局计时/倒地次数、救援、观察者、全灭同 seed 重开等。

日志：`/private/tmp/escape-review-campaign-final-all.log`、`/private/tmp/escape-review-campaign-typecheck.log`、`/private/tmp/escape-review-campaign-build.log`、`/private/tmp/escape-review-campaign-native.log`。

## 仍需集成方完成

本切片未启动浏览器或进行视觉评分。L5–L8 桌面/手机浏览器通关、截图与全部八关连续实玩仍交集成方验收；上述单测和原生权威检查不替代这些验收。主 `todo.md` 的第 5–8 关、全流程回归等整项应在各自完整验收达成后再勾选。
