import { markdownLanguage } from '@codemirror/lang-markdown';

// URLs in structured documentation are data, including aliases in paths/queries.
export const preserveUrls = (value, render) => value.split(
  /(\b[a-z][a-z\d+.-]*:(?:\/\/|\\\/\\\/)[^\s<>"'`]+)/gi,
).map((part, index) => index % 2 ? part : render(part)).join('');

// Use the existing editor parser for nested destinations and reference identities.
// Apply edits by source range, rather than serialize Markdown and alter formatting.
export const brandMarkdown = (value, render, renderFence) => {
  const protectedRanges = [];
  const protect = (from, to, replacement) => protectedRanges.push({ from, to, replacement });
  for (const match of value.matchAll(/<!-- upstream-attribution:start -->[\s\S]*?<!-- upstream-attribution:end -->/g)) {
    protect(match.index, match.index + match[0].length);
  }
  const tree = markdownLanguage.parser.parse(value);
  const references = new Set();
  const referenceId = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  tree.iterate({ enter({ name, node }) {
    if (name === 'LinkReference') {
      const label = node.getChild('LinkLabel');
      references.add(referenceId(value.slice(label.from + 1, label.to - 1)));
    }
  } });
  tree.iterate({
    enter({ name, from, to, node }) {
      if (['InlineCode', 'CodeBlock', 'URL', 'LinkLabel'].includes(name)) {
        protect(from, to);
        return false;
      }
      if (name === 'FencedCode') {
        protect(from, to, () => renderFence(value.slice(from, to)));
        return false;
      }
      if (name === 'Link' || name === 'Image') {
        const reference = node.getChild('LinkLabel');
        if (!node.getChild('URL') && (!reference || value.slice(reference.from, reference.to) === '[]')) {
          const marks = node.getChildren('LinkMark');
          const label = value.slice(marks[0].to, marks[1].from);
          if (!references.has(referenceId(label))) return;
          // A shortcut/collapsed label is also a reference ID. Make that ID explicit
          // only when its visible label changes; reference IDs remain byte-identical.
          protect(from, to, () => {
            const branded = brandMarkdown(label, render, renderFence);
            return branded === label ? value.slice(from, to)
              : `${name === 'Image' ? '![' : '['}${branded}][${label}]`;
          });
          return false;
        }
      }
      if (name === 'HTMLTag' || name === 'HTMLBlock') {
        const attributes = /\b(?:href|src|srcset|poster|action|formaction|xlink:href|id|name)\s*=\s*(?:\{\s*)?(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
        for (const match of value.slice(from, to).matchAll(attributes)) {
          protect(from + match.index, from + match.index + match[0].length);
        }
      }
    },
  });
  let output = '';
  let cursor = 0;
  for (const range of protectedRanges.sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (range.from < cursor) continue;
    output += render(value.slice(cursor, range.from));
    output += range.replacement ? range.replacement() : value.slice(range.from, range.to);
    cursor = range.to;
  }
  return output + render(value.slice(cursor));
};
