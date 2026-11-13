import * as THREE from 'three';
import { FLOOR_HEIGHT, floorStack, roomKey, WALL_T, type BuildingDef, type RoomDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { facadeOpenings } from './building.ts';
import { PART, rectOf, storeyPartitions, storeyRooms } from './rooms.ts';
import { STAIR, type LBox } from '../../../../shared/campus/stairs.ts';
import { SURF } from '../render/facade.ts';
import { officeFurniture, officeSpot } from './office.ts';
import { guardFurniture, guardSpot } from './gatehouse.ts';
import { isLibraryRoom, libraryFurniture, librarySpot } from './library.ts';
import { serverFurniture } from './netroom.ts';
import { hallFurniture, hallSpot, isHallRoom } from './hall.ts';
import { gymFurniture, gymSpot } from './gym.ts';
import { canteenFurniture, canteenSpot, isCanteenRoom } from './canteen.ts';
import { isLabRoom, labFurniture, labSpot } from './oldlab.ts';
import { boilerFurniture, boilerSpot, isBoilerRoom } from './boiler.ts';
import { isToiletRoom, toiletFurniture } from './toilet.ts';
import { isWaterRoom, waterFurniture } from './waterroom.ts';
import { isStorageRoom, storageFurniture } from './storage.ts';
import { safetyFurniture } from './safety.ts';
import { stairFurniture } from './stairfit.ts';
import { doorTrims, officeLeaves } from './doorway.ts';
import { hallwayFurniture } from './hallway.ts';

/**
 * 教室陈设① (docs/03_campus.md 室内③): 课桌椅, 讲台, 讲桌 and the 黑板 of every 教室, laid out in the room's own frame
 * and turned into building-local axis-aligned boxes. Orientation 「窗在左」: the students face so that the outer wall
 * with the windows is on their left (light from the left for right-handed writing), the 讲台 is at the end they face.
 * One list of boxes feeds the colliders, roomRoute (world/interior.ts) and the render (`furnitureGeometry`: one merged
 * mesh per storey, lit by the building's interior material). Pure apart from the geometry builder.
 */

export const DESK = {
  /** one desk (across × along × top height), its 桌肚 under the top */ w: 0.6, d: 0.42, h: 0.76, top: 0.03, drawer: 0.15,
  /** chair seat (across × along), seat height, backrest top; centre behind the desk centre */ cw: 0.4, cd: 0.38, seat: 0.45, back: 0.85, behind: 0.4,
  /** row pitch, the aisles between desk pairs (at least), 讲台 + gap to the first row, free space behind the last row */
  pitch: 0.9, aisle: 0.7, front: 1.8, rear: 1.6, maxPairs: 4, maxRows: 8,
  /** 讲台 (depth, height, kept off the side walls), 讲桌 (across × along × height above the 讲台) */
  stage: { d: 1, h: 0.2, side: 0.9 }, lectern: { w: 1.2, d: 0.55, h: 0.95 },
  /** Steel desk/chair frame: 30 mm square tube, with all four sides visible from the hiding camera. */
  tube: 0.03,
  /** 黑板 (bottom, top above the storey floor; widest), 槽 under it */ board: { y0: 0.95, y1: 2.15, w: 4.2, frame: 0.05 },
  /** 后黑板报 on the back wall (bottom, top, widest; kept `side` m off each side wall) */ bulletin: { y0: 1, y1: 2.2, w: 3.6, side: 0.8 },
  /** 钟 over the middle of the 黑板 (centre height above the storey floor, radius, face off the wall) */ clock: { y: 2.64, r: 0.2, off: 0.04 },
  /** 储物柜 under the 黑板报: column width, depth, two tiers of this height, gap between doors (the ink draws it), handle */
  locker: { w: 0.45, d: 0.4, tier: 0.42, gap: 0.012, handle: { w: 0.025, h: 0.09, d: 0.02 } },
  /** 窗帘 gathered either side of each outer window: bunch width (past the jamb, over the glass), pleats per bunch, the
   *  pleats' two depths off the wall, top above / bottom below the window, rail (height, depth) */
  curtain: { out: 0.34, over: 0.08, pleats: 4, near: 0.05, far: 0.12, above: 0.22, below: 0.12, rail: { h: 0.04, d: 0.13 } },
  /** 日光灯 fixture on the TUBE grid: hung `drop` under the ceiling on two rods, a reflector housing over the tube */
  lamp: { drop: 0.3, housing: { len: 1.28, w: 0.14, h: 0.05 }, tube: { w: 0.04, h: 0.035 }, rod: 0.012, keep: 0.15 },
  /** 吊扇 at TUBE grid cell centres (between the tubes): down-rod, motor, 3 blades (length from the hub, width) */
  fan: { rod: 0.55, motor: { r: 0.12, h: 0.13 }, blade: { r0: 0.08, len: 0.62, w: 0.12, t: 0.012 }, keep: 0.8, max: 4 },
  /** 投影幕 rolled up in its case under the ceiling over the 黑板 (half width cap, depth, height, off the wall, pull cord) */
  screen: { half: 1.3, d: 0.1, h: 0.11, off: 0.03, cord: 0.32 },
  /** 黑板灯 (打磨②): reflector fixtures flush on the ceiling `off` m out from the 黑板, `n` of them `len` long side by
   *  side along it; their tube is lit with the room's 日光灯 and the slate takes the light (render/interior_light.ts
   *  BOARD_LAMP) */
  boardLamp: { off: 0.75, n: 2, len: 1.28, gap: 0.5, housing: { w: 0.2, h: 0.08 }, tube: { w: 0.04, h: 0.035 } },
  /** 投影仪 on a ceiling rod, `back` m from the front wall (snapped between tube rows) */
  projector: { w: 0.34, d: 0.28, h: 0.11, drop: 0.45, back: 3.5 },
};

/** Ceiling 日光灯 grid (building-local, m): a tube `len` long every `px` along x, `w` wide every `pz` along z (the
 *  interior material paints the strip on every ceiling; a 教室 hangs a fixture over each one inside it). */
export const TUBE = { px: 3, len: 1.2, pz: 2.4, w: 0.12 };

export const FURN_COLOR = {
  // wood: the 黄课桌's varnish. Chroma well clear of the greys (Oklab C .1): indoors a top gets ~0.2× light and keeps
  // ~70% of its chroma, and the cold 日光灯 at night takes more; at C .056 it fell into the grey ramp (docs/05 家具色)
  wood: '#c3a656', steel: '#8d8b82', mouth: '#4e483d', stage: '#a08e6e', lectern: '#c89a58', board: '#4a6680', frame: '#8a7a62',
  locker: '#8f9790', curtain: '#8c98a0', fold: '#6f7b84', rail: '#a7a397',
  lamp: '#bdbcb2', tube: '#e4e5de', boardTube: '#e4e5de', screen: '#cdcabf', fan: '#a6a497', projector: '#c3c0b5', cord: '#a7a397',
  // 办公室 (world/office.ts): varnished old desks, 作业本 covers, 暖壶, 绿萝, 档案柜 and its 档案盒, the papers on the walls
  // (the three pulled apart for the dim room, docs/05 家具色: desk a brown 栗色 wood (24, the floor is grey 3), chair a
  // 枣红 paint (27/21), 档案柜 a yellow varnished wood (12) off the grey wall and the blue 墙裙)
  desk: '#c89a60', chair: '#c07858', paper: '#dcd6c5', cover: '#7f8d93', coverR: '#93695c', coverG: '#78866b',
  cup: '#d3cfc3', shade: '#62705f', thermos: '#8a5848', pot: '#8c6d56', leaf: '#71895c', cabinet: '#c3a656',
  file: '#b09b75', ink: '#46423a', sill: '#bcb6a7',
  // 校长室 / 会议室: a dark brown 皮沙发 / 老板椅, white 蕾丝 巾, the 茶几's green-tinted glass, red 锦旗 with gold 题字,
  // the 发财树's lit leaves, the 会议桌's blue 台布 (a green one fell into the grey ramp like the floor; blue lands 17 as bookB)
  leather: '#7a4a3a', lace: '#ebe6da', glassTop: '#9fb4ac', pennant: '#b84a3c', pennantGold: '#d8b860',
  leafHi: '#86a848', tableCloth: '#6e8cc4',
  // 处室 / 档案室 / 复印室 / 财务室: the 铁皮柜's blue-grey baked enamel (a pale grey one sat on the wall's grey; blue
  // lands on the palette's blue like the 台布, C .08), the 复印机's beige body and its charcoal lid / base, the 保险柜's
  // dark green paint
  steelCab: '#7a96c6', copier: '#c4bca6', copierTop: '#4a4c4c', safe: '#55705e',
  // 门卫室 (world/gatehouse.ts): the 收音机's wood case and speaker cloth, a black 电话, 搪瓷缸, the little 电视 and its
  // dark screen, the 蓝白格 床单 (blue, the white checks are paper strips), the 军绿 被子, a red 暖壶; all off the grey
  // ramp the walls and floor sit on (docs/05 家具色: 床单 17/18, 被子 29/30, 暖壶 21/22)
  radio: '#7d6047', cloth: '#5b544a', phone: '#4a4741', enamel: '#dcd9cf', tv: '#94918a', crt: '#3e4844',
  quilt: '#7a9ad0', blanket: '#8a8236', thermosR: '#b84a3c',
  // 图书馆 (world/library.ts): grey-green steel 书架, faded book cloth, the 借还台's 水曲柳 front, the oak 目录柜
  shelf: '#9aa096', shelfBack: '#7e847b', bookR: '#8a5a4e', bookB: '#6e8cc4', bookG: '#7f8a3e', bookY: '#a8925e', bookW: '#c9c2ae',
  counter: '#a28b68', catalog: '#8e7456',
  // 密集书库: the carriages' grey-blue baked enamel, the cream 端板, the 手摇轮's black handle, the 书脊 (painted by the shader)
  compact: '#9ea6a6', compactEnd: '#c2bba6', knob: '#3f3d38', spines: '#ffffff',
  // 网络中心机房 (world/netroom.ts): 防静电地板 tiles (some 通风板) on a dark pedestal grid, charcoal 机柜, black servers
  // and beige 交换机 in them, the cream 精密空调 / UPS, 指示灯 (lit by the shader: FurnBox.glow), the 监控 feeds, cables
  tile: '#c4c1b6', tileVent: '#a9a79e', pedestal: '#4a4843', rack: '#4f5557', rackDoor: '#a3a9a6', rackMesh: '#6c7270', server: '#3b3e3f', switch: '#b5ae9b',
  aircon: '#cdc8b8', grille: '#7d7a70', ledG: '#86c873', ledA: '#dba55a', feed: '#ffffff', cable: '#3d403c', duct: '#d6d3c8',
  // 锁着的门 (world/doors.ts): an old 木门's faded green paint
  doorLeaf: '#93a08c',
  // 门套 (world/doorway.ts): the 隔墙 doors' varnished wooden frames. Not green: the palette has none, and the old
  // #6f7a66 snapped to charcoal, so a 门套 seen edge-on read as a near-black slab up the wall (LIB 中厅, 门厅); a
  // light grey-beige (r − b < 40), not ochre, so a classroom's wall stays clear of the desks' yellow (e2e class7)
  doorTrim: '#a89c86',
  // 体育馆 (world/gym.ts): 枫木地板 and its seams, white court lines on a faded red 限制区, grey steel 桁架, the 篮架's
  // dark blue base and pads, white 篮板, orange 篮圈, the 器材室's 吊顶, blue-grey 体操垫, the 跳箱's varnish and
  // leather, 实心球, 跳绳, red-and-white 栏架, basketballs
  maple: '#bea47e', mapleSeam: '#a98c62', courtLine: '#e8e4d8', keyPaint: '#c88c74', truss: '#8f938f',
  hoopBase: '#4f6170', hoopPad: '#5c6f7e', hoopPost: '#6d7478', backboard: '#e2e0d8', rim: '#c4703e', net: '#d8d4c8',
  ceiling: '#d7d3c6', mat: '#6f8494', matB: '#5f7484', matEdge: '#4a5a66', vault: '#b08e62', vaultTop: '#7a5a44',
  medBall: '#5a4e44', rope: '#a8554a', hurdle: '#d6d1c4', hurdleBar: '#b0574a', ball: '#b0683e',
  // 食堂 + 小卖部 (world/canteen.ts): the 餐桌's cream melamine top and orange stools, stainless 打饭台 / 滑道 / 抽油烟罩
  // (a cool grey, #228: a step over the wall where the old #b4b5ae sat under it) and their bright 折边, the 罩's dark
  // 油网, the galvanised 排烟管 (flue), what's in the 菜盆, the white 瓷砖 and the floor's 红缸砖 (格缝: render/interior_light.ts, SURF_TILE), the
  // black 大锅 and its pale bottom, the 木锅盖, the red 燃气阀, the 案板, bamboo 蒸笼, the 小卖部's glass 柜台 top, snack
  // packets, bottles, the 冰柜 (the 柜台's base: counterBody)
  tableTop: '#d8d0bc', stool: '#c08a52', stainless: '#c4ccd2', stainlessHi: '#f4f3ee', hoodFilter: '#7a7e80', flue: '#a8a8a2', counterBody: '#7f8b80',
  rice: '#e6e2d6', potato: '#c9a45e', greens: '#6f8a52', braise: '#8a4e38', tileWhite: '#f0efe8', wok: '#3e3c38', wokIn: '#6a665f',
  quarry: '#b86e58', lid: '#b88a58', lidTop: '#c89a66', valve: '#c0503c', chopping: '#a88a62',
  steamer: '#c2a676', steamerB: '#b39867', steamerLid: '#a88e60', glassCase: '#a9b8b4',
  snackR: '#b25a48', snackY: '#c9a84e', snackB: '#5e7896', snackG: '#7a9460', bottle: '#8fa9a2', freezer: '#dedbd0',
  // 2F 小炒 餐厅: 四人方桌 in a pale green 防火板 with a darker apron, red-brown 靠背椅 (cheap moulded seat + back),
  // the bamboo 筷筒, a white 纸巾盒, the 立式空调's cream cabinet and its grey grilles
  sqTable: '#7fbf86', sqEdge: '#4f8f58', chairCan: '#a8553f', chopTube: '#b9945a', tissue: '#ebe8de', acUnit: '#e4e0d4', acGrille: '#9a9890',
  // 礼堂 (world/hall.ts): the 舞台's varnished boards (`deck`, lighter than a classroom 讲台's `stage`), its dark
  // nosing, 台口墙 plaster, the red 横幅 and its cream characters, wine-red 大幕 (two tones for the pleats; it stands in
  // the 台口's shadow at ~15% light, hence the pale albedo: it lands on 背光砖 27/28, not black, #227), black 侧幕, the
  // grey-blue 天幕, spotlights, green baize, the piano and its 防尘罩, the 合唱台阶, 礼堂椅 (wooden back with a pale worn
  // top rail, red pad, steel arm)
  deck: '#c8a058', hallDoor: '#7e3a30', hallCase: '#9c8f78', stageEdge: '#5e4a38', stageSeam: '#8a7658', plaster: '#cfc6b2', banner: '#9a4a40', bannerText: '#e2d8bc',
  drape: '#d8746a', drapeB: '#b05650', drapeDark: '#3e3a38', cyc: '#8e98a0', spot: '#45464a', baize: '#8fac87',
  piano: '#3a3532', dustCloth: '#c9c2b0', riser: '#9a8462', seatBack: '#b29468', seatRail: '#d6c29a', seatPad: '#b8634f', seatArm: '#7a766c',
  // the 观众席's raked tiers (水磨石), their risers a shade deeper, and the dark nosings
  rake: '#a8a294', rakeRiser: '#8a8476', rakeEdge: '#6e6658',
  // 台仓: the deck's 搁栅, 布景 flats (raw plywood back, painted sky / wall / trees, faded), 道具箱 and their lids, the 大鼓
  flatBack: '#b89e78', flatSky: '#a3b6bc', flatWall: '#c8aa8c', flatGreen: '#6e9a52', joist: '#bca684', crate: '#ae9068', crateLid: '#8c7052', drum: '#a65244',
  // 旧实验楼 (world/oldlab.ts): 实验桌's black 台面 on a grey-green body, the white 水池, 方凳, the 通风橱 and its glass,
  // 试剂瓶 (brown, clear, white-labelled), 标本罐 and their lids, 仪器 brass, 纸箱; 暗室: the 遮光板 and its battens, the
  // 显影盘 (red / grey / white enamel) and the liquid in them, the 安全灯 (case, red glass: lit), the 放大机, its bellows
  // and 放大尺板, prints on the 晾片绳 (light, dark), wooden pegs, the 遮光帘
  labTop: '#3e403c', labBody: '#7f8a7e', sink: '#c9c8bf', labStool: '#9a8664', hood: '#c4c0b2', hoodGlass: '#a9b5b1',
  reagentB: '#7a4e30', reagentC: '#b8c2bc', reagentW: '#d6d2c4', jar: '#a7ad8c', jarLid: '#5b5a52', brass: '#a88a4e',
  // 标本室: 标本罐 (old 福尔马林 gone cloudy yellow-green, C .11: paler and greyer on the sunny window row), the glass over
  // it, a glint, the 蜡封 (sealing-wax red-brown, faded), the thing in it (dark, bleached), the 标本柜's varnished wood and
  // its dark inside, the plastic 人体骨架 gone ivory-yellow (C .08: the cream wall is C .03), the 猫头鹰, its face, dust
  formalin: '#cbc270', formalinPale: '#d9d094', jarGlass: '#c2ccc4', jarHi: '#eef0e6', wax: '#94503c', waxPale: '#b08670',
  specimen: '#5c4a2a', specimenPale: '#968c6e', specCab: '#965f36', specCabIn: '#5a3c24', bone: '#d6c48a',
  owl: '#8a7656', owlFace: '#c4b48e', dust: '#cbc8be',
  box: '#b49a72', boxB: '#a08660', blackout: '#5e5446', batten: '#4a4238',
  // 配电间 (world/storage.ts): 灰绿 铁皮 配电柜, its paler 眉头 / 窗框
  switchgear: '#6f9a80', switchgearHi: '#b0c4b4',
  // 杂物间 / 库房 (world/storage.ts): 角钢货架's grey-blue paint, 油漆桶, 米面袋 (white flour, the 编织 rice sack), white
  // plastic 调料桶, the blue 油桶
  rackSteel: '#7d8a96', paintCan: '#c9c4b4', sack: '#e2ddcf', sackB: '#c8bc98', tub: '#dcdad0', oilCan: '#4f74a0',
  trayDev: '#a8574a', trayStop: '#8c8c86', trayFix: '#d8d4c6', tray: '#6e6a58', safelightCase: '#2e2d2a', safelight: '#a8261a', exitCase: '#cfd2c8', exitSign: '#3e8a86',
  enlarger: '#3a3936', bellows: '#24231f', easel: '#c8c2b0', print: '#d8d2c0', printDark: '#6a6660', peg: '#b0905e', blackCloth: '#2f2d2b',
  // 锅炉房 (world/boiler.ts): the 耐火砖 setting, the shell's grey 石棉 lagging (lit / shaded), iron (front plate, bands,
  // 烟道), its rust bands, the 炉门, the cold 炉膛 / dark 观火孔, the 压力表 face, red 手轮, the green-painted 水箱 and
  // 水泵, 煤 (two lumps' tones, the dust on the floor), grey 灰渣, the 斗车's rubber wheel
  blrBrick: '#c08c72', blrLag: '#b4ae9f', blrLagD: '#a69c8c', blrIron: '#7b7266', blrBand: '#7a5440', blrDoor: '#5e574d',
  blrHearth: '#1f1c19', blrGauge: '#dcd6c4', blrValve: '#a8433a', blrTank: '#6f8270', blrPump: '#55705e',
  // the 煤仓门 (world/doors.ts iron leaf, boiler.ts frame): faded 铁红 plate (light: in the dim corner by the 煤渣 a
  // #9a6450 lands on the warm greys, as dark as the boiler front), darker flat bar and angle iron
  ironDoor: '#c48a6c', ironBand: '#6e4535',
  coal: '#2f2e2c', coalB: '#3a3936', coalDust: '#665e53', ash: '#8e8a82', ashB: '#7c7870', rubber: '#2c2b29',
  // 角色061's things: 竹梯 / 扫帚 handle, the 扫帚's straw, 捆纸箱的 string, the red-brown plastic 拖把桶
  bamboo: '#b48f3c', straw: '#d2b25a', twine: '#e2dac8', pail: '#9a6450',
  // 天台水箱间 (world/tankroom.ts): the cement-rendered 墙裙 (and the pump plinth), the whitewash over it and on the
  // ceiling, the floor screed; the 水泵 pair's blue-grey paint (motor, pump body)
  cement: '#8f8a80', cementD: '#7a766c', lime: '#c8c1ae', tankMotor: '#5b8597', tankPump: '#79a4b4',
  // 厕所 (world/toilet.ts): the 蹲位's 隔板 in blue-grey 调和漆 (the palette has no green: a pale grey-green snaps to the wall grey), its darker 立柱 / 压条 and the wet-stained foot along it, the
  // grey tiled 台阶 under them, white 蹲坑 porcelain
  stall: '#8a9db8', stallTrim: '#3a4250', stallFoot: '#6c727a', stallStep: '#99978f', porcelain: '#e6e5de',
  // 消防与监控 (world/safety.ts): the 灭火器箱's red steel and its glass door, the bottles behind it, white 标识; the
  // 监控摄像头's off-white body, black lens, grey mount, red light (lit)
  extBox: '#d8705a', extGlass: '#8c9692', extBottle: '#e08a6e', extLabel: '#f2eee4',
  camBody: '#ece9e0', camLens: '#222322', camMount: '#a3a49f', camLed: '#c8302a',
  // 楼梯间陈设 (world/stairfit.ts): the 银粉 cast-iron radiator and the dark between its sections; the 消火栓箱's dull
  // red steel and its 铁皮门 (lighter than it looks: the 1F 楼层平台 is dim, and darker reds fall to the palette's
  // greys there), the coiled canvas 水带 behind the glass
  radIron: '#c4c5be', radGap: '#45443f', hydBox: '#c25646', hydDoor: '#cc5e4d', hydHose: '#d3cbb4',
};

export type Kind = keyof typeof FURN_COLOR;
/** A box face: one of the 4 sides or top / bottom. */
export type Face = Side | 'top' | 'bottom';
/**
 * A render box (building-local) with its colour; `skip` = faces never seen (on the floor, against a wall, edges of a
 * thin board: the ink pass outlines it anyway). `mouth`: that face is drawn as the dark 桌肚 opening under a `lip`
 * (m) strip of the box's own colour (the desk top's edge).
 */
export interface FurnBox extends LBox {
  kind: Kind; skip?: Face[]; mouth?: Side; lip?: number; /** turned this much (rad) about its centre in plan (吊扇 blades) */ rot?: number;
  /** turned this much (rad) about its centre around a horizontal building axis (密集架 手摇轮): x→y about z, z→y about x */
  spin?: { axis: 'x' | 'z'; ang: number };
  /** an upright prism instead of a box: its four vertical edges cut at 45° back this fraction of the half-width
   *  (标本罐: an octagon reads as a round jar); eight sides always drawn, `skip` only takes top / bottom */
  oct?: number;
  /** 书脊 (密集架 merged books, world/library.ts): the tier's clear height (m); the interior shader paints the books on
   *  the box (surf = (its bottom y, 5 + spine)) */
  spine?: number;
  /** 书脊 seed 1..255 (a moving 密集架's, world/compact.ts): its painting hashes on this instead of where the face is */
  seed?: number;
  /** lit by the interior shader (world/netroom.ts): a 指示灯 (`phase` 0..1 flickers with its own phase, ≥ 1 steady)
   *  or one quarter of a 监控 picture (`phase` = the camera it shows) */
  glow?: 'led' | 'feed'; phase?: number;
  /** 吊扇 part that turns (blade / motor): its axis (building-local x, z); the interior shader spins it about the axis
   *  while the room's 日光灯 are on (surf = (world x, SURF_FAN - world z)) */
  fan?: [number, number];
  /** 档案盒 (world/office.ts): this face is its spine, the interior shader paints a handwritten label and the finger
   *  hole on it (surf = (u + 2 × (width cm + 16 × (height cm + 64 × seed)), SURF_LABEL + v), u, v 0..1 across the face) */
  label?: Side; /** its seed 0..15 */ labelSeed?: number;
  /** 作业本 pile (world/office.ts): the side faces show the stacked books' cover and page edges
   *  (surf = (height + 10 if a `paper` batch, SURF_PILE + v)) */
  pile?: boolean;
}

/** Unit plan vector of a side. */
const vec = (s: Side): [number, number] => (s[1] === 'x' ? [s[0] === '+' ? 1 : -1, 0] : [0, s[0] === '+' ? 1 : -1]);
const sideOf = (x: number, z: number): Side => (Math.abs(x) > Math.abs(z) ? (x > 0 ? '+x' : '-x') : (z > 0 ? '+z' : '-z'));

/**
 * Which way a classroom's students face (building-local side): the window wall (a room edge on the outer wall) on
 * their left; with windows on two sides the one that makes them face along the room's longer axis; no outer wall →
 * the corridor (door) side on their right.
 */
export function classroomFacing(b: BuildingDef, r: RoomDef): Side {
  const R = rectOf(r), ix = b.w / 2 - WALL_T, iz = b.d / 2 - WALL_T, e = 0.05;
  const outer: Side[] = [];
  if (Math.abs(R.x0 + ix) < e) outer.push('-x');
  if (Math.abs(R.x1 - ix) < e) outer.push('+x');
  if (Math.abs(R.z0 + iz) < e) outer.push('-z');
  if (Math.abs(R.z1 - iz) < e) outer.push('+z');
  // facing f with the window normal n on the left: left of f = (f.z, −f.x) = n → f = (−n.z, n.x)
  const face = (n: [number, number]) => sideOf(-n[1], n[0]);
  const along = r.w >= r.d ? 'x' : 'z';
  const win = outer.find(s => face(vec(s))[1] === along) ?? outer[0];
  if (win) return face(vec(win));
  // the door side on the right: right of f = (−f.z, f.x) = d → f = (d.z, −d.x)
  const d = vec(r.doors?.[0]?.side ?? '+z');
  return sideOf(d[1], -d[0]);
}

/** The room's frame: centre, facing f, right-hand r; usable half-length along f and half-width across (隔墙 off). */
const frame = (b: BuildingDef, r: RoomDef) => roomFrame(r, classroomFacing(b, r));

/** A room's frame facing `front` (world/office.ts lays its 办公室 out in one too). */
export function roomFrame(r: RoomDef, front: Side) {
  const f = vec(front), rt: [number, number] = [-f[1], f[0]];
  const t = PART.t / 2, L = (f[0] !== 0 ? r.w : r.d) / 2 - t, W = (f[0] !== 0 ? r.d : r.w) / 2 - t;
  /** (along a, across v, y0..y1) box in the room frame → building-local AABB */
  const box = (a0: number, a1: number, v0: number, v1: number, y0: number, y1: number): LBox => {
    const xs = [a0, a1].flatMap(a => [v0, v1].map(v => r.x + f[0] * a + rt[0] * v));
    const zs = [a0, a1].flatMap(a => [v0, v1].map(v => r.z + f[1] * a + rt[1] * v));
    return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs), y0, y1 };
  };
  /** room-frame direction → building-local side: f(ront), b(ack), r(ight), l(eft) */
  const dir = (k: 'f' | 'b' | 'r' | 'l'): Side => {
    const [x, z] = k === 'f' ? f : k === 'b' ? [-f[0], -f[1]] : k === 'r' ? rt : [-rt[0], -rt[1]];
    return sideOf(x, z);
  };
  /** room-frame point (along a, across v, height y) → building-local [x, y, z] */
  const pt = (a: number, v: number, y: number): [number, number, number] => [r.x + f[0] * a + rt[0] * v, y, r.z + f[1] * a + rt[1] * v];
  return { front, f, L, W, box, dir, pt };
}

