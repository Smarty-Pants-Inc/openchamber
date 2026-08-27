export const PRODUCT_NAME = "smarty-code";
export const PRODUCT_MARK = "🤓";
export const brandText = (template: string) => template.replace(/\b(?:OpenChamber|OpenChambers|OpenCode|smarty-code)\b/g, () => PRODUCT_NAME);
export const brandProductText = (template: string) => template.replace(/\b(?:OpenChamber|OpenChambers|smarty-code)\b/g, () => PRODUCT_NAME);
