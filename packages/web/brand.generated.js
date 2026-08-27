export const PRODUCT_NAME = "smarty-code";
export const PRODUCT_MARK = "🤓";
export const brandText = (template) => template.replace(/\b(?:OpenChamber|OpenCode|smarty-code)\b/g, () => PRODUCT_NAME);
export const brandProductText = (template) => template.replace(/\b(?:OpenChamber|smarty-code)\b/g, () => PRODUCT_NAME);