/**
 * A chalked face (教室② 黑板 / 黑板报, world/blackboard.ts draws what is on it): building-local corners bottom-left,
 * bottom-right, top-right, top-left as seen from inside the room, the side it faces, the room it belongs to.
 */
export interface BoardFace { room: string; part: 'front' | 'back'; p: [number, number, number][]; n: Side }

/**
 * Whether the room's wall on `side` is a plain 隔墙 along [v0, v1] (room frame across, centred on the room) up to
 * `y1` above the floor: a partition covers the span and no door / high window of it opens there. Outer and 天井 walls
 * (windows; never in storeyPartitions) are not plain: a board there would hang over the glass.
 */
function plainWall(b: BuildingDef, level: number, r: RoomDef, side: Side, half: number, y1: number): boolean {
  const R = rectOf(r), axis = side[1] === 'x' ? 'z' : 'x';
  const c = side === '+x' ? R.x1 : side === '-x' ? R.x0 : side === '+z' ? R.z1 : R.z0, mid = axis === 'x' ? r.x : r.z;
  const u0 = mid - half, u1 = mid + half;
  return storeyPartitions(b, level).some(p => p.axis === axis && Math.abs(p.c - c) < 0.05 && p.u0 <= u0 + 1e-6 && p.u1 >= u1 - 1e-6
    && !p.holes.some(h => h.u0 < u1 + 0.1 && u0 - 0.1 < h.u1 && h.y0 < y1));
}

