// The module specifiers of a source text's static imports and re-exports, read by tokenizing the
// source just far enough to know what is code. Comments, string and template literals and regular
// expression literals are skipped, so text inside them is never taken for a declaration, and a
// declaration is recognised with comments or line breaks between its tokens.
//
// It is not a parser. It does not check that the source is valid, a dynamic import() is not listed,
// and a slash is told to start a regular expression rather than a division from the token before it,
// which is right for ordinary code. The extension loader uses it to word a message and to refuse the
// one import the module system accepts and should not: a static import by absolute file: URL.

// A slash after one of these words starts a regular expression; after any other word it divides.
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "default"
]);
// The `(` after one of these opens the head of a statement, so a slash after its `)` starts a regular expression.
const STATEMENT_HEAD_WORD = new Set(["if", "while", "for", "with"]);
// The `{` after one of these opens an object literal, whose `}` ends a value; elsewhere after a word it opens a block.
const OBJECT_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "yield", "await", "default"
]);
// What an import or export clause may hold between the keyword and its `from "specifier"`.
const CLAUSE_PUNCTUATION = new Set(["{", "}", ",", "*"]);
// Every other character that is not part of a word, a string, a template or a comment is one of these.
const PUNCTUATION = new Set([..."(){}[];,.:?!=<>+-*%&|^~@"]);
// The four line terminators of the language: line feed, carriage return, line separator, paragraph separator.
const LINE_BREAKS = new Set(["\n", "\r", String.fromCharCode(0x2028), String.fromCharCode(0x2029)]);

const isLineBreak = (c) => LINE_BREAKS.has(c);
const isWordCharacter = (c) => !/\s/.test(c) && !PUNCTUATION.has(c) && c !== "/" && c !== '"' && c !== "'" && c !== "`";

// The index of the line terminator that ends the line holding `from`, or the end of the text.
function lineEnd(text, from) {
  let end = from;
  while (end < text.length && !isLineBreak(text[end])) end += 1;
  return end;
}

function regexAllowed(previous) {
  if (previous === undefined) return true;
  if (previous.type === "word") return REGEX_AFTER_WORD.has(previous.value);
  if (previous.type !== "punct") return false;
  if (previous.value === ")" || previous.value === "}" || previous.value === "++" || previous.value === "--") {
    return previous.regexAfter === true;
  }
  return previous.value !== "]";
}

function opensBlock(previous) {
  if (previous === undefined) return true;
  if (previous.type === "word") return !OBJECT_AFTER_WORD.has(previous.value);
  return previous.type === "punct" && [";", "{", "}", ")", "=>"].includes(previous.value);
}

// The index after the string literal that starts at `start`; an unterminated one ends at its line.
function stringEnd(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    const c = text[index];
    if (c === "\\") index += 1;
    else if (c === quote) return { end: index + 1, terminated: true };
    else if (c === "\n" || c === "\r") return { end: index, terminated: false };
  }
  return { end: text.length, terminated: false };
}

// The index after the regular expression literal that starts at `start`, or -1 when the line ends
// first (then the slash was a division).
function regexEnd(text, start) {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const c = text[index];
    if (isLineBreak(c)) return -1;
    if (c === "\\") index += 1;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z]/.test(text[end])) end += 1;
      return end;
    }
  }
  return -1;
}

