import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeExecutionPolicy } from "../dist/agent-runtime/execution-policy.js";
import { runExternalCommandCapture } from "../dist/external-sessions/process.js";

for (const tier of ["full-protected", "controlled"]) test(`Gemini ${tier}: project registry atomic writes and directory lock preserve all neighbouring masks`, { skip: process.platform !== "darwin" }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-gemini-state-"))), home = join(root, "account"), work = join(root, "work"), runtimeHome = join(home, ".gemini");
  fs.mkdirSync(runtimeHome, { recursive: true }); fs.mkdirSync(work); fs.mkdirSync(join(home, ".hara")); fs.mkdirSync(join(home, ".kimi/credentials"), { recursive: true });
  for (const name of ["settings.json", "oauth_creds.json", "google_accounts.json"]) fs.writeFileSync(join(runtimeHome, name), "FAKE_ONLY");
  fs.writeFileSync(join(home, ".kimi/credentials/kimi-code.json"), "FOREIGN_FAKE");
  fs.mkdirSync(join(work, ".gemini")); fs.writeFileSync(join(work, ".gemini/settings.json"), "HOST_OVERLAY"); fs.writeFileSync(join(work, ".gemini/.hara-settings.lock"), "");
  let policy; t.after(async () => { try { await policy?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  policy = createRuntimeExecutionPolicy({ runtimeId: "gemini", tier, accountHome: home, workRoot: work, runtimeHome });
  const paths = { home, work, runtimeHome }, script = `const fs=require('node:fs'),p=${JSON.stringify(paths)},o={};
const atomic=p.runtimeHome+'/projects.json.12345678-1234-4123-8123-123456789abc.tmp';
for(const[k,fn]of Object.entries({
 projectSettings:()=>fs.writeFileSync(p.work+'/.gemini/settings.json','no'),
 projectUnlink:()=>fs.unlinkSync(p.work+'/.gemini/settings.json'),
 projectRename:()=>fs.renameSync(p.work+'/.gemini',p.work+'/.gemini-old'),
 projectLock:()=>fs.unlinkSync(p.work+'/.gemini/.hara-settings.lock'),
 registry:()=>fs.writeFileSync(p.runtimeHome+'/projects.json','{}'),
 atomic:()=>fs.writeFileSync(atomic,'{}'),
 rename:()=>fs.renameSync(atomic,p.runtimeHome+'/projects.json'),
 lock:()=>fs.mkdirSync(p.runtimeHome+'/projects.json.lock'),
 lockTime:()=>fs.utimesSync(p.runtimeHome+'/projects.json.lock',new Date(),new Date()),
 lockChild:()=>fs.writeFileSync(p.runtimeHome+'/projects.json.lock/child','no'),
 lockFile:()=>{fs.rmdirSync(p.runtimeHome+'/projects.json.lock');fs.writeFileSync(p.runtimeHome+'/projects.json.lock','no')},
 installation:()=>fs.writeFileSync(p.runtimeHome+'/installation_id','fixture-id'),
 arbitraryTemp:()=>fs.writeFileSync(p.runtimeHome+'/projects.json.untrusted.tmp','no'),
 otherRegistry:()=>fs.writeFileSync(p.runtimeHome+'/private-projects.json','no'),
 cache:()=>fs.writeFileSync(p.runtimeHome+'/models_cache.json','no'),
 settings:()=>fs.writeFileSync(p.runtimeHome+'/settings.json','no'),
 ownLoginRead:()=>fs.readFileSync(p.runtimeHome+'/oauth_creds.json'),
 ownLoginWrite:()=>fs.writeFileSync(p.runtimeHome+'/oauth_creds.json','no'),
 accountWrite:()=>fs.writeFileSync(p.runtimeHome+'/google_accounts.json','no'),
 foreignRead:()=>fs.readFileSync(p.home+'/.kimi/credentials/kimi-code.json'),
 haraWrite:()=>fs.writeFileSync(p.home+'/.hara/state.json','no'),
 workWrite:()=>fs.writeFileSync(p.work+'/native.txt','ok'),
 hardlink:()=>fs.linkSync(p.runtimeHome+'/oauth_creds.json',p.work+'/alias')
})){try{fn();o[k]=true}catch{o[k]=false}}console.log(JSON.stringify(o));`;
  const launch = policy.wrap({ command: process.execPath, args: ["-e", script], env: { ...process.env, HOME: home } });
  const out = await runExternalCommandCapture(launch, launch.args, { cwd: work, timeoutMs: 10000, waitForClose: true, retainStdoutOnFailure: true });
  assert.equal(out.ok, true, out.errorCode);
  assert.deepEqual(JSON.parse(out.stdout), { projectSettings: false, projectUnlink: false, projectRename: false, projectLock: false, registry: true, atomic: true, rename: true, lock: true, lockTime: true, lockChild: false, lockFile: false, installation: true, arbitraryTemp: false, otherRegistry: false, cache: false, settings: false, ownLoginRead: true, ownLoginWrite: false, accountWrite: false, foreignRead: false, haraWrite: false, workWrite: tier === "full-protected", hardlink: false });
});