/** Desk-pair columns (centre v of each pair) and row centres (a of each desk) of a classroom; empty if it is too small. */
export function seatGrid(b: BuildingDef, r: RoomDef): { pairs: number[]; rows: number[] } {
  const { L, W } = frame(b, r), D = DESK, pw = 2 * D.w;
  const n = Math.min(D.maxPairs, Math.floor((2 * W - D.aisle) / (pw + D.aisle)));
  const rowSpan = D.d / 2 + D.behind + D.cd / 2; // desk front edge → chair back
  const m = Math.min(D.maxRows, Math.floor((2 * L - D.front - D.rear - rowSpan) / D.pitch) + 1);
  if (n < 1 || m < 1) return { pairs: [], rows: [] };
  const gap = (2 * W - n * pw) / (n + 1);
  const pairs = Array.from({ length: n }, (_, k) => -W + gap + pw / 2 + k * (pw + gap));
  const a0 = L - D.front - D.d / 2;
  return { pairs, rows: Array.from({ length: m }, (_, k) => a0 - k * D.pitch) };
}

/**
 * Everything in one classroom: render boxes and colliders (building-local, y from the storey floor `y`). A collider
 * per desk pair + its chairs (the walker goes round by the aisles), the 讲台 (low enough to step onto), the 讲桌.
 */
