// 角色074 materials: cartoon face + jacket shading painted on CanvasTextures (no image files).
import * as THREE from 'three';
import { MATS, type MatName } from './model.ts';
import { readableWardenMaterial } from './lighting.ts';

const SKIN = '#d4b697'; // students
const WARDEN_SKIN = '#a9ad9c'; // 角色074: sallow grey-green, a bloodless corpse tone (not a healthy tan)

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, wrap = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Deterministic noise so the textures (and the screenshots) are stable between runs. */
function rng(seed: number) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

/** Equirect face for the head sphere (u 0.25 = front, v from the crown): thin brows, narrow eyes, faint smile. */
export function faceTexture(smile = 0.3) {
  return canvas(512, 256, (g) => {
    g.fillStyle = WARDEN_SKIN; g.fillRect(0, 0, 512, 256);
    const cx = 128; // u 0.25
    const rnd = rng(7);
    for (let i = 0; i < 1800; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(60,66,52,0.10)' : 'rgba(210,214,196,0.07)'; g.fillRect(rnd() * 512, rnd() * 256, 2 + rnd() * 3, 2); } // pores / mottling
    // no blush: a pale, slightly sallow face reads older and colder than rosy cheeks
    // bald: bare skin on the crown with a soft sheen
    const hl = g.createRadialGradient(cx, 40, 4, cx, 40, 60); hl.addColorStop(0, 'rgba(255,240,225,0.45)'); hl.addColorStop(1, 'rgba(255,240,225,0)');
    g.fillStyle = hl; g.fillRect(0, 0, 512, 110);
    g.lineCap = 'round';
    // skin that reads as flesh, not plastic: forehead creases, nasolabial folds, a hollow shadow round each eye socket
    g.lineCap = 'round'; g.strokeStyle = 'rgba(120,76,58,0.28)'; g.lineWidth = 2;
    for (const y of [80, 88]) { g.beginPath(); g.moveTo(cx - 34, y); g.quadraticCurveTo(cx, y - 4, cx + 34, y); g.stroke(); }
    for (const s of [-1, 1]) {
      g.save(); g.lineWidth = 3.6; g.strokeStyle = 'rgba(70,44,40,0.5)'; // nasolabial fold: a deep groove from the nostril wing round the mouth, with a pale lip below it
      g.beginPath(); g.moveTo(cx + s * 16, 134); g.quadraticCurveTo(cx + s * 30, 150, cx + s * 33, 168); g.stroke();
      g.lineWidth = 2; g.strokeStyle = 'rgba(214,218,200,0.2)';
      g.beginPath(); g.moveTo(cx + s * 20, 136); g.quadraticCurveTo(cx + s * 34, 152, cx + s * 37, 168); g.stroke();
      g.restore();
      g.beginPath(); g.moveTo(cx + s * 4, 143); g.lineTo(cx + s * 5, 153); g.stroke(); // philtrum: two ridges between the nose and the lip
      const sh = g.createRadialGradient(cx + s * 30, 120, 4, cx + s * 30, 120, 32); // sunken sockets: near-black violet fading out over the cheek
      sh.addColorStop(0, 'rgba(22,14,22,0.94)'); sh.addColorStop(0.55, 'rgba(34,24,34,0.6)'); sh.addColorStop(1, 'rgba(34,24,34,0)');
      g.fillStyle = sh; g.fillRect(cx + s * 30 - 34, 86, 68, 64);
    }
    g.strokeStyle = '#3a2a22';
    for (const s of [-1, 1]) {
      g.lineWidth = 3.5; // brows: heavy, slanting down toward the nose (stern, not kindly)
      g.beginPath(); g.moveTo(cx + s * 12, 107); g.quadraticCurveTo(cx + s * 28, 101, cx + s * 46, 96); g.stroke();
      // eyes: little white, a small dark pupil, a heavy upper lid slanting down toward the nose (a flat stare, not wide-eyed)
      const ex = cx + s * 30, ey = 117;
      g.save(); g.beginPath(); g.ellipse(ex, ey, 12.5, 7.5, 0, 0, Math.PI * 2); g.clip();
      g.fillStyle = '#050304'; g.fillRect(ex - 14, ey - 9, 28, 18); // all-black eyes: no white, no pupil to read as a cartoon
      g.fillStyle = '#6a1510'; g.beginPath(); g.arc(ex, ey + 1.5, 2.2, 0, Math.PI * 2); g.fill(); // dull red ember (lit by the emissive map while hunting)
      g.fillStyle = '#6f7466'; g.beginPath(); g.moveTo(ex - s * 14, ey - 9); g.lineTo(ex + s * 14, ey - 9); g.lineTo(ex + s * 14, ey - 3); g.lineTo(ex - s * 14, ey + 0.5); g.closePath(); g.fill();
      g.restore();
      g.strokeStyle = '#2a1d17'; g.lineWidth = 2.6; g.beginPath(); g.moveTo(ex - s * 13, ey + 0.5); g.lineTo(ex + s * 13, ey - 3); g.stroke();
      g.strokeStyle = 'rgba(110,68,76,0.5)'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(ex - 12, ey + 8); g.quadraticCurveTo(ex, ey + 12, ex + 12, ey + 8); g.stroke(); // tired bags under the eyes
      g.strokeStyle = '#3a2a22';
    }
    // mouth: a thin, faint smile, a little lopsided (his right corner higher, tucked in with a dimple tick); `smile` widens it and,
    // past halfway (the cold joke / face-change), opens it over a strip of teeth
    const w = 18 + smile * 15, my = 158;
    const fr = Math.max(0, 1 - smile / 0.3); // at rest (hunting) the corners are pulled DOWN into a grim frown; it fades out as he starts to smile
    const lx = cx - w, ly = my + 1.5 - smile * 8 + 5 * fr, rx = cx + w, ry = my - smile * 10 + 4 * fr;
    const cy = my - 2 + smile * 11 - 7 * fr;
    if (smile > 0.5) {
      const gap = (smile - 0.5) * 2 * 9;
      g.fillStyle = '#2a0f0f';
      g.beginPath(); g.moveTo(lx, ly); g.quadraticCurveTo(cx, cy, rx, ry); g.quadraticCurveTo(cx, cy + gap * 2, lx, ly); g.fill();
      g.fillStyle = '#e9e4d0'; // upper teeth, clipped to the mouth
      g.save(); g.clip();
      g.fillRect(lx, my - 8, w * 2, 4 + gap * 0.5);
      g.restore();
    }
    g.strokeStyle = 'rgba(86,38,36,0.95)'; g.lineWidth = 2.8;
    g.beginPath(); g.moveTo(lx, ly); g.quadraticCurveTo(cx + 2, cy, rx, ry); g.stroke();
    if (smile > 0.15) { // corner ticks (dimples) only once he actually smiles; at rest the mouth is a flat line with one corner nudged up
      g.lineWidth = 1.8;
      g.beginPath(); g.moveTo(lx - 2, ly - 4); g.quadraticCurveTo(lx - 3, ly - 1, lx + 2, ly + 1); g.stroke();
      g.beginPath(); g.moveTo(rx + 3, ry - 5); g.quadraticCurveTo(rx + 3, ry - 1, rx - 2, ry + 1); g.stroke();
    }
    g.fillStyle = 'rgba(120,70,56,0.16)'; // faint shadow under the lower lip
    g.beginPath(); g.ellipse(cx, my + 17, 13, 3.5, 0, 0, Math.PI * 2); g.fill();
  });
}

/** Lathe UV for the jacket (u 0.5 = front, v 0 = hem): black shell, half-open zip showing the grey T-shirt, folds, pockets. */
function jacketTexture() {
  return canvas(256, 256, (g) => {
    g.fillStyle = '#17181b'; g.fillRect(0, 0, 256, 256);
    // grey crew-neck T-shirt in the open zip: wide at the collar, closed at mid-chest
    g.fillStyle = '#9fa2a7';
    g.beginPath(); g.moveTo(128 - 30, 0); g.lineTo(128 + 30, 0); g.lineTo(130, 110); g.lineTo(126, 110); g.closePath(); g.fill();
    g.fillStyle = '#7b7e84'; g.fillRect(97, 0, 62, 8); // T-shirt collar rib
    // zip below the opening
    g.strokeStyle = '#4c4f55'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(128, 110); g.lineTo(128, 256); g.stroke();
    g.fillStyle = '#9a9ca0'; g.fillRect(125, 108, 6, 9); // zip pull
    g.strokeStyle = '#2e3036'; g.lineWidth = 2; // lapel edges catch some light
    g.beginPath(); g.moveTo(96, 0); g.lineTo(126, 110); g.moveTo(160, 0); g.lineTo(130, 110); g.stroke();
    // hem band + side pockets (diagonal zips)
    g.fillStyle = '#0d0e10'; g.fillRect(0, 238, 256, 18);
    g.strokeStyle = '#33353b'; g.lineWidth = 2;
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(128 + s * 26, 210); g.lineTo(128 + s * 44, 168); g.stroke(); }
    // fabric folds: soft dark/light streaks (stands in for a normal map at this budget)
    for (let i = 0; i < 18; i++) {
      const x = (i * 97) % 256, y = 110 + ((i * 53) % 90), l = 20 + (i % 4) * 8;
      g.strokeStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.35)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 6, y + l / 2, x + 2, y + l); g.stroke();
    }
  });
}

