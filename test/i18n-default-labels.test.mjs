import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {LocalWorkspaceCatalog} from '../dist/workspace/local-catalog.js';
import {WorkspaceRegistryStore} from '../dist/workspace/store.js';
import {WorkspaceResources} from '../dist/workspace/resources.js';
import {workspaceStateHome} from '../dist/workspace/resource-context.js';
const home=t=>{const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'hara-i18n-labels-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
function oldCatalog(t){const root=home(t),catalog=new LocalWorkspaceCatalog(root);catalog.create('我的空間',catalog.read().revision);catalog.create('Jeff Studio',catalog.read().revision);const file=join(root,'.hara/workspace-local-dev/catalog-v2.json'),value=JSON.parse(fs.readFileSync(file));for(const row of value.workspaces){delete row.labelSource;delete row.labelKey;}const text=JSON.stringify(value)+'\n';fs.writeFileSync(file,text,{mode:0o600});return{root,file,text,value};}
test('default-only migration backs up exact bytes, preserves custom names/authority and rolls back without reapplying',t=>{
 const f=oldCatalog(t),catalog=new LocalWorkspaceCatalog(f.root),value=catalog.read();assert.equal(value.revision,f.value.revision+1);assert.equal(value.workspaces[0].label,'我的空間');assert.equal(value.workspaces[0].labelSource,'default');assert.equal(value.workspaces[1].labelSource,undefined);
 for(let i=0;i<2;i++){const{labelSource,labelKey,...row}=value.workspaces[i];assert.deepEqual(row,f.value.workspaces[i]);}
 const backup=join(f.root,'.hara/workspace-local-dev/default-labels-v1.json');assert.equal(JSON.parse(fs.readFileSync(backup)).beforeText,f.text);assert.equal(fs.statSync(backup).mode&0o777,0o600);
 assert(catalog.migrateDefaultLabels(true));assert.equal(fs.readFileSync(f.file,'utf8'),f.text);assert.equal(new LocalWorkspaceCatalog(f.root).read().workspaces[0].labelSource,undefined);
});
test('renames clear default metadata; rollback refuses newer state without changing bytes',t=>{
 const f=oldCatalog(t),catalog=new LocalWorkspaceCatalog(f.root),s=catalog.read();catalog.rename(s.workspaces[0].scope.workspaceId,'My edited room',s.revision);const bytes=fs.readFileSync(f.file);assert.equal(catalog.read().workspaces[0].labelSource,undefined);assert.throws(()=>catalog.migrateDefaultLabels(true),/rollback refused/);assert.deepEqual(fs.readFileSync(f.file),bytes);
});
test('linked private migration backups are refused without replacing the catalog or target',t=>{
 const f=oldCatalog(t),target=join(f.root,'outside.json');fs.writeFileSync(target,'unique');fs.symlinkSync(target,join(f.root,'.hara/workspace-local-dev/default-labels-v1.json'));assert.throws(()=>new LocalWorkspaceCatalog(f.root));assert.equal(fs.readFileSync(f.file,'utf8'),f.text);assert.equal(fs.readFileSync(target,'utf8'),'unique');
});
test('legacy registry has explicit reversible migration; read-only reads never migrate',t=>{
 const root=home(t),store=new WorkspaceRegistryStore(root),value=store.initialize([],null);delete value.workspaces[0].labelSource;delete value.workspaces[0].labelKey;const file=join(root,'.hara/workspaces.json'),before=JSON.stringify(value)+'\n';fs.writeFileSync(file,before);assert.equal(store.read().workspaces[0].labelSource,undefined);assert.equal(fs.readFileSync(file,'utf8'),before);assert(store.migrateDefaultLabels());assert.equal(store.read().workspaces[0].labelSource,'default');assert(store.migrateDefaultLabels(true));assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('main title metadata migration preserves config hash, agent epoch and user titles',t=>{
 const root=home(t),scope={schemaVersion:1,workspaceId:'ws_'+randomUUID(),authority:{kind:'local',localAuthorityId:randomUUID()}},resources=new WorkspaceResources(root,scope);resources.initialize();const main=resources.agents.initializeMain();
 const file=resources.storage.run(()=>join(workspaceStateHome(),'.hara/workspace-agents.json')),value=JSON.parse(fs.readFileSync(file));delete value.agents[0].titleSource;delete value.agents[0].titleKey;const before=JSON.stringify(value)+'\n';fs.writeFileSync(file,before);assert(resources.agents.migrateDefaultLabels());const after=JSON.parse(fs.readFileSync(file));assert.deepEqual(after.agents[0].configurations,value.agents[0].configurations);assert.equal(after.agents[0].epoch,value.agents[0].epoch);assert.equal(resources.agents.get(main.agentId).titleKey,'core.name.orchestrator');assert(resources.agents.migrateDefaultLabels(true));assert.equal(fs.readFileSync(file,'utf8'),before);
 const edited=resources.agents.updatePersona(main.agentId,{profile:{displayName:'Hara',title:'My custom lead'}},main.configRevision,main.agentEpoch);assert.equal(edited.titleSource,undefined);assert.equal(edited.identity.title,'My custom lead');
});
