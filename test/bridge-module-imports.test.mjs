import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { staticImportSpecifiers } from "../scripts/lib/bridge-module-imports.mjs";

const TICK = "`";

function check(table) {
  for (const [label, source, expected] of table) {
    assert.deepEqual(staticImportSpecifiers(source), expected, label);
  }
}

test("every form of static import and re-export yields its specifier", () => {
  check([
    ["a side-effect import", `import "a";`, ["a"]],
    ["a default import", `import a from "a";`, ["a"]],
    ["named imports with a rename, in single quotes", `import { a, b as c } from 'x';`, ["x"]],
    ["a namespace import", `import * as ns from "x";`, ["x"]],
    ["a default and named import", `import a, { b } from "x";`, ["x"]],
    ["a default and namespace import", `import a, * as ns from "x";`, ["x"]],
    ["a star re-export", `export * from "x";`, ["x"]],
    ["a namespace re-export", `export * as ns from "x";`, ["x"]],
    ["a named re-export", `export { a, b as c } from "x";`, ["x"]],
    ["a re-export of the default", `export { default } from "x";\nexport { default as d } from "y";`, ["x", "y"]],
    ["import attributes after the specifier", `import data from "./d.json" with { type: "json" };`, ["./d.json"]],
    ["names that are contextual words", `import { from } from "a";\nimport from from "b";\nexport { x as from } from "c";`, ["a", "b", "c"]],
    ["no semicolons, one declaration per line", `import a from "a"\nimport b from "b"\nexport default a`, ["a", "b"]],
    ["a declaration split across lines", `import {\n  a,\n  b\n} from\n  "x"`, ["x"]],
    ["declarations after code and blocks", `function f() { return 1 }\nconst o = { a: 1 };\nimport a from "a";`, ["a"]],
    ["source order", `import a from "1";\nexport * from "2";\nimport "3";`, ["1", "2", "3"]]
  ]);
});

test("what looks like a declaration but names no specifier yields nothing", () => {
  check([
    ["a dynamic import", `const m = await import("x");`, []],
    ["a dynamic import inside a function", `export default { observe() { return import("x"); } };`, []],
    ["import.meta", `const here = import.meta.url;`, []],
    ["a property named import or export", `obj.import = 1;\nobj.export = 2;\nx?.import;`, []],
    ["keys named import and export", `const o = { import: "a", export: "b" };`, []],
    ["methods named import and export", `class A { import() {} export() {} }`, []],
    ["exports that re-export nothing", [
      "export default function () {}", "export const a = 1;", "export function f() {}", "export class A {}",
      "export { a };", "export { a, b as c };", "export {};"
    ].join("\n"), []],
    ["an export default of an object", `export default { apiVersion: 1 };`, []],
    ["an import call inside a block", `if (x) { import("y"); }`, []],
    ["an export that is followed by an import", `export { a }\nimport b from "b"`, ["b"]]
  ]);
});

test("text that only looks like a declaration is not one", () => {
  const text = "import helper from 'file:///example.mjs'";
  check([
    ["a double-quoted string after a brace", `const o = { text: "{ ${text}" };`, []],
    ["a string after a semicolon", `const s = "a; ${text}";`, []],
    ["a single-quoted string with an escaped quote", `const s = 'it\\'s; import helper from "file:///example.mjs"';`, []],
    ["a template line", `const s = ${TICK}\n${text}\n${TICK};`, []],
    ["a template inside a template substitution", `const s = ${TICK}a \${ ${TICK}\n${text}\n${TICK} } b${TICK};`, []],
    ["a template whose substitutions hold a backtick string and braces",
      `const s = ${TICK}a \${ "${TICK}" } \${ { k: "}" }.k } ${text}${TICK};`, []],
    ["a template followed by a real import", `const s = ${TICK}${text}${TICK};\nimport real from "r";`, ["r"]],
    ["a template substitution followed by a real import", `const s = ${TICK}a \${ 1 } b${TICK}; import real from "r";`, ["r"]],
    ["a block comment", `/*\n ${text}\n*/`, []],
    ["a line comment", `// ${text}\nconst a = 1;`, []],
    ["a comment holding quotes and backticks", `/* it's "quoted" ${TICK}ticks${TICK} */`, []],
    ["an unterminated block comment", `/* ${text}`, []],
    ["a block comment before a real import on its line", `/* c */ import real from "r";`, ["r"]],
    ["a block comment between the tokens of a real import", `import/* a */{ real }/* b */from/* c */"r";`, ["r"]],
    ["a line comment inside a multi-line import", `import {\n  a, // the helper\n  b /* unused */\n} from "r";`, ["r"]]
  ]);
});

