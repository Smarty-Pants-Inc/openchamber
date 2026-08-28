export const PRODUCT_NAME = "smarty-code";
export const PRODUCT_MARK = "🤓";
export const brandText = (template) => template.replace(/(^|\W)(?:OpenChambers|OpenChamber|smarty-code|OpenCode)(?=$|\W)/g, (_match, boundary) => boundary + PRODUCT_NAME);
export const brandProductText = (template) => template.replace(/([qQ]u|[dDlL])([’'])(OpenChamber|OpenChambers)\b|(^|\W)(?:OpenChambers|OpenChamber|smarty-code)(?=$|\W)/g, (_match, prefix, _apostrophe, _elisionAlias, boundary) => prefix ? (prefix === 'Qu' ? 'Que ' + PRODUCT_NAME : prefix === 'D' ? 'De ' + PRODUCT_NAME : prefix === 'L' ? 'Le ' + PRODUCT_NAME : prefix.toLowerCase() === 'qu' ? 'que ' + PRODUCT_NAME : prefix.toLowerCase() === 'd' ? 'de ' + PRODUCT_NAME : 'le ' + PRODUCT_NAME) : (boundary ?? '') + PRODUCT_NAME);
