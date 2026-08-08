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
  renderPresentationDraft,
  updatePresentationArtifact,
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
        theme: { preset: "signal" },
        template: { preset: "report" },
        slides: [
          {
            id: "slide-1",
            claim: "产品聚焦改善了交付。",
            takeawayTitle: "聚焦让可靠性提升",
            blocks: [
              { id: "metric-1", type: "metric", literal: { label: "准时交付", value: 92, format: "percent" } },
              { id: "list-1", type: "list", literal: ["缩小批次", "明确责任"] },
              {
                id: "chart-1",
                type: "chart",
                literal: {
                  chartType: "line",
                  categories: ["一月", "二月", "三月"],
                  series: [{ name: "准时交付", values: [68, 81, 92] }],
                },
              },
            ],
          },
          {
            id: "slide-2",
            claim: "左右两侧承担不同职责。",
            takeawayTitle: "聊天与工作台协同",
            blocks: [{
              id: "columns-1",
              type: "columns",
              literal: {
                left: { title: "聊天", items: ["补充资料", "提出修改"] },
                right: { title: "工作台", items: ["直接编辑", "检查导出"] },
              },
            }],
          },
        ],
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
    assert.match(previewText, /补充资料/);
    assert.match(previewText, /检查导出/);
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
      if (format === "pptx") {
        assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
        assert.ok(bytes.includes(Buffer.from("ppt/charts/chart1.xml")), "PPTX keeps an editable native chart part");
      }
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

test("native Presentation drafts render before save and commits use optimistic revisions", async () => {
  await withTempHome(async (home) => {
    const created = createPresentationArtifact(home, { title: "Draft review" });
    const editedProject = {
      ...created.project,
      title: "Draft review — edited",
      slides: created.project.slides.map((slide, index) => index === 0
        ? {
            ...slide,
            claim: "The editor renders this change before it becomes a revision.",
            takeawayTitle: "Draft first, then save one exact revision",
          }
        : slide),
    };

    const draft = renderPresentationDraft({ project: editedProject });
    assert.match(draft.html, /Draft first, then save one exact revision/);
    assert.equal(
      getPresentationArtifact(home, created.artifact.artifactId).currentRevision.revisionId,
      created.currentRevision.revisionId,
      "ephemeral draft rendering must not mutate the Artifact",
    );

    const updated = updatePresentationArtifact(home, {
      artifactId: created.artifact.artifactId,
      baseRevisionId: created.currentRevision.revisionId,
      project: editedProject,
      actor: "user",
    });
    assert.equal(updated.artifact.title, "Draft review — edited");
    assert.equal(updated.currentRevision.parentRevisionId, created.currentRevision.revisionId);
    assert.deepEqual(updated.currentRevision.changedPaths, ["presentation/project"]);
    assert.equal(updated.project.slides[0].claim, "The editor renders this change before it becomes a revision.");

    assert.throws(
      () => updatePresentationArtifact(home, {
        artifactId: created.artifact.artifactId,
        baseRevisionId: created.currentRevision.revisionId,
        project: editedProject,
      }),
      /changed after this edit started/,
    );
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
  await withTempHome(async (stateHome) => {
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
  for (const type of [
    "text", "list", "image", "metric", "table", "chart", "compare", "timeline", "flow",
    "diagram", "columns", "group",
  ]) {
    assert.ok(blockTypes.includes(type), `tool schema teaches the model how to generate ${type}`);
  }
  assert.deepEqual(projectSchema.properties.theme.properties.preset.enum, [
    "editorial", "midnight", "signal", "calm",
  ]);
  assert.deepEqual(projectSchema.properties.template.properties.preset.enum, [
    "pitch", "report", "technical", "visual",
  ]);
  assert.equal(projectSchema.properties.slides.items.properties.blocks.maxItems, 7);
  assert.match(tool.description, /must not repeat one default card grid/);
  assert.match(tool.description, /never more than six/);
  assert.match(tool.description, /shorten content, split the slide, or choose a roomier template/);
  assert.match(
    projectSchema.properties.slides.items.properties.blocks.items.properties.literal.description,
    /chartType:bar\|line\|area\|pie\|doughnut/,
  );

  const notices = [];
  const surfaces = [];
  const output = await tool.run({
    action: "create",
    project: {
      schemaVersion: "hara.presentation/1",
      title: "Agent launch review",
      widthEmu: 12192000,
      heightEmu: 6858000,
      brief: { audience: "Release owners", purpose: "Make the release decision" },
      template: { preset: "technical" },
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
    stateHome,
    sessionId: "presentation-tool-test",
    ui: {
      text() {}, reasoning() {}, tool() {}, diff() {},
      notice(value) { notices.push(value); },
      surface(value) { surfaces.push(value); },
    },
  });
  assert.doesNotMatch(output, /^Error:/);
  const created = JSON.parse(output);
  assert.equal(created.slideCount, 2);
  assert.equal(created.content.extension, ".hpres");
  assert.equal(created.surfaceOffer.status, "offered");
  assert.match(created.surfaceOffer.meaning, /does not prove/);
  assert.match(notices[0], /Presentation created/);
  assert.deepEqual(surfaces, [{
    kind: "presentation",
    title: "Agent launch review",
    resource: {
      type: "artifact",
      artifactId: created.artifact.artifactId,
      revisionId: created.currentRevision.revisionId,
    },
  }]);

  const previewOutput = await tool.run({
    action: "preview",
    artifact_id: created.artifact.artifactId,
    revision_id: created.currentRevision.revisionId,
  }, { cwd: process.cwd(), stateHome });
  const preview = JSON.parse(previewOutput);
  assert.equal(preview.previewFileCreated, true);
  assert.equal(preview.openedInDesktop, false);
  assert.match(preview.meaning, /does not open/);
  assert.match(await readFile(preview.path, "utf8"), /Ship from evidence, not optimism/);
  });
});