/** Glow mask for the face (same layout as faceTexture): just the two eye embers. */
function eyeGlowTexture() {
  return canvas(512, 256, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256);
    for (const s of [-1, 1]) { const gr = g.createRadialGradient(128 + s * 30, 118.5, 0, 128 + s * 30, 118.5, 5); gr.addColorStop(0, '#ff3020'); gr.addColorStop(1, '#000'); g.fillStyle = gr; g.fillRect(128 + s * 30 - 6, 112, 12, 14); }
  });
}

/** Cloth relief for the jacket / sleeves / trousers (rep tiles round the body): broad soft drapes that wander down the cloth plus a fine weave, no sharp creases (those read as scratches). */
function foldBump(seed: number) {
  const t = canvas(128, 256, (g) => {
    const rnd = rng(seed), img = g.createImageData(128, 256);
    const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) {
      const u = x / 128, w = y / 256 * Math.PI * 2; // whole cycles in x and y: the tile wraps seamlessly
      const warp = 0.09 * Math.sin(w + ph[0]) + 0.05 * Math.sin(2 * w + ph[1]);
      const fold = 0.62 * Math.sin(Math.PI * 2 * (3 * u + warp) + ph[2]) + 0.38 * Math.sin(Math.PI * 2 * (7 * u + 2 * warp) + ph[1]);
      const weave = ((x >> 1) + (y >> 1)) & 1 ? 4 : -4;
      const v = Math.max(0, Math.min(255, 128 + 30 * fold + weave + (rnd() - 0.5) * 8));
      const i = (y * 128 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, true);
  t.repeat.set(3, 1);
  return t;
}

/** One material per MATS entry, same order. */
export function makeMaterials(): THREE.Material[] {
  const std = (o: THREE.MeshStandardMaterialParameters) => {
    const material = new THREE.MeshStandardMaterial(o);
    readableWardenMaterial(material);
    return material;
  };
  const m: Record<MatName, THREE.Material> = {
    face: std({ map: faceTexture(), roughness: 0.58, emissive: 0xffffff, emissiveMap: eyeGlowTexture(), emissiveIntensity: 0.25 }), // a soft scalp sheen, not an eggshell; eyes glow faintly, fully while hunting
    skin: std({ color: WARDEN_SKIN, roughness: 0.5 }),
    jacket: std({ map: jacketTexture(), roughness: 0.8, bumpMap: foldBump(11), bumpScale: 0.035 }),
    sleeve: std({ color: 0x1a1b1e, roughness: 0.8, bumpMap: foldBump(23), bumpScale: 0.025 }),
    pants: std({ color: 0x38455c, roughness: 0.85, bumpMap: foldBump(37), bumpScale: 0.02 }),
    shoe: std({ color: 0x0b0b0c, roughness: 0.35 }),
    frame: std({ color: 0xc8ccd0, metalness: 0.3, roughness: 0.35 }), // thin light silver-grey rims (design.md: 细框浅色眼镜)
    lens: new THREE.MeshPhongMaterial({ color: 0xcfe4ff, specular: 0xffffff, shininess: 60, emissive: 0x3a4a5c, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }),
    metal: std({ color: 0xc8c8c8, metalness: 0.8, roughness: 0.25, emissive: 0x6a5e40 }), // buckle glints faintly in the dark
    lapel: std({ color: 0x3a3c42, roughness: 0.5 }), // folded-back facing: lighter and smoother than the jacket body
  };
  return MATS.map((k) => m[k]);
}

let studentFace: THREE.Texture | undefined;
/** Young face for the student avatars: same equirect layout as faceTexture, plain eyes and a small smile. */
function studentFaceTexture() {
  return studentFace ??= canvas(512, 256, (g) => {
    g.fillStyle = SKIN; g.fillRect(0, 0, 512, 256);
    const cx = 128;
    g.fillStyle = 'rgba(214,140,120,0.22)';
    for (const s of [-1, 1]) { g.beginPath(); g.ellipse(cx + s * 40, 135, 16, 10, 0, 0, Math.PI * 2); g.fill(); }
    g.lineCap = 'round'; g.strokeStyle = '#2e2420'; g.lineWidth = 4;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(cx + s * 16, 104); g.lineTo(cx + s * 40, 102); g.stroke();
      g.fillStyle = '#2e2420'; g.beginPath(); g.ellipse(cx + s * 28, 118, 5, 7, 0, 0, Math.PI * 2); g.fill();
    }
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx - 14, 158); g.quadraticCurveTo(cx, 166, cx + 14, 158); g.stroke();
  });
}

