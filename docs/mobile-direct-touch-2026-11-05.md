手机现在可以直接轻点画面里的物品、门叶和配电箱，辅助互动按钮仍可用于原有躲藏等操作；桌面键鼠行为不变。分支基于 `fb7e154`，与视觉切片 `881c840` 分开。

- `worldTouch.ts` 对实际渲染的门叶/把手实例、物品和配电箱做屏幕射线，细小物品给44 px最小选择圆。目标在手指按下时锁定，在抬手时重新检查当前距离、楼层和碰撞遮挡，交给现有 `act` 消息等待服务器的gone/door/power确认，不直接改本地物品或门状态。
- 左右两块触区各自维护指头身份，左杆移动与右手点物体可同时操作；同一区域第二指、取消、失焦、拖动都取消该次互动。10 px移动阈值不可逆，移回原点也不会变回点击；跨阈值先吃掉死区，随后只按实际移动量转头。
- 短点≤320 ms，按住350 ms后只对倒地队友启动持续搀扶；每帧保持原有救援发送和服务器3秒累计，松手/取消/目标移动或输入暂停立即停止。短点门不会误成长按、长按其他物体不会在抬手补发点击。
- HUD、地图、旋屏门、声音设置的可见区域排除世界点击，右下辅助按钮继续走原输入路径。触屏提示与教程改成“点物品”“点门”“按住队友”，保留原桌面说明。

本分支文件归属：game.ts（公共 `interact(tgt)`、`touchTarget`/`onWorldTouch` 与hold救援）、input.ts（仅worldTouch回调）、touch.ts、worldTouch.ts、hudText.ts、tutorial.ts、main.ts（仅手机hint文字）、两份文案单测、新world_touch单测和 `x-touch-world.spec.ts`。

验证：typecheck、完整build通过（4069导航节点、0 failures）；相关6文件34项unit通过，maxWorkers=2。独立4383 Chromium Metal单worker真实服务端E2E最终14.9秒通过：离准星拾取电池、左杆实际移动+右手点击、双浏览器物品gone/门open一致、拖动无act、touchcancel/同区第二指无act、超距不拾取、地图点按无世界act、竖屏门拦截、队友短点不救/半途取消不救/持续长按救起。首次独立手机点钥匙+门的两端测试也曾通过；最终自动回归用地面电池，避免随机讲台位置改变可见方向。最终errors=[]。

[点取前的真实物品](shots/mobile-direct-touch/item-before.png)和[持续搀扶后队友站起](shots/mobile-direct-touch/teammate-revived.png)均已亲自查看。原始图、WebSocket acts与日志在本worktree `game/test-results/mobile-direct/`。E2E使用当前分支原有HUD，集成视觉/音频/L4后应集中再跑同一tracked用例。

集成注意：音频分支在旧KeyE发act处记录pendingFeedback，应搬入本分支公共 `interact(tgt)` 的发act分支；保留音频`input.clear`及集成`captureTab`。L4的新候选与sticker/keypad执行分支需合入 `touchTarget` 的boxes与公共dispatch（已告知集成agent），本提交不包含L4。L7镜中钥匙保留其专属 `__l7.interactAt` 接口，本提交未接入或修改L7。

限制：屏幕拾取使用44 px圆形辅助区域，仍由距离和碰撞遮挡限制；已有服务器路径维持原权威reach/状态检查，未在本提交扩展协议或全局服务器遮挡规则。躲藏仍可用辅助互动按钮；实体手机尚未验收。不是全关卡通用触控框架。
