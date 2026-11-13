import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, realpath, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseRecord, prepareNativeUi } from './prepare-ui.mjs';
const apps = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2), arg = name => args[args.indexOf(name)+1];
const source = resolve(args.includes('--game') ? arg('--game') : process.env.GAME_ROOT || join(apps,'../game'));
const packageVersion = JSON.parse(await readFile(join(apps, 'package.json'), 'utf8')).version;
const portrait = args.includes('--portrait') ? resolve(arg('--portrait')) : undefined;
const dirty = execFileSync('git',['status','--porcelain','--untracked-files=no','--','.'],{cwd:source,encoding:'utf8'}).trim();
if(dirty && !args.includes('--allow-dirty')) throw new Error('Game source has uncommitted changes; freeze a committed revision before release.');
const sha = execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
const stage=resolve(process.env.ESCAPE_STAGE_ROOT || join(apps,'stage')), copy=join(stage,'source'), runtime=join(stage,'runtime');
await mkdir(stage,{recursive:true});await rm(copy,{recursive:true,force:true});await rm(runtime,{recursive:true,force:true});
const excluded=new Set(['node_modules','.git','.green','.stage','.cache','dist','dist-server','test-results','playwright-report','loop']);
await cp(source,copy,{recursive:true,filter:path=> !excluded.has(basename(path)) && basename(path)!=='.DS_Store'});
await symlink(await realpath(join(source,'node_modules')),join(copy,'node_modules'),'dir');
if(existsSync(join(source,'.cache/campus-nav.json'))){await mkdir(join(copy,'.cache'),{recursive:true});await cp(join(source,'.cache/campus-nav.json'),join(copy,'.cache/campus-nav.json'));}
function run(command,argv){const r=spawnSync(command,argv,{cwd:copy,stdio:'inherit',env:{...process.env,ESC_DEBUG:'0'}});if(r.status!==0)throw new Error(`${command} failed: ${r.status}`);}
run('npm',['run','build']);
await mkdir(runtime,{recursive:true});await cp(join(copy,'dist'),join(runtime,'dist'),{recursive:true});
const legal=join(runtime,'legal');await mkdir(legal,{recursive:true});
for(const name of ['LICENSE','LICENSE.zh-CN.md','DISCLAIMER.md','THIRD_PARTY_NOTICES.md']){
  const file=resolve(source,'..',name);if(existsSync(file))await cp(file,join(legal,name));
}
await cp(join(copy,'.cache/campus-nav.json'),join(runtime,'campus-nav.json'));
// Vite resolves campus import.meta.glob data before esbuild makes the self-contained native server.
await build({entryPoints:[join(copy,'dist-server/index.js')],outfile:join(runtime,'server.cjs'),platform:'node',format:'cjs',target:'node22',bundle:true,sourcemap:false,external:['bufferutil','utf-8-validate'],logLevel:'info'});
const release=await releaseRecord(source);
const metadata={...release,id:packageVersion,gameVersion:release.id,sourceSha:sha,sourceDirty:Boolean(dirty),packagedAt:new Date().toISOString()};
await writeFile(join(runtime,'release.json'),JSON.stringify(metadata,null,2)+'\n');
await prepareNativeUi({apps,source,metadata,portrait});
// Android retains a bundled client. Only its transport entry is adapted; the original source is untouched.
const main=join(copy,'client/src/main.ts');let text=await readFile(main,'utf8');const marker='const net = new Net();';
if(text.split(marker).length!==2)throw new Error('Native client adapter needs review: Net initialization changed.');
text=text.replace(marker,`const nativeEndpoint = new URLSearchParams(location.search).get('server') || 'http://154.217.245.217:4100';\nconst nativeUrl = new URL(nativeEndpoint);\nif (!['http:', 'https:'].includes(nativeUrl.protocol) || nativeUrl.username || nativeUrl.password) throw new Error('Invalid game server');\nnativeUrl.protocol = nativeUrl.protocol === 'https:' ? 'wss:' : 'ws:'; nativeUrl.pathname = '/ws'; nativeUrl.search = ''; nativeUrl.hash = '';\nconst net = new Net(nativeUrl.href);`);
await writeFile(main,text);run('npm',['run','build:client']);
const android=join(apps,'android/app/src/main/assets/web');await rm(android,{recursive:true,force:true});await mkdir(android,{recursive:true});
await cp(join(copy,'dist'),android,{recursive:true,filter:p=>!p.endsWith('.br')&&!p.endsWith('.gz')});
await cp(legal,join(android,'legal'),{recursive:true});
await writeFile(join(android,'native-release.json'),JSON.stringify(metadata,null,2)+'\n');
await writeFile(join(stage,'prepared.json'),JSON.stringify(metadata,null,2)+'\n');console.log(JSON.stringify(metadata,null,2));
