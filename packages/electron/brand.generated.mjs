export const PRODUCT_NAME = "smarty-code";
export const PRODUCT_MARK = "🤓";
export const brandText = (template) => template.replace(/\b(?:OpenChamber|OpenChambers|OpenCode|smarty-code)\b/g, () => PRODUCT_NAME);
export const brandProductText = (template) => template.replace(/([qQ]u|[dDlL])([’'])(OpenChamber|OpenChambers)\b/g, (_match, prefix) => prefix === 'Qu' ? 'Que ' + PRODUCT_NAME : prefix === 'D' ? 'De ' + PRODUCT_NAME : prefix === 'L' ? 'Le ' + PRODUCT_NAME : prefix.toLowerCase() === 'qu' ? 'que ' + PRODUCT_NAME : prefix.toLowerCase() === 'd' ? 'de ' + PRODUCT_NAME : 'le ' + PRODUCT_NAME).replace(/\b(?:OpenChamber|OpenChambers|smarty-code)\b/g, () => PRODUCT_NAME);