export function classroomFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const { L, W, box, dir } = frame(b, r), D = DESK, render: FurnBox[] = [], solid: LBox[] = [];
  const put = (kind: Kind, q: LBox, more: Partial<FurnBox> = {}) => render.push({ ...q, kind, ...more });
  const { pairs, rows } = seatGrid(b, r);
  const F = dir('f'), B = dir('b'), R = dir('r'), Lf = dir('l');
  const halfTube = D.tube / 2;
  /** Square tube legs have four real side faces; only the floor and wood-covered ends are hidden. */
  const leg = (a: number, v: number, top: number) =>
    put('steel', box(a - halfTube, a + halfTube, v - halfTube, v + halfTube, y, top), { skip: ['top', 'bottom'] });
  const sideRail = (a0: number, a1: number, v: number, top: number) =>
    put('steel', box(a0, a1, v - halfTube, v + halfTube, top - D.tube, top));
  for (const v of pairs) for (const a of rows) {
    const hd = D.d / 2, ty = y + D.h - D.top - D.drawer;
    for (const s of [-1, 1]) {
      const c = v + (s * D.w) / 2, hw = D.w / 2 - 0.01;
      // desk = top + 桌肚 as one block: its chair side is the dark mouth under the top's edge; the end facing the
      // other desk of the pair (2 cm away) and the bottom are never seen
      put('wood', box(a - hd, a + hd, c - hw, c + hw, ty, y + D.h), { skip: ['bottom', s < 0 ? R : Lf], mouth: B, lip: D.top });
      // Four square desk legs and two upper side rails replace the old full-depth, uncapped sheet supports.
      const front = a + hd - 0.04, back = a - hd + 0.04;
      for (const e of [-1, 1]) {
        const side = c + e * (hw - 0.03);
        for (const along of [front, back]) leg(along, side, ty - D.tube);
        sideRail(back - halfTube, front + halfTube, side, ty);
      }
      // Chair: seat/backrest boards above four matching tube legs and their upper side rails.
      const ca = a - D.behind, cw = D.cw / 2, cd = D.cd / 2;
      put('wood', box(ca - cd, ca + cd, c - cw, c + cw, y + D.seat - 0.03, y + D.seat), { skip: ['bottom', R, Lf] });
      put('wood', box(ca - cd, ca - cd + 0.03, c - cw, c + cw, y + D.seat, y + D.back), { skip: ['top', 'bottom', R, Lf] });
      const chairTop = y + D.seat - 0.03, chairFront = ca + cd - 0.035, chairBack = ca - cd + 0.035;
      for (const e of [-1, 1]) {
        const side = c + e * (cw - 0.035);
        for (const along of [chairFront, chairBack]) leg(along, side, chairTop - D.tube);
        sideRail(chairBack - halfTube, chairFront + halfTube, side, chairTop);
      }
    }
    solid.push(box(a - D.behind - D.cd / 2, a + D.d / 2, v - D.w, v + D.w, y, y + D.back));
  }
  // 讲台 across the front (clear of the side walls, so both doors stay free), 讲桌 on it, 黑板 on the front wall
  const S = D.stage, sw = W - S.side;
  if (sw > 0.5) {
    const stage = box(L - S.d, L, -sw, sw, y, y + S.h);
    put('stage', stage, { skip: ['bottom'] });
    solid.push(stage);
    const lc = L - S.d / 2 - 0.1, ld = D.lectern.d / 2, lw = D.lectern.w / 2;
    const lectern = box(lc - ld, lc + ld, -lw, lw, y + S.h, y + S.h + D.lectern.h);
    put('lectern', lectern, { skip: ['bottom'] });
    solid.push(lectern);
  }
  // the slate's room face is the chalked texture (boardFaces, world/blackboard.ts): the box only gives its edges
  const { front: fb, back: bb } = boardSpans(b, r, y), Bd = D.board, Bk = D.bulletin;
  if (fb) {
    put('frame', box(L - 0.03, L, -fb - Bd.frame, fb + Bd.frame, y + Bd.y0 - Bd.frame, y + Bd.y1 + Bd.frame), { skip: [F] });
    put('board', box(L - 0.045, L - 0.03, -fb, fb, y + Bd.y0, y + Bd.y1), { skip: [F, B, 'bottom'] });
    put('frame', box(L - 0.1, L - 0.03, -fb, fb, y + Bd.y0 - Bd.frame - 0.03, y + Bd.y0 - Bd.frame), { skip: [F] }); // 粉笔槽
  }
  // 后黑板报 on the back wall, if it is a plain 隔墙 there (not the windows of an outer wall)
  if (bb) {
    put('frame', box(-L, -L + 0.03, -bb - Bd.frame, bb + Bd.frame, y + Bk.y0 - Bd.frame, y + Bk.y1 + Bd.frame), { skip: [B] });
    put('board', box(-L + 0.03, -L + 0.045, -bb, bb, y + Bk.y0, y + Bk.y1), { skip: [F, B, 'bottom'] });
    // 储物柜 under it: a row of steel columns, two doors each, their seams real gaps so the ink pass draws them
    const K = D.locker, n = Math.floor((2 * bb) / K.w), h0 = -L + K.d, kh = K.handle;
    for (let i = 0; i < n; i++) {
      const v0 = -n * K.w / 2 + i * K.w, v1 = v0 + K.w - K.gap;
      for (let t = 0; t < 2; t++) {
        const y0 = y + t * K.tier, y1 = y0 + K.tier - K.gap;
        // the seams are 1.2 cm: only the row's two ends show their sides, only the upper tier its top
        const ends: Face[] = [...(i > 0 ? [Lf] : []), ...(i < n - 1 ? [R] : [])].filter(e => e !== F && e !== B);
        put('locker', box(-L, h0, v0, v1, y0, y1), { skip: ['bottom', B, ...ends, ...(t === 0 ? ['top' as Face] : [])] });
        // handle near the seam with the neighbour (alternating, as the doors open away from each other): its face only
        const hv = i % 2 ? v0 + 0.05 : v1 - 0.05 - kh.w, hy = y1 - 0.12;
        put('mouth', box(h0, h0 + kh.d, hv, hv + kh.w, hy - kh.h, hy), { skip: [B, R, Lf, 'bottom', 'top'] });
      }
    }
    if (n) solid.push(box(-L, h0, -n * K.w / 2, n * K.w / 2, y, y + 2 * K.tier));
  }
  render.push(...curtains(b, r, y));
  const h = floorStack(b).find(s => Math.abs(s.y - y) < 1e-6)?.h ?? b.floorHeight ?? FLOOR_HEIGHT;
  render.push(...ceilingFixtures(b, r, y, h));
  return { render, solid };
}

