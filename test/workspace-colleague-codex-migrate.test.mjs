import test from "node:test";
import {codexCwdCase} from "./helpers/colleague-codex-cwd.mjs";
test("Codex existing dialogue retains legacy cwd until a committed explicit reset",t=>codexCwdCase(t,true));
