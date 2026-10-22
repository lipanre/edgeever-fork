import { markdownToDoc, type TiptapNode } from "@edgeever/shared";

const hasMarkdownSemantics = (nodes: TiptapNode[]): boolean => nodes.some((node) => {
  if (node.type !== "paragraph") return true;

  return (node.content ?? []).some((child) => {
    if (child.type !== "text") return true;
    return Boolean(("marks" in child ? child.marks : undefined)?.length);
  });
});

/**
 * Convert pasted Markdown source only when parsing produces rich-text semantics.
 * Plain text and incidental punctuation remain on TipTap's native paste path.
 */
export const getMarkdownPasteContent = (text: string): TiptapNode[] | null => {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return null;

  try {
    const document = markdownToDoc(normalized);
    if (!hasMarkdownSemantics(document.content)) return null;

    if (document.content.length === 1 && document.content[0].type === "paragraph") {
      return document.content[0].content ?? null;
    }

    return document.content;
  } catch {
    // Clipboard text is untrusted; fall back to ProseMirror's native paste.
    return null;
  }
};
