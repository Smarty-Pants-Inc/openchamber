import { validateHeaderName } from 'node:http';

// RFC HTTP OWS is only SP/HTAB; Unicode whitespace must not create valid directive names.
const trimOWS = value => value.replace(/^[ \t]+|[ \t]+$/g, '');

// RFC quoted-string/quoted-pair: commas inside extension values are not separators.
function cacheDirectives(value) {
  const parts = [];
  let start = 0, quoted = false, escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (quoted && character === '\\') escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ',') { parts.push(value.slice(start, index)); start = index + 1; }
  }
  if (quoted || escaped) throw new Error('Invalid cache control quoted value');
  parts.push(value.slice(start));
  return parts.map(part => {
    const matched = trimOWS(part).match(/^([^=\s]+)(?:[ \t]*=[ \t]*(.*))?$/);
    if (!matched) throw new Error('Invalid cache control directive');
    const [, name, argument] = matched;
    validateHeaderName(name);
    if (argument !== undefined) {
      if (argument.startsWith('"')) {
        if (!/^"(?:[\t\x20\x21\x23-\x5b\x5d-\xff]|\\[\t\x20-\xff])*"$/.test(argument)) {
          throw new Error('Invalid cache control quoted value');
        }
      } else validateHeaderName(argument);
    }
    return { name: name.toLowerCase(), bare: argument === undefined };
  });
}

/** Normalize/validate every value before publication; do not defer validation to Express vary(). */
export function validatedPolicyHeaderValue(name, value) {
  if (name === 'vary') {
    const fields = value.split(',').map(trimOWS);
    fields.forEach(field => validateHeaderName(field));
    return fields.join(', ');
  }
  if (name === 'cache-control') {
    const directives = cacheDirectives(value);
    if (!directives.some(directive => directive.name === 'private' && directive.bare)
      || !directives.some(directive => directive.name === 'no-store' && directive.bare)
      || directives.some(directive => ['public', 's-maxage'].includes(directive.name))) {
      throw new Error('Response policy cache control must be private, no-store');
    }
  }
  return value;
}