function tokenize(text) {
  const tokens = [];
  const stack = [];
  const add = (token) => {
    token.depth = stack.length;
    tokens.push(token);
    return token;
  };
  // Template text from `from` (after the opening backtick, or after the `}` that closes a
  // substitution) to the closing backtick or the next `${`, where code resumes.
  const scanTemplate = (from) => {
    for (let index = from; index < text.length; index += 1) {
      const c = text[index];
      if (c === "\\") index += 1;
      else if (c === "`") {
        add({ type: "template" });
        return index + 1;
      } else if (c === "$" && text[index + 1] === "{") {
        add({ type: "punct", value: "${" });
        stack.push({ template: true });
        return index + 2;
      }
    }
    add({ type: "template" });
    return text.length;
  };

  let index = text.startsWith("#!") ? lineEnd(text, 0) : 0;
  while (index < text.length) {
    const c = text[index];
    const previous = tokens[tokens.length - 1];
    if (/\s/.test(c)) {
      index += 1;
    } else if (c === "/" && text[index + 1] === "/") {
      index = lineEnd(text, index);
    } else if (c === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (c === "/") {
      const end = regexAllowed(previous) ? regexEnd(text, index) : -1;
      if (end === -1) {
        add({ type: "punct", value: "/" });
        index += 1;
      } else {
        add({ type: "regex" });
        index = end;
      }
    } else if (c === '"' || c === "'") {
      const { end, terminated } = stringEnd(text, index);
      add({ type: "string", value: text.slice(index + 1, terminated ? end - 1 : end) });
      index = end;
    } else if (c === "`") {
      index = scanTemplate(index + 1);
    } else if (c === "}" && stack.at(-1)?.template === true) {
      stack.pop();
      index = scanTemplate(index + 1);
    } else if (c === "(") {
      add({ type: "punct", value: c });
      stack.push({ regexAfter: previous?.type === "word" && STATEMENT_HEAD_WORD.has(previous.value) });
      index += 1;
    } else if (c === "{") {
      add({ type: "punct", value: c });
      stack.push({ block: opensBlock(previous) });
      index += 1;
    } else if (c === "[") {
      add({ type: "punct", value: c });
      stack.push({});
      index += 1;
    } else if (c === ")" || c === "}" || c === "]") {
      const closed = stack.pop();
      add({ type: "punct", value: c, regexAfter: c === ")" ? closed?.regexAfter === true : closed?.block === true });
      index += 1;
    } else if ((c === "+" || c === "-") && text[index + 1] === c) {
      // A postfix increment ends a value and a prefix one does not: what follows is read as after what preceded it.
      add({ type: "punct", value: c + c, regexAfter: regexAllowed(previous) });
      index += 2;
    } else if (c === "=" && text[index + 1] === ">") {
      add({ type: "punct", value: "=>" });
      index += 2;
    } else if (PUNCTUATION.has(c)) {
      add({ type: "punct", value: c });
      index += 1;
    } else {
      let end = index + 1;
      while (end < text.length && isWordCharacter(text[end])) end += 1;
      add({ type: "word", value: text.slice(index, end) });
      index = end;
    }
  }
  return tokens;
}

// The specifier of the import or export declaration whose keyword is tokens[at], or null when it
// names none (`export const x`, `import(...)`, `import.meta`, `export { a }`).
function declarationSpecifier(tokens, at) {
  const next = tokens[at + 1];
  if (next === undefined) return null;
  if (tokens[at].value === "import") {
    if (next.type === "string") return next.value;
    if (next.type === "punct" && (next.value === "(" || next.value === ".")) return null;
  } else if (next.type !== "punct" || (next.value !== "*" && next.value !== "{")) {
    return null;
  }
  for (let index = at + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "word") {
      if (token.depth === 0 && (token.value === "import" || token.value === "export")) return null;
      if (token.value === "from" && tokens[index + 1]?.type === "string") return tokens[index + 1].value;
    } else if (token.type !== "string" && !(token.type === "punct" && CLAUSE_PUNCTUATION.has(token.value))) {
      return null;
    }
  }
  return null;
}

/**
 * The specifiers of a source text's static imports and re-exports, in source order. `source` is a
 * string or the bytes of one (UTF-8).
 */
export function staticImportSpecifiers(source) {
  const tokens = tokenize(source.toString("utf8"));
  const specifiers = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token.type !== "word" || token.depth !== 0 || (token.value !== "import" && token.value !== "export")) continue;
    // `import` and `export` at the top level of a module are declarations, unless a dot makes them a property name.
    if (tokens[at - 1]?.type === "punct" && tokens[at - 1].value === ".") continue;
    const specifier = declarationSpecifier(tokens, at);
    if (specifier !== null) specifiers.push(specifier);
  }
  return specifiers;
}
