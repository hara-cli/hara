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
import { basename, join } from "node:path";
import {
  ArtifactStoreError,
  MAX_ARTIFACT_IMPORT_BYTES,
  cleanupArtifactStaging,
  commitArtifact,
  exportArtifact,
  getArtifact,
  importArtifact,
  listArtifactRevisions,
  listArtifacts,
  revertArtifact,
  validateArtifact,
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

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const storedZip = (entries) => {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [nameText, contentText] of entries) {
    const name = Buffer.from(nameText);
    const content = Buffer.from(contentText);
    const digest = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(digest, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, content);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(digest, 16);
    directory.writeUInt32LE(content.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + content.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
};

const officeBenchmarks = {
  pptx: storedZip([
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'],
    ["ppt/presentation.xml", '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>'],
    ["ppt/_rels/presentation.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'],
    ["ppt/slides/slide1.xml", '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>'],
  ]),
  xlsx: storedZip([
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml", '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hara</t></is></c></row></sheetData></worksheet>'],
  ]),
  docx: storedZip([
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ["word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hara</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'],
  ]),
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

test("Artifact validation binds an immutable revision and safe export never replaces a file", async () => {
  await withHome(async (home) => {
    const work = join(home, "work");
    mkdirSync(work);
    const source = join(work, "review.pptx");
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x10, 0x20, 0x30]);
    writeFileSync(source, bytes);
    const imported = await importArtifact(home, { sourcePath: source });
    const artifactId = imported.artifact.artifactId;
    const revisionId = imported.currentRevision.revisionId;

    const report = validateArtifact(home, { artifactId, revisionId });
    assert.match(report.reportId, /^val_[a-f0-9]{32}$/);
    assert.equal(report.revisionId, revisionId);
    assert.equal(report.snapshotDigest, imported.content.sha256);
    assert.equal(report.status, "pass");
    assert.equal(report.validatorId, "hara.office.integrity");
    assert.equal(report.findings[0].code, "ARTIFACT_INTEGRITY_VERIFIED");
    const reportPath = join(home, ".hara", "artifacts", artifactId, "validations", `${report.reportId}.json`);
    assert.equal(readFileSync(reportPath, "utf8").includes(source), false);

    const destination = join(work, "review-copy.pptx");
    const receipt = exportArtifact(home, {
      artifactId,
      revisionId,
      validationReportId: report.reportId,
      destinationPath: destination,
    });
    assert.match(receipt.receiptId, /^exp_[a-f0-9]{32}$/);
    assert.equal(receipt.revisionId, revisionId);
    assert.equal(receipt.validationReportId, report.reportId);
    assert.equal(receipt.fidelity, "roundtrip");
    assert.equal(receipt.format, "pptx");
    assert.equal(receipt.output.sha256, imported.content.sha256);
    assert.deepEqual(readFileSync(destination), bytes);
    const receiptText = readFileSync(
      join(home, ".hara", "artifacts", artifactId, "exports", `${receipt.receiptId}.json`),
      "utf8",
    );
    assert.equal(receiptText.includes(destination), false, "receipts do not retain the user's absolute output path");

    writeFileSync(destination, "keep this exact file");
    assert.throws(
      () => exportArtifact(home, {
        artifactId,
        revisionId,
        validationReportId: report.reportId,
        destinationPath: destination,
      }),
      (error) => error instanceof ArtifactStoreError && error.code === "ARTIFACT_CONFLICT",
    );
    assert.equal(readFileSync(destination, "utf8"), "keep this exact file");
    assert.throws(
      () => exportArtifact(home, {
        artifactId,
        revisionId,
        validationReportId: report.reportId,
        destinationPath: join(work, "not-a-conversion.pdf"),
      }),
      (error) => error instanceof ArtifactStoreError && error.code === "ARTIFACT_INVALID_INPUT",
    );

    const edited = join(work, "review-edited.pptx");
    writeFileSync(edited, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99]));
    await commitArtifact(home, {
      artifactId,
      baseRevisionId: revisionId,
      sourcePath: edited,
    });
    assert.throws(
      () => exportArtifact(home, {
        artifactId,
        revisionId,
        validationReportId: report.reportId,
        destinationPath: join(work, "stale.pptx"),
      }),
      (error) => error instanceof ArtifactStoreError && error.code === "ARTIFACT_CONFLICT",
    );
  });
});

test("fixed PPTX, XLSX, and DOCX benchmarks validate and export byte-for-byte", async () => {
  await withHome(async (home) => {
    const work = join(home, "work");
    mkdirSync(work);
    for (const [extension, bytes] of Object.entries(officeBenchmarks)) {
      const source = join(work, `benchmark.${extension}`);
      const destination = join(work, `benchmark-copy.${extension}`);
      writeFileSync(source, bytes);
      const imported = await importArtifact(home, { sourcePath: source });
      const report = validateArtifact(home, {
        artifactId: imported.artifact.artifactId,
        revisionId: imported.currentRevision.revisionId,
      });
      const receipt = exportArtifact(home, {
        artifactId: imported.artifact.artifactId,
        revisionId: imported.currentRevision.revisionId,
        validationReportId: report.reportId,
        destinationPath: destination,
      });
      assert.equal(report.status, "pass", `${extension} benchmark validates`);
      assert.equal(receipt.format, extension);
      assert.equal(receipt.output.sha256, imported.content.sha256);
      assert.deepEqual(readFileSync(destination), bytes, `${extension} export is byte-identical`);
    }
  });
});

test("Artifact staging cleanup removes only old strictly named private staging directories", async () => {
  await withHome(async (home) => {
    const work = join(home, "work");
    mkdirSync(work);
    const source = join(work, "notes.md");
    writeFileSync(source, "# notes\n");
    const imported = await importArtifact(home, { sourcePath: source });
    const root = join(home, ".hara", "artifacts");
    const oldRoot = join(root, `.staging-art_${"a".repeat(32)}-${"b".repeat(32)}`);
    const oldNested = join(
      root,
      imported.artifact.artifactId,
      `.staging-rev_${"c".repeat(32)}-${"d".repeat(32)}`,
    );
    const unrecognized = join(root, ".staging-do-not-delete");
    mkdirSync(oldRoot);
    mkdirSync(oldNested);
    mkdirSync(unrecognized);
    writeFileSync(join(oldRoot, "partial.bin"), "partial");
    writeFileSync(join(oldNested, "partial.bin"), "partial");

    const cleaned = cleanupArtifactStaging(home, Date.now() + 7 * 60 * 60 * 1_000);
    assert.equal(cleaned.removed, 2);
    assert.equal(cleaned.retained, 1);
    assert.equal(readdirSync(root).includes(basename(oldRoot)), false);
    assert.equal(
      readdirSync(join(root, imported.artifact.artifactId)).includes(basename(oldNested)),
      false,
    );
    assert.equal(readdirSync(root).includes(basename(unrecognized)), true);
  });
});
