/**
 * The Markdown structure the checks need, as CommonMark defines it: fenced code blocks and code
 * spans. Both the refs check and the handoff parser read fences from here, so they can't
 * disagree about where a block ends.
 */

/**
 * For each line, whether it belongs to a fenced code block, fence lines included; and the line
 * of a fence still open at the end. A fence opens with at least three backticks or tildes,
 * indented at most three spaces (a backtick fence's info string has no backtick), and closes
 * only on the same character, at least as long, with nothing after it.
 */
export const fencedLines = (
  lines: ReadonlyArray<string>,
): { readonly fenced: ReadonlyArray<boolean>; readonly unclosed: number | undefined } => {
  const fenced: Array<boolean> = [];
  let open: { readonly marker: string; readonly line: number } | undefined;
  lines.forEach((line, index) => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = fence?.[1];
    const rest = fence?.[2] ?? "";
    if (open === undefined) {
      const opens = marker !== undefined && !(marker.startsWith("`") && rest.includes("`"));
      if (opens) open = { marker, line: index };
      fenced.push(opens);
      return;
    }
    fenced.push(true);
    if (
      marker !== undefined &&
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      rest.trim() === ""
    )
      open = undefined;
  });
  return { fenced, unclosed: open?.line };
};

/**
 * Whether a line leaves a code span open, so the span would continue on the next line. A run
 * of n backticks closes only at the next run of exactly n; a backslash-escaped backtick and
 * HTML comments open nothing.
 */
export const opensCodeSpan = (line: string): boolean => {
  const text = line.replace(/<!--.*?-->/g, "");
  const runLength = (at: number) => {
    let end = at;
    while (text[end] === "`") end++;
    return end - at;
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const n = runLength(i);
    let j = i + n;
    let closed: number | undefined;
    while (j < text.length && closed === undefined) {
      if (text[j] !== "`") j++;
      else {
        const m = runLength(j);
        if (m === n) closed = j + m;
        j += m;
      }
    }
    if (closed === undefined) return true;
    i = closed;
  }
  return false;
};
