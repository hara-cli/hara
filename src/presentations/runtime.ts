import { basename } from "node:path";
import {
  createPresentationProject,
  importPresentationSource,
  parsePresentationProject,
  renderPresentationHtml,
  renderPresentationPptx,
  serializePresentationProject,
  type PresentationImportWarning,
  type PresentationProject,
} from "@nanhara/hara-presentation";
import {
  ArtifactStoreError,
  commitArtifactBytes,
  exportArtifactConverted,
  importArtifactBytes,
  readArtifactRevisionContent,
  readArtifactSourceBytes,
  recordArtifactValidation,
  type ArtifactDetails,
  type ArtifactExportReceipt,
  type ArtifactExportWarning,
  type ArtifactRevision,
  type ArtifactValidationReport,
} from "../artifacts/store.js";
import {
  bindPrivateHaraStateFile,
  writePrivateStateFileSync,
} from "../security/private-state.js";

export const PRESENTATION_ARTIFACT_EXTENSION = ".hpres";
export const PRESENTATION_VALIDATOR_ID = "hara.office.presentation";
export const PRESENTATION_VALIDATOR_VERSION = "1.0.0";
const PRESENTATION_SOURCE_EXTENSIONS = [".hpres", ".json", ".md", ".markdown"] as const;

export interface PresentationArtifactDetails extends ArtifactDetails {
  project: Readonly<PresentationProject>;
}

export interface PresentationImportArtifactResult extends PresentationArtifactDetails {
  warnings: readonly Readonly<PresentationImportWarning>[];
}

function runtimeError(
  code: ConstructorParameters<typeof ArtifactStoreError>[0],
  message: string,
  cause?: unknown,
): ArtifactStoreError {
  return new ArtifactStoreError(code, message, cause === undefined ? undefined : { cause });
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1_000);
}

function parseProject(bytes: Uint8Array): Readonly<PresentationProject> {
  try {
    return parsePresentationProject(bytes);
  } catch (error) {
    throw runtimeError(
      "ARTIFACT_CORRUPT",
      `Hara Presentation content is invalid: ${safeMessage(error)}`,
      error,
    );
  }
}

function assertPresentationContent(content: {
  artifact: { kind: string };
  content: { extension: string; mediaType: string };
}): void {
  if (
    content.artifact.kind !== "presentation"
    || content.content.extension !== PRESENTATION_ARTIFACT_EXTENSION
    || content.content.mediaType !== "application/vnd.nanhara.presentation+json"
  ) {
    throw runtimeError(
      "ARTIFACT_INVALID_INPUT",
      "this Artifact is an imported Office file, not an editable Hara Presentation",
    );
  }
}

function starterProject(title: string): Readonly<PresentationProject> {
  return createPresentationProject({
    title,
    brief: {
      sourceFormat: "hara-native",
      purpose: "Draft a focused presentation and refine it with Hara.",
    },
    slides: [
      {
        id: "slide-1",
        claim: "A clear point of view makes the presentation useful.",
        takeawayTitle: title,
        blocks: [
          { id: "slide-1-heading", type: "heading", literal: title },
          {
            id: "slide-1-callout",
            type: "callout",
            literal: "Tell Hara the audience, decision, evidence, and desired next action.",
          },
        ],
      },
    ],
  });
}

export function createPresentationArtifact(
  home: string,
  input: {
    title?: string;
    project?: unknown;
    actor?: "user" | "agent" | "migration";
    taskRunId?: string;
  } = {},
): PresentationArtifactDetails {
  const requestedTitle = typeof input.title === "string" ? input.title.trim() : "";
  let project: Readonly<PresentationProject>;
  try {
    project = input.project === undefined
      ? starterProject(requestedTitle || "Untitled presentation")
      : parsePresentationProject(input.project);
    if (requestedTitle && project.title !== requestedTitle) {
      project = createPresentationProject({ ...project, title: requestedTitle });
    }
  } catch (error) {
    throw runtimeError(
      "ARTIFACT_INVALID_INPUT",
      `PresentationProject could not be created: ${safeMessage(error)}`,
      error,
    );
  }
  const bytes = Buffer.from(serializePresentationProject(project), "utf8");
  const details = importArtifactBytes(home, {
    kind: "presentation",
    title: project.title,
    extension: PRESENTATION_ARTIFACT_EXTENSION,
    mediaType: "application/vnd.nanhara.presentation+json",
    bytes,
    origin: input.actor === "agent" ? "agent-created" : "hara-created",
    actor: input.actor ?? "user",
    ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
  });
  return { ...details, project };
}

