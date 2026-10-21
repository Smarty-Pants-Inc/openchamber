const normalizeBasePath = (value: string | undefined): string => {
  if (!value || !value.startsWith('/')) return '';
  return value.replace(/\/+$/, '');
};

/** Vite's build base is the one mount prefix shared by the hosted web UI. */
export const APP_BASE_PATH = normalizeBasePath(import.meta.env.BASE_URL);

export const appPath = (path: string): string => {
  const normalized = path.startsWith('/') ? path : '/' + path;
  if (!APP_BASE_PATH || normalized === APP_BASE_PATH || normalized.startsWith(APP_BASE_PATH + '/')) return normalized;
  return APP_BASE_PATH + normalized;
};
