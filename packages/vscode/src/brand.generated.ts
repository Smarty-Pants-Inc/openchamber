export const PRODUCT_NAME = "smarty-code";
export const PRODUCT_MARK = "🤓";
const isWordCharacter = (value: string | undefined): boolean => value !== undefined && /\w/.test(value);
const brandRegex = /(?:OpenChambers|OpenChamber|smarty-code|OpenCode)/g;
const replaceAliases = (value: string, regex: RegExp, replacement: string): string => value.replace(regex, (match: string, offset: number, input: string) => isWordCharacter(input[offset - 1]) || isWordCharacter(input[offset + match.length]) ? match : replacement);
export const brandText = (template: string) => replaceAliases(template, brandRegex, PRODUCT_NAME);
const documentationProductRegex = /([qQ]u|[dDlL])([’'])(OpenChamber|OpenChambers)\b|(?:OpenChambers|OpenChamber|smarty-code)/g;
export const brandProductText = (template: string) => template.replace(documentationProductRegex, (match: string, prefix: string | undefined, _apostrophe: string | undefined, _elisionAlias: string | undefined, offset: number, input: string) => prefix ? (prefix === 'Qu' ? 'Que ' + PRODUCT_NAME : prefix === 'D' ? 'De ' + PRODUCT_NAME : prefix === 'L' ? 'Le ' + PRODUCT_NAME : prefix.toLowerCase() === 'qu' ? 'que ' + PRODUCT_NAME : prefix.toLowerCase() === 'd' ? 'de ' + PRODUCT_NAME : 'le ' + PRODUCT_NAME) : (isWordCharacter(input[offset - 1]) || isWordCharacter(input[offset + match.length]) ? match : PRODUCT_NAME));