test("a slash starts a regular expression or divides, by what precedes it", () => {
  const real = ` import a from "x";`;
  check([
    ["a regular expression holding a quote", `const re = /'/;${real}`, ["x"]],
    ["a regular expression holding a quote and a slash in a class", `const re = /[/]'/g;${real}`, ["x"]],
    ["a regular expression after an if head", `if (x) /'/.test(y);${real}`, ["x"]],
    ["a regular expression after return", `function f() { return /'/.test(y); }${real}`, ["x"]],
    ["a regular expression after a block", `{ }\n/'/.test(s);${real}`, ["x"]],
    ["a regular expression as an argument", `check(/'/, 1);${real}`, ["x"]],
    ["a regular expression with flags", `const re = /a/gi;${real}`, ["x"]],
    ["a division of numbers", `const h = 4 / 2; const s = "x";${real} const k = 8 / 2;`, ["x"]],
    ["a division of a call", `const h = f(1) / 2; const s = "x";${real} const k = 8 / 2;`, ["x"]],
    ["a division of an index", `const h = a[0] / 2; const s = "x";${real} const k = 8 / 2;`, ["x"]],
    ["a division after a postfix increment", `i++ / 2;${real} j++ / 3;`, ["x"]],
    ["a division after an object literal", `const o = { a: 1 } / 2;${real} const k = 8 / 2;`, ["x"]],
    ["a division assignment", `x /= 2;${real} y /= 3;`, ["x"]],
    ["a division with nothing to close a regular expression on its line", `const half = total / 2\n${real}`, ["x"]]
  ]);
});

test("any text is read without throwing, and a source cut short ends where the text does", () => {
  const cut = [
    "'abc", '"abc', `${TICK}abc`, `${TICK}abc \${ 1`, "/* abc", "// abc", "/abc", "/", TICK, "${", "}}))]]",
    "(".repeat(2000) + "import a from 'x'", "import", "import {", "import { a } from", "export * from", "\r\n\r\n"
  ];
  for (const source of cut) assert.ok(Array.isArray(staticImportSpecifiers(source)), JSON.stringify(source.slice(0, 24)));
  assert.deepEqual(staticImportSpecifiers(""), []);
  assert.deepEqual(staticImportSpecifiers("#!/usr/bin/env node\nimport a from 'x';"), ["x"], "a hashbang line is skipped");
  assert.deepEqual(staticImportSpecifiers("import a from 'x';\r\nimport b from 'y';\r\n"), ["x", "y"], "CRLF line endings");
  const separator = String.fromCharCode(0x2028);
  assert.deepEqual(staticImportSpecifiers(`// note${separator}import a from "x";`), ["x"], "a line separator ends a line comment");
  assert.deepEqual(staticImportSpecifiers(Buffer.from(`import a from "x";`)), ["x"], "bytes are read as UTF-8 text");
});

test("any input is tokenized to a list of strings", () => {
  fc.assert(fc.property(fc.string({ maxLength: 300 }), (source) => {
    const specifiers = staticImportSpecifiers(source);
    return Array.isArray(specifiers) && specifiers.every((specifier) => typeof specifier === "string");
  }), { numRuns: 300 });
});

test("text in a string, a template or a comment is never listed, whatever surrounds it", () => {
  const inner = fc.stringMatching(/^[a-z0-9:._-]{0,24}$/);
  const decoys = [
    (value) => `const s = "{ import x from '${value}'; export * from '${value}'";`,
    (value) => `const s = '{ import x from "${value}"; export * from "${value}"';`,
    (value) => `const s = ${TICK}{ import x from '${value}'\nexport * from "${value}"${TICK};`,
    (value) => `/* { import x from '${value}'\nexport * from "${value}" */`,
    (value) => `// { import x from '${value}'; export * from "${value}"\n`
  ];
  fc.assert(fc.property(inner, fc.integer({ min: 0, max: decoys.length - 1 }), (value, which) => {
    const decoy = decoys[which](value);
    assert.deepEqual(staticImportSpecifiers(decoy), [], decoy);
    assert.deepEqual(staticImportSpecifiers(`${decoy}\nimport real from "r";`), ["r"], decoy);
  }), { numRuns: 200 });
});

test("comments and line breaks may sit between any two tokens of a declaration", () => {
  const word = fc.constantFrom(" ", "\n", "/* note */", "// note\n");
  const gap = fc.constantFrom("", " ", "\n", "/* note */", "// note\n", "/*\n*/", " /* it's */ ");
  fc.assert(fc.property(word, fc.array(gap, { minLength: 7, maxLength: 7 }), (first, gaps) => {
    const [g1, g2, g3, g4, g5, g6, g7] = gaps;
    const imported = `import${first}a${g1},${g2}{${g3}b${g4}}${g5}from${g6}'x'${g7};`;
    assert.deepEqual(staticImportSpecifiers(imported), ["x"], imported);
    const reexported = `export${g1}*${g2}from${g3}"y"${g4};`;
    assert.deepEqual(staticImportSpecifiers(reexported), ["y"], reexported);
  }), { numRuns: 200 });
});
