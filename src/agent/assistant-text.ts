const REASONING_TAG = /^<\s*(\/?)\s*(think(?:ing)?)\s*>$/iu;
const REASONING_TAG_FORMS = ["<think>", "</think>", "<thinking>", "</thinking>"];

function couldBecomeReasoningTag(value: string): boolean {
  const compact = value.toLocaleLowerCase().replace(/\s+/gu, "");
  return compact.length > 0 && REASONING_TAG_FORMS.some((tag) => tag.startsWith(compact));
}

/**
 * Provider-neutral privacy boundary for models/proxies that incorrectly put private reasoning tags in
 * ordinary assistant text. It recognizes tags only at the start of a logical line (or while already
 * suppressing a reasoning block), so inline documentation such as `` `<think>` `` remains intact.
 *
 * The parser is incremental: a tag may be split across arbitrary stream chunks, and neither the tag nor
 * the text inside an opening/closing pair is emitted or persisted.
 */
export class AssistantTextSanitizer {
  private pending = "";
  private hiddenDepth = 0;
  private lineHasContent = false;
  private safeText = "";

  push(delta: string): string {
    if (!delta) return "";
    this.pending += delta;
    return this.drain(false);
  }

  finish(): string {
    return this.drain(true);
  }

  get text(): string {
    return this.safeText;
  }

  private consume(value: string): string {
    const visible = this.hiddenDepth === 0 ? value : "";
    // Hidden reasoning is not visible line content. Keeping it out of this state also lets consecutive
    // orphan closers at the same boundary be removed instead of exposing the second and later tags.
    if (visible) {
      for (const char of value) {
        if (char === "\n" || char === "\r") this.lineHasContent = false;
        else if (!/\s/u.test(char)) this.lineHasContent = true;
      }
    }
    return visible;
  }

  private drain(final: boolean): string {
    let emitted = "";
    while (this.pending) {
      const tagStart = this.pending.indexOf("<");
      if (tagStart < 0) {
        emitted += this.consume(this.pending);
        this.pending = "";
        break;
      }
      if (tagStart > 0) {
        emitted += this.consume(this.pending.slice(0, tagStart));
        this.pending = this.pending.slice(tagStart);
        continue;
      }

      const mayBeBoundaryTag = this.hiddenDepth > 0 || !this.lineHasContent;
      const tagEnd = this.pending.indexOf(">");
      if (tagEnd < 0) {
        const potentialTag = mayBeBoundaryTag && couldBecomeReasoningTag(this.pending);
        if (!potentialTag) {
          emitted += this.consume("<");
          this.pending = this.pending.slice(1);
          continue;
        }
        if (!final) break;
        // A provider that ends in a truncated private tag must not leak that fragment. Inside a private
        // block every unterminated tail remains private as well.
        this.pending = "";
        break;
      }

      const candidate = this.pending.slice(0, tagEnd + 1);
      const match = mayBeBoundaryTag ? REASONING_TAG.exec(candidate) : null;
      if (match) {
        if (match[1]) this.hiddenDepth = Math.max(0, this.hiddenDepth - 1);
        else this.hiddenDepth += 1;
        this.pending = this.pending.slice(tagEnd + 1);
        continue;
      }

      emitted += this.consume("<");
      this.pending = this.pending.slice(1);
    }
    this.safeText += emitted;
    return emitted;
  }
}

export function sanitizeAssistantText(value: string): string {
  const sanitizer = new AssistantTextSanitizer();
  return sanitizer.push(value) + sanitizer.finish();
}
