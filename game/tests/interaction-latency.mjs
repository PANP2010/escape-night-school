import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)), port=Number(process.env.ESC_LATENCY_PORT??4390);
const local=`http://127.0.0.1:${port}`, remote=process.env.ESC_LATENCY_REMOTE??local;
process.env.LOCAL_ONLY??=process.env.ESC_LATENCY_REMOTE?'':'1';
if((process.env.PUBLIC_ONLY||process.env.REMOTE_WS)&&!process.env.ESC_LATENCY_REMOTE)throw Error('Set ESC_LATENCY_REMOTE explicitly for public-room probes');
const out=root+'/test-results/interaction-latency', label=process.env.PROBE_LABEL??'baseline';
const report={label,started:new Date().toISOString(),cases:[],errors:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const stats=xs=>{const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);return{n:a.length,p50:a[Math.floor(a.length*.5)]??null,p95:a[Math.min(a.length-1,Math.floor(a.length*.95))]??null,max:a.at(-1)??null};};
let server,browser;
async function until(f,name,t=15000){const end=Date.now()+t;while(Date.now()<end){if(await f())return;await pause(30);}throw Error('Timeout '+name);}
try{
 assert.equal(await fetch(local+'/healthz').then(()=>true).catch(()=>false),false,'4390 occupied');
 await mkdir(out,{recursive:true});
 server=spawn(process.execPath,['dist-server/index.js'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',NODE_ENV:'development'},stdio:'ignore'});
 await until(async()=>fetch(local+'/healthz').then(r=>r.ok).catch(()=>false),'server');
 browser=await chromium.launch({headless:true,args:['--use-angle=metal','--mute-audio','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
 const cases=process.env.REMOTE_WS?[[local,false,'normal'],[local,true,'normal']]:process.env.PUBLIC_ONLY?[[remote,false,'normal'],[remote,true,'normal']]:process.env.SLOW_ONLY?[[local,false,'raf1hz'],[local,true,'raf1hz'],[local,true,'cpu6']]:[[local,false,'normal'],[local,true,'normal'],...process.env.LOCAL_ONLY?[]:[[remote,false,'normal'],[remote,true,'normal']],[local,false,'raf1hz'],[local,true,'raf1hz'],[local,true,'cpu6']];
 for(const [baseURL,mobile,mode] of cases){
  const name=(process.env.REMOTE_WS?'local-client-public-ws':baseURL===local?'local':'public')+'-'+(mobile?'phone':'desktop')+'-'+mode;
  const ctx=await browser.newContext({baseURL,viewport:mobile?{width:844,height:390}:{width:960,height:540},hasTouch:mobile,isMobile:mobile,deviceScaleFactor:1});
  const page=await ctx.newPage();page.on('pageerror',e=>report.errors.push(name+': '+e.message));
  await page.addInitScript(()=>{window.__lat={events:[],long:[],eventTiming:[],frames:[],renders:[],methods:[],sent:[],received:[],trials:[],active:null};
   try{new PerformanceObserver(l=>window.__lat.long.push(...l.getEntries().map(e=>({t:e.startTime,ms:e.duration})))).observe({type:'longtask',buffered:true});}catch{}
   try{new PerformanceObserver(l=>window.__lat.eventTiming.push(...l.getEntries().map(e=>({name:e.name,t:e.startTime,ms:e.duration,delay:e.processingStart-e.startTime,processing:e.processingEnd-e.processingStart})))).observe({type:'event',buffered:true,durationThreshold:16});}catch{}
   for(const type of['keydown','touchstart','touchend','pointerdown'])addEventListener(type,e=>{const relevant=e.code==='KeyE'||e.target?.classList?.contains('main');if(relevant){const event={type,t:performance.now(),stamp:e.timeStamp,trusted:e.isTrusted};window.__lat.events.push(event);if(window.__lat.active&&window.__lat.active.event===undefined&&(type==='keydown'||type==='touchstart'||type==='pointerdown'))window.__lat.active.event=event.t;}},true);
  });
  if(process.env.REMOTE_WS)await page.addInitScript(url=>{const Original=WebSocket;window.WebSocket=class extends Original{constructor(value,protocols){super(String(value).endsWith('/ws')?url:String(value),protocols);}};},remote.replace('http','ws')+'/ws');
  await page.goto('/?steady');await page.fill('#name','延迟验收'+name);await page.click('#create');await page.click('#start');
  await page.waitForFunction(()=>window.__escape.game()?.spawnSynced,null,{timeout:60000});
  await page.evaluate(async()=>{if(document.fullscreenElement)await document.exitFullscreen();window.__escape.debug('safe',600);});
  await page.setViewportSize(mobile?{width:844,height:390}:{width:960,height:540});
  const door=await page.evaluate(()=>{const g=window.__escape.game();const ds=g.doors.filter(d=>(d.y0??0)===0&&!g.regionLocked(d.id)&&!g.doorLocked[d.id]);const d=ds.sort((a,b)=>Math.hypot(a.x-g.body.x,a.z-g.body.z)-Math.hypot(b.x-g.body.x,b.z-g.body.z))[0];return d;});
  if(baseURL===local&&!process.env.REMOTE_WS)await page.evaluate(d=>window.__escape.debug('tp',d.x+(d.alongX?0:1.3),d.z+(d.alongX?1.3:0)),door);
  else await page.evaluate(d=>{const g=window.__escape.game();window.__escape.autopilot([[g.body.x,g.body.z],[d.x+(d.alongX?0:1.3),d.z+(d.alongX?1.3:0)]]);},door);
  await page.waitForFunction(d=>{const g=window.__escape.game();return Math.hypot(g.body.x-d.x-(d.alongX?0:1.3),g.body.z-d.z-(d.alongX?1.3:0))<.35;},door,{timeout:10000});
  await page.evaluate(d=>{const g=window.__escape.game();g.route=null;g.input.yaw=d.alongX?0:Math.PI/2;g.input.pitch=-.1;},door);
  await pause(500);
  await page.evaluate(id=>{const g=window.__escape.game(),p=window.__lat;p.door=id;p.initialCorrections=g.corrections;p.initialSnaps=g.snaps;
   const update=g.update.bind(g);g.update=(...args)=>{const t=performance.now();if(p.lastFrame&&p.lastNow!==args[1])p.frames.push(t-p.lastFrame);p.lastFrame=t;p.lastNow=args[1];const value=update(...args);p.methods.push({name:'update',t,ms:performance.now()-t});return value;};
   const render=g.renderer.render.bind(g.renderer);g.renderer.render=(...args)=>{const t=performance.now(),a=p.active;if(a&&a.confirm!==undefined&&a.render===undefined&&g.doorSwing[id]!==a.beforeSwing){a.render=t;a.swing=g.doorSwing[id];}const value=render(...args);p.renders.push({t,ms:performance.now()-t});return value;};
   for(const name of['target','interact','tickMap','tickTeam','showPrompt','doorSound','onWorldTouch']){const method=g[name].bind(g);g[name]=(...args)=>{const t=performance.now();const value=method(...args);p.methods.push({name,t,ms:performance.now()-t});if(name==='showPrompt'&&p.active&&p.active.pendingAt===undefined&&document.querySelector('#prompt').textContent==='请求已发出，等待确认…'){p.active.pendingAt=performance.now();p.active.pendingOpen=g.doorOpen[id];}return value;};}
   const press=g.input.press.bind(g.input);g.input.press=code=>{if(code==='KeyE'&&p.active)p.active.press=performance.now();return press(code);};
   const send=g.net.send.bind(g.net);g.net.send=m=>{if(m.t==='act'&&m.kind==='use'&&m.id===id&&p.active){p.active.send=performance.now();p.active.act=m;p.active.actCount=(p.active.actCount??0)+1;}p.sent.push({t:performance.now(),type:m.t});return send(m);};
   const receive=window.__escape.net.onMsg.bind(window.__escape.net);window.__escape.net.onMsg=m=>{const t=performance.now();if(m.t==='snap')p.received.push({t,tick:m.tick});if(m.t==='correct')p.received.push({t,type:'correct',forced:m.forced});if(p.active&&m.t==='snap'&&m.doors?.some(d=>d.id===id)){p.active.confirm=t;p.active.confirmOpen=m.doors.find(d=>d.id===id).open;}const value=receive(m);if(p.active&&p.active.confirm===t)p.active.applied=performance.now();return value;};
   const voiceUnlock=g.voice.unlock.bind(g.voice);g.voice.unlock=(...args)=>{const t=performance.now();const value=voiceUnlock(...args);p.methods.push({name:'voice.unlock',t,ms:performance.now()-t});return value;};
   for(const name of['unlock','update','door','click']){const method=g.sound[name].bind(g.sound);g.sound[name]=(...args)=>{const t=performance.now();const value=method(...args);p.methods.push({name:'sound.'+name,t,ms:performance.now()-t});return value;};}
  },door.id);
  const health=[];for(let i=0;i<5;i++){const t=Date.now();await page.evaluate(()=>fetch('/healthz',{cache:'no-store'}).then(r=>r.text()));health.push(Date.now()-t);}
  if(mode==='raf1hz')await page.evaluate(()=>{const raf=requestAnimationFrame.bind(window);window.requestAnimationFrame=cb=>setTimeout(()=>raf(cb),1000);});
  if(mode==='cpu6'){const cdp=await ctx.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});}
  const trials=[];
  for(let i=0;i<(mode==='normal'?12:4);i++){
   const prepared=await page.evaluate(i=>{const g=window.__escape.game(),p=window.__lat,target=g.target();const a={i,prepared:performance.now(),target,beforeOpen:g.doorOpen[p.door],beforeSwing:g.doorSwing[p.door],snaps:g.snaps};p.active=a;p.trials.push(a);return a;},i);
   assert.equal(prepared.target?.kind,'use',name+' target');assert.equal(prepared.target?.id,door.id,name+' target id');
   if(mobile){const btn=page.locator('#touch-btns .main'),box=await btn.boundingBox();assert.ok(box);const cdp=await ctx.newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});await pause(i===0?180:45);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
   else{await page.keyboard.down('KeyE');await pause(45);await page.keyboard.up('KeyE');}
   await page.waitForFunction(()=>window.__lat.active.render!==undefined,null,{timeout:10000,polling:10});
   await pause(430);
   const a=await page.evaluate(()=>({...window.__lat.active}));if(process.env.EXPECT_FIXED){assert.equal(a.actCount,1,name+' exactly one action');assert.ok(a.pendingAt>=a.send&&a.pendingAt<a.confirm,name+' immediate pending prompt');assert.equal(a.pendingOpen,a.beforeOpen,name+' no predicted success');assert.ok(a.send-a.press<20,name+' dispatch without rAF');}trials.push({...a,eventToPress:a.press-a.event,eventToSend:a.send-a.event,sendToConfirm:a.confirm-a.send,confirmApply:a.applied-a.confirm,confirmToRender:a.render-a.confirm,eventToRender:a.render-a.event,eventToPending:a.pendingAt-a.event});
  }
  await page.screenshot({path:out+'/'+label+'-'+name+'.png'}).catch(()=>{});
  const raw=await page.evaluate(()=>{const p=window.__lat,g=window.__escape.game(),gl=g.renderer.getContext();return{...p,active:null,initialCorrections:p.initialCorrections,corrections:g.corrections-p.initialCorrections,snaps:g.snaps-p.initialSnaps,renderer:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),drawCalls:g.renderer.info.render.calls,triangles:g.renderer.info.render.triangles,sound:g.sound.diagnostics};});
  const c={name,door:door.id,trials,summary:{eventToPress:stats(trials.map(a=>a.eventToPress)),eventToSend:stats(trials.map(a=>a.eventToSend)),sendToConfirm:stats(trials.map(a=>a.sendToConfirm)),confirmApply:stats(trials.map(a=>a.confirmApply)),confirmToRender:stats(trials.map(a=>a.confirmToRender)),eventToRender:stats(trials.map(a=>a.eventToRender)),eventToPending:stats(trials.map(a=>a.eventToPending)),frame:stats(raw.frames),render:stats(raw.renders.map(a=>a.ms)),long:stats(raw.long.map(a=>a.ms)),healthRoundtrip:stats(health)},raw};report.cases.push(c);console.log(JSON.stringify({name,summary:c.summary,corrections:raw.corrections,renderer:raw.renderer,triangles:raw.triangles}));await ctx.close();
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.error=e.stack??String(e);process.exitCode=1;}
finally{await browser?.close();server?.kill('SIGTERM');await mkdir(out,{recursive:true});await writeFile(out+'/'+label+'.json',JSON.stringify(report,null,2));console.log(report.error??'PASS '+report.cases.length+' cases');}
