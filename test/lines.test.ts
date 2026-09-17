import { describe, expect, test } from "bun:test";
import { lineCriteria, renderTagged, tagLines, windowDescription, windowLines } from "../src/core/lines.ts";
import { LIMITS } from "../src/core/validate.ts";

const document = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

describe("tagLines", () => {
  test("line numbers are 1-based while ids start at zero", () => {
    const tagged = tagLines("alpha\nbeta\ngamma");
    expect(tagged).toHaveLength(3);
    expect(tagged[0]).toMatchObject({ id: "L000", number: 1, text: "alpha" });
    expect(tagged[2]).toMatchObject({ id: "L002", number: 3, text: "gamma" });
  });

  test("a single trailing newline does not produce a phantom final line", () => {
    expect(tagLines("alpha\nbeta\n")).toHaveLength(2);
  });

  test("interior blank lines are preserved, since they carry structure", () => {
    const tagged = tagLines("alpha\n\nbeta");
    expect(tagged).toHaveLength(3);
    expect(tagged[1]?.text).toBe("");
  });

  test("ids are padded to a uniform width so they sort lexically", () => {
    const tagged = tagLines(document(1200));
    expect(tagged[0]?.id).toBe("L0000");
    expect(tagged[1199]?.id).toBe("L1199");
    const widths = new Set(tagged.map((line) => line.id.length));
    expect(widths.size).toBe(1);
  });

  test("the prefix is configurable", () => {
    expect(tagLines("a\nb", "C")[1]?.id).toBe("C001");
  });
});

describe("renderTagged and lineCriteria", () => {
  test("rendering prefixes each line with its id", () => {
    expect(renderTagged(tagLines("alpha\nbeta"))).toBe("L000| alpha\nL001| beta");
  });

  test("criteria descriptions stay null, because the state already carries the text", () => {
    const criteria = lineCriteria(tagLines("alpha\nbeta"));
    expect(criteria).toEqual({ L000: null, L001: null });
  });
});

describe("windowLines", () => {
  test("a document within the option limit is one window", () => {
    const windows = windowLines(tagLines(document(100)));
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ id: "W00", from: 1, to: 100 });
  });

  test("exactly 255 lines still fits in a single window", () => {
    const windows = windowLines(tagLines(document(LIMITS.MAX_CHOICE_OPTIONS)));
    expect(windows).toHaveLength(1);
  });

  test("256 lines splits, and every window fits one choice question", () => {
    const windows = windowLines(tagLines(document(LIMITS.MAX_CHOICE_OPTIONS + 1)));
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) {
      expect(window.lines.length).toBeLessThanOrEqual(LIMITS.MAX_CHOICE_OPTIONS);
    }
  });

  test("windows tile the document with no gap and no overlap", () => {
    const lines = tagLines(document(1000));
    const windows = windowLines(lines, 60);
    expect(windows[0]?.from).toBe(1);
    expect(windows[windows.length - 1]?.to).toBe(1000);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]?.from).toBe((windows[i - 1]?.to ?? 0) + 1);
    }
    expect(windows.reduce((n, w) => n + w.lines.length, 0)).toBe(1000);
  });

  test("the window count itself fits one choice, so the first pass is askable", () => {
    // 255 * 255 = 65025 lines is the largest a two-pass search can address.
    const windows = windowLines(tagLines(document(65_025)), 1);
    expect(windows.length).toBeLessThanOrEqual(LIMITS.MAX_CHOICE_OPTIONS);
    for (const window of windows) {
      expect(window.lines.length).toBeLessThanOrEqual(LIMITS.MAX_CHOICE_OPTIONS);
    }
  });

  test("an oversized or nonsensical window size is clamped rather than trusted", () => {
    expect(windowLines(tagLines(document(300)), 10_000)[0]?.lines.length).toBeLessThanOrEqual(
      LIMITS.MAX_CHOICE_OPTIONS,
    );
    expect(windowLines(tagLines(document(10)), 0)).toHaveLength(10);
  });

  test("window ids are zero-padded and sequential", () => {
    const windows = windowLines(tagLines(document(500)), 100);
    expect(windows.map((w) => w.id)).toEqual(["W00", "W01", "W02", "W03", "W04"]);
  });
});

describe("windowDescription", () => {
  test("the range is always present and a preview is added when there is text", () => {
    const [window] = windowLines(tagLines("alpha\nbeta\ngamma\ndelta"), 4);
    const text = windowDescription(window!);
    expect(text).toContain("Lines 1-4");
    expect(text).toContain("alpha");
  });

  test("a window of only blank lines degrades to the range alone", () => {
    const [window] = windowLines(tagLines("\n\n\n"), 4);
    expect(windowDescription(window!)).toMatch(/^Lines \d+-\d+$/);
  });
});
