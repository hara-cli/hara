import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {LOCALE_REGISTRY,LOCALE_REGISTRY_SHA256} from '../dist/i18n/registry.generated.js';
import {parseClientLocale,localeDescriptor,currentClientLocale,withClientLocale,resolveLocale} from '../dist/i18n/locale.js';
import {replyCopyLanguage,requestedReplyCopyLanguage} from '../dist/i18n/reply-language.js';
import {coreText} from '../dist/i18n/messages.js';
import {PUBLIC_ERROR_CODES,publicErrorData} from '../dist/i18n/errors.js';
import {RuntimeTierUnavailableError,NativeEngineUnsupportedError} from '../dist/agent-runtime/execution-policy.js';
import {compileMessage} from '../scripts/icu-message.mjs';
const root=new URL('../',import.meta.url),json=name=>JSON.parse(fs.readFileSync(new URL(name,root),'utf8'));
test('registry matches BCP47 language/script, stable selection and same-script fallback',()=>{
 assert.deepEqual(LOCALE_REGISTRY.languages.filter(r=>r.status==='stable').map(r=>r.tag),['en','zh-Hans']);
 for(const [tag,want]of [['zh_CN','zh-Hans'],['zh-SG','zh-Hans'],['zh-TW','zh-Hant'],['zh-Hant-HK','zh-Hant'],['zh-HK','zh-HK'],['ja-JP','ja'],['ko-KR','ko'],['en-GB','en'],['bad!!','en']])assert.equal(resolveLocale(tag),want,tag);
 assert.deepEqual(localeDescriptor('zh-HK').fallback,['zh-Hant','en']);assert.deepEqual(localeDescriptor('zh-Hant').fallback,['en']);
 for(const bad of ['zh-Hans',{tag:'zh-Hans',fallback:['zh-Hant','en']},{tag:'zh-Hans',fallback:['en'],extra:1},{tag:'xx',fallback:[]},{tag:'en',fallback:['en']}])assert.throws(()=>parseClientLocale(bad),/invalid client locale/);
 assert.equal(createHash('sha256').update(fs.readFileSync(new URL('src/i18n/registry.json',root),'utf8').replace(/\r\n/g,'\n')).digest('hex'),LOCALE_REGISTRY_SHA256);
});
test('two overlapping client locales remain isolated after asynchronous boundaries',async()=>{
 await Promise.all(['en','zh-Hans'].map(tag=>withClientLocale(localeDescriptor(tag),async()=>{await new Promise(r=>setImmediate(r));assert.equal(currentClientLocale().tag,tag);assert.equal(coreText('core.name.workspace'),tag==='en'?'My workspace':'我的工作空间');})));
});
test('reply script detection handles kana, Hangul, exclusive Han, mixed/short/code/path input',()=>{
 for(const [text,fallback,want]of [['日本語で説明してください','zh-Hans','ja'],['한글로 설명해주세요','zh-Hans','ko'],['请打开这个项目的文件','en','zh-Hans'],['請打開這個專案的檔案','en','zh-Hant'],['Please explain the result','zh-Hans','en'],['你好','zh-Hant','zh-Hant'],['👍','zh-Hans','zh-Hans'],['/Users/檔案/專案.ts','en','en'],['C:\\資料夾\\檔案.ts','en','en'],['```js\nconst 中文 = "檔案";\n```','en','en'],['后後','zh-Hant','zh-Hant']])assert.equal(replyCopyLanguage(text,fallback),want,text);
});
test('invalid legacy language overrides retain automatic script matching',()=>{assert.equal(requestedReplyCopyLanguage('请打开这个项目',{HARA_REPLY_LANGUAGE:'not_a_language'}),'zh-Hans');});
test('stable Core ICU resources cover identical keys/parameters and never cross Hant to Hans',()=>{
 const en={...json('src/i18n/en/core.json'),...json('src/i18n/en/errors.json')},zh={...json('src/i18n/zh-Hans/core.json'),...json('src/i18n/zh-Hans/errors.json')};
 assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort());
 for(const key of Object.keys(en))assert.deepEqual(compileMessage(en[key]).params,compileMessage(zh[key]).params,key);
 assert.equal(coreText('core.created.colleague_named','en',{name:'<Alpha>'}),'Created colleague <Alpha>.');
 assert.equal(coreText('core.created.colleague_named','zh-Hans',{name:'甲'}),'已建立同事 甲。');
 assert.equal(coreText('core.name.workspace','zh-Hant'),'My workspace');
 assert.throws(()=>coreText('core.created.group','en',{name:'A',credential:'secret'}),/parameters/);
 assert.throws(()=>coreText('core.created.group','en',{}),/parameters/);
});
test('ICU compiler handles nested plural/select, quoting and rejects malformed messages',()=>{
 const ast=compileMessage("{n, plural, =0 {None} one {# item} other {{kind, select, file {# files} other {# items}}}} and '{literal}'");assert.deepEqual(ast.params,['kind','n']);
 for(const bad of ['{n','{n, plural, one {one}}','{n, unknown}','{x, select, other {a} other {b}}'])assert.throws(()=>compileMessage(bad));
 assert.deepEqual(compileMessage("The task's result: {name}").params,['name']);
});
test('102 public codes have en/Hans keys; unknown and secret-bearing errors remain generic and redacted',()=>{
 assert.equal(PUBLIC_ERROR_CODES.length,102);assert.equal(new Set(PUBLIC_ERROR_CODES).size,102);
 const catalog=json('src/i18n/errors.json'),en=json('src/i18n/en/errors.json'),zh=json('src/i18n/zh-Hans/errors.json');
 for(const row of catalog.errors){assert.equal(row.key,'core.error.'+row.code);assert.equal(typeof en[row.key],'string');assert.equal(typeof zh[row.key],'string');for(const source of row.sourceMessages)assert.equal(publicErrorData(new Error(source)).code,row.code);}
 const safe=publicErrorData(new Error('at /fixture/root api_key=sk-secret-token-value'),['/fixture/root','sk-secret-token-value']);assert.equal(safe.code,'request_failed');assert.deepEqual(safe.params,{});assert(!safe.technicalDetail.includes('/fixture/root'));assert(!safe.technicalDetail.includes('sk-secret-token-value'));
});
test('decision B platform refusals render through their closed public codes in en and zh-Hans',()=>{
 const en=json('src/i18n/en/errors.json'),zh=json('src/i18n/zh-Hans/errors.json');
 for(const error of [new RuntimeTierUnavailableError(),new NativeEngineUnsupportedError()]){
  const data=publicErrorData(error);assert.equal(data.code,error.code);assert.deepEqual(data.params,{});
  assert.equal(typeof en['core.error.'+error.code],'string');assert.equal(typeof zh['core.error.'+error.code],'string');
  assert.doesNotMatch(zh['core.error.'+error.code].replace(/macOS|Pi/gu,''),/[A-Za-z]{4,}/u,'Simplified Chinese copy has no English leftovers');
 }
});
test('generated registry/messages and existing Hant intent artifacts verify with CRLF checkouts',t=>{
 const temp=fs.mkdtempSync(join(tmpdir(),'hara-i18n-crlf-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 fs.cpSync(new URL('src/i18n',root),join(temp,'src/i18n'),{recursive:true});fs.mkdirSync(join(temp,'scripts'));
 for(const name of ['generate-i18n.mjs','icu-message.mjs'])fs.copyFileSync(new URL('scripts/'+name,root),join(temp,'scripts',name));
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(json|ts|mjs)$/.test(file))fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/\r?\n/g,'\r\n'));}};walk(temp);
 const result=spawnSync(process.execPath,[join(temp,'scripts/generate-i18n.mjs'),'--check'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const intents=spawnSync(process.execPath,['scripts/generate-core-intents.mjs','--verify'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.equal(intents.status,0,intents.stderr);
});
