import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runtimeErrorFirstLine } from '../dist/security/runtime-error.js';
import { JsonlRpcClient, runExternalCommandCapture, ExternalJsonlRpcRequestError, ExternalJsonlRpcTransportError } from '../dist/external-sessions/process.js';
import { runtimeFailureMessage } from '../dist/agent-runtime/failure-diagnostics.js';
import { runtimeFailureTracker } from '../dist/agent-runtime/failure-tracker.js';
import { cliMcpFixture, until } from './helpers/workspace-cli-mcp.mjs';
const secret='opaque-native-credential-12345';
const env={...process.env,NATIVE_API_TOKEN:secret};
const raw=`Error: invalid transport token=${secret} /Users/private/.codex/auth.json https://private.example/?key=secret private@example.com\nPRIVATE_SECOND_LINE`;
const body=text=>JSON.parse(text.slice('hara_runtime_failure_v1='.length));

test('native first line redacts before truncation and excludes paths, accounts, URLs, IDs and subsequent lines',()=>{
 const safe=runtimeErrorFirstLine(raw,env);
 assert.match(safe,/Error: invalid transport/);
 assert.doesNotMatch(safe,/opaque-native|Users|private|https:|SECOND_LINE|example/);
 assert.match(safe,/\[path\]/);assert.match(safe,/\[url\]/);assert.match(safe,/\[account\]/);
 assert.equal(runtimeErrorFirstLine('\n\r\n'),undefined);
 assert.doesNotMatch(runtimeErrorFirstLine('401 Unauthorized PRIVATE_ACCOUNT_DETAIL'),/PRIVATE_ACCOUNT_DETAIL/);
 assert.equal([...runtimeErrorFirstLine('界'.repeat(500))].length,320);
 assert.doesNotMatch(runtimeErrorFirstLine('failure prompt="PRIVATE_PROMPT" thread_id=11111111-1111-4111-8111-111111111111'),/PRIVATE|11111111/);
 assert.doesNotMatch(runtimeErrorFirstLine('\u001b[31mError:\u001b[0m bad\u202e'),/\u001b|\u202e/);
});

test('capture exposes safe first line only with explicit runtime diagnostic admission',async()=>{
 const spawnProcess=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();setImmediate(()=>{child.stderr.write(raw);child.emit('close',1);});return child;};
 for(const captureErrorFirstLine of [false,true]){
  const result=await runExternalCommandCapture({command:process.execPath,env,spawnProcess},[],{failureKind:'runtime',captureErrorFirstLine});
  assert.equal(Boolean(result.errorFirstLine),captureErrorFirstLine);
  assert.doesNotMatch(JSON.stringify(result),/opaque-native|Users|example|SECOND_LINE/);
 }
});

function rpcChild(){const ch=new EventEmitter();ch.stdout=new PassThrough();ch.stderr=new PassThrough();ch.stdin=new PassThrough();return ch;}
test('split stderr is redacted as one line and transport/RPC failures preserve their safe evidence',async()=>{
 const child=rpcChild();const client=JsonlRpcClient.start({command:process.execPath,env,captureErrorFirstLine:true,spawnProcess:()=>child});
 const waiting=client.call('initialize');
 child.stderr.write(raw.slice(0,35));child.stderr.write(raw.slice(35));child.emit('close',1);
 await assert.rejects(waiting,error=>error instanceof ExternalJsonlRpcTransportError&&error.errorFirstLine.startsWith('Error: invalid transport')&&!JSON.stringify(error).includes(secret));
 const rpc=rpcChild();const another=JsonlRpcClient.start({command:process.execPath,env,captureErrorFirstLine:true,spawnProcess:()=>rpc});
 const response=another.call('thread/start');rpc.stdout.write(JSON.stringify({id:1,error:{code:-32602,message:raw,data:{prompt:'PRIVATE_DATA'}}})+'\n');
 await assert.rejects(response,error=>error instanceof ExternalJsonlRpcRequestError&&error.code===-32602&&error.errorFirstLine.startsWith('Error: invalid transport')&&!JSON.stringify(error).includes('PRIVATE_DATA'));
 another.close();rpc.emit('close',0);
});

test('closed diagnostic and route cooldown retain only the safe line; success clears it',()=>{
 const context={runtime:'codex',version:'0.163.0',loginSource:'host',homeMatchesAccount:true};
 const line=runtimeErrorFirstLine(raw,env);const dto=body(runtimeFailureMessage({...context,kind:'runtime_failed',elapsedMs:2,errorFirstLine:line}));
 assert.equal(dto.errorFirstLine,line);assert.doesNotMatch(JSON.stringify(dto),/opaque-native|Users|example|SECOND_LINE/);
 const installer={failureContext:()=>context};const tracker=runtimeFailureTracker(installer,'codex','agent','route',{env,loginSource:'host'});
 assert.equal(body(tracker.failed('runtime_failed',3,line)).errorFirstLine,line);
 assert.equal(body(tracker.blocked()).errorFirstLine,line);tracker.succeeded();assert.equal(tracker.blocked(),null);
 assert.equal(body(tracker.failed('runtime_failed',3)).errorFirstLine,undefined);
});

test('native startup stderr reaches the real Hara recovery diagnostic without a model retry',async t=>{
 const f=await cliMcpFixture(t,'list');f.mode({mode:'list',startupStderr:'Error: invalid transport /Users/private/config.toml\nPRIVATE_SECOND_LINE'});
 await f.send('Say ready without tools.');const view=await until(f.read,v=>v.conversation.state==='blocked');
 const text=JSON.stringify(view.conversation);
 assert.match(text,/errorFirstLine/);assert.match(text,/Error: invalid transport \[path\]/);
 assert.doesNotMatch(text,/Users\/private|PRIVATE_SECOND_LINE/);
});
