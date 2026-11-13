# 联机断线续接与房主提示交接

基线：`57a05ea`（v040 集成树）。保留本 lane 中断前 WIP，在本树完成审查、验证后提交；未重放旧分支，未修改主工作区、其他 lane、todo、loop 或凭据。

## 产品行为

- `hello` 私发 32 字节密码学随机、base64url 编码的 opaque resume token；仅保存在页面内存和当前标签页的 sessionStorage，不进入 URL、广播、日志或永久 localStorage。成功续接即轮换 token；活连接不能被第二条连接抢占，被踢会话立即撤销 token。
- 断线后保留服务器玩家对象、身份、席位、位置和游戏状态 10 秒。断线者不能行动、救援、被追捕或阻塞在线成员过关；倒地出局计时继续，不因续接刷新保护期。无人在线时不触发全灭重开。
- 房主断线立即转给在线队友，原房主恢复后不抢回。大厅名单显示“断线中”；局内人数只数在线者，并显示重连人数。大厅和局内都有可见房主变更提示，局内常驻当前房主。
- 本轮截图复核修正房主栏被“声音与触感”按钮遮挡的问题：房主栏放在按钮下方，展开声音设置时暂时隐藏；第四关广播状态相应下移，保留广播内容与交互。
- 续接先下发完整房间、世界与玩家/怪物状态，再强制纠正到服务器权威位置。恢复必须使用新的 correction epoch 与递增 seq，离线输入、交互、聊天和自动寻路不重放。
- 客户端断网/静默时暂停操作与反馈；恢复同步完成才解锁。柜内刷新还原服务器朝向/俯仰与柜缝视角，避免默认朝向把玩家转向柜壁。10 秒恢复失败后回普通大厅，浏览器仍离线时等 online 再返回，避免离线 reload 丢失在线监听。
- 服务器每 5 秒 ping，15 秒无 WS pong 断开；应用层 heartbeat 不能替代 WS pong。10 秒保留期从服务器确认断线开始，静默网络黑洞先经心跳超时识别。限制 50 房间、实际源 IP 4 连接、滚动秒 30 条消息；8 条非法消息或持续洪泛踢出并撤销续接。

## 已知边界

- 若服务器接受续接并轮换凭据后，新 welcome 尚未抵达客户端就再次断线，客户端仍持有已退役凭据，会返回正常大厅。此切片保持旧凭据立即失效，不增加旧凭据别名或确认协议；持续稳定的网络恢复、刷新及静默掉线已覆盖。

## 文件与合并点

- 新模块：`game/server/reconnect.ts`、`game/client/src/reconnect.ts`、`reconnect.css`。
- 服务端：`index.ts` 的连接生命周期/hello/heartbeat/限流接线；`room.ts` 只增加 offline 过滤、disconnect/resume、恢复完整状态及输入纪元保护，未重构关卡/AI。
- 协议：`game/shared/protocol.ts` 增加 hello.resume、welcome 扩展、heartbeat、resume.downLeft、玩家 online=false；未改 shared/lines.ts。
- 客户端：`net.ts` 负责续接状态机；`main.ts` 负责覆盖提示、房主提示与过期返回；`game.ts` 增加暂停和恢复钩子、离线队友过滤，救援发送改 8 Hz 以让正常 20 Hz input + 长按救援处于 30 条/秒限额内；`broadcast.ts`、`voice.ts` 只加可恢复的静音接口。
- 验证：3 个 reconnect 单测；真实 WS 测试及 peer/proxy helper；独立 `playwright.reconnect.config.ts` 与 2 个单浏览器验收。现有 x-multi 仅适配断线保留席位、房主提示与源 IP 限额，未删断言。macOS 使用已有接口作为第二来源，避免未配置的 127.0.0.2 导致 EADDRNOTAVAIL。

与公共大厅、音频、过场等 lane 合并时保留其产品内容，再接入以上钩子。尤其不要用本树整份覆盖它们已更改的 main/game/room/protocol。新增关卡若增加 sendState 或完整 mob 字段，也要纳入 resume 的全量同步。客户端与服务器需作为同一集成构建配套部署。

## 实际验证

- 中断前 heavy 门禁：typecheck 通过；10 文件 126 项相关单测通过；完整 client/server/nav 构建通过。最终测试修改后的第二次 typecheck 也通过。
- 中断前补查柜内刷新朝向问题：实际 Game.onMsg(snap) 回归用例在旧逻辑下稳定失败（期望 1.4，实际 0）；修复后再次 typecheck、4 文件 36 项续接/躲藏单测、client 构建均通过。
- 真实构建服 4419：最终 10 组真实 WS 验收全部通过，含“有效续接凭据/新纪元仍拒绝 10 米瞬移”；15 秒无 pong 实测 15.016 秒。macOS 第二实际 IPv4 来源连接固定 4419 端口也通过，未配置 loopback alias。结果：`game/test-results/reconnect-ws.json`；该轮自起服务器已关闭。
- 中断前浏览器记录已找回：本 lane `attempt-190551/events.jsonl:232` 的 item_40，browser 门禁命令退出 0，两个独立用例 `2 passed (31.9s)`。涵盖大厅/局内 offline→online、原位恢复、刷新仍为存活玩家、过期回入口、两处房主转移提示，以及浏览器保持 online 的单向链路静默续接。证据时间 18:58:22–18:58:53，晚于 `f62ec73` 与本树配套构建；本轮已亲自查看全部 6 张截图。
- 本轮布局修复后：heavy 门禁 `npm run build:client` 退出 0；browser 门禁运行原两条用例，`2 passed (32.3s)`、退出 0。只用一个浏览器/worker、Metal、headless `--mute-audio`，固定 4419。证据目录中的临时 harness 导入原 spec，只在同一页面补充窄屏截图，没有修改原测试。完整命令/输出：`game/test-results/reconnect-browser-final.log`。
- 本轮 8 张新截图均已亲自查看；960×540、844×390、640×360 的房主栏与声音按钮无重叠。窄屏实测房主栏 y=96、高 29.5，声音按钮 y=44、高 46；目标面板也清楚。窄屏是桌面 context 调整尺寸，未模拟触控与设备安全区域；第四关广播的布局仅静态确认，柜内刷新朝向专门场景仍由既有单测覆盖。
- 本轮 browser 门禁完成后复查 4419 无监听，未留下自起浏览器或服务器。
- 独立浏览器用例不在默认 `tests/e2e` 目录中；集成全量 check 释放资源锁后，需额外执行 `cd game && python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node node_modules/@playwright/test/cli.js test --config=playwright.reconnect.config.ts`，并确保 4419 空闲。
- 未运行全量 npm run check；按分工交由集成代理串行执行。未部署；部署必须由集成代理完成。
- 本轮无视频/Gemini 外部评分。生成证据只保留在本树 game/test-results，不提交。
