# 值周生姓名与黑板名单

按用户给定班级图片录入姓名，并按后续要求将“角色003”替换为“角色020”、新增“角色094”，共 42 个姓名；同一房间、关卡、怪物 id 使用同一个随机姓名，同 seed 重试保持不变。服务器把姓名作为怪物快照的增量字段发布，击倒事件携带实际怪物 id 和同一姓名。中央击倒标题为“你被〈实际人名〉卷死了”，没有括号；角色074、镜中人仍沿用各自抓捕文案。按肩短过场也显示同一人名。

值周生头顶新增小型姓名牌，只在 9 米内、相机前方且世界视线无遮挡时显示；材质保留深度测试，怪物移除或姓名改变时释放自己的贴图与材质。姓名增量快照缺省时保留上次值。

黑板的值日生从同一池无重复选取，按房间 seed、内容键和日期确定；同一黑板一周五个上学日的 20 个名字也不重复。周末沿用原逻辑留空。`Blackboards.setRosterSeed(seed)` 会在同一天 seed 变化时强制重画，避免保留上一房间名单。

集成接线：

- `shared/studentNames.ts`：姓名池、稳定随机分配、黑板去重及统一击倒文案。
- `shared/protocol.ts`：`MobSnap.name?`、`CaughtEvent.mob? / name?`。
- `server/room.ts`：实际捕获值周生 id/姓名和快照姓名使用相同缓存；保留捕获前的位置、事件顺序和救援时限。
- `client/src/mobs.ts` 与独立 `monitorName.ts`：接收姓名增量、显示及释放姓名牌。
- `client/src/game.ts`：黑板 seed、中央标题、姓名牌视线检测三处小接线。异步校园构建合入后，`setRosterSeed` 必须在校园完整就绪后调用。
- `client/src/capturePresentation.ts`：短抓捕过场使用实际人名。
- `campus/world/blackboard.ts` / `campus/data/classroom.json`：替换原名单并按同一池重画。

验证：通过共享 heavy gate 的 TypeScript 检查；7 组定向单测 58 条通过，包含两客户端姓名一致、真实 Room 捕获事件与两端快照同名、增量保留、同周名单去重、精确击倒文案、视线/距离隐藏、纹理释放，以及原捕获、监考动作、校园显示回归。日志位于 `/private/tmp/escape-names-final-unit.log`。`git diff --check` 通过。

本切片尚未运行完整构建、真实浏览器或截图验收。按主代理安排先交产品，未进入共享 browser 排队；本切片未部署，也没有改动主工作区 todo.md。后续若合入 teamFeedback，队友通知也应沿用实际事件姓名，不回退为旧泛称。
