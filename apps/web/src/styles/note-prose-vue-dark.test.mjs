import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Vue Dark note palette", () => {
  test("is available to the Web palette picker", () => {
    const noteProse = read("../../../../packages/shared/src/note-prose.ts");
    expect(noteProse).toContain('"vue-dark"');
    expect(noteProse).toContain('background: "#1F1F1F"');
  });

  test("is loaded by the Web stylesheet", () => {
    expect(read("./globals.css")).toContain('@import "./note-prose-vue-dark.css";');
  });

  test("preserves the upstream palette, font, and attribution", () => {
    const css = read("./note-prose-vue-dark.css");
    expect(css).toContain("blinkfox/typora-vue-theme");
    expect(css).toContain("Apache License, Version 2.0");
    expect(css).toContain('font-family: "Source Sans Pro"');
    expect(css).toContain("border-left: 4px solid var(--note-palette-accent)");
    expect(css).toContain("background: rgb(66 185 131 / 0.1)");
  });

  test("bundles Source Sans Pro and Roboto Mono font assets", () => {
    const fontsCss = read("./fonts/typora-vue-theme/fonts.css");
    const fontFiles = readdirSync(new URL("./fonts/typora-vue-theme", import.meta.url));
    expect(fontsCss).toContain("font-family: 'Source Sans Pro'");
    expect(fontsCss).toContain("font-family: 'Roboto Mono'");
    expect(fontFiles.filter((file) => file.endsWith(".woff2"))).toHaveLength(28);
  });
});
