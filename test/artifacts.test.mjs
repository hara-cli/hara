import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactStoreError,
  MAX_ARTIFACT_IMPORT_BYTES,
  commitArtifact,
  getArtifact,
  importArtifact,
  listArtifactRevisions,
  listArtifacts,
  revertArtifact,
} from "../dist/artifacts/store.js";
import {
  bindPrivateHaraStateFile,
  writePrivateStateBytesOnceSync,
} from "../dist/security/private-state.js";

const withHome = async (run) => {
  const home = mkdtempSync(join(tmpdir(), "hara-artifacts-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const expectArtifactError = async (promise, code) => {
  await assert.rejects(
    promise,
    (error) => error instanceof ArtifactStoreError && error.code === code,
  );
};

test("Artifact import creates a private artifact/1 revision without retaining the source path", async () => {
  await withHome(async (home) => {
    const work = join(home, "work");
    mkdirSync(work);
    const source = join(work, "quarter.xlsx");
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x20]);
    writeFileSync(source, bytes);

    const imported = await importArtifact(home, { sourcePath: source });
    assert.equal(imported.artifact.protocol, "artifact/1");
    assert.equal(imported.artifact.kind, "spreadsheet");
    assert.equal(imported.artifact.title, "quarter");
    assert.equal(imported.artifact.origin, "local-import");
    assert.equal(imported.artifact.dataResidency, "local");
    assert.match(imported.artifact.artifactId, /^art_[a-f0-9]{32}$/);
    assert.match(imported.currentRevision.revisionId, /^rev_[a-f0-9]{32}$/);
    assert.equal(imported.currentRevision.baseRevisionId, imported.currentRevision.revisionId);
    assert.equal(imported.currentRevision.contentDigest, imported.content.sha256);
    assert.equal(imported.content.byteSize, bytes.length);

    const artifactDir = join(home, ".hara", "artifacts", imported.artifact.artifactId);
    const revisionDir = join(artifactDir, "revisions", imported.currentRevision.revisionId);
    const metadataText = readFileSync(join(artifactDir, "metadata.json"), "utf8");
    assert.equal(metadataText.includes(source), false, "private metadata does not retain the absolute source path");
    assert.equal(metadataText.includes("sourcePath"), false);
    assert.deepEqual(readFileSync(join(revisionDir, imported.currentRevision.contentRef)), bytes);
    assert.equal(
      readdirSync(join(home, ".hara", "artifacts")).some((name) => name.startsWith(".staging-")),
      false,
      "atomic activation leaves no visible staging directory",
    );
    if (process.platform !== "win32") {
      assert.equal(lstatSync(artifactDir).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(revisionDir, imported.currentRevision.contentRef)).mode & 0o777, 0o600);
    }

    const listed = listArtifacts(home);
    assert.equal(listed.invalid, 0);
    assert.equal(listed.truncated, false);
    assert.deepEqual(listed.artifacts.map((entry) => entry.artifactId), [imported.artifact.artifactId]);
    assert.equal(listed.artifacts[0].kind, "spreadsheet");
    assert.equal(listed.artifacts[0].extension, ".xlsx");

    const capabilityLock = {
      id: "office.spreadsheet",
      version: "0.1.0",
      sha256: "a".repeat(64),
    };
    imported.artifact.capabilityLock = capabilityLock;
    writeFileSync(
      join(artifactDir, "metadata.json"),
      `${JSON.stringify(imported.artifact, null, 2)}\n`,
    );
    const loaded = getArtifact(home, imported.artifact.artifactId);
    assert.deepEqual(loaded, imported);
    assert.deepEqual(loaded.artifact.capabilityLock, capabilityLock);
    const revisions = listArtifactRevisions(home, imported.artifact.artifactId);
    assert.deepEqual(revisions, [imported.currentRevision]);

    writeFileSync(join(revisionDir, imported.currentRevision.contentRef), Buffer.alloc(bytes.length, 0x41));
    assert.throws(
      () => getArtifact(home, imported.artifact.artifactId),
      (error) => error instanceof ArtifactStoreError && error.code === "ARTIFACT_CORRUPT",
      "artifact.get verifies the current content digest",
    );
  });
});