/** Lattice centres k·p (k integer) whose span ±half fits in [lo, hi]. */
const lattice = (p: number, lo: number, hi: number, half: number) => {
  const out: number[] = [];
  for (let k = Math.ceil((lo + half) / p); k * p <= hi - half + 1e-9; k++) out.push(k * p);
  return out;
};
const overlaps = (a: LBox, q: LBox) => a.x0 < q.x1 && q.x0 < a.x1 && a.z0 < q.z1 && q.z0 < a.z1;

/**
 * 教室③b ceiling (building-local, y from the storey floor `y`, storey height `h`): a 日光灯 fixture under every tube
 * strip of the TUBE grid inside the room (the material paints the strip on the ceiling and lights the tube box at
 * night: surf.y = 2), 吊扇 at the grid cells between the tubes, the 投影幕 case rolled up over the 黑板 (above the 钟)
 * and a 投影仪 on a rod in the middle. Render only: everything is over head height.
 */
function ceilingFixtures(b: BuildingDef, r: RoomDef, y: number, h: number): FurnBox[] {
  const { L, box, dir } = frame(b, r), D = DESK, ceil = y + h - STAIR.slab;
  const { out, lamps } = lampsAndFans(r, y, h, D.fan.max);
  // 投影幕: its case right under the ceiling over the 黑板 (the 钟 hangs below it), a pull cord near one end
  const fb = boardSpans(b, r, y).front, S = D.screen, Fr = dir('f');
  if (fb) {
    const sh = Math.min(S.half, fb), a1 = L - S.off;
    out.push({ ...box(a1 - S.d, a1, -sh, sh, ceil - S.h, ceil), kind: 'screen', skip: ['top', Fr] });
    const cv = sh - 0.15;
    out.push({ ...box(a1 - S.d / 2 - 0.005, a1 - S.d / 2 + 0.005, cv - 0.005, cv + 0.005, ceil - S.h - S.cord, ceil - S.h), kind: 'cord', skip: ['top', 'bottom'] });
  }
  // 黑板灯: over the front of the 讲台, a row of reflector fixtures along the 黑板, clear of the 日光灯 (sides only and
  // the tube's underside and long faces: a dozen quads a room)
  if (fb) {
    const G = D.boardLamp, Hs = G.housing, span = G.n * G.len + (G.n - 1) * G.gap, ends: Face[] = [dir('r'), dir('l')];
    for (const da of [0, 0.15, 0.3, 0.45]) {
      const a = L - G.off - da, boxes: FurnBox[] = [];
      for (let k = 0; k < G.n; k++) {
        const v0 = -span / 2 + k * (G.len + G.gap), v1 = v0 + G.len;
        boxes.push({ ...box(a - Hs.w / 2, a + Hs.w / 2, v0, v1, ceil - Hs.h, ceil), kind: 'lamp', skip: ['top', 'bottom'] });
        boxes.push({ ...box(a - G.tube.w / 2, a + G.tube.w / 2, v0 + 0.04, v1 - 0.04, ceil - Hs.h - G.tube.h, ceil - Hs.h), kind: 'boardTube', skip: ['top', ...ends] });
      }
      if (boxes.some(q => lamps.some(l => overlaps({ ...l, x0: l.x0 - 0.05, x1: l.x1 + 0.05, z0: l.z0 - 0.05, z1: l.z1 + 0.05 }, q)))) continue;
      out.push(...boxes);
      break;
    }
  }
  // 投影仪 on the room's centre line, slid along it to the first spot clear of the lamps (none if there is none)
  const P = D.projector, py = ceil - P.drop;
  for (const da of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
    const pa = L - P.back + da, pb = box(pa - P.d / 2, pa + P.d / 2, -P.w / 2, P.w / 2, py, py + P.h);
    if (!fb || pa > L - 1 || pa < -L + 1 || lamps.some(l => overlaps({ ...l, x0: l.x0 - 0.1, x1: l.x1 + 0.1, z0: l.z0 - 0.1, z1: l.z1 + 0.1 }, pb))) continue;
    // its lens faces the screen: the front face dark
    out.push({ ...pb, kind: 'projector', skip: ['top'], mouth: Fr, lip: 0.03 });
    out.push({ ...box(pa - 0.012, pa + 0.012, -0.012, 0.012, py + P.h, ceil), kind: 'projector', skip: ['top', 'bottom'] });
    break;
  }
  return out;
}

