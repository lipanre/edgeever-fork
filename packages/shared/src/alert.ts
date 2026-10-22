import {
  InputRule,
  mergeAttributes,
  Node,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownRendererHelpers,
  type MarkdownToken,
} from "@tiptap/core";

export const ALERT_NODE_TYPE = "edgeeverAlert";
export const ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const ALERT_LABELS: Record<AlertKind, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const ALERT_START_PATTERN = /^ {0,3}>[ \t]?\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/im;
const BLOCKQUOTE_LINE_PATTERN = /^ {0,3}>/;
const BLOCKQUOTE_PREFIX_PATTERN = /^ {0,3}>[ \t]?/;
const ALERT_INPUT_PATTERN = /\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;

export const normalizeAlertKind = (value: unknown): AlertKind => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ALERT_KINDS.includes(normalized as AlertKind) ? normalized as AlertKind : "note";
};

/** Removes a leading GitHub alert marker from a legacy blockquote text node. */
export const stripAlertMarker = (text: string) => {
  const match = /^[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*(?:\r?\n|$))/i.exec(text);
  if (!match) return null;
  return {
    kind: normalizeAlertKind(match[1]),
    text: text.slice(match[0].length),
  };
};

const parseAlertMarkdown = (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
  const content = helpers.parseChildren(token.tokens || []);
  return helpers.createNode(
    ALERT_NODE_TYPE,
    { kind: normalizeAlertKind(token.kind) },
    content.length > 0 ? content : [{ type: "paragraph" }],
  );
};

const renderAlertMarkdown = (node: JSONContent, helpers: MarkdownRendererHelpers) => {
  const kind = normalizeAlertKind(node.attrs?.kind);
  const body = helpers.renderChildren(node.content ?? [], "\n\n").trim();
  const quotedBody = body
    ? body.split("\n").map((line) => line ? `> ${line}` : ">").join("\n")
    : "";
  return `> [!${kind.toUpperCase()}]${quotedBody ? `\n${quotedBody}` : ""}`;
};

export const EdgeEverAlert = Node.create({
  name: ALERT_NODE_TYPE,
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (element: HTMLElement) => normalizeAlertKind(element.getAttribute("data-edgeever-alert")),
        renderHTML: (attributes: { kind?: string }) => ({
          "data-edgeever-alert": normalizeAlertKind(attributes.kind),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "blockquote[data-edgeever-alert]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = normalizeAlertKind(node.attrs.kind);
    return [
      "blockquote",
      mergeAttributes(HTMLAttributes, {
        class: `edgeever-alert edgeever-alert--${kind}`,
        "data-edgeever-alert": kind,
        "data-edgeever-alert-label": ALERT_LABELS[kind],
      }),
      0,
    ];
  },

  parseMarkdown: parseAlertMarkdown,
  renderMarkdown: renderAlertMarkdown,
  addInputRules() {
    return [
      new InputRule({
        find: ALERT_INPUT_PATTERN,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          if (range.from !== $from.start()) return null;

          let depth = $from.depth;
          while (depth > 0 && $from.node(depth).type.name !== "blockquote") depth -= 1;
          if (depth === 0) return null;

          state.tr.setNodeMarkup($from.before(depth), this.type, {
            kind: normalizeAlertKind(match[1]),
          });
          state.tr.delete(range.from, range.to);
        },
      }),
    ];
  },
  markdownTokenizer: {
    name: ALERT_NODE_TYPE,
    level: "block",
    start(source: string) {
      return source.match(ALERT_START_PATTERN)?.index ?? -1;
    },
    tokenize(source: string, _tokens, lexer) {
      const normalized = source.replace(/\r\n?/g, "\n");
      const lines = normalized.split("\n");
      const marker = /^ {0,3}>[ \t]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i.exec(lines[0] || "");
      if (!marker) return undefined;

      let end = 1;
      while (end < lines.length && BLOCKQUOTE_LINE_PATTERN.test(lines[end])) end += 1;

      const body = lines
        .slice(1, end)
        .map((line) => line.replace(BLOCKQUOTE_PREFIX_PATTERN, ""))
        .join("\n");

      return {
        type: ALERT_NODE_TYPE,
        raw: lines.slice(0, end).join("\n"),
        kind: normalizeAlertKind(marker[1]),
        tokens: lexer.blockTokens(body),
      };
    },
  },
});
