// The /model picker: ↑↓ choose a model (from the key's live /models list), ←→ set the thinking level for
// this endpoint, ⏎ apply, esc cancel. Built on the provider registry — the reasoning STYLE (from the
// endpoint) decides which levels ←→ offers. The nav math is pure + exported for tests; the component is a
// thin ink shell over it (like the Transcript overlay).
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { supportsReasoningStyle, type ReasoningStyle, type Effort } from "../providers/reasoning.js";

/** The levels ←→ cycles for a style. Binary thinking toggles (DashScope enable_thinking, Ollama think)
 *  show off/on; graded styles (OpenAI/Anthropic effort/budget) show the full dial; `none` → no control. */
export function levelsFor(style: ReasoningStyle, model = ""): Effort[] {
  if (!supportsReasoningStyle(style, model)) return [];
  if (style === "enable_thinking" || style === "ollama_think") return ["off", "high"]; // "high" renders as "on"
  if (style === "deepseek") return ["off", "low", "medium", "high", "max"]; // DeepSeek V4 honors a real "max"
  return ["off", "low", "medium", "high"];
}

/** Label a level for display — binary styles read as on/off, graded ones as the level name. */
export function levelLabel(style: ReasoningStyle, e: Effort): string {
  if (style === "enable_thinking" || style === "ollama_think") return e === "off" ? "off" : "on";
  return String(e);
}

export interface PickerState {
  modelIdx: number;
  effort: Effort;
}

/** Pure navigation: ↑↓ moves through models (wrapping); ←→ cycles the thinking level for the endpoint's
 *  style. No-ops when there are no models / the style has no levels. Exported for tests. */
export function movePicker(
  s: PickerState,
  key: "up" | "down" | "left" | "right",
  modelCount: number,
  style: ReasoningStyle,
  model = "",
): PickerState {
  if (key === "up" || key === "down") {
    if (modelCount <= 0) return s;
    const d = key === "down" ? 1 : -1;
    return { ...s, modelIdx: (s.modelIdx + d + modelCount) % modelCount };
  }
  const levels = levelsFor(style, model);
  if (!levels.length) return s;
  const cur = Math.max(0, levels.indexOf(s.effort));
  const d = key === "right" ? 1 : -1;
  return { ...s, effort: levels[(cur + d + levels.length) % levels.length] };
}

export function ModelPicker({
  models,
  style,
  current,
  effort,
  onSelect,
  onCancel,
}: {
  models: string[];
  /** reasoning style for this endpoint (from the registry) — decides the ←→ levels */
  style: ReasoningStyle;
  /** the currently-active model id, to open the cursor on it */
  current?: string;
  /** the current session reasoning dial, to open the ←→ on it */
  effort: Effort;
  onSelect: (model: string, effort: Effort) => void;
  onCancel: () => void;
}) {
  const start = Math.max(0, models.indexOf(current ?? ""));
  const [s, setS] = useState<PickerState>({ modelIdx: start, effort });
  const selectedModel = models[s.modelIdx] ?? current ?? "";
  const levels = levelsFor(style, selectedModel);
  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onSelect(selectedModel, levels.length ? s.effort : undefined);
    if (key.upArrow) setS((p) => movePicker(p, "up", models.length, style));
    else if (key.downArrow) setS((p) => movePicker(p, "down", models.length, style));
    else if (key.leftArrow) setS((p) => movePicker(p, "left", models.length, style, selectedModel));
    else if (key.rightArrow) setS((p) => movePicker(p, "right", models.length, style, selectedModel));
  });

  const hasLevels = levels.length > 0;
  const dial = hasLevels ? `thinking ◀ ${levelLabel(style, s.effort)} ▶` : "";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">{`  pick a model  ·  ↑↓ model  ·  ${hasLevels ? "←→ thinking  ·  " : ""}⏎ apply  ·  esc`}</Text>
      {models.length === 0 ? (
        <Text dimColor>{"   (this endpoint doesn't list models — use /model <id> to set one directly)"}</Text>
      ) : (
        models.map((m, i) => {
          const on = i === s.modelIdx;
          return (
            <Box key={m}>
              <Text color={on ? "cyan" : undefined} bold={on}>{(on ? " ❯ " : "   ") + m}</Text>
              {on && hasLevels ? <Text dimColor>{"   " + dial}</Text> : null}
            </Box>
          );
        })
      )}
    </Box>
  );
}