/**
 * The 日光灯 fixtures under the TUBE strips inside a room and up to `fanMax` 吊扇 between them (any room kind: the
 * 办公室 of world/office.ts hang the same ones). Also returns the lamp housings, to keep other fixtures clear of them.
 */
export function lampsAndFans(r: RoomDef, y: number, h: number, fanMax: number): { out: FurnBox[]; lamps: LBox[] } {
  const D = DESK, out: FurnBox[] = [], R = rectOf(r), t = PART.t / 2;
  const ceil = y + h - STAIR.slab, Lp = D.lamp, H = Lp.housing;
  const x0 = R.x0 + t, x1 = R.x1 - t, z0 = R.z0 + t, z1 = R.z1 - t;
  // 日光灯: housing (sides only, the tube fills its underside), the tube under it, two rods up to the ceiling
  const hy = ceil - Lp.drop, lamps: LBox[] = [];
  for (const cx of lattice(TUBE.px, x0 + Lp.keep, x1 - Lp.keep, H.len / 2)) for (const cz of lattice(TUBE.pz, z0 + Lp.keep, z1 - Lp.keep, H.w / 2)) {
    const hb: LBox = { x0: cx - H.len / 2, x1: cx + H.len / 2, z0: cz - H.w / 2, z1: cz + H.w / 2, y0: hy, y1: hy + H.h };
    lamps.push(hb);
    out.push({ ...hb, kind: 'lamp', skip: ['top', 'bottom'] });
    const tl = TUBE.len / 2, tw = Lp.tube.w / 2;
    out.push({ x0: cx - tl, x1: cx + tl, z0: cz - tw, z1: cz + tw, y0: hy - Lp.tube.h, y1: hy, kind: 'tube', skip: ['top', '+x', '-x'] });
    for (const e of [-1, 1]) {
      const rx = cx + e * (H.len / 2 - 0.12), rr = Lp.rod / 2;
      out.push({ x0: rx - rr, x1: rx + rr, z0: cz - rr, z1: cz + rr, y0: hy + H.h, y1: ceil, kind: 'lamp', skip: ['top', 'bottom', '+x', '-x'] });
    }
  }
  // 吊扇 at the cell centres (half a grid step off the tubes both ways), kept off the walls
  const F = D.fan, reach = F.blade.r0 + F.blade.len, fans: [number, number][] = [];
  for (const cx of lattice(TUBE.px, x0 - TUBE.px / 2 + F.keep, x1 - TUBE.px / 2 - F.keep, reach)) for (const cz of lattice(TUBE.pz, z0 - TUBE.pz / 2 + F.keep, z1 - TUBE.pz / 2 - F.keep, reach)) fans.push([cx + TUBE.px / 2, cz + TUBE.pz / 2]);
  fans.slice(0, fanMax).forEach(([cx, cz], i) => {
    const my = ceil - F.rod, M = F.motor, rr = 0.015, by = my - 0.01;
    out.push({ x0: cx - rr, x1: cx + rr, z0: cz - rr, z1: cz + rr, y0: my + M.h / 2, y1: ceil, kind: 'fan', skip: ['top', 'bottom'] });
    out.push({ x0: cx - M.r, x1: cx + M.r, z0: cz - M.r, z1: cz + M.r, y0: my - M.h / 2, y1: my + M.h / 2, kind: 'fan', rot: Math.PI / 4, skip: ['top'], fan: [cx, cz] });
    // three blades, each turned a different way per fan (where they stopped; the interior shader turns them while the lights are on)
    const a0 = 0.7 + i * 1.3, bl = F.blade, mid = bl.r0 + bl.len / 2;
    for (let k = 0; k < 3; k++) {
      const a = a0 + (k * 2 * Math.PI) / 3, bx = cx + Math.cos(a) * mid, bz = cz + Math.sin(a) * mid;
      out.push({ x0: bx - bl.len / 2, x1: bx + bl.len / 2, z0: bz - bl.w / 2, z1: bz + bl.w / 2, y0: by - bl.t, y1: by, kind: 'fan', rot: a, skip: ['top', '+x', '-x'], fan: [cx, cz] }); // seen from below: its underside and long edges
    }
  });
  return { out, lamps };
}

/**
 * 窗帘 of a classroom: on its window wall (the students' left, an outer wall), a bunch of pleats either side of each
 * window of this storey, and one rail over them all. Pleats alternate between two depths off the wall: the ink pass
 * draws every step and the recessed ones are a shade darker, which is what reads as folds. Render only (the walker never gets there: desks and aisles).
 */
function curtains(b: BuildingDef, r: RoomDef, y: number): FurnBox[] {
  const { f, L, W, box, dir } = frame(b, r), C = DESK.curtain, left = dir('l'), out: FurnBox[] = [];
  const R = rectOf(r), half = (left[1] === 'x' ? b.w : b.d) / 2 - WALL_T;
  const edge = left === '+x' ? R.x1 : left === '-x' ? R.x0 : left === '+z' ? R.z1 : R.z0;
  if (Math.abs(Math.abs(edge) - half) > 0.05) return out; // no outer wall on the left: no windows to dress
  // a window's along-wall span (building-local u) → the room frame's along axis a
  const toA = (u: number) => (left[1] === 'x' ? f[1] * (u - r.z) : f[0] * (u - r.x));
  const wins = facadeOpenings(b).filter(o => o.kind === 'window' && !o.court && o.side === left && o.y0 >= y && o.y0 < y + 3)
    .map(o => { const [a0, a1] = [toA(o.u0), toA(o.u1)].sort((p, q) => p - q); return { a0, a1, y0: o.y0, y1: o.y1 }; })
    .filter(w => w.a0 > -L && w.a1 < L);
  if (!wins.length) return out;
  const top = Math.max(...wins.map(w => w.y1)) + C.above, pw = C.out / C.pleats, v = -W - PART.t / 2 + 0.005;
  for (const w of wins) for (const s0 of [w.a0 - C.out + C.over, w.a1 - C.over]) {
    for (let k = 0; k < C.pleats; k++) {
      // a window close to the 隔墙 gets a bunch squeezed against it
      const a0 = Math.max(s0 + k * pw, -L + 0.01), a1 = Math.min(s0 + (k + 1) * pw, L - 0.01), deep = k % 2 ? C.far : C.near;
      if (a1 - a0 < 0.02) continue;
      // its wall side and top are never seen (the rail covers the top); the room face, its ends and its foot are
      out.push({ ...box(a0, a1, v, v + deep, w.y0 - C.below, top), kind: k % 2 ? 'curtain' : 'fold', skip: [left, 'top'] });
    }
  }
  const a0 = Math.min(...wins.map(w => w.a0)) - C.out - 0.05, a1 = Math.max(...wins.map(w => w.a1)) + C.out + 0.05;
  out.push({ ...box(Math.max(a0, -L + 0.01), Math.min(a1, L - 0.01), v, v + C.rail.d, top, top + C.rail.h), kind: 'rail', skip: [left] });
  return out;
}

/** Half widths of a classroom's front board and back 黑板报 (0 = none: too narrow, or the back wall is not plain). */
function boardSpans(b: BuildingDef, r: RoomDef, y: number): { front: number; back: number } {
  const { W, dir } = frame(b, r), Bd = DESK.board, Bk = DESK.bulletin;
  const front = Math.min(Bd.w, W * 2 - 2.4) / 2, bw = Math.min(Bk.w, W * 2 - 2 * Bk.side) / 2;
  const level = floorStack(b).find(s => Math.abs(s.y - y) < 1e-6)?.level;
  const back = bw > 0.5 && level !== undefined && plainWall(b, level, r, dir('b'), bw + Bd.frame, Bk.y1 + Bd.frame) ? bw : 0;
  return { front: front > 0.5 ? front : 0, back };
}

