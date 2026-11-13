# 值周代号025 Boss 验证记录

2026-11-07，提交 `2f7011c`：`npm run typecheck`、完整 `npm run build` 和全部 165 个 Vitest 文件 / 1701 项测试通过。导航构建为 4069 节点、0 失败。相关测试覆盖预警期间不命中、走出粉笔圈、跨楼层、墙体遮挡、冷却与扫线边界；带宽测试保持原阈值。

真实浏览器命令：先以 `PORT=4438 HOST=127.0.0.1 node dist-server/index.js` 启动开发测试服务，再运行 `node tests/shot-role_boss.mjs`。此脚本使用 844×390 触屏 Chromium，经过大厅和权威 `/ws`。调试仅用于进入 L5、摆放初始位置和关闭角色074；技能预警后的躲避使用普通键盘移动，不修改 Boss、玩家状态或判定。

实测首次粉笔圈以 `[-100, 0, 62]` 为固定目标，预警 1.8 秒。玩家走至 `[-100, 0, 58.8002]` 后，服务端进入 active（tick 361），玩家未倒地、未旁观、未收到 caught。页面错误为 0。客户端实际创建 `ROLE_BOSS_CHALK_BADGE` 与 `ROLE_BOSS_DUTY_SASH`；预警有 polite 实时播报，并与目标面板无重叠。

可复现产物写入 `test-results/role_boss-smoke/report.json` 与 `phone-boss.png`。截图是技能验证通过后的看台近景，用于确认红绶带、粉笔胸牌、姓名及手机布局；它不代替服务端判定证据。