const studentMats = new Map<number, THREE.Material[]>();
/** Materials for a teammate (same slots as makeMaterials): coloured jacket and sleeves, jeans, no glasses. Shared per colour. */
export function makeStudentMaterials(color: number): THREE.Material[] {
  let mats = studentMats.get(color);
  if (mats) return mats;
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
  const hide = <T extends THREE.Material>(m: T) => { m.visible = false; return m; };
  const m: Record<MatName, THREE.Material> = {
    face: std({ map: studentFaceTexture(), roughness: 0.6 }),
    skin: std({ color: SKIN, roughness: 0.55 }),
    jacket: std({ color, roughness: 0.7 }),
    sleeve: std({ color, roughness: 0.7 }),
    pants: std({ color: 0x4a5f86, roughness: 0.85 }),
    shoe: std({ color: 0xe8e8e8, roughness: 0.5 }),
    frame: hide(std({})),
    lens: hide(std({})),
    metal: std({ color: 0xb8b8b8, metalness: 0.8, roughness: 0.25 }),
    lapel: std({ color, roughness: 0.6 }),
  };
  mats = MATS.map((k) => m[k]);
  studentMats.set(color, mats);
  return mats;
}

let monitorMats: THREE.Material[] | undefined;
let monitorFace: THREE.Texture | undefined;
/** 无脸值日生: a blank sheet of paper where the face should be (same equirect layout), a faint fold and nothing else. */
function monitorFaceTexture() {
  return monitorFace ??= canvas(512, 256, (g) => {
    g.fillStyle = '#e4e0d2'; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = 'rgba(120,110,95,0.25)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(60, 120); g.quadraticCurveTo(128, 132, 196, 118); g.stroke();
    g.beginPath(); g.moveTo(128, 70); g.lineTo(126, 190); g.stroke();
  });
}

/** Skeleton materials of the 值日生: white shirt, grey trousers, paper face, no glasses (red armband: mobs.ts). */
export function makeMonitorMaterials(): THREE.Material[] {
  if (monitorMats) return monitorMats;
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
  const hide = <T extends THREE.Material>(m: T) => { m.visible = false; return m; };
  const shirt = 0xe6e3da;
  const m: Record<MatName, THREE.Material> = {
    face: std({ map: monitorFaceTexture(), roughness: 0.9 }),
    skin: std({ color: 0xe0dccf, roughness: 0.8 }),
    jacket: std({ color: shirt, roughness: 0.85 }),
    sleeve: std({ color: shirt, roughness: 0.85 }),
    pants: std({ color: 0x3c3f46, roughness: 0.9 }),
    shoe: std({ color: 0x1c1c1e, roughness: 0.6 }),
    frame: hide(std({})),
    lens: hide(std({})),
    metal: std({ color: 0xb8b8b8, metalness: 0.8, roughness: 0.25 }),
    lapel: std({ color: shirt, roughness: 0.85 }),
  };
  return monitorMats = MATS.map((k) => m[k]);
}
