import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Markdown alert styles", () => {
  test("covers desktop and mobile-rich-text editors", () => {
    const styles = read("./markdown-alert.css");
    expect(styles).toContain(".ProseMirror blockquote[data-edgeever-alert]");
    expect(styles).toContain(".edgeever-mobile-tiptap-content blockquote[data-edgeever-alert]");
    expect(styles).toContain('content: attr(data-edgeever-alert-label)');
  });

  test("is loaded by both Web editor entrypoints", () => {
    expect(read("./globals.css")).toContain('@import "./markdown-alert.css";');
    expect(read("../mobile-edit.tsx")).toContain('import "./styles/markdown-alert.css";');
  });
});
