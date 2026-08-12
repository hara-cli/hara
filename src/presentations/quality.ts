import type { ArtifactFinding } from "../artifacts/store.js";
import type { PresentationBlock, PresentationProject, PresentationSlide } from "@nanhara/hara-presentation";

const GENERIC_HEADINGS = new Set([
  "问题陈述", "主要观点", "核心观点", "关键点", "重点", "内容", "正文", "概述", "总结",
  "problemstatement", "keypoints", "mainpoints", "overview", "summary", "content", "evidence",
]);
const VISUAL_BLOCKS = new Set([
  "image", "table", "metric", "chart", "compare", "timeline", "flow", "diagram", "columns", "group",
]);

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .slice(0, 2_000);
}

function blockText(block: PresentationBlock): string {
  const value = block.literal;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(blockTextValue).filter(Boolean).join(" ");
  return blockTextValue(value);
}

function blockTextValue(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => blockTextValue(item, depth + 1)).filter(Boolean).join(" ");
  if (typeof value !== "object") return "";
  return Object.values(value as Record<string, unknown>)
    .map((item) => blockTextValue(item, depth + 1))
    .filter(Boolean)
    .join(" ");
}

function repeatsMessage(left: unknown, right: unknown): boolean {
  const a = normalizedText(left);
  const b = normalizedText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return shorter.length >= 8 && shorter.length / longer.length >= 0.72 && longer.includes(shorter);
}

function slidePath(slide: PresentationSlide): string {
  const safe = String(slide.id || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  return `slides/${safe || "unknown"}`;
}

function warning(
  code: string,
  message: string,
  slide?: PresentationSlide,
  suggestion?: string,
): ArtifactFinding {
  return {
    code,
    severity: "warning",
    message,
    ...(slide ? { path: slidePath(slide) } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}

function compositionSignature(slide: PresentationSlide): string {
  return slide.blocks
    .filter((block, index) => !(index === 0 && block.type === "heading" && repeatsMessage(block.literal, slide.takeawayTitle)))
    .map((block) => block.type)
    .join("+");
}

/** A deterministic authoring-quality gate for native, Agent-produced decks. It complements structural and
 * geometry validation: the renderer can fit repeated boilerplate perfectly, but it still should not ship. */
export function analyzePresentationNarrative(project: PresentationProject): ArtifactFinding[] {
  const findings: ArtifactFinding[] = [];
  const titleOwners = new Map<string, PresentationSlide>();

  for (const slide of project.slides) {
    if (repeatsMessage(slide.takeawayTitle, slide.claim)) {
      findings.push(warning(
        "PRESENTATION_NARRATIVE_DUPLICATE_MESSAGE",
        `${slide.id} repeats the same message in its title and claim.`,
        slide,
        "Use the title for the conclusion and the claim for distinct evidence, scope, or causality.",
      ));
    }

    const titleKey = normalizedText(slide.takeawayTitle);
    const previous = titleOwners.get(titleKey);
    if (titleKey && previous) {
      findings.push(warning(
        "PRESENTATION_NARRATIVE_REPEATED_TITLE",
        `${slide.id} repeats the takeaway title already used by ${previous.id}.`,
        slide,
        "Give each slide one distinct narrative job and conclusion.",
      ));
    } else if (titleKey) {
      titleOwners.set(titleKey, slide);
    }

    for (const block of slide.blocks) {
      const literalText = blockText(block);
      if (block.type === "heading" && GENERIC_HEADINGS.has(normalizedText(literalText))) {
        findings.push(warning(
          "PRESENTATION_NARRATIVE_GENERIC_HEADING",
          `${slide.id} uses the generic heading '${literalText.trim()}'.`,
          slide,
          "Replace it with audience-facing evidence or remove the redundant heading block.",
        ));
      }
      if (block.type === "heading" && repeatsMessage(literalText, slide.takeawayTitle)) {
        findings.push(warning(
          "PRESENTATION_NARRATIVE_REDUNDANT_HEADING",
          `${slide.id} repeats its takeaway title in a heading block.`,
          slide,
          "Remove the heading block; the slide title already supplies the hierarchy.",
        ));
      }
      if (["text", "callout", "quote"].includes(block.type) && repeatsMessage(literalText, slide.claim)) {
        findings.push(warning(
          "PRESENTATION_NARRATIVE_DUPLICATE_BODY",
          `${slide.id} repeats its claim in block ${block.id}.`,
          slide,
          "Use the body for proof, implications, examples, or the next action instead of restating the claim.",
        ));
      }
    }
  }

  if (project.slides.length >= 3) {
    for (let index = 0; index <= project.slides.length - 3; index += 1) {
      const window = project.slides.slice(index, index + 3);
      const signatures = window.map(compositionSignature);
      if (signatures[0] && signatures.every((signature) => signature === signatures[0])) {
        findings.push(warning(
          "PRESENTATION_NARRATIVE_REPETITIVE_COMPOSITION",
          `${window.map((slide) => slide.id).join(", ")} repeat the same ${signatures[0]} composition.`,
          window[1],
          "Vary the sequence with a data, process, visual, split, or statement slide that fits the story.",
        ));
        break;
      }
    }
  }

  if (
    project.slides.length >= 6
    && project.slides.every((slide) => slide.blocks.every((block) => !VISUAL_BLOCKS.has(block.type)))
  ) {
    findings.push(warning(
      "PRESENTATION_NARRATIVE_VISUAL_MONOTONY",
      "The deck has six or more slides but no data, process, comparison, image, or diagram composition.",
      undefined,
      "Use a chart for real data, a flow or diagram for structure, or a supplied image where it advances the story.",
    ));
  }

  return findings;
}