test("Artifact import rejects ambiguous, executable, linked, protected, and oversized sources", async () => {
  await withHome(async (home) => {
    const work = join(home, "work");
    mkdirSync(work);

    await expectArtifactError(
      importArtifact(home, { sourcePath: "relative.docx" }),
      "ARTIFACT_INVALID_INPUT",
    );
    const executable = join(work, "payload.exe");
    writeFileSync(executable, "no");
    await expectArtifactError(
      importArtifact(home, { sourcePath: executable }),
      "ARTIFACT_INVALID_INPUT",
    );
    const disguised = join(work, "disguised.docx");
    writeFileSync(disguised, "this is not an Office package");
    await expectArtifactError(
      importArtifact(home, { sourcePath: disguised }),
      "ARTIFACT_SOURCE_REJECTED",
    );
    const macro = join(work, "macro.xlsm");
    writeFileSync(macro, "macro");
    await expectArtifactError(
      importArtifact(home, { sourcePath: macro }),
      "ARTIFACT_SOURCE_REJECTED",
    );
    const empty = join(work, "empty.docx");
    writeFileSync(empty, "");
    await expectArtifactError(
      importArtifact(home, { sourcePath: empty }),
      "ARTIFACT_INVALID_INPUT",
    );

    const regular = join(work, "regular.docx");
    writeFileSync(regular, "document");
    const linked = join(work, "linked.docx");
    linkSync(regular, linked);
    await expectArtifactError(
      importArtifact(home, { sourcePath: linked }),
      "ARTIFACT_SOURCE_REJECTED",
    );
    const symlink = join(work, "symlink.docx");
    symlinkSync(regular, symlink);
    await expectArtifactError(
      importArtifact(home, { sourcePath: symlink }),
      "ARTIFACT_SOURCE_REJECTED",
    );

    const protectedSource = join(work, ".env.xlsx");
    writeFileSync(protectedSource, "secret-placeholder");
    await expectArtifactError(
      importArtifact(home, { sourcePath: protectedSource }),
      "ARTIFACT_SOURCE_REJECTED",
    );

    const sheet = join(work, "sheet.xlsx");
    writeFileSync(sheet, "sheet");
    await expectArtifactError(
      importArtifact(home, { sourcePath: sheet, kind: "document" }),
      "ARTIFACT_INVALID_INPUT",
    );

    const huge = join(work, "huge.pptx");
    writeFileSync(huge, "x");
    truncateSync(huge, MAX_ARTIFACT_IMPORT_BYTES + 1);
    await expectArtifactError(
      importArtifact(home, { sourcePath: huge }),
      "ARTIFACT_TOO_LARGE",
    );
  });
});

