import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  BracketedPasteDecoder,
  BracketedPasteInput,
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  enableBracketedPaste,
} from "../dist/tui/bracketed-paste.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("BracketedPasteDecoder joins split framing and emits the paste exactly once", () => {
  const decoder = new BracketedPasteDecoder();
  const output = [];
  output.push(...decoder.feed(`before${BRACKETED_PASTE_START.slice(0, 4)}`));
  output.push(...decoder.feed(`${BRACKETED_PASTE_START.slice(4)}first line\n`));
  output.push(...decoder.feed(`second line${BRACKETED_PASTE_END.slice(0, 3)}`));
  output.push(...decoder.feed(`${BRACKETED_PASTE_END.slice(3)}after`));
  assert.deepEqual(output, ["before", "first line\nsecond line", "after"]);
});

test("BracketedPasteDecoder recovers an incomplete paste without swallowing future input", () => {
  const decoder = new BracketedPasteDecoder();
  assert.deepEqual(decoder.feed(`${BRACKETED_PASTE_START}unfinished\ntext`), []);
  assert.equal(decoder.hasIncompletePaste, true);
  assert.deepEqual(decoder.flushIncomplete(), ["unfinished\ntext"]);
  assert.deepEqual(decoder.feed("next"), ["next"]);
});

test("BracketedPasteDecoder rejects an oversized paste instead of retaining or truncating it", () => {
  const decoder = new BracketedPasteDecoder(8);
  const output = decoder.feed(`${BRACKETED_PASTE_START}123456789${BRACKETED_PASTE_END}`);
  assert.deepEqual(output, ["[Paste rejected: input exceeds 8 characters]"]);
  assert.equal(decoder.hasIncompletePaste, false);
});

test("BracketedPasteInput keeps paste and trailing Enter as separate readable events", async () => {
  const source = new PassThrough();
  source.isTTY = true;
  source.setRawMode = () => source;
  source.ref = () => source;
  source.unref = () => source;
  const input = new BracketedPasteInput(source, { incompleteTimeoutMs: 50 });
  input.setEncoding("utf8");
  const chunks = [];
  input.on("data", (chunk) => chunks.push(chunk));

  source.write(`${BRACKETED_PASTE_START}alpha\nbeta${BRACKETED_PASTE_END}\r`);
  await tick();
  await tick();
  assert.deepEqual(chunks, ["alpha\nbeta", "\r"]);
  input.dispose();
});

test("BracketedPasteInput resumes stdin paused by readline before Ink mounts", async () => {
  const source = new PassThrough();
  source.isTTY = true;
  source.setRawMode = () => source;
  source.ref = () => source;
  source.unref = () => source;
  source.pause();

  const input = new BracketedPasteInput(source);
  input.setEncoding("utf8");
  const chunks = [];
  input.on("readable", () => {
    let chunk;
    while ((chunk = input.read()) !== null) chunks.push(chunk);
  });
  input.setRawMode(true);

  source.write("ordinary keyboard input");
  await tick();
  assert.deepEqual(chunks, ["ordinary keyboard input"]);
  assert.equal(source.isPaused(), false, "Ink raw mode resumes the wrapped terminal");

  input.setRawMode(false);
  assert.equal(source.isPaused(), true, "Ink cleanup pauses the wrapped terminal again");
  input.dispose();
});

test("BracketedPasteInput timeout releases content when the terminal omits paste-end", async () => {
  const source = new PassThrough();
  source.isTTY = true;
  source.setRawMode = () => source;
  source.ref = () => source;
  source.unref = () => source;
  const input = new BracketedPasteInput(source, { incompleteTimeoutMs: 10 });
  input.setEncoding("utf8");
  const chunks = [];
  input.on("data", (chunk) => chunks.push(chunk));
  source.write(`${BRACKETED_PASTE_START}recover me`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(chunks, ["recover me"]);
  input.dispose();
});

test("enableBracketedPaste brackets a TTY lifecycle and cleans up once", () => {
  const writes = [];
  const disable = enableBracketedPaste({ isTTY: true, write: (value) => writes.push(value) });
  disable();
  disable();
  assert.deepEqual(writes, [ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE]);

  const nonTtyWrites = [];
  enableBracketedPaste({ isTTY: false, write: (value) => nonTtyWrites.push(value) })();
  assert.deepEqual(nonTtyWrites, []);
});
