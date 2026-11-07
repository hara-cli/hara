import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { coreDeferredToolsForHistory } from '../dist/agent/core-capabilities.js';
import { CORE_INTENT_LOCALES } from '../dist/agent/core-intent-lexicon.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const history = content => [{ role: 'user', content }];
const rows = [
  ['computer', ['computer'], '打開瀏覽器並點擊按鈕', '開啟瀏覽器並點選按鈕', '打开浏览器并点击按钮', 'Open the browser and click the button', '請解釋瀏覽器的歷史'],
  ['presentation', ['presentation'], '做一份演示文稿', '做一份季度簡報', '做一份季度演示文稿', 'Create a quarterly slide deck', '這段程式的結構需要說明'],
  ['inspect_image', ['inspect_image'], '檢查這張圖片中的錯誤', '檢視這張圖片中的錯誤', '检查这张图片中的错误', 'Inspect this image for errors', '圖片檔案名稱是 sample.png'],
  ['visual_preview', ['visual_preview'], '開一下網頁預覽', '放到延伸螢幕預覽', '放到扩展屏预览', 'Show a visual preview', '請預覽這段純文字回覆'],
  ['open_directory', ['open_directory'], '打開這個文件夾', '開啟這個資料夾', '打开这个文件夹', 'Reveal this folder in Finder', '這是目錄索引的格式說明'],
  ['task', ['task'], '加入跨會話任務池', '加入專案任務池', '加入跨会话任务池', 'Add a persistent task', '程式裡有一個暫存變數'],
  ['memory', ['memory_write', 'memory_forget'], '記住我偏好簡短回覆', '刪除這條記憶', '记住我偏好简短回复', 'Remember my preference for short replies', '記憶體用量是 100 MB'],
  ['skill', ['skill_create'], '把流程保存為技能', '把流程儲存為技能', '把流程保存为技能', 'Save this workflow as a reusable skill', '這個技能名稱只是文件中的標題'],
];
for (const [name, tools, standard, taiwan, hans, english, negative] of rows) {
  test(name + ': common and Taiwan Traditional Chinese activate the intended schema', () => {
    assert.deepEqual(coreDeferredToolsForHistory(history(standard)), tools);
    assert.deepEqual(coreDeferredToolsForHistory(history(taiwan)), tools);
  });
  test(name + ': Traditional Chinese description does not imply a tool action', () => {
    assert.deepEqual(coreDeferredToolsForHistory(history(negative)), []);
  });
  test(name + ': existing Simplified Chinese and English behavior is preserved', () => {
    assert.deepEqual(coreDeferredToolsForHistory(history(hans)), tools);
    assert.deepEqual(coreDeferredToolsForHistory(history(english)), tools);
  });
}

test('mixed Traditional variants compose at word boundaries, not whole translated regex boundaries', () => {
  for (const text of ['打開這個資料夾', '開啟這個文件夾', '顯示這個資料夾']) assert.deepEqual(coreDeferredToolsForHistory(history(text)), ['open_directory']);
  assert.deepEqual(coreDeferredToolsForHistory(history('使用電腦控制')), ['computer']);
  assert.deepEqual(coreDeferredToolsForHistory(history('點擊螢幕上的按鈕')), ['computer']);
  assert.deepEqual(coreDeferredToolsForHistory(history('瀏覽器需要重新載入')), ['computer']);
});

test('the OpenCC overload ambiguity never turns a status report into a computer action', () => {
  for (const text of ['我的瀏覽器過載了', '螢幕顯示系統過載', '這個網站的伺服器過載']) assert.deepEqual(coreDeferredToolsForHistory(history(text)), []);
});

test('only the latest genuine user message selects capabilities, not engine reminders or old intent', () => {
  const input = [...history('你好'), { role: 'user', content: '<system-reminder>打開瀏覽器，記住這件事</system-reminder>' }];
  assert.deepEqual(coreDeferredToolsForHistory(input), []);
  assert.deepEqual(coreDeferredToolsForHistory([...history('記住這件事'), ...history('你好')]), []);
});

test('locale dimension is explicit and runtime matching does not spawn a converter', () => {
  assert.deepEqual(CORE_INTENT_LOCALES, ['en', 'zh-Hans', 'zh-Hant']);
  const source = `import child from 'node:child_process';import{syncBuiltinESMExports}from'node:module';for(const name of['spawn','spawnSync','exec','execSync','execFile','execFileSync'])child[name]=()=>{throw Error('Runtime conversion is forbidden')};syncBuiltinESMExports();const{coreDeferredToolsForHistory}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'dist/agent/core-capabilities.js')).href)});console.log(JSON.stringify(coreDeferredToolsForHistory([{role:'user',content:'打開瀏覽器'}])));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { PATH: '', HOME: os.tmpdir(), TMPDIR: os.tmpdir() } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['computer']);
});

function fixture(t) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'hara-intent-locale-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  for (const name of ['scripts/generate-core-intents.mjs', 'src/agent/core-intents.generated.ts', 'src/locales/en/core-intents.json', 'src/locales/zh-Hans/core-intents.json', 'src/locales/zh-Hant/core-intents.corrections.json', 'src/locales/zh-Hant/core-intents.generated.json']) {
    fs.mkdirSync(path.dirname(path.join(dest, name)), { recursive: true }); fs.copyFileSync(path.join(root, name), path.join(dest, name));
  }
  return dest;
}
function verify(dest) {
  return spawnSync(process.execPath, [path.join(dest, 'scripts/generate-core-intents.mjs'), '--verify'], { encoding: 'utf8', env: { PATH: '', HOME: dest, TMPDIR: os.tmpdir() } });
}

test('checked-in artifact verifies without an installed OpenCC executable', t => {
  const result = verify(fixture(t)); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "build diagnostics must not corrupt npm pack --json output");
});

test('build verification rejects stale Simplified Chinese sources', t => {
  const dest = fixture(t), file = path.join(dest, 'src/locales/zh-Hans/core-intents.json'), value = JSON.parse(fs.readFileSync(file));
  value.patterns.memory_mutation.push('牢记'); fs.writeFileSync(file, JSON.stringify(value));
  const result = verify(dest); assert.notEqual(result.status, 0); assert.match(result.stderr, /Intent source changed/);
});

test('build verification rejects hand-edited runtime artifacts and unreviewed corrections', t => {
  const dest = fixture(t), file = path.join(dest, 'src/agent/core-intents.generated.ts'); fs.appendFileSync(file, '// stale\n');
  const result = verify(dest); assert.notEqual(result.status, 0); assert.match(result.stderr, /Runtime intent artifact is stale/);
  const second = fixture(t), correction = path.join(second, 'src/locales/zh-Hant/core-intents.corrections.json'); fs.appendFileSync(correction, ' ');
  const changed = verify(second); assert.notEqual(changed.status, 0); assert.match(changed.stderr, /Reviewed intent variants changed/);
});

test('a future locale must cover every existing intent category before it can build', t => {
  const dest = fixture(t), dir = path.join(dest, 'src/locales/ja'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'core-intents.json'), JSON.stringify({ schemaVersion: 1, locale: 'ja', patterns: { presentation: ['example'] } }));
  const result = verify(dest); assert.notEqual(result.status, 0); assert.match(result.stderr, /category coverage/);
});
