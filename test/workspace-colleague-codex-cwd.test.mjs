import test from "node:test";
import {codexCwdCase} from "./helpers/colleague-codex-cwd.mjs";
test("fresh Codex colleague keeps its own cwd and resident process across the next message",t=>codexCwdCase(t,false));
