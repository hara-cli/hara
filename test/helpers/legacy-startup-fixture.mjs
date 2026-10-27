// Shared fixture for the legacy-startup suites. The scenarios are split across files so each file keeps
// the original 120s per-file deadline on slow-fsync Intel runners instead of sharing one budget across
// every heavy host-boot scenario.
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { LocalWorkspaceHost } from "../../dist/workspace/local-host.js";
import { MemoryCredentialVault } from "../../dist/workspace/credential-vault.js";
import { SYNTHETIC_CONNECTION, createWorkspaceSyntheticProvider } from "../../dist/workspace/synthetic-provider.js";
export const hash=v=>createHash("sha256").update(v).digest("hex");
export function fixture(t,{roles=2,jobs=3,vault=new MemoryCredentialVault(),businessFactory}={}){
  const base=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hara-auto-legacy-")));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=join(base,"target"),sourceHome=join(base,"source");for(const path of[root,sourceHome])fs.mkdirSync(path,{mode:0o700});
  const write=(rel,content)=>{const path=join(sourceHome,rel);fs.mkdirSync(join(path,".."),{recursive:true,mode:0o700});fs.writeFileSync(path,content,{mode:0o600});return path;};
  write(".hara/config.json",JSON.stringify(SYNTHETIC_CONNECTION));
  for(let i=0;i<roles;i++)write(`.hara/roles/legacy${String(i).padStart(2,"0")}.md`,`---\nname: legacy${String(i).padStart(2,"0")}\ndisplayName: Legacy ${i}\ndescription: Fixture colleague\n---\nUse source evidence and verify file work.\n`);
  write(".hara/memory/global/MEMORY.md","Use concise Chinese summaries.\n");
  write(".hara/skills/source-evidence/SKILL.md","---\nname: source-evidence\ndescription: Verify source evidence\n---\nRead before acting.\n");
  const tasks=Array.from({length:jobs},(_,i)=>({id:`legacy-${i}`,name:`Legacy task ${i}`,enabled:i%3!==2,mode:i===1?"print":"command",
    cwd:join(sourceHome,"project"),task:i===1?"生成 hello.md 並驗證":"printf authored-fixture-only",createdAt:0,schedule:{kind:"every",everyMs:60000,display:"every minute"}}));
  const jobsFile=write(".hara/cron/jobs.json",JSON.stringify(tasks));
  const options={mode:"workspace",hostHome:root,legacySourceHome:sourceHome,credentialVault:vault,providerFactory:createWorkspaceSyntheticProvider,
    ...(businessFactory?{legacyBusinessFactory:businessFactory}:{})};
  return{base,root,sourceHome,tasks,jobsFile,vault,write,open:()=>new LocalWorkspaceHost(root,options)};
}
export function allText(root){let text="";for(const entry of fs.readdirSync(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())text+=allText(path);else if(entry.isFile())text+=fs.readFileSync(path,"utf8");}return text;}
