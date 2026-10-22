import { describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { createEdgeEverDocumentExtensions } from "@edgeever/shared";
import { createEdgeEverMathematics } from "@edgeever/shared/mathematics";
import { ensureTestWindowDom } from "../../lib/restore-test-global.mjs";
import { getMarkdownPasteContent } from "./markdown-paste.ts";

const createEditor = () => {
  ensureTestWindowDom();
  return new Editor({
    extensions: createEdgeEverDocumentExtensions({
      mathematics: createEdgeEverMathematics(),
    }),
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "before after" }] }],
    },
  });
};

describe("Markdown paste detection", () => {
  test("returns inline Markdown nodes when formatting only applies inside a paragraph", () => {
    expect(getMarkdownPasteContent("See **bold** and [link](https://example.com)")).toEqual([
      { type: "text", text: "See " },
      { type: "text", text: "bold", marks: [{ type: "bold" }] },
      { type: "text", text: " and " },
      {
        type: "text",
        text: "link",
        marks: [{ type: "link", attrs: { href: "https://example.com", title: null } }],
      },
    ]);
  });

  test("returns block nodes for headings, lists, tables, and fenced code", () => {
    const source = [
      "# Title",
      "",
      "- one",
      "- two",
      "",
      "```js",
      "const value = 1",
      "```",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");

    expect(getMarkdownPasteContent(source)?.map((node) => node.type)).toEqual([
      "heading",
      "bulletList",
      "codeBlock",
      "table",
    ]);
  });

  test("leaves plain text, currency, and ordinary line breaks on the native paste path", () => {
    expect(getMarkdownPasteContent("")).toBeNull();
    expect(getMarkdownPasteContent("hello\nworld")).toBeNull();
    expect(getMarkdownPasteContent("The price is $100.")).toBeNull();
  });

  test("inserts parsed blocks into the active paragraph without leaving Markdown literals", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(8);

    const content = getMarkdownPasteContent("# Title\n\n- one\n- two");
    expect(content).not.toBeNull();
    expect(editor.commands.insertContent(content)).toBe(true);

    expect(editor.getJSON().content.map((node) => node.type)).toEqual([
      "paragraph",
      "heading",
      "bulletList",
      "paragraph",
    ]);
    expect(editor.getJSON().content[1].content).toEqual([{ type: "text", text: "Title" }]);
    editor.destroy();
  });

  test("inserts inline Markdown formatting at the active cursor", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(8);

    const content = getMarkdownPasteContent("See **bold**");
    expect(content).not.toBeNull();
    expect(editor.commands.insertContent(content)).toBe(true);

    expect(editor.getJSON().content).toEqual([{
      type: "paragraph",
      content: [
        { type: "text", text: "before See " },
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
        { type: "text", text: "after" },
      ],
    }]);
    editor.destroy();
  });
});
