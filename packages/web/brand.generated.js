export const PRODUCT_NAME = "Smarty Code";
export const PRODUCT_MARK = "🤓";
const isWordCharacter = (value) => value !== undefined && /\w/.test(value);
const brandRegex = /(?:OpenChambers|OpenChamber|smarty-code|Smarty Code|OpenCode)/g;
const replaceAliases = (value, regex, replacement) => value.replace(regex, (match, offset, input) => isWordCharacter(input[offset - 1]) || isWordCharacter(input[offset + match.length]) ? match : replacement);
export const brandText = (template) => replaceAliases(template, brandRegex, PRODUCT_NAME);
const documentationProductRegex = /([qQ]u|[dDlL])([’'])(OpenChamber|OpenChambers)\b|(?:OpenChambers|OpenChamber|smarty-code|Smarty Code)/g;
export const brandProductText = (template) => template.replace(documentationProductRegex, (match, prefix, _apostrophe, _elisionAlias, offset, input) => prefix ? (isWordCharacter(input[offset - 1]) ? match : (prefix === 'Qu' ? 'Que ' + PRODUCT_NAME : prefix === 'D' ? 'De ' + PRODUCT_NAME : prefix === 'L' ? 'Le ' + PRODUCT_NAME : prefix.toLowerCase() === 'qu' ? 'que ' + PRODUCT_NAME : prefix.toLowerCase() === 'd' ? 'de ' + PRODUCT_NAME : 'le ' + PRODUCT_NAME)) : (isWordCharacter(input[offset - 1]) || isWordCharacter(input[offset + match.length]) ? match : PRODUCT_NAME));
