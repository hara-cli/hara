import { homedir } from "node:os";
import { isAbsolute } from "node:path";
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
    + "Work as a Presentation specialist: infer a minimal audience/purpose/source brief, ask only for missing facts "
    + "that materially change the result, then create an editable draft early and offer its exact Artifact revision "
    + "to Hara Desktop's right work surface. The offer is not proof that a Desktop loaded or displayed it; only the "
    + "Desktop host may report that UI state. "
    + "Give every slide one narrative job, one evidence-backed claim, one short takeaway title, unique slide/block ids, "
    + "and usually 2–3 visible top-level blocks (normally no more than four and never more than six). Title, claim, "
    + "evidence, and action must play distinct semantic roles: do not paraphrase the same fact across them, do not add "
    + "generic heading blocks such as Problem Statement or Key Points, and keep background detail in speaker notes. "
    + "Target 8–16 Chinese characters or 5–10 English words for a title, 15–32 Chinese characters for a claim, at most "
    + "four list items, and at most two body blocks on a statement page. Write audience-facing copy only; never expose "
    + "agent plans, tool results, Artifact/revision/surface state, validation codes, or production scaffolding unless the "
    + "user explicitly requests a technical deck about those internals. Record external sources in notes and never invent "
    + "evidence. Choose a "
    + "deliberate layout template independently from the color theme: pitch for a persuasive proposal, report for evidence "
    + "and charts, technical for architecture/process detail, or visual for image-led storytelling. Vary the content "
    + "composition: statement, data, process, visual, split, or editorial pages must not repeat one default card grid. Use "
    + "native chart data for real comparisons; use flow/diagram/columns for processes and architecture; use images only when "
    + "the user supplied a real bounded raster image, otherwise keep an honest image placeholder. Revise the same Artifact "
    + "instead of creating parallel copies. If validation reports layout density, title, list, composite, or chart findings, "
    + "shorten content, split the slide, or choose a roomier template; never repeat the same rejected dense project. "
    + "Always validate the exact revision before export. A surface offer only proves that Desktop was notified; do not say "
    + "the right surface is open or visible until the Desktop host reports the exact revision as active. Ordinary PPT work "
    + "must not configure or invoke a separate vision "
    + "helper; image-based review is optional and only for an explicit request with a natively image-capable main model. "
    + "Import accepts controlled Slidev Markdown or Hara presentation JSON. Export supports editable PPTX, self-contained "
    + "HTML (also browser Print/Save PDF), and canonical JSON.",
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
            description: "Optional shared visual theme used by Desktop HTML and editable PPTX",
            additionalProperties: false,
            properties: {
              preset: {
                type: "string",
                enum: ["editorial", "midnight", "signal", "calm"],
                description: "Select deliberately from editorial, midnight, signal, or calm",
              },
            },
          },
          template: {
            type: "object",
            description:
              "Optional layout geometry, independent from theme colors. Choose for the story and content density.",
            additionalProperties: false,
            properties: {
              preset: {
                type: "string",
                enum: ["pitch", "report", "technical", "visual"],
                description:
                  "pitch=persuasive proposal; report=evidence/charts; technical=process/architecture; visual=image-led",
              },
            },
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
                  description:
                    "The concise evidence-backed assertion this slide proves; add scope or evidence and never restate the title",
                },
                takeawayTitle: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Audience-facing conclusion shown as the slide title; target 8–16 Chinese characters or 5–10 English words",
                },
                notes: {
                  type: "string",
                  description: "Optional speaker notes for sources, background, caveats, and details that should not crowd the slide",
                },
                blocks: {
                  type: "array",
                  minItems: 1,
                  maxItems: 6,
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
                          + "chart uses {chartType:bar|line|area|pie|doughnut,title?,categories,series:[{name,values}]}; "
                          + "compare/columns use {left:{title,description?,items?},right:{title,description?,items?}}; "
                          + "timeline/flow/diagram/group use {items:[{title or text,description?,items?}]}; image uses "
                          + "{src:data:image/(png|jpeg|webp|gif);base64,...,alt,caption?} or an honest {alt,caption?} placeholder.",
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
    const home = typeof ctx.stateHome === "string" && isAbsolute(ctx.stateHome)
      ? ctx.stateHome
      : homedir();
    try {
      switch (input.action) {
        case "create": {
          const details = createPresentationArtifact(home, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.project !== undefined ? { project: input.project } : {}),
            actor: "agent",
            ...(ctx.sessionId ? { taskRunId: ctx.sessionId } : {}),
          });
          const surfaceOffer = typeof ctx.ui?.surface === "function" ? "offered" : "unavailable";
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
            surfaceOffer: {
              status: surfaceOffer,
              meaning: surfaceOffer === "offered"
                ? "The host was notified about this exact Artifact revision; this does not prove that it loaded, became visible, or is the active tab."
                : "No persistent visual host was attached. The Artifact still exists and can be opened from Hara Office.",
            },
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
          const surfaceOffer = typeof ctx.ui?.surface === "function" ? "offered" : "unavailable";
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
            surfaceOffer: {
              status: surfaceOffer,
              meaning: surfaceOffer === "offered"
                ? "The host was notified about this exact Artifact revision; this does not prove that it loaded, became visible, or is the active tab."
                : "No persistent visual host was attached. The Artifact still exists and can be opened from Hara Office.",
            },
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
          const surfaceOffer = typeof ctx.ui?.surface === "function" ? "offered" : "unavailable";
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
            surfaceOffer: {
              status: surfaceOffer,
              meaning: surfaceOffer === "offered"
                ? "The host was notified about this exact Artifact revision; this does not prove that it loaded, became visible, or is the active tab."
                : "No persistent visual host was attached. The Artifact still exists and can be opened from Hara Office.",
            },
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
          const preview = createPresentationPreviewFile(home, {
            artifactId: input.artifact_id,
            revisionId: input.revision_id,
          });
          return result({
            ...preview,
            previewFileCreated: true,
            openedInDesktop: false,
            meaning: "A private HTML preview file was created. This action does not open, load, or activate a Desktop work surface.",
          });
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