test("Artifact commit uses optimistic concurrency and revert creates an immutable new revision", async () => {
  await withHome(async (home) => {
    const work = join(home, "work");
    mkdirSync(work);
    const source = join(work, "brief.md");
    writeFileSync(source, "# Version one\n");
    const imported = await importArtifact(home, { sourcePath: source });
    const firstRevisionId = imported.currentRevision.revisionId;

    const edited = join(work, "brief-edited.md");
    writeFileSync(edited, "# Version two\n");
    const committed = await commitArtifact(home, {
      artifactId: imported.artifact.artifactId,
      baseRevisionId: firstRevisionId,
      sourcePath: edited,
      actor: "agent",
      taskRunId: "task-test",
      changedPaths: ["body/heading"],
    });
    assert.notEqual(committed.currentRevision.revisionId, firstRevisionId);
    assert.equal(committed.currentRevision.parentRevisionId, firstRevisionId);
    assert.equal(committed.currentRevision.baseRevisionId, firstRevisionId);
    assert.equal(committed.currentRevision.actor, "agent");
    assert.equal(committed.currentRevision.taskRunId, "task-test");
    assert.deepEqual(committed.currentRevision.changedPaths, ["body/heading"]);
    assert.equal(
      readFileSync(
        join(
          home,
          ".hara",
          "artifacts",
          imported.artifact.artifactId,
          "revisions",
          firstRevisionId,
          imported.currentRevision.contentRef,
        ),
        "utf8",
      ),
      "# Version one\n",
      "the previous revision remains immutable",
    );

    await expectArtifactError(
      commitArtifact(home, {
        artifactId: imported.artifact.artifactId,
        baseRevisionId: firstRevisionId,
        sourcePath: edited,
      }),
      "ARTIFACT_CONFLICT",
    );
    assert.equal(
      getArtifact(home, imported.artifact.artifactId).currentRevision.revisionId,
      committed.currentRevision.revisionId,
      "a stale commit never changes the current pointer",
    );

    const wrongKind = join(work, "wrong.xlsx");
    writeFileSync(wrongKind, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]));
    await expectArtifactError(
      commitArtifact(home, {
        artifactId: imported.artifact.artifactId,
        baseRevisionId: committed.currentRevision.revisionId,
        sourcePath: wrongKind,
      }),
      "ARTIFACT_INVALID_INPUT",
    );

    const reverted = revertArtifact(home, {
      artifactId: imported.artifact.artifactId,
      baseRevisionId: committed.currentRevision.revisionId,
      targetRevisionId: firstRevisionId,
    });
    assert.notEqual(reverted.currentRevision.revisionId, firstRevisionId);
    assert.notEqual(reverted.currentRevision.revisionId, committed.currentRevision.revisionId);
    assert.equal(reverted.currentRevision.parentRevisionId, committed.currentRevision.revisionId);
    assert.equal(reverted.currentRevision.baseRevisionId, committed.currentRevision.revisionId);
    assert.equal(reverted.currentRevision.contentDigest, imported.currentRevision.contentDigest);
    assert.deepEqual(
      readFileSync(
        join(
          home,
          ".hara",
          "artifacts",
          imported.artifact.artifactId,
          "revisions",
          reverted.currentRevision.revisionId,
          reverted.currentRevision.contentRef,
        ),
      ),
      Buffer.from("# Version one\n"),
    );
    assert.equal(listArtifactRevisions(home, imported.artifact.artifactId).length, 3);
    assert.throws(
      () => revertArtifact(home, {
        artifactId: imported.artifact.artifactId,
        baseRevisionId: reverted.currentRevision.revisionId,
        targetRevisionId: reverted.currentRevision.revisionId,
      }),
      (error) => error instanceof ArtifactStoreError && error.code === "ARTIFACT_INVALID_INPUT",
    );
  });
});

test("Artifact roots fail closed on a preseeded symlink and immutable binary writes never replace", async () => {
  await withHome(async (home) => {
    const outside = join(home, "outside");
    const hara = join(home, ".hara");
    mkdirSync(outside);
    mkdirSync(hara);
    symlinkSync(outside, join(hara, "artifacts"));
    assert.throws(() => listArtifacts(home), /not a real directory|symbolic-link/i);
    assert.deepEqual(readdirSync(outside), [], "the rejected root did not write through the link");
  });

  await withHome(async (home) => {
    const binding = bindPrivateHaraStateFile(home, ["artifacts", "binary-test"], "content.bin");
    writePrivateStateBytesOnceSync(binding, Buffer.from([1, 2, 3]));
    assert.throws(
      () => writePrivateStateBytesOnceSync(binding, Buffer.from([9, 9, 9])),
      /already exists/,
    );
    assert.deepEqual(readFileSync(binding.path), Buffer.from([1, 2, 3]));
  });
});

test("Artifact list isolates corrupt entries instead of hiding healthy work", async () => {
  await withHome(async (home) => {
    const work = join(home, "work");
    mkdirSync(work);
    const one = join(work, "one.md");
    const two = join(work, "two.md");
    writeFileSync(one, "# one\n");
    writeFileSync(two, "# two\n");
    const healthy = await importArtifact(home, { sourcePath: one });
    const corrupt = await importArtifact(home, { sourcePath: two });
    writeFileSync(
      join(home, ".hara", "artifacts", corrupt.artifact.artifactId, "metadata.json"),
      "{not json",
    );

    const listed = listArtifacts(home);
    assert.equal(listed.invalid, 1);
    assert.deepEqual(listed.artifacts.map((entry) => entry.artifactId), [healthy.artifact.artifactId]);
  });
});
