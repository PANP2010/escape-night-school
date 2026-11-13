import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { shot } from './draw.ts';
import { browserArgs } from '../browser-args.mjs';

test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
 launchOptions: { args: browserArgs(['--renderer-process-limit=1']) } });

test('phone direct touch: moving pickup, door sync, drag/cancel/HUD isolation and held revive', async ({page,browser,baseURL}) => {
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const acts:unknown[]=[];page.on('websocket',ws=>ws.on('framesent',f=>{try{const m=JSON.parse(String(f.payload));if(m.t==='act')acts.push(m);}catch{}}));
 await page.goto('/?nodraw&steady');await page.fill('#name','点物品');await page.click('#create');await expect(page.locator('#wait-code')).not.toBeEmpty();
 const peer=await browser.newPage({baseURL,viewport:{width:640,height:400}});await peer.goto('/?nodraw&steady');await peer.fill('#name','队友');await peer.fill('#code',await page.locator('#wait-code').innerText());await peer.click('#join');
 await expect(page.locator('#wait-members li')).toHaveCount(2);await page.click('#start');
 await Promise.all([page,peer].map(p=>p.waitForFunction(()=>{const g=window.__escape.game();return g?.presentationReady&&(g as any).spawnSynced&&!g.intro.active;})));
 await Promise.all([page,peer].map(async p=>{await p.keyboard.press('Shift');await p.waitForFunction(()=>window.__escape.game()!.openingComplete);}));
 await page.evaluate(async()=>{if(document.fullscreenElement)await document.exitFullscreen();window.__escape.debug('safe',600);});await page.setViewportSize({width:844,height:390});
 await expect(page.locator('#banner')).toBeHidden({timeout:15000});
 const item=await page.evaluate(()=>{const g=window.__escape.game() as any;const k=g.items.filter((k:any)=>k.kind==='battery').sort((a:any,b:any)=>Math.hypot(a.p[0]-g.pos.x,a.p[2]-g.pos.z)-Math.hypot(b.p[0]-g.pos.x,b.p[2]-g.pos.z))[0];window.__escape.debug('tp',k.p[0]+.8,k.p[2]);return k;});
 await expect.poll(()=>page.evaluate(p=>Math.abs(window.__escape.game()!.pos.x-(p+0.8)),item.p[0])).toBeLessThan(.2);
 await page.waitForTimeout(500);
 await page.evaluate(p=>{const g=window.__escape.game()!;const dx=p[0]-g.camera.position.x,dz=p[2]-g.camera.position.z;g.input.yaw=Math.atan2(-dx,-dz)+.45;g.input.pitch=Math.atan2(p[1]+.03-g.camera.position.y,Math.hypot(dx,dz));g.light=false;},item.p);
 await page.waitForTimeout(300);
 let point=await page.evaluate(id=>{const g=window.__escape.game() as any;const m=g.itemMeshes.get(id);g.camera.updateMatrixWorld();const v=m.position.clone().project(g.camera);return{x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2};},item.id);
 mkdirSync('test-results/mobile-direct/evidence',{recursive:true});await shot(page,'test-results/mobile-direct/evidence/key-before.png');
 const yaw=await page.evaluate(()=>window.__escape.game()!.input.yaw);;
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:90,y:300}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:110,y:300}]});
 point=await page.evaluate(id=>{const g=window.__escape.game() as any;const v=g.itemMeshes.get(id).position.clone().project(g.camera);return{x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2};},item.id);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:110,y:300},{id:2,x:point.x,y:point.y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[{id:2,x:point.x,y:point.y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await expect.poll(()=>page.evaluate(id=>(window.__escape.game() as any).items.some((k:any)=>k.id===id),item.id)).toBe(false);
 await expect.poll(()=>peer.evaluate(id=>(window.__escape.game() as any).items.some((k:any)=>k.id===id),item.id)).toBe(false);
 expect(await page.evaluate(()=>window.__escape.game()!.input.yaw)).toBe(yaw);
 const door=await page.evaluate(()=>{const g=window.__escape.game() as any;const d=g.doors.find((d:any)=>d.y0===0&&!g.regionLocked(d.id)&&!g.doorLocked[d.id]);window.__escape.debug('tp',d.x+(d.alongX?0:1.3),d.z+(d.alongX?1.3:0));return d;});
 await expect.poll(()=>page.evaluate(d=>Math.hypot(window.__escape.game()!.pos.x-d.x-(d.alongX?0:1.3),window.__escape.game()!.pos.z-d.z-(d.alongX?1.3:0)),door)).toBeLessThan(.2);
 await page.evaluate(d=>{const g=window.__escape.game()!;g.input.yaw=d.alongX?-.15:Math.PI/2-.15;g.input.pitch=-.08;},door);await page.waitForTimeout(250);
 const dp=await page.evaluate(id=>{const g=window.__escape.game() as any;const m=new window.__escape.THREE.Matrix4();g.doorMesh.getMatrixAt(id,m);const v=new window.__escape.THREE.Vector3().setFromMatrixPosition(m).project(g.camera);return{x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2};},door.id);
 await shot(page,'test-results/mobile-direct/evidence/door-before.png');await page.touchscreen.tap(dp.x,dp.y);
 await expect.poll(()=>page.evaluate(id=>window.__escape.game()!.doorOpen[id],door.id)).toBe(true);
 await expect.poll(()=>peer.evaluate(id=>window.__escape.game()!.doorOpen[id],door.id)).toBe(true);
 const before=acts.length, beforeYaw=await page.evaluate(()=>window.__escape.game()!.input.yaw);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:dp.x,y:dp.y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:dp.x+11,y:dp.y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:dp.x+81,y:dp.y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(200);
 expect(acts.length).toBe(before);expect(Math.abs((await page.evaluate(()=>window.__escape.game()!.input.yaw))-beforeYaw)).toBeGreaterThan(.2);
 // Cancellation and a second finger in the same look region never toggle the open door.
 await page.evaluate(d=>{const g=window.__escape.game()!;g.input.yaw=d.alongX?-.15:Math.PI/2-.15;g.input.pitch=-.08;},door);await page.waitForTimeout(200);
 const cancelCount=acts.length;
 await page.locator('#touch-map').tap();await expect(page.locator('#map')).toBeVisible();await page.locator('#touch-map').tap();await expect(page.locator('#map')).toBeHidden();expect(acts.length).toBe(cancelCount);
 await page.setViewportSize({width:390,height:844});await expect(page.locator('#rotate')).toBeVisible();await page.touchscreen.tap(200,400);expect(acts.length).toBe(cancelCount);await page.setViewportSize({width:844,height:390});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:500,y:230}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:500,y:230}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:500,y:230},{id:2,x:540,y:230}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(100);expect(acts.length).toBe(cancelCount);
 // Direct touch uses the same authority and visible floor as the player's view. A wall blocks a far/hidden item.
 const remaining=await page.evaluate(()=>{const g=window.__escape.game() as any;return g.items.find((k:any)=>k.kind==='door_key');});
 await page.evaluate(p=>window.__escape.debug('tp',p[0]+4,p[2]),remaining.p);await page.waitForTimeout(350);
 await page.evaluate(p=>{const g=window.__escape.game()!;const dx=p[0]-g.camera.position.x,dz=p[2]-g.camera.position.z;g.input.yaw=Math.atan2(-dx,-dz);g.input.pitch=Math.atan2(p[1]+.03-g.camera.position.y,Math.hypot(dx,dz));},remaining.p);await page.waitForTimeout(150);
 const farPoint=await page.evaluate(id=>{const g=window.__escape.game() as any,v=g.itemMeshes.get(id).position.clone().project(g.camera);return {x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2};},remaining.id);
 await page.touchscreen.tap(farPoint.x,farPoint.y);expect(acts.length).toBe(cancelCount);
 await expect.poll(()=>page.evaluate(id=>(window.__escape.game() as any).items.some((k:any)=>k.id===id),remaining.id)).toBe(true);
 // A teammate is revived only while the finger remains held on their body.
 await page.evaluate(()=>window.__escape.debug('tp',-41.5,73.36));await peer.evaluate(()=>{window.__escape.debug('tp',-43,73.36);window.__escape.debug('safe',600);});await page.waitForTimeout(250);await peer.evaluate(()=>window.__escape.debug('down',30));
 await expect(peer.locator('#down-overlay')).toBeVisible();await page.waitForTimeout(400);
 await page.evaluate(()=>{const g=window.__escape.game() as any;const r=[...g.remotes.values()].find((r:any)=>r.down);const dx=r.mesh.position.x-g.camera.position.x,dz=r.mesh.position.z-g.camera.position.z;g.input.yaw=Math.atan2(-dx,-dz);g.input.pitch=Math.atan2(.25-g.camera.position.y,Math.hypot(dx,dz));});await page.waitForTimeout(200);
 const rp=await page.evaluate(()=>{const g=window.__escape.game() as any,r=[...g.remotes.values()].find((r:any)=>r.down),v=r.mesh.position.clone().add(new window.__escape.THREE.Vector3(0,.25,0)).project(g.camera);return{x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2};});
 await page.touchscreen.tap(rp.x,rp.y);await page.waitForTimeout(400);await expect(peer.locator('#down-overlay')).toBeVisible();
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rp.x,y:rp.y}]});await page.waitForTimeout(800);await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await page.waitForTimeout(200);await expect(peer.locator('#down-overlay')).toBeVisible();
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rp.x,y:rp.y}]});await page.waitForTimeout(3900);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expect(peer.locator('#down-overlay')).toBeHidden({timeout:5000});
 await shot(page,'test-results/mobile-direct/evidence/teammate-revived.png');writeFileSync('test-results/mobile-direct/evidence/results.json',JSON.stringify({item,point,door:door.id,doorPoint:dp,acts,errors},null,2));expect(errors).toEqual([]);await peer.close();
});
