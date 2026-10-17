/**
 * Extract module-level `NAME = {"a", "b"}` string-set literals from Python source.
 *
 * Split out of `vocabulary-parity.ts` because that script calls `process.exit` at module
 * scope and so cannot be imported by a test — and a parser the vocabulary gate's verdict
 * rests on, with no tests of its own, is the same "asserts a slot, not a behaviour" shape
 * the gate exists to prevent. Nothing here executes Python or decides anything; it returns
 * what it could parse and lets the caller decide what an empty result means.
 *
 * Deliberately narrow. Anything that is not a flat list of plain string literals — a
 * derived set (`A - B`), a dict, a number, a backslash escape — yields `null` for that
 * name, and the name is then simply absent from the map. Absent is loud at the call site
 * (reported as "missing from task-queue-mcp — renamed upstream?"); a lenient parser that
 * guessed would be quiet and wrong.
 */

/**
 * Parse the inside of a Python `{...}` as plain string literals.
 * Returns null if the body contains anything else.
 */
export function parseStringSetBody(body: string): string[] | null {
  const values: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === ',' || /\s/.test(ch)) { i++; continue; }
    // A `#` comment. Safe to strip here only because we have already established we are
    // outside a string literal — the string branch below consumes its own content.
    if (ch === '#') { while (i < body.length && body[i] !== '\n') i++; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let val = '';
      while (j < body.length && body[j] !== ch) {
        // Refuse rather than mis-decode. None of the vocabulary values contain escapes,
        // and a wrong decode here would be reported as a real drift.
        if (body[j] === '\\') return null;
        val += body[j];
        j++;
      }
      if (j >= body.length) return null; // unterminated
      values.push(val);
      i = j + 1;
      continue;
    }
    return null; // identifier, dict colon, number, operator — not a plain string set
  }
  return values;
}

/**
 * Every module-level `NAME = { ... }` string-set literal in `source`.
 *
 * The name pattern requires column 0 and a bare ` = `, which excludes an annotated
 * assignment (`NAME: dict[str, set[str]] = {`) — never one of these sets — as well as
 * anything indented inside a function.
 */
export function literalSets(source: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const re = /^([A-Z][A-Z0-9_]*) = \{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let k = m.index + m[0].length;
    while (k < source.length && depth > 0) {
      if (source[k] === '{') depth++;
      else if (source[k] === '}') depth--;
      k++;
    }
    if (depth !== 0) continue; // unbalanced to EOF
    const values = parseStringSetBody(source.slice(m.index + m[0].length, k - 1));
    if (values) found.set(m[1], values);
  }
  return found;
}
