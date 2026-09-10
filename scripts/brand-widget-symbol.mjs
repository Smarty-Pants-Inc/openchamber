// The stock SF Symbols template owns glyph identities, guides and attribution.
// Generic SVG artwork belongs inside its glyphs, never at the symbolset root.
export const widgetSymbol = (template, artwork) => {
  const viewBox = artwork.match(/<svg\b[^>]*\bviewBox="([^"]+)"/)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) {
    throw new Error('Widget symbol artwork requires a finite, positive SVG viewBox');
  }
  const body = artwork.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1];
  const marker = '<!-- brand:symbols -->';
  if (!body || template.split(marker).length !== 2) throw new Error('Missing widget artwork or stock symbol template marker');
  const [minX, minY, width, height] = viewBox;
  // Stock S glyphs have capline 76, baseline 146 and column centers 265/465/665.
  const scale = 70 / Math.max(width, height);
  const y = 111 - (minY + height / 2) * scale;
  const glyphs = ['Ultralight', 'Regular', 'Black'].map((weight, index) => {
    const x = 265 + index * 200 - (minX + width / 2) * scale;
    return `        <g id="${weight}-S" transform="translate(${x},${y}) scale(${scale})">${body}        </g>`;
  }).join('\n');
  return template.replace(marker, () => glyphs);
};
