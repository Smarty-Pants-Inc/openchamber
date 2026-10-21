const BASE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

export const normalizeBasePath = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('SMARTY_CODE_BASE_PATH must be canonical');
  const segments = value.split('/').slice(1);
  if (!value.startsWith('/') || !segments.length || segments.some(segment => !BASE_PATH_SEGMENT.test(segment))) {
    throw new Error('SMARTY_CODE_BASE_PATH must be a canonical absolute path without a trailing slash');
  }
  return value;
};

export const stripBasePathFromUrl = (url, value) => {
  const basePath = normalizeBasePath(value);
  if (!basePath) return url;
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex < 0 ? url : url.slice(0, queryIndex);
  if (pathname !== basePath && !pathname.startsWith(basePath + '/')) return null;
  const suffix = pathname.slice(basePath.length) || '/';
  return suffix + (queryIndex < 0 ? '' : url.slice(queryIndex));
};

export const createBasePathMiddleware = (value, preservePaths = []) => {
  const basePath = normalizeBasePath(value);
  return (req, res, next) => {
    const pathname = req.url.split('?')[0];
    if (basePath && preservePaths.some(path => pathname === basePath + path || pathname.startsWith(basePath + path + '/'))) return next();
    const url = stripBasePathFromUrl(req.url, basePath);
    if (url === null) return res.status(404).type('text/plain').send('Not found');
    req.url = url;
    return next();
  };
};