/** The chalked faces of a classroom (building-local, y from the storey floor `y`): its front board, its 黑板报. */
export function boardFaces(b: BuildingDef, r: RoomDef, y: number): BoardFace[] {
  const { L, pt, dir } = frame(b, r), { front: fb, back: bb } = boardSpans(b, r, y), Bd = DESK.board, Bk = DESK.bulletin;
  const out: BoardFace[] = [];
  // seen from the seats (facing f, right hand +v) and from the 讲台 end (facing back, right hand −v)
  if (fb) { const a = L - 0.045; out.push({ room: r.id, part: 'front', n: dir('b'), p: [pt(a, -fb, y + Bd.y0), pt(a, fb, y + Bd.y0), pt(a, fb, y + Bd.y1), pt(a, -fb, y + Bd.y1)] }); }
  if (bb) { const a = -L + 0.045; out.push({ room: r.id, part: 'back', n: dir('f'), p: [pt(a, bb, y + Bk.y0), pt(a, -bb, y + Bk.y0), pt(a, -bb, y + Bk.y1), pt(a, bb, y + Bk.y1)] }); }
  return out;
}

/**
 * 教室② 钟: hung on the front wall over the middle of the 黑板 (only where there is one). Centre on the wall
 * (building-local; the face is DESK.clock.off in front of it), the viewer's right in plan (unit), the side it faces.
 */
export interface ClockSpot { room: string; c: [number, number, number]; r: [number, number]; n: Side }
export function clockSpot(b: BuildingDef, r: RoomDef, y: number): ClockSpot | null {
  const { L, pt, dir } = frame(b, r), C = DESK.clock;
  if (!boardSpans(b, r, y).front) return null;
  const c = pt(L, 0, y + C.y), e = pt(L, 1, y + C.y);
  return { room: r.id, c, r: [e[0] - c[0], e[2] - c[2]], n: dir('b') };
}

/** Every 钟 of a storey's classrooms, with the room's key. */
export function storeyClocks(b: BuildingDef, level: number): (ClockSpot & { key: string })[] {
  const st = floorStack(b).find(s => s.level === level);
  if (!st) return [];
  return storeyRooms(b, level).filter(r => r.kind === 'classroom').flatMap(r => {
    const c = clockSpot(b, r, st.y);
    return c ? [{ ...c, key: roomKey(b.id, level, r.id) }] : [];
  });
}

/** Every chalked face of a storey's classrooms, with the room's key (campus_schema roomKey). */
export function storeyBoards(b: BuildingDef, level: number): (BoardFace & { key: string })[] {
  const st = floorStack(b).find(s => s.level === level);
  if (!st) return [];
  return storeyRooms(b, level).filter(r => r.kind === 'classroom').flatMap(r => boardFaces(b, r, st.y).map(f => ({ ...f, key: roomKey(b.id, level, r.id) })));
}

/** Every 教室's, 办公室's and 门卫室's furniture on a storey (building-local). */
export function storeyFurniture(b: BuildingDef, level: number): { render: FurnBox[]; solid: LBox[] } {
  // memoised per building object + level (the 书库 alone is thousands of boxes, and colliders, routes, the interior
  // light and the render all ask); a building def is never mutated after load (tests clone before they change one)
  const memo = FURN_MEMO.get(b) ?? new Map<number, { render: FurnBox[]; solid: LBox[] }>();
  FURN_MEMO.set(b, memo);
  const hit = memo.get(level);
  if (hit) return hit;
  const res = storeyFurnitureOf(b, level);
  memo.set(level, res);
  return res;
}
const FURN_MEMO = new WeakMap<BuildingDef, Map<number, { render: FurnBox[]; solid: LBox[] }>>();
function storeyFurnitureOf(b: BuildingDef, level: number): { render: FurnBox[]; solid: LBox[] } {
  const st = floorStack(b).find(s => s.level === level);
  const out = { render: [] as FurnBox[], solid: [] as LBox[] };
  if (!st) return out;
  for (const r of storeyRooms(b, level)) if (r.kind === 'classroom' || r.kind === 'office' || r.kind === 'guard' || r.kind === 'server' || r.kind === 'court' || r.kind === 'equip' || isCanteenRoom(r) || isHallRoom(r) || isLibraryRoom(r, b) || isLabRoom(r, b) || isBoilerRoom(r) || isToiletRoom(r) || isWaterRoom(r) || isStorageRoom(r)) {
    const f = r.kind === 'classroom' ? classroomFurniture(b, r, st.y) : r.kind === 'office' ? officeFurniture(b, r, st.y)
      : r.kind === 'guard' ? guardFurniture(b, r, st.y) : r.kind === 'server' ? serverFurniture(b, r, st.y)
      : r.kind === 'court' || r.kind === 'equip' ? gymFurniture(b, r, st.y, st.h)
      : isCanteenRoom(r) ? canteenFurniture(b, r, st.y, st.h) : isLabRoom(r, b) ? labFurniture(b, r, st.y, st.h) : isBoilerRoom(r) ? boilerFurniture(b, r, st.y, st.h) : isToiletRoom(r) ? toiletFurniture(b, r, st.y, st.h) : isWaterRoom(r) ? waterFurniture(b, r, st.y, st.h) : isStorageRoom(r) ? storageFurniture(b, r, st.y, st.h) : isHallRoom(r) ? hallFurniture(b, r, st.y, st.h) : libraryFurniture(b, r, st.y);
    out.render.push(...f.render); out.solid.push(...f.solid);
  }
  const s = safetyFurniture(b, level);
  out.render.push(...s.render); out.solid.push(...s.solid);
  // 楼梯间: 休息平台 radiators on their 立管, the 1F 消火栓箱 (world/stairfit.ts)
  const sf = stairFurniture(b, level);
  out.render.push(...sf.render); out.solid.push(...sf.solid);
  // 楼梯口走廊扩大段: 光荣榜 / 宣传栏, 钟, 拖把池, 垃圾桶 against the stairwell wall (world/hallway.ts)
  const hw = hallwayFurniture(b, level, out.solid);
  out.render.push(...hw.render); out.solid.push(...hw.solid);
  // 门套 round every 隔墙 door, the 办公室 doors' leaves standing open (world/doorway.ts)
  const l = officeLeaves(b, level);
  out.render.push(...doorTrims(b, level), ...l.render); out.solid.push(...l.solid);
  return out;
}

/**
 * Where a walker stands "in" a room (building-local x, z): a 教室's middle is all desks, so its spot is in the aisle
 * right of the middle desk pair, halfway down the rows; a 办公室's just inside its door (world/office.ts officeSpot), a
 * 门卫室's between its chair and bed (world/gatehouse.ts guardSpot); any other room's is its centre. roomRoute walks there.
 */
export function roomSpot(b: BuildingDef, r: RoomDef): [number, number] {
  if (r.kind === 'office') return officeSpot(b, r);
  if (r.kind === 'guard') return guardSpot(b, r);
  if (r.kind === 'court' || r.kind === 'equip') return gymSpot(b, r);
  if (isCanteenRoom(r)) return canteenSpot(b, r);
  if (isHallRoom(r)) return hallSpot(b, r);
  if (isLabRoom(r, b)) return labSpot(b, r);
  if (isBoilerRoom(r)) return boilerSpot(b, r);
  if (r.kind === 'stacks' || r.kind === 'reading' || r.kind === 'compact' || r.kind === 'server') return librarySpot(b, r);
  const { pairs, rows } = r.kind === 'classroom' ? seatGrid(b, r) : { pairs: [], rows: [] };
  if (!pairs.length) return [r.x, r.z];
  const { front, W } = frame(b, r), f = vec(front), rt: [number, number] = [-f[1], f[0]];
  const k = Math.floor((pairs.length - 1) / 2), edge = pairs[k] + DESK.w;
  const v = (edge + (k + 1 < pairs.length ? pairs[k + 1] - DESK.w : W)) / 2;
  const a = (rows[0] + rows[rows.length - 1]) / 2 - DESK.behind / 2;
  return [r.x + f[0] * a + rt[0] * v, r.z + f[1] * a + rt[1] * v];
}

const N = {
  '+x': new THREE.Vector3(1, 0, 0), '-x': new THREE.Vector3(-1, 0, 0), '+z': new THREE.Vector3(0, 0, 1), '-z': new THREE.Vector3(0, 0, -1),
  top: new THREE.Vector3(0, 1, 0), bottom: new THREE.Vector3(0, -1, 0),
};

/**
 * Furniture of one storey as one flat-shaded, vertex-coloured mesh (world space) for the building's interior material
 * (`surf` = plain, no 墙裙). Faces a box never shows (on the floor, under a top) are left out; side faces get the
 * usual 0.9 shade, so a desk reads against the 水磨石 under the ink pass; a 桌肚's `mouth` face is drawn dark.
 */
