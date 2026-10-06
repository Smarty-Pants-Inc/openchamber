import { readQuotaCredential, writeQuotaCredential } from './store.js';

const clean = (value) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

const normalizers = {
  'exe-dev': (value) => {
    const usageToken = clean(value?.usageToken);
    return usageToken ? { usageToken } : null;
  },
  'ollama-cloud': (value) => {
    const cookie = clean(value?.cookie);
    return cookie ? { cookie } : null;
  },
  cursor: (value) => {
    const accessToken = clean(value?.accessToken);
    const refreshToken = clean(value?.refreshToken);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
  },
};

export const readManagedCredential = (providerId) => {
  const normalize = normalizers[providerId];
  return normalize ? readQuotaCredential(providerId, normalize) : null;
};

export const writeManagedCredential = (providerId, value) => {
  const credential = normalizers[providerId]?.(value);
  if (!credential) throw new Error('Invalid credential');
  writeQuotaCredential(providerId, credential);
};
