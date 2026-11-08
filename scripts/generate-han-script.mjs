import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const target=fileURLToPath(new URL('../src/i18n/han-script.generated.json',import.meta.url));
const mode=process.argv[2];if(!['--check','--generate'].includes(mode))throw Error('Use --check or --generate (requires pinned OpenCC 1.3.1)');
const executable=fs.realpathSync(process.env.OPENCC_BIN??'/opt/homebrew/bin/opencc');
if(!/Version:\s*1\.3\.1(?:\s|$)/u.test(execFileSync(executable,['--version'],{encoding:'utf8'})))throw Error('OpenCC 1.3.1 required');
const data=path.resolve(executable,'../../share/opencc'),dict=path.join(path.dirname(executable),'opencc_dict');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'hara-han-script-'));const sets={},hashes={};
try{
 for(const name of ['STCharacters','TSCharacters']){
  const input=path.join(data,name+'.ocd2'),output=path.join(scratch,name+'.txt');
  hashes[name+'.ocd2']=createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  execFileSync(dict,['-i',input,'-o',output,'-f','ocd2','-t','text']);
  sets[name]=new Set(fs.readFileSync(output,'utf8').split(/\r?\n/u).map(line=>line.split('\t')[0]).filter(key=>[...key].length===1));
 }
 const exclusive=(left,right)=>[...left].filter(c=>!right.has(c)).sort((a,b)=>a.codePointAt(0)-b.codePointAt(0)).join('');
 const value={generator:'OpenCC 1.3.1 STCharacters / TSCharacters: one-character keys exclusive to each direction',license:'Apache-2.0 (OpenCC dictionary data)',dictionarySha256:hashes,simplifiedExclusive:exclusive(sets.STCharacters,sets.TSCharacters),traditionalExclusive:exclusive(sets.TSCharacters,sets.STCharacters)};
 if(mode==='--generate')fs.writeFileSync(target,JSON.stringify(value,null,2)+'\n');
 else if(JSON.stringify(JSON.parse(fs.readFileSync(target,'utf8')))!==JSON.stringify(value))throw Error('Stale Han script character statistics');
 console.log('Han script exclusive sets match pinned OpenCC dictionaries');
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
