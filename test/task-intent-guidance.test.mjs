import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSystem, runAgent } from "../dist/agent/loop.js";
import { createTaskExecution, newTurnInteraction } from "../dist/session/task.js";

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const fixtureHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-intent-guidance-")));
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(fixtureHome, { recursive: true, force: true });
});

test("first intake guidance distinguishes the authorized outcome from a read-only first stage", () => {
  const system = composeSystem(fixtureHome, undefined, undefined, undefined, false, undefined, { enabled: true });
  const context = system.parts.find((part) => part.id === "task-intake").content;
  assert.match(context, /intent from the user-authorized end result, not your current stage or first tool/);
  assert.match(context, /Use `change` for an authorized fix[\s\S]*read-only inspection/);
  assert.match(context, /Use `answer` for explanation[\s\S]*`investigate` for diagnosis\/review without modification/);
  assert.match(context, /Do not infer permission to change[\s\S]*keep read-only requests read-only/);
});

test("the model-visible intent schema keeps all authority choices explicit and forbids tool-driven promotion", async () => {
  const task = createTaskExecution("Explain the synthetic parser without changing it", newTurnInteraction().turnId);
  let intentSchema;
  const outcome = await runAgent([{ role: "user", content: task.objective }], {
    provider: {
      id: "intent-guidance-fixture", model: "intent-guidance-fixture",
      async turn({ tools }) {
        intentSchema = tools.find((tool) => tool.name === "task_intake").input_schema.properties.intent;
        return { text: "The synthetic context is explained.", toolUses: [], stop: "end" };
      },
    },
    ctx: { cwd: fixtureHome }, approval: "full-auto", approvalChannel: false,
    confirm: async () => false, quiet: true, hooks: false, taskIntake: { task },
  });
  assert.equal(outcome.status, "completed");
  assert.deepEqual(intentSchema.enum, ["answer", "investigate", "change"]);
  assert.match(intentSchema.description, /user-authorized outcome, not the first stage/);
  assert.match(intentSchema.description, /investigate = inspect\/diagnose\/review without modification/);
  assert.match(intentSchema.description, /change = authorized[\s\S]*inspection comes first/);
  assert.match(intentSchema.description, /Never infer change authority from a desired tool call/);
});
