import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { endpointUrl, serverEnvironment, privateIPv4Addresses }=createRequire(import.meta.url)('../desktop/runtime.cjs');
test('server endpoints admit only explicit HTTP(S) without credentials',()=>{
 assert.equal(endpointUrl('https://game.example/'),'https://game.example/');
 assert.equal(endpointUrl('http://127.0.0.1:4100'),'http://127.0.0.1:4100/');
 assert.equal(endpointUrl('http://192.168.50.12:52123'),'http://192.168.50.12:52123/');
 for(const value of ['javascript:alert(1)','file:///etc/passwd','ftp://example.com','https://user:secret@example.com'])assert.throws(()=>endpointUrl(value));
});
test('local server excludes model credentials and debug settings',()=>{
 const env=serverEnvironment({PATH:'/bin',HOME:'/tmp/home',ANTHROPIC_AUTH_TOKEN:'not-a-real-token',OPENAI_API_KEY:'not-a-real-key',ESC_DEBUG:'1',NODE_OPTIONS:'--inspect'},'/tmp/game',4101);
 assert.equal(env.HOST,'127.0.0.1');assert.equal(env.PORT,'4101');assert.equal(env.NODE_ENV,'production');
 for(const key of ['ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','ESC_DEBUG','NODE_OPTIONS'])assert.equal(env[key],undefined);
 assert.equal(env.DIST,'/tmp/game/dist');
});
test('LAN serving is explicit and persistent scores live in the writable user directory',()=>{
 const source={HOME:'/tmp/home',LEADERBOARD_FILE:'/tmp/untrusted.json',HOST:'public.example',NODE_OPTIONS:'--inspect'};
 const lan=serverEnvironment(source,'/Applications/School.app/Contents/Resources/game',52123,{lan:true,dataPath:'/Users/local-user/Library/Application Support/School'});
 assert.equal(lan.HOST,'0.0.0.0');assert.equal(lan.PORT,'52123');
 assert.equal(lan.LEADERBOARD_FILE,'/Users/local-user/Library/Application Support/School/leaderboard.json');
 assert.equal(lan.NODE_OPTIONS,undefined);
 const solo=serverEnvironment(source,'/tmp/game',4101,{dataPath:'/tmp/data'});
 assert.equal(solo.HOST,'127.0.0.1');assert.equal(solo.LEADERBOARD_FILE,'/tmp/data/leaderboard.json');
});
test('share real private IPv4 interfaces only, excluding loopback, VPN public, IPv6 and duplicates',()=>{
 const entry=(address,internal=false,family='IPv4')=>({address,internal,family});
 assert.deepEqual(privateIPv4Addresses({en0:[entry('192.168.1.22')],en1:[entry('10.0.0.2'),entry('192.168.1.22')],
  bridge:[entry('172.16.0.3',false,4),entry('172.31.255.3')],lo:[entry('127.0.0.1',true)],other:[entry('172.32.0.1'),entry('169.254.1.1'),entry('154.217.245.217'),entry('::1',false,'IPv6'),entry('10.999.0.1')]}),
  ['192.168.1.22','10.0.0.2','172.16.0.3','172.31.255.3']);
 assert.deepEqual(privateIPv4Addresses({en0:undefined}),[]);
});
