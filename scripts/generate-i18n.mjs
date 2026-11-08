import { compileMessage } from "./icu-message.mjs";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const file = root + "src/i18n/registry.json";
const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const value = JSON.parse(text);
if (value.schemaVersion !== 1 || !Array.isArray(value.languages)) throw Error("Invalid locale registry");
const tags = value.languages.map(row => row.tag);
if (new Set(tags).size !== tags.length || !tags.includes("en")) throw Error("Duplicate/missing locale");
for (const row of value.languages) {
 if (new Intl.Locale(row.tag).toString() !== row.tag || !["stable", "beta", "hidden"].includes(row.status)
   || !["ltr", "rtl"].includes(row.dir) || !row.font || !row.nativeName || !row.match
   || !Array.isArray(row.fallback) || new Set(row.fallback).size !== row.fallback.length
   || row.fallback.some(tag => !tags.includes(tag) || tag === row.tag)
   || row.tag !== "en" && row.fallback.at(-1) !== "en") throw Error("Invalid locale entry: " + row.tag);
 for (const tag of row.fallback) if (value.languages.find(item => item.tag === tag).fallback.includes(row.tag)) throw Error("Cyclic locale fallback");
}
if (value.languages.filter(row => row.status === "stable").map(row => row.tag).join(",") !== "en,zh-Hans") throw Error("This release enables en and zh-Hans only");
const hash = createHash("sha256").update(text).digest("hex");
const output = "// Generated from registry.json; run scripts/generate-i18n.mjs --write.\nexport const LOCALE_REGISTRY = " + JSON.stringify(value,null,2) + " as const;\nexport type Locale = typeof LOCALE_REGISTRY.languages[number][\"tag\"];\nexport const LOCALE_REGISTRY_SHA256 = " + JSON.stringify(hash) + ";\n";
const dest = root + "src/i18n/registry.generated.ts";
if (process.argv[2] === "--write") fs.writeFileSync(dest, output);
else if (fs.readFileSync(dest,"utf8").replace(/\r\n/g,"\n") !== output) throw Error("Stale locale registry projection");

const bundles = {}, parameters = {};
for (const row of value.languages) {
 const dir = root + "src/i18n/" + row.tag;
 if (!fs.existsSync(dir)) continue;
 bundles[row.tag] = {};
 for (const name of ["core.json", "errors.json"]) {
  const file = dir + "/" + name;
  if (!fs.existsSync(file)) continue;
  for (const [key, text] of Object.entries(JSON.parse(fs.readFileSync(file,"utf8")))) {
   if (!/^core\.[A-Za-z0-9_.]+$/.test(key) || Object.hasOwn(bundles[row.tag],key)) throw Error("Invalid/duplicate i18n key");
   const compiled = compileMessage(text);
   bundles[row.tag][key] = compiled.ast;
   if(row.tag === "en") parameters[key] = compiled.params;
   else if (JSON.stringify(parameters[key]) !== JSON.stringify(compiled.params)) throw Error("Locale parameters differ: " + key);
  }
 }
 if (row.status === "stable" && row.tag !== "en" && JSON.stringify(Object.keys(bundles.en).sort()) !== JSON.stringify(Object.keys(bundles[row.tag]).sort())) throw Error("Incomplete stable locale: " + row.tag);
}
const errors = JSON.parse(fs.readFileSync(root + "src/i18n/errors.json", "utf8"));
if(new Set(errors.errors.map(row => row.code)).size !== errors.errors.length)throw Error("Duplicate public error code");
for(const row of errors.errors) if(!bundles.en[row.key] || JSON.stringify(parameters[row.key]) !== JSON.stringify(row.params))throw Error("Public error mapping differs: "+row.code);
const generated = "// Generated ICU AST and parameter contract; no runtime parser.\nexport const CORE_MESSAGES: Record<string, Record<string, readonly unknown[]>> = " + JSON.stringify(bundles,null,2) + ";\nexport const CORE_MESSAGE_PARAMS = " + JSON.stringify(parameters,null,2) + " as const;\nexport type CoreMessageKey = keyof typeof CORE_MESSAGE_PARAMS;\n";
const target = root + "src/i18n/messages.generated.ts";
if(process.argv[2] === "--write") fs.writeFileSync(target,generated);
else if(fs.readFileSync(target,"utf8").replace(/\r\n/g,"\n") !== generated)throw Error("Stale compiled Core messages");
