import { describe, expect, it } from 'vitest';
import { MirrorKey } from '../../server/l7-key.ts';
import { canTakeMirrorKey, mirrorKeyPoint, watchesKeyGuard, type KeyViewer } from '../../shared/l7-key.ts';
import { mirrorPoint, MIRRORS } from '../../shared/levels/l7.ts';
import { ST_DOWN, ST_OK, ST_SPECTATE } from '../../shared/protocol.ts';
import { lineOfSight } from '../../shared/campus/nav.ts';
import { l7World } from '../../shared/levels/l7.ts';
const clear = () => true;
const viewer = (): KeyViewer => ({p:[-80.4,0,143.4],yaw:Math.PI/2,pitch:-.1,st:ST_OK});
function opened() {const key=new MirrorKey();key.step(3.5,[],clear);return key;}

describe('L7 mirror-only key in the duty student back window',()=>{
 it('opens and closes on natural turns without being frozen by a mirror viewer',()=>{
  const key=new MirrorKey(), p=viewer();expect(key.snapshot().open).toBe(false);
  expect(watchesKeyGuard(p,clear)).toBe(false);key.step(3.5,[p],clear);
  expect(key.snapshot().open).toBe(true);expect(key.snapshot().guard.watched).toBe(false);
  key.step(3.5,[p],clear);expect(key.snapshot().open).toBe(false);
 });
 it('direct sight with a clear ray freezes turning but an occluded viewer does not',()=>{
  const key=new MirrorKey(),p=viewer();p.yaw=-Math.PI/2;
  expect(watchesKeyGuard(p,clear)).toBe(true);const yaw=key.yaw;key.step(2,[p],clear);expect(key.yaw).toBe(yaw);
  key.step(2,[p],()=>false);expect(key.yaw).not.toBe(yaw);
 });
 it('requires a visible glass ray and a clear reflected back ray in an open window',()=>{
  const key=opened(),p=viewer();expect(canTakeMirrorKey(p,key.snapshot(),clear)).toBe(true);
  expect(canTakeMirrorKey(p,key.snapshot(),()=>false)).toBe(false);
  let n=0;expect(canTakeMirrorKey(p,key.snapshot(),()=>++n===1)).toBe(false);
  const virtual=mirrorPoint(MIRRORS[0],mirrorKeyPoint(key.snapshot()));expect(virtual[0]).toBeLessThan(MIRRORS[0].center[0]);
 });
 it('refuses frontal, remote, wrong-floor, off-angle, downed, observer and closed-window requests',()=>{
  const key=opened();
  for(const p of [ {...viewer(),yaw:-Math.PI/2}, {...viewer(),p:[-76,0,143.4] as [number,number,number]}, {...viewer(),p:[-80.4,3.6,143.4] as [number,number,number]}, {...viewer(),pitch:1.2}, {...viewer(),st:ST_DOWN}, {...viewer(),st:ST_SPECTATE}])expect(key.take(p,clear)).toBe(false);
  expect(new MirrorKey().take(viewer(),clear)).toBe(false);expect(key.taken).toBe(false);
 });
 it('grants one shared key, makes duplicate takes harmless and resets for replay',()=>{
  const key=opened();expect(key.take(viewer(),clear)).toBe(true);expect(key.snapshot()).toMatchObject({taken:true,open:false});
  expect(key.take(viewer(),clear)).toBe(false);key.reset();expect(key.snapshot()).toMatchObject({taken:false,open:false});
 });
 it('takes through the actual LAB glass with both real collision rays clear',()=>{
  const world=l7World(),los=(a:[number,number,number],b:[number,number,number])=>lineOfSight(world,{x:a[0],y:a[1],z:a[2]},{x:b[0],y:b[1],z:b[2]});
  const key=opened();expect(canTakeMirrorKey(viewer(),key.snapshot(),los)).toBe(true);
  expect(key.take(viewer(),los)).toBe(true);
 });
 it('lets one teammate directly freeze the turn while the other watches the mirror',()=>{
  const key=new MirrorKey(),mirror=viewer(),direct={...viewer(),yaw:-Math.PI/2};
  key.step(3.5,[mirror,direct],clear);expect(key.snapshot()).toMatchObject({open:false,guard:{watched:true}});
  expect(key.take(mirror,clear)).toBe(false);
  key.step(3.5,[mirror,{...direct,st:ST_SPECTATE}],clear);
  expect(key.snapshot()).toMatchObject({open:true,guard:{watched:false}});
  expect(key.take(mirror,clear)).toBe(true);
 });
});