const QUAD = [0, 1, 2, 0, 2, 3];
/** surf.y of the 黑板's chalked face (world/blackboard.ts): render/interior_light.ts adds the 黑板灯 to it at night */
export const SURF_BOARD = -3;
/** 书脊 surf.x = bottom y + SPINE_SEED × seed (render/interior_light.ts spineGlsl splits them again) */
export const SPINE_SEED = 64;
/** 吊扇 surf.y = SURF_FAN - its axis' world z (|z| < 400 keeps it under -500, clear of every other tag) */
export const SURF_FAN = -1000;
/** surf.y of a 瓷砖 face (kind tileWhite, the 后厨's quarry floor): render/interior_light.ts draws the 格缝 (TILE) on it */
export const SURF_TILE = -6;
/** 档案盒 spine label surf.y = SURF_LABEL + v (v 0..1 up the face), 作业本 pile edges SURF_PILE + v */
export const SURF_LABEL = -11, SURF_PILE = -13;
/** surf of a 档案盒 spine / 作业本 pile face's corner (u, v) (render/interior_light.ts labelGlsl / pileGlsl decode it) */
export function decalSurf(q: FurnBox, u: number, v: number): [number, number] {
  const h = q.y1 - q.y0;
  if (q.pile) return [h + (q.kind === 'paper' ? 10 : 0), SURF_PILE + v];
  const w = q.label === '+x' || q.label === '-x' ? q.z1 - q.z0 : q.x1 - q.x0;
  const k = Math.min(15, Math.round(w * 100)) + 16 * (Math.min(63, Math.round(h * 100)) + 64 * ((q.labelSeed ?? 0) & 15));
  return [u + 2 * k, SURF_LABEL + v];
}
export function furnitureGeometry(b: BuildingDef, boxes: FurnBox[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], surf: number[] = [];
  const cols = Object.fromEntries(Object.entries(FURN_COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<Kind, THREE.Color>;
  const sides = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.clone().multiplyScalar(0.9)])) as Record<Kind, THREE.Color>;
  // surf.y: 0 = plain, 2 = a 日光灯 tube (render/interior_light.ts lights it when the tubes are on)
  // surf.y = -1: 指示灯, -2: 监控 picture, surf.x its phase / camera (render/interior_light.ts glowGlsl)
  // surf.y = SURF_TILE: a white 瓷砖 face, the shader draws the 格缝 on it
  // surf.y = 5 + clear height: 书脊, surf.x its bottom (world y, |y| < 32) + SPINE_SEED × its seed
  // surf.y < -500: a turning 吊扇 part, surf = (axis world x, SURF_FAN - axis world z)
  // surf.y in [SURF_LABEL, +1] / [SURF_PILE, +1]: a 档案盒 spine / 作业本 pile face, per corner (decalSurf)
  let dado = 0, sx: number = SURF.plain;
  // corners (a lo, b lo, b hi, a hi) of a side face as (u, v)
  const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const quad = (p: number[][], n: THREE.Vector3, c: THREE.Color, decal?: FurnBox) => {
    for (const i of QUAD) {
      const v = p[i], d = decal ? decalSurf(decal, UV[i][0], UV[i][1]) : [sx, dado];
      pos.push(v[0], v[1], v[2]); nor.push(n.x, n.y, n.z); col.push(c.r, c.g, c.b); surf.push(d[0], d[1]);
    }
  };
  for (const q of boxes) {
    const x0 = b.x + q.x0, x1 = b.x + q.x1, z0 = b.z + q.z0, z1 = b.z + q.z1, y0 = q.y0, y1 = q.y1;
    const base = cols[q.kind], side = sides[q.kind];
    const skip = new Set(q.skip ?? []);
    // a turned box (吊扇 blade): corners and side normals rotated about its centre in plan
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, c = Math.cos(q.rot ?? 0), sn = Math.sin(q.rot ?? 0);
    // a spun box (手摇轮 spoke / rim): corners and normals turned about its centre in the (x | z, y) plane
    const cy = (y0 + y1) / 2, sp = q.spin, pc = Math.cos(sp?.ang ?? 0), ps = Math.sin(sp?.ang ?? 0);
    const spun = (x: number, y: number, z: number): number[] => {
      if (!sp) return [x, y, z];
      if (sp.axis === 'z') return [cx + (x - cx) * pc - (y - cy) * ps, cy + (x - cx) * ps + (y - cy) * pc, z];
      return [x, cy + (z - cz) * ps + (y - cy) * pc, cz + (z - cz) * pc - (y - cy) * ps];
    };
    const at = (x: number, y: number, z: number) => (q.rot ? [cx + (x - cx) * c - (z - cz) * sn, y, cz + (x - cx) * sn + (z - cz) * c] : spun(x, y, z));
    const turn = (n: THREE.Vector3) => {
      if (q.rot) return new THREE.Vector3(n.x * c - n.z * sn, n.y, n.x * sn + n.z * c);
      if (!sp) return n;
      return sp.axis === 'z' ? new THREE.Vector3(n.x * pc - n.y * ps, n.x * ps + n.y * pc, n.z) : new THREE.Vector3(n.x, n.z * ps + n.y * pc, n.z * pc - n.y * ps);
    };
    dado = q.kind === 'tube' || q.kind === 'boardTube' ? 2 : q.kind === 'tileWhite' || q.kind === 'quarry' ? SURF_TILE : q.spine ? 5 + q.spine : q.glow === 'led' ? -1 : q.glow === 'feed' ? -2 : 0;
    sx = q.spine ? y0 + SPINE_SEED * (q.seed ?? 0) : q.glow ? q.phase ?? 0 : SURF.plain;
    if (q.fan) { sx = b.x + q.fan[0]; dado = SURF_FAN - (b.z + q.fan[1]); }
    if (q.oct) {
      // corners going round (+x face first), each side from the corner after it (a) to its own (b), as the box's below
      const hx = (x1 - x0) / 2, hz = (z1 - z0) / 2, k = q.oct * Math.min(hx, hz);
      const P = [[hx, -hz + k], [hx, hz - k], [hx - k, hz], [-hx + k, hz], [-hx, hz - k], [-hx, -hz + k], [-hx + k, -hz], [hx - k, -hz]].map(([u, w]) => [cx + u, cz + w]);
      for (let i = 0; i < 8; i++) {
        const [ax, az] = P[(i + 1) % 8], [bx, bz] = P[i], a = (i * Math.PI) / 4;
        quad([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), side);
      }
      const U = [7, 6, 5, 4, 3, 2, 1, 0].map(i => P[i]), cap = (y: number, idx: number[]) => idx.map(i => [U[i][0], y, U[i][1]]);
      if (!skip.has('top')) for (const f of [[0, 1, 2, 3], [0, 3, 4, 7], [4, 5, 6, 7]]) quad(cap(y1, f), N.top, base);
      if (!skip.has('bottom')) for (const f of [[3, 2, 1, 0], [7, 4, 3, 0], [7, 6, 5, 4]]) quad(cap(y0, f), N.bottom, side);
      continue;
    }
    // counter-clockwise seen from outside; the side faces as (corner a, corner b) at the bottom, going up
    const faces: [Side, number[], number[]][] = [
      ['+x', [x1, z1], [x1, z0]], ['-x', [x0, z0], [x0, z1]], ['+z', [x0, z1], [x1, z1]], ['-z', [x1, z0], [x0, z0]],
    ];
    for (const [s, [ax, az], [bx, bz]] of faces) {
      if (skip.has(s)) continue;
      const decal = q.pile || q.label === s ? q : undefined;
      const wall = (lo: number, hi: number, c: THREE.Color) => quad([at(ax, lo, az), at(bx, lo, bz), at(bx, hi, bz), at(ax, hi, az)], turn(N[s]), c, decal);
      if (s !== q.mouth) wall(y0, y1, side);
      else { const m = y1 - (q.lip ?? 0); wall(y0, m, cols.mouth); if (m < y1) wall(m, y1, side); }
    }
    if (!skip.has('top')) quad([at(x0, y1, z1), at(x1, y1, z1), at(x1, y1, z0), at(x0, y1, z0)], turn(N.top), base);
    if (!skip.has('bottom')) quad([at(x0, y0, z0), at(x1, y0, z0), at(x1, y0, z1), at(x0, y0, z1)], turn(N.bottom), q.kind === 'tube' || q.kind === 'boardTube' ? base : side);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('surf', new THREE.Float32BufferAttribute(surf, 2));
  g.computeBoundingSphere();
  return g;
}
