import {describe,expect,it,vi} from 'vitest';
import * as THREE from 'three';
import {TouchIntent,worldTouchHit,touchHitState,worldTouchBlocked,TOUCH_HOLD_MS} from '../../client/src/worldTouch.ts';
import {CollisionWorld,box} from '../../shared/campus/collision.ts';
import {boxAt,type Cand} from '../../shared/interact.ts';

const rect={left:0,top:0,width:844,height:390};
function fixture(x=.4,z=-1.4){
 const camera=new THREE.PerspectiveCamera(70,844/390,.1,60);camera.position.set(0,1.6,0);camera.updateMatrixWorld();
 const item=new THREE.Mesh(new THREE.BoxGeometry(.08,.1,.08),new THREE.MeshBasicMaterial());item.position.set(x,1,z);
 const target:Cand={kind:'pick',id:7,...boxAt([x,1,z],.35,1.2)};
 const p=item.position.clone().project(camera);return {camera,item,target,x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2};
}
describe('touch intent',()=>{
 it('distinguishes quick taps, threshold-crossing drags, long holds and cancelled chords',()=>{
  const t=new TouchIntent();t.begin(100,200,0);t.move(104,203);expect(t.tap(180)).toBe(true);
  t.move(112,200);t.move(100,200);expect(t.tap(190)).toBe(false);expect(t.dragging).toBe(true);
  t.begin(0,0,0);expect(t.hold(TOUCH_HOLD_MS-1)).toBe(false);expect(t.hold(TOUCH_HOLD_MS)).toBe(true);expect(t.hold(500)).toBe(false);expect(t.tap(500)).toBe(false);
  t.begin(0,0,0);t.suppress();expect(t.tap(50)).toBe(false);expect(t.hold(500)).toBe(false);
  t.begin(0,0,0);expect(t.tap(1000)).toBe(false);
 });
});
describe('world touch selection',()=>{
 it('protects the body-level chat rectangle while leaving the adjacent world touchable',()=>{
  const chat={hidden:false,getBoundingClientRect:()=>({left:12,right:252,top:260,bottom:330,width:240,height:70})};
  vi.stubGlobal('document',{querySelectorAll:(selector:string)=>selector.includes('#chat-panel')?[chat]:[]});
  vi.stubGlobal('getComputedStyle',()=>({display:'block'}));
  try {
   expect(worldTouchBlocked(120,285)).toBe(true);
   expect(worldTouchBlocked(260,285)).toBe(false);
   expect(worldTouchBlocked(120,250)).toBe(false);
   chat.hidden=true;expect(worldTouchBlocked(120,285)).toBe(false);
  } finally {vi.unstubAllGlobals();}
 });
 it('selects an off-centre rendered pickup without turning the camera, with a small finger allowance',()=>{
  const f=fixture(),before=f.camera.quaternion.clone();
  expect(worldTouchHit(f.camera,rect,f.x,f.y,[{object:f.item,target:f.target,radius:22}])?.target.id).toBe(7);
  expect(worldTouchHit(f.camera,rect,f.x+18,f.y,[{object:f.item,target:f.target,radius:22}])?.target.id).toBe(7);
  expect(worldTouchHit(f.camera,rect,f.x+40,f.y,[{object:f.item,target:f.target,radius:22}])).toBeNull();
  expect(f.camera.quaternion.equals(before)).toBe(true);
 });
 it('selects the currently rotated door leaf instance, not its old doorway',()=>{
  const f=fixture(0,-1.5),mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial(),2);
  mesh.setMatrixAt(0,new THREE.Matrix4().makeTranslation(-3,1,-2));
  mesh.setMatrixAt(1,new THREE.Matrix4().makeRotationY(.7).setPosition(0,1,-1.5));
  const target=(id:number|undefined):Cand|null=>id===undefined?null:{kind:'use',id,...boxAt([0,0,-1.5],.5,3)};
  expect(worldTouchHit(f.camera,rect,f.x,f.y,[{object:mesh,target}])?.target.id).toBe(1);
 });
 it('keeps server reach and storey limits, and refuses a wall between the eye and a pickup',()=>{
  const f=fixture(),hit=worldTouchHit(f.camera,rect,f.x,f.y,[{object:f.item,target:f.target,radius:22}])!;
  expect(touchHitState(hit,f.camera,[0,0,0],new CollisionWorld())).toBe('ready');
  expect(touchHitState(hit,f.camera,[0,4,0],new CollisionWorld())).toBe('far');
  expect(touchHitState(hit,f.camera,[0,0,5],new CollisionWorld())).toBe('far');
  expect(touchHitState(hit,f.camera,[0,0,0],new CollisionWorld([box(.2,-.7,2,.15,3)]))).toBe('blocked');
 });
 it('ignores objects behind the camera and offscreen touches',()=>{
  const f=fixture(0,1.5);expect(worldTouchHit(f.camera,rect,422,195,[{object:f.item,target:f.target,radius:22}])).toBeNull();
  expect(worldTouchHit(f.camera,rect,-1,195,[{object:f.item,target:f.target}])).toBeNull();
 });
});
