import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../dist/tools/presentation.js";
import { getTool } from "../dist/tools/registry.js";
import {
  createPresentationArtifact,
  createPresentationPreviewFile,
  exportPresentationArtifact,
  getPresentationArtifact,
  importPresentationArtifact,
  validatePresentationArtifact,
} from "../dist/presentations/runtime.js";

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "hara-presentation-test-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("native Presentation Artifact previews and exports one validated revision", async () => {
  await withTempHome(async (home) => {
    const created = createPresentationArtifact(home, {
      title: "经营复盘",
      project: {
        schemaVersion: "hara.presentation/1",
        title: "经营复盘",
        widthEmu: 12192000,
        heightEmu: 6858000,
        brief: { audience: "Management" },
        slides: [{
          id: "slide-1",
          claim: "产品聚焦改善了交付。",
          takeawayTitle: "聚焦让可靠性提升",
          blocks: [
            { id: "metric-1", type: "metric", literal: { label: "准时交付", value: 92, format: "percent" } },
            { id: "list-1", type: "list", literal: ["缩小批次", "明确责任"] },
          ],
        }],
      },
    });
    assert.equal(created.content.extension, ".hpres");
    assert.equal(created.project.title, "经营复盘");

    const reopened = getPresentationArtifact(home, created.artifact.artifactId);
    assert.equal(reopened.currentRevision.revisionId, created.currentRevision.revisionId);
    const report = validatePresentationArtifact(home, {
      artifactId: created.artifact.artifactId,
      revisionId: created.currentRevision.revisionId,
    });
    assert.equal(report.status, "pass");
    assert.equal(report.validatorId, "hara.office.presentation");

    const preview = createPresentationPreviewFile(home, {
      artifactId: created.artifact.artifactId,
      revisionId: created.currentRevision.revisionId,
    });
    const previewText = await readFile(preview.path, "utf8");
    assert.match(previewText, /Content-Security-Policy/);
    if (process.platform !== "win32") {
      assert.equal((await stat(preview.path)).mode & 0o777, 0o600);
    }

    for (const format of ["json", "html", "pptx"]) {
      const destinationPath = join(home, `经营复盘.${format}`);
      const receipt = await exportPresentationArtifact(home, {
        artifactId: created.artifact.artifactId,
        revisionId: created.currentRevision.revisionId,
        validationReportId: report.reportId,
        destinationPath,
        format,
      });
      assert.equal(receipt.format, format);
      assert.ok(receipt.output.byteSize > 0);
      const bytes = await readFile(destinationPath);
      assert.equal(bytes.byteLength, receipt.output.byteSize);
      if (format === "pptx") assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
      if (format === "html") assert.match(bytes.toString("utf8"), /@media print/);
    }
  });
});

test("controlled Slidev Markdown import becomes canonical Hara Presentation content", async () => {
  await withTempHome(async (home) => {
    const sourcePath = join(home, "review.md");
    await writeFile(sourcePath, `---
title: Release review
---

# Evidence is complete

- Tests passed
- Rollback rehearsed

---

# Ask for focused verification

> Verify the browser preview and editable PPTX.
`);
    const imported = await importPresentationArtifact(home, { sourcePath });
    assert.equal(imported.project.title, "Release review");
    assert.equal(imported.project.slides.length, 2);
    assert.equal(imported.content.extension, ".hpres");
    assert.equal(imported.artifact.origin, "slidev-import");
  });
});

test("Presentation export refuses a report from a different validator", async () => {
  await withTempHome(async (home) => {
    const created = createPresentationArtifact(home, { title: "Validator boundary" });
    const { validateArtifact } = await import("../dist/artifacts/store.js");
    const integrity = validateArtifact(home, {
      artifactId: created.artifact.artifactId,
      revisionId: created.currentRevision.revisionId,
    });
    await assert.rejects(
      exportPresentationArtifact(home, {
        artifactId: created.artifact.artifactId,
        revisionId: created.currentRevision.revisionId,
        validationReportId: integrity.reportId,
        destinationPath: join(home, "should-not-exist.pptx"),
        format: "pptx",
      }),
      /does not authorize this exact revision/,
    );
  });
});

test("agent presentation tool exposes a complete generation schema and creates a Desktop-ready deck", async () => {
  const tool = getTool("presentation");
  assert.ok(tool);
  const projectSchema = tool.input_schema.properties.project;
  assert.deepEqual(projectSchema.required, [
    "schemaVersion",
    "title",
    "widthEmu",
    "heightEmu",
    "brief",
    "slides",
  ]);
  const blockTypes = projectSchema.properties.slides.items.properties.blocks.items.properties.type.enum;
  for (const type of ["text", "list", "metric", "table", "chart", "compare", "timeline", "flow"]) {
    assert.ok(blockTypes.includes(type), `tool schema teaches the model how to generate ${type}`);
  }

  const notices = [];
  const output = await tool.run({
    action: "create",
    project: {
      schemaVersion: "hara.presentation/1",
      title: "Agent launch review",
      widthEmu: 12192000,
      heightEmu: 6858000,
      brief: { audience: "Release owners", purpose: "Make the release decision" },
      slides: [
        {
          id: "slide-01",
          claim: "The release has enough evidence to proceed.",
          takeawayTitle: "Ship from evidence, not optimism",
          blocks: [
            { id: "metric-pass", type: "metric", literal: { label: "Checks passing", value: 100, format: "percent" } },
            { id: "proof-list", type: "list", literal: ["Exact Desktop preview", "Editable PPTX export"] },
          ],
        },
        {
          id: "slide-02",
          claim: "Focused verification closes the final risk.",
          takeawayTitle: "Verify the same presenter in both surfaces",
          blocks: [
            { id: "verify-flow", type: "flow", literal: { items: ["Desktop panel", "Browser HTML", "PPTX"] } },
          ],
        },
      ],
    },
  }, {
    cwd: process.cwd(),
    sessionId: "presentation-tool-test",
    ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice(value) { notices.push(value); } },
  });
  assert.doesNotMatch(output, /^Error:/);
  const created = JSON.parse(output);
  assert.equal(created.slideCount, 2);
  assert.equal(created.content.extension, ".hpres");
  assert.match(notices[0], /Presentation created/);

  const previewOutput = await tool.run({
    action: "preview",
    artifact_id: created.artifact.artifactId,
    revision_id: created.currentRevision.revisionId,
  }, { cwd: process.cwd() });
  const preview = JSON.parse(previewOutput);
  assert.match(await readFile(preview.path, "utf8"), /Ship from evidence, not optimism/);
});