export async function importPresentationArtifact(
  home: string,
  input: {
    sourcePath: string;
    title?: string;
    actor?: "user" | "agent" | "migration";
    taskRunId?: string;
  },
): Promise<PresentationImportArtifactResult> {
  const source = await readArtifactSourceBytes(input.sourcePath, PRESENTATION_SOURCE_EXTENSIONS);
  const format = source.extension === ".md" || source.extension === ".markdown"
    ? "slidev"
    : source.extension === ".hpres"
      ? "hpres"
      : "json";
  let imported;
  try {
    imported = importPresentationSource(source.bytes, {
      format,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  } catch (error) {
    throw runtimeError(
      "ARTIFACT_SOURCE_REJECTED",
      `Presentation import was rejected: ${safeMessage(error)}`,
      error,
    );
  }
  const bytes = Buffer.from(serializePresentationProject(imported.project), "utf8");
  const details = importArtifactBytes(home, {
    kind: "presentation",
    title: imported.project.title || basename(source.sourcePath, source.extension),
    extension: PRESENTATION_ARTIFACT_EXTENSION,
    mediaType: "application/vnd.nanhara.presentation+json",
    bytes,
    origin: format === "slidev" ? "slidev-import" : "hara-import",
    actor: input.actor ?? "user",
    ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
  });
  return { ...details, project: imported.project, warnings: imported.warnings };
}

export function getPresentationArtifact(
  home: string,
  artifactId: string,
  revisionId?: string,
): PresentationArtifactDetails {
  const source = readArtifactRevisionContent(home, {
    artifactId,
    ...(revisionId ? { revisionId } : {}),
    requireCurrent: revisionId === undefined,
  });
  assertPresentationContent(source);
  const project = parseProject(source.bytes);
  return {
    artifact: source.artifact,
    currentRevision: source.revision,
    content: source.content,
    project,
  };
}

export function updatePresentationArtifact(
  home: string,
  input: {
    artifactId: string;
    baseRevisionId: string;
    project: unknown;
    actor?: "user" | "agent" | "migration";
    taskRunId?: string;
  },
): PresentationArtifactDetails {
  getPresentationArtifact(home, input.artifactId, input.baseRevisionId);
  let project: Readonly<PresentationProject>;
  try {
    project = parsePresentationProject(input.project);
  } catch (error) {
    throw runtimeError(
      "ARTIFACT_INVALID_INPUT",
      `PresentationProject could not be updated: ${safeMessage(error)}`,
      error,
    );
  }
  const bytes = Buffer.from(serializePresentationProject(project), "utf8");
  const details = commitArtifactBytes(home, {
    artifactId: input.artifactId,
    baseRevisionId: input.baseRevisionId,
    extension: PRESENTATION_ARTIFACT_EXTENSION,
    mediaType: "application/vnd.nanhara.presentation+json",
    bytes,
    title: project.title,
    actor: input.actor ?? "user",
    ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
    changedPaths: ["presentation/project"],
  });
  return { ...details, project };
}

function validationFindings(error: unknown): Array<{
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
}> {
  const candidate = error && typeof error === "object" && "findings" in error
    ? (error as { findings?: unknown }).findings
    : undefined;
  if (Array.isArray(candidate)) {
    return candidate.slice(0, 999).map((finding) => ({
      code: finding && typeof finding === "object" && typeof (finding as any).code === "string"
        ? (finding as any).code
        : "PRESENTATION_INVALID",
      severity: "error",
      message: finding && typeof finding === "object" && typeof (finding as any).message === "string"
        ? (finding as any).message
        : safeMessage(error),
    }));
  }
  return [{
    code: "PRESENTATION_INVALID",
    severity: "error",
    message: safeMessage(error),
  }];
}

export function validatePresentationArtifact(
  home: string,
  input: { artifactId: string; revisionId: string },
): ArtifactValidationReport {
  const source = readArtifactRevisionContent(home, {
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    requireCurrent: true,
  });
  assertPresentationContent(source);
  let findings: ArtifactValidationReport["findings"];
  try {
    parsePresentationProject(source.bytes);
    findings = [{
      code: "PRESENTATION_VALIDATED",
      severity: "info",
      message: "PresentationProject structure, immutable content digest, and safe block contract match this revision.",
    }];
  } catch (error) {
    findings = validationFindings(error);
  }
  return recordArtifactValidation(home, {
    artifactId: source.artifact.artifactId,
    revisionId: source.revision.revisionId,
    snapshotDigest: source.content.sha256,
    validatorId: PRESENTATION_VALIDATOR_ID,
    validatorVersion: PRESENTATION_VALIDATOR_VERSION,
    findings,
  });
}

function safeSlidePath(slideId: string | undefined): string | undefined {
  if (!slideId) return undefined;
  const segment = slideId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return segment ? `slides/${segment}` : undefined;
}

function exportWarnings(warnings: readonly Readonly<PresentationImportWarning>[]): ArtifactExportWarning[] {
  return warnings.map((warning) => ({
    code: warning.code.replace(/[^A-Z0-9_]+/g, "_").slice(0, 100) || "PRESENTATION_EXPORT_WARNING",
    severity: "warning",
    message: warning.message.slice(0, 4_000),
    ...(safeSlidePath(warning.slideId) ? { path: safeSlidePath(warning.slideId) } : {}),
  }));
}

export async function exportPresentationArtifact(
  home: string,
  input: {
    artifactId: string;
    revisionId: string;
    validationReportId: string;
    destinationPath: string;
    format: "json" | "html" | "pptx";
  },
): Promise<ArtifactExportReceipt> {
  const source = readArtifactRevisionContent(home, {
    artifactId: input.artifactId,
    revisionId: input.revisionId,
    requireCurrent: true,
  });
  assertPresentationContent(source);
  const project = parseProject(source.bytes);
  let bytes: Uint8Array;
  let mediaType: string;
  let fidelity: ArtifactExportReceipt["fidelity"];
  let warnings: ArtifactExportWarning[] = [];
  if (input.format === "json") {
    bytes = Buffer.from(serializePresentationProject(project), "utf8");
    mediaType = "application/json";
    fidelity = "semantic-editable";
  } else if (input.format === "html") {
    bytes = Buffer.from(renderPresentationHtml(project), "utf8");
    mediaType = "text/html";
    fidelity = "visual-fidelity";
    warnings = [{
      code: "PDF_VIA_BROWSER_PRINT",
      severity: "warning",
      message: "Open this HTML presenter in a browser and use Print / Save as PDF for a font-aware PDF.",
    }];
  } else {
    const rendered = await renderPresentationPptx(project);
    bytes = rendered.bytes;
    mediaType = rendered.mediaType;
    fidelity = rendered.fidelity;
    warnings = exportWarnings(rendered.warnings);
  }
  return exportArtifactConverted(home, {
    artifactId: source.artifact.artifactId,
    revisionId: source.revision.revisionId,
    validationReportId: input.validationReportId,
    destinationPath: input.destinationPath,
    format: input.format,
    mediaType,
    fidelity,
    bytes,
    warnings,
    validatorId: PRESENTATION_VALIDATOR_ID,
    validatorVersion: PRESENTATION_VALIDATOR_VERSION,
  });
}

export function createPresentationPreviewFile(
  home: string,
  input: { artifactId: string; revisionId: string },
): { path: string; revisionId: string } {
  const details = getPresentationArtifact(home, input.artifactId, input.revisionId);
  if (details.artifact.currentRevisionId !== input.revisionId) {
    throw runtimeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed before browser preview was prepared; reopen the latest revision",
    );
  }
  const html = renderPresentationHtml(details.project);
  const binding = bindPrivateHaraStateFile(
    home,
    ["artifacts", details.artifact.artifactId, "previews"],
    `${details.currentRevision.revisionId}.html`,
  );
  writePrivateStateFileSync(binding, html);
  return { path: binding.path, revisionId: details.currentRevision.revisionId };
}

function boundedPresentationHtml(
  project: unknown,
  overflowMessage: string,
): string {
  let html: string;
  try {
    html = renderPresentationHtml(parsePresentationProject(project));
  } catch (error) {
    throw runtimeError(
      "ARTIFACT_INVALID_INPUT",
      `PresentationProject could not be rendered: ${safeMessage(error)}`,
      error,
    );
  }
  if (Buffer.byteLength(html, "utf8") > 8 * 1024 * 1024) {
    throw runtimeError("ARTIFACT_TOO_LARGE", overflowMessage);
  }
  return html;
}

export function renderPresentationDraft(
  input: { project: unknown },
): { html: string } {
  return {
    html: boundedPresentationHtml(
      input.project,
      "the rendered presentation draft exceeds the bounded Desktop preview size; relink oversized embedded images",
    ),
  };
}

export function renderPresentationPreview(
  home: string,
  input: { artifactId: string; revisionId: string },
): { html: string; revisionId: string } {
  const details = getPresentationArtifact(home, input.artifactId, input.revisionId);
  if (details.artifact.currentRevisionId !== input.revisionId) {
    throw runtimeError(
      "ARTIFACT_CONFLICT",
      "the Artifact changed before the Desktop preview was prepared; reopen the latest revision",
    );
  }
  const html = boundedPresentationHtml(
    details.project,
    "the rendered presentation exceeds the bounded Desktop preview size; relink oversized embedded images",
  );
  return { html, revisionId: details.currentRevision.revisionId };
}

export function presentationRevisionSummary(
  revision: ArtifactRevision,
): Pick<ArtifactRevision, "revisionId" | "createdAt" | "actor"> {
  return {
    revisionId: revision.revisionId,
    createdAt: revision.createdAt,
    actor: revision.actor,
  };
}
