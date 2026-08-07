import { homedir } from "node:os";
import { listArtifacts } from "../artifacts/store.js";
import {
  createPresentationArtifact,
  createPresentationPreviewFile,
  exportPresentationArtifact,
  getPresentationArtifact,
  importPresentationArtifact,
  updatePresentationArtifact,
  validatePresentationArtifact,
} from "../presentations/runtime.js";
import { registerTool } from "./registry.js";

function result(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

registerTool({
  name: "presentation",
  description:
    "Create, import, update, inspect, validate, preview, or export a native Hara presentation. "
    + "Use create with a PresentationProject to make a deck visible in Hara Desktop's right panel. "
    + "Give every slide one evidence-backed claim and takeaway title, unique slide/block ids, and usually 2–5 blocks. "
    + "Import accepts controlled Slidev Markdown or Hara presentation JSON. Export supports editable PPTX, "
    + "self-contained HTML (also browser Print/Save PDF), and canonical JSON.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "import", "update", "list", "get", "validate", "preview", "export"],
      },
      title: { type: "string", description: "Presentation title for create/import" },
      project: {
        type: "object",
        description: "Complete hara.presentation/1 deck. The same project drives Desktop, browser HTML, and editable PPTX.",
        additionalProperties: false,
        properties: {
          schemaVersion: {
            type: "string",
            enum: ["hara.presentation/1"],
            description: "Always hara.presentation/1",
          },
          title: { type: "string", minLength: 1, maxLength: 500 },
          widthEmu: {
            type: "integer",
            enum: [12192000],
            description: "16:9 width; use 12192000",
          },
          heightEmu: {
            type: "integer",
            enum: [6858000],
            description: "16:9 height; use 6858000",
          },
          brief: {
            type: "object",
            description: "Audience, purpose, source notes, and desired action as plain JSON",
          },
          theme: {
            type: "object",
            description: "Optional plain-JSON theme metadata; Presenter remains deterministic",
          },
          slides: {
            type: "array",
            minItems: 1,
            maxItems: 500,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                  description: "Unique stable id, for example slide-01",
                },
                claim: {
                  type: "string",
                  minLength: 1,
                  description: "The evidence-backed assertion this slide proves",
                },
                takeawayTitle: {
                  type: "string",
                  minLength: 1,
                  description: "Short conclusion shown as the slide title",
                },
                notes: { type: "string", description: "Optional speaker notes" },
                blocks: {
                  type: "array",
                  minItems: 1,
                  maxItems: 200,
                  items: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      id: {
                        type: "string",
                        minLength: 1,
                        maxLength: 200,
                        description: "Unique across the whole deck",
                      },
                      type: {
                        type: "string",
                        enum: [
                          "heading", "text", "list", "image", "table", "metric", "chart",
                          "quote", "callout", "compare", "timeline", "flow", "diagram", "columns", "group",
                        ],
                      },
                      literal: {
                        description:
                          "Block data: heading/text/quote/callout use a string; list uses string[]; "
                          + "metric uses {label,value,format?,delta?}; table uses {headers,rows}; "
                          + "chart uses {values} or {series:[{values}]}; compare uses {left,right}; "
                          + "timeline/flow use {items:[{text or title,description?}]}; image uses a safe data:image base64 URL or {alt}.",
                      },
                    },
                    required: ["id", "type", "literal"],
                  },
                },
              },
              required: ["id", "claim", "takeawayTitle", "blocks"],
            },
          },
        },
        required: ["schemaVersion", "title", "widthEmu", "heightEmu", "brief", "slides"],
      },
      source_path: {
        type: "string",
        description: "Absolute path to controlled Slidev Markdown, .hpres, or Hara presentation JSON",
      },
      artifact_id: { type: "string" },
      revision_id: { type: "string" },
      destination_path: {
        type: "string",
        description: "Absolute create-only destination path with the selected format extension",
      },
      format: { type: "string", enum: ["json", "html", "pptx"] },
    },
    required: ["action"],
  },
  kind: "edit",
  classify(input) {
    if (input?.action === "list" || input?.action === "get") {
      return { effect: "read", concurrencySafe: true };
    }
    if (input?.action === "validate" || input?.action === "preview") {
      return { effect: "state", concurrencySafe: false };
    }
    return { effect: "edit", concurrencySafe: false };
  },
  async run(input, ctx) {
    const home = homedir();
    try {
      switch (input.action) {
        case "create": {
          const details = createPresentationArtifact(home, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.project !== undefined ? { project: input.project } : {}),
            actor: "agent",
            ...(ctx.sessionId ? { taskRunId: ctx.sessionId } : {}),
          });
          ctx.ui?.surface?.({
            kind: "presentation",
            title: details.artifact.title,
            resource: {
              type: "artifact",
              artifactId: details.artifact.artifactId,
              revisionId: details.currentRevision.revisionId,
            },
          });
          ctx.ui?.notice(`Presentation created: ${details.artifact.title} (${details.artifact.artifactId})`);
          return result({
            artifact: details.artifact,
            currentRevision: details.currentRevision,
            content: details.content,
            slideCount: details.project.slides.length,
            next: "Hara Desktop opens the exact presenter in this session's Visual Dock when typed surface events are available.",
          });
        }
        case "import": {
          if (typeof input.source_path !== "string" || !input.source_path) {
            return "Error: presentation import requires source_path.";
          }
          const details = await importPresentationArtifact(home, {
            sourcePath: input.source_path,
            ...(input.title !== undefined ? { title: input.title } : {}),
            actor: "agent",
            ...(ctx.sessionId ? { taskRunId: ctx.sessionId } : {}),
          });
          ctx.ui?.surface?.({
            kind: "presentation",
            title: details.artifact.title,
            resource: {
              type: "artifact",
              artifactId: details.artifact.artifactId,
              revisionId: details.currentRevision.revisionId,
            },
          });
          ctx.ui?.notice(`Presentation imported: ${details.artifact.title} (${details.artifact.artifactId})`);
          return result({
            artifact: details.artifact,
            currentRevision: details.currentRevision,
            content: details.content,
            slideCount: details.project.slides.length,
            warnings: details.warnings,
          });
        }
        case "update": {
          if (
            typeof input.artifact_id !== "string"
            || typeof input.revision_id !== "string"
            || !input.project
            || typeof input.project !== "object"
            || Array.isArray(input.project)
          ) {
            return "Error: presentation update requires artifact_id, revision_id, and project.";
          }
          const details = updatePresentationArtifact(home, {
            artifactId: input.artifact_id,
            baseRevisionId: input.revision_id,
            project: input.project,
            actor: "agent",
            ...(ctx.sessionId ? { taskRunId: ctx.sessionId } : {}),
          });
          ctx.ui?.surface?.({
            kind: "presentation",
            title: details.artifact.title,
            resource: {
              type: "artifact",
              artifactId: details.artifact.artifactId,
              revisionId: details.currentRevision.revisionId,
            },
          });
          ctx.ui?.notice(`Presentation updated: ${details.artifact.title} (${details.artifact.artifactId})`);
          return result({
            artifact: details.artifact,
            currentRevision: details.currentRevision,
            content: details.content,
            slideCount: details.project.slides.length,
          });
        }
        case "list": {
          const listed = listArtifacts(home);
          return result({
            presentations: listed.artifacts.filter((artifact) => artifact.kind === "presentation"),
            invalid: listed.invalid,
            truncated: listed.truncated,
          });
        }
        case "get": {
          if (typeof input.artifact_id !== "string") {
            return "Error: presentation get requires artifact_id.";
          }
          const details = getPresentationArtifact(
            home,
            input.artifact_id,
            typeof input.revision_id === "string" ? input.revision_id : undefined,
          );
          return result(details);
        }
        case "validate": {
          if (typeof input.artifact_id !== "string" || typeof input.revision_id !== "string") {
            return "Error: presentation validate requires artifact_id and revision_id.";
          }
          return result({
            report: validatePresentationArtifact(home, {
              artifactId: input.artifact_id,
              revisionId: input.revision_id,
            }),
          });
        }
        case "preview": {
          if (typeof input.artifact_id !== "string" || typeof input.revision_id !== "string") {
            return "Error: presentation preview requires artifact_id and revision_id.";
          }
          return result(createPresentationPreviewFile(home, {
            artifactId: input.artifact_id,
            revisionId: input.revision_id,
          }));
        }
        case "export": {
          if (
            typeof input.artifact_id !== "string"
            || typeof input.revision_id !== "string"
            || typeof input.destination_path !== "string"
            || (input.format !== "json" && input.format !== "html" && input.format !== "pptx")
          ) {
            return "Error: presentation export requires artifact_id, revision_id, destination_path, and format.";
          }
          const report = validatePresentationArtifact(home, {
            artifactId: input.artifact_id,
            revisionId: input.revision_id,
          });
          if (report.status !== "pass") return result({ report, exported: false });
          const receipt = await exportPresentationArtifact(home, {
            artifactId: input.artifact_id,
            revisionId: input.revision_id,
            validationReportId: report.reportId,
            destinationPath: input.destination_path,
            format: input.format,
          });
          return result({ report, receipt, exported: true });
        }
        default:
          return "Error: unknown presentation action.";
      }
    } catch (error: any) {
      return `Error: ${String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000)}`;
    }
  },
});
