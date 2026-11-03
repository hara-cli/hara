import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawn,execFileSync} from "node:child_process";
import {once} from "node:events";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createRuntimeExecutionPolicy} from "../dist/agent-runtime/execution-policy.js";
const live=pid=>{try{return !execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'}).trim().startsWith('Z');}catch{return false;}};
async function fixture(t,lifetime="attempt"){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"owned-tree-"))),home=join(root,"account"),work=join(root,"work");fs.mkdirSync(home);fs.mkdirSync(work);
 const policy=createRuntimeExecutionPolicy({runtimeId:"codex",tier:"full-protected",accountHome:home,workRoot:work,lifetime});policy.beginAttempt("one");
 t.after(async()=>{await policy.close();fs.rmSync(root,{recursive:true,force:true});});return{root,home,work,policy};
}
function start(f,code){const launch=f.policy.wrap({command:process.execPath,args:['-e',code],env:{...process.env,HOME:f.home}}),child=spawn(launch.command,launch.args,{env:launch.env,detached:true,stdio:['pipe','pipe','pipe']});const exited=new Promise(resolve=>child.once("exit",resolve));launch.onProcess(child,true);let buffer='',messages=[],waiters=[];child.stdout.on('data',chunk=>{buffer+=chunk;for(let n;(n=buffer.indexOf('\n'))>=0;){const value=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);const waiter=waiters.shift();if(waiter)waiter(value);else messages.push(value);}});return{child,launch,exited,next:()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('bounded owned-process response')),15000);waiters.push(v=>{clearTimeout(timer);resolve(v);});})};}
const background=`const{spawn}=require('child_process');const tool=spawn('/bin/sh',['-c',"trap '' TERM; /bin/sleep 300 & echo $!; wait"],{detached:true,stdio:['ignore','pipe','ignore']});tool.stdout.once('data',chunk=>{console.log(JSON.stringify({root:process.pid,tool:tool.pid,background:Number(chunk.toString().trim())}));tool.stdout.destroy();});`;
test("resident drain kills the attempt's background tree, retains the app-server root and leaves an unrelated sibling alone",{skip:process.platform!=="darwin"},async t=>{
 const f=await fixture(t,"resident"),sibling=spawn('/bin/sleep',['300'],{detached:true,stdio:'ignore'});t.after(async()=>{sibling.kill('SIGKILL');if(sibling.exitCode===null&&sibling.signalCode===null)await once(sibling,'close');});
 const p=start(f,background+`require('readline').createInterface({input:process.stdin}).on('line',line=>{if(line==='ping')console.log(JSON.stringify({pong:process.pid}));});`),ids=await p.next();assert.equal(live(ids.background),true);assert.equal(live(sibling.pid),true);
 const drained=await f.policy.drainAttempt({keepResidentRoot:true});assert.equal(drained.remaining,0);assert.equal(drained.rootRetained,true);assert.equal(live(ids.tool),false);assert.equal(live(ids.background),false);assert.equal(live(p.child.pid),true);assert.equal(live(sibling.pid),true);
 f.policy.beginAttempt("two");await f.policy.prepareAttempt();p.child.stdin.write('ping\n');assert.equal((await p.next()).pong,ids.root);await f.policy.drainAttempt({keepResidentRoot:true});assert.equal(live(ids.root),true);
 await f.policy.close();assert.equal(live(ids.root),false);assert.equal(live(sibling.pid),true);
});
test("single exec drains surviving inherited background processes after root exit",{skip:process.platform!=="darwin"},async t=>{
 const f=await fixture(t),p=start(f,`const{spawn}=require('child_process');const bg=spawn('/bin/sleep',['300'],{stdio:'ignore'});console.log(JSON.stringify({root:process.pid,background:bg.pid}));process.exit(0);`),ids=await p.next();await p.exited;await p.launch.drainProcess();assert.equal(live(ids.background),false);assert.equal(live(ids.root),false);
});
test("a missing process-ownership hook never releases the stopped runtime startup barrier",{skip:process.platform!=="darwin"},async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'unarmed-tree-'))),home=join(root,'account'),work=join(root,'work');fs.mkdirSync(home);fs.mkdirSync(work);
 const policy=createRuntimeExecutionPolicy({runtimeId:'codex',tier:'full-protected',accountHome:home,workRoot:work}),marker=join(work,'must-not-execute');
 const launch=policy.wrap({command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],env:{...process.env,HOME:home}}),child=spawn(launch.command,launch.args,{env:launch.env,detached:true,stdio:'ignore'});
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(fs.existsSync(marker),false);child.kill('SIGKILL');await once(child,'close');await assert.rejects(policy.close(),/ownership hook/);
 fs.rmSync(policy.tempRoot,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});
});
