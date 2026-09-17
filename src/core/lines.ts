import { LIMITS } from "./validate.ts";

/**
 * Line tagging and windowing, shared by `find` and `rank`.
 *
 * A Choice question accepts at most 255 options, so a document longer than that
 * cannot be ranked in one request. The published approach is two passes: one Choice
 * picks a window, a second ranks the lines inside it. Tagging every line with a short
 * id lets the model name a line without reproducing its text.
 */

export interface TaggedLine {
  /** Short stable id such as `L042`, used as a Choice option label. */
  id: string;
  /** 1-based line number in the original file. */
  number: number;
  text: string;
}

/** Number of digits needed so every id in a document of `count` lines is the same width. */
const idWidth = (count: number): number => Math.max(3, String(Math.max(0, count - 1)).length);

export function tagLines(text: string, prefix = "L"): TaggedLine[] {
  const raw = text.split("\n");
  // Drop a single trailing empty line produced by a final newline.
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  const width = idWidth(raw.length);
  return raw.map((line, index) => ({
    id: `${prefix}${String(index).padStart(width, "0")}`,
    number: index + 1,
    text: line,
  }));
}

/**
 * Render tagged lines into the single string sent as state.
 *
 * Blank lines are preserved as real gaps rather than tagged entries, so the model
 * still sees the document's paragraph structure.
 */
export function renderTagged(lines: readonly TaggedLine[]): string {
  return lines.map((line) => `${line.id}| ${line.text}`).join("\n");
}

/** Build the criteria map for a Choice over line ids. Descriptions stay null: the
 *  state already carries each line's text, so repeating it would double the cost. */
export function lineCriteria(lines: readonly TaggedLine[]): Record<string, null> {
  const criteria: Record<string, null> = {};
  for (const line of lines) criteria[line.id] = null;
  return criteria;
}

export interface Window {
  /** Label used as the Choice option for this window, e.g. `W00`. */
  id: string;
  lines: TaggedLine[];
  /** Inclusive 1-based line range covered, for display. */
  from: number;
  to: number;
}

/**
 * Split lines into windows small enough to fit one Choice question.
 *
 * The window count must itself fit within the option limit, otherwise the first pass
 * could not be asked either. `size` is clamped accordingly for very large files.
 */
export function windowLines(
  lines: readonly TaggedLine[],
  size: number = LIMITS.MAX_CHOICE_OPTIONS,
): Window[] {
  const max = LIMITS.MAX_CHOICE_OPTIONS;
  let effective = Math.min(Math.max(1, size), max);
  // Ensure the number of windows also fits in a single Choice.
  if (Math.ceil(lines.length / effective) > max) {
    effective = Math.ceil(lines.length / max);
  }

  const windows: Window[] = [];
  for (let start = 0; start < lines.length; start += effective) {
    const slice = lines.slice(start, start + effective);
    if (slice.length === 0) continue;
    windows.push({
      id: `W${String(windows.length).padStart(2, "0")}`,
      lines: slice,
      from: (slice[0] as TaggedLine).number,
      to: (slice[slice.length - 1] as TaggedLine).number,
    });
  }
  return windows;
}

/** Describe a window for the first-pass Choice criteria, using its line range and a preview. */
export function windowDescription(window: Window): string {
  const preview = window.lines
    .map((l) => l.text.trim())
    .filter((t) => t !== "")
    .slice(0, 3)
    .join(" / ");
  const head = `Lines ${window.from}-${window.to}`;
  return preview ? `${head}. Begins: ${preview.slice(0, 160)}` : head;
}
