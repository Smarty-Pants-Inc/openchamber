export class SettingsPreconditionError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'SettingsPreconditionError';
    this.statusCode = statusCode;
  }
}

export const createSettingsRevision = (crypto, formattedSettings) => {
  const content = JSON.stringify(formattedSettings);
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  return `"${digest}"`;
};

const MAX_IF_MATCH_LENGTH = 8192;
const MAX_IF_MATCH_TAGS = 64;

const isOptionalWhitespace = (character) => character === ' ' || character === '\t';
const isOpaqueTagCharacter = (character) => {
  const code = character.charCodeAt(0);
  return code === 0x21 || (code >= 0x23 && code <= 0x7e) || code >= 0x80;
};

export const parseIfMatch = (header) => {
  if (header === undefined) {
    return null;
  }
  if (Object.prototype.toString.call(header) !== '[object String]' || header.length > MAX_IF_MATCH_LENGTH) {
    throw new SettingsPreconditionError('If-Match must be a valid entity-tag list.', 400);
  }

  let position = 0;
  const skipOptionalWhitespace = () => {
    while (position < header.length && isOptionalWhitespace(header[position])) {
      position += 1;
    }
  };
  const malformed = () => {
    throw new SettingsPreconditionError('If-Match must be a valid entity-tag list.', 400);
  };

  skipOptionalWhitespace();
  if (header[position] === '*') {
    position += 1;
    skipOptionalWhitespace();
    if (position !== header.length) malformed();
    return { any: true, etags: [] };
  }

  const etags = [];
  while (position < header.length) {
    const weak = header.startsWith('W/', position);
    if (weak) position += 2;
    if (header[position] !== '"') malformed();

    const start = position;
    position += 1;
    while (position < header.length && header[position] !== '"') {
      if (!isOpaqueTagCharacter(header[position])) malformed();
      position += 1;
    }
    if (position === header.length) malformed();

    const etag = header.slice(start, position + 1);
    etags.push(weak ? `W/${etag}` : etag);
    if (etags.length > MAX_IF_MATCH_TAGS) malformed();
    position += 1;
    skipOptionalWhitespace();
    if (position === header.length) break;
    if (header[position] !== ',') malformed();
    position += 1;
    skipOptionalWhitespace();
    if (position === header.length) malformed();
  }

  if (etags.length === 0) malformed();
  return { any: false, etags };
};

export const assertSettingsPrecondition = (precondition, revision) => {
  if (!precondition || precondition.any || precondition.etags.includes(revision)) {
    return;
  }
  throw new SettingsPreconditionError('Settings changed before this update could be saved.', 412);
};
