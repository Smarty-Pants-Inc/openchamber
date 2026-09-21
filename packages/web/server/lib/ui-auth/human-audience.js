const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Configuration is an explicit access policy, never a Google account-selection hint. */
export function createHumanAudience(domains) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('Human authentication requires an allowed email domain');
  }
  const allowed = new Set(domains.map((domain) => {
    if (typeof domain !== 'string' || domain !== domain.trim() || !domainPattern.test(domain.toLowerCase())) {
      throw new Error('Invalid allowed email domain');
    }
    return domain.toLowerCase();
  }));
  return (user) => {
    if (user?.emailVerified !== true || typeof user.email !== 'string') return false;
    const email = user.email;
    if (email !== email.trim() || /[\s\u0000-\u001f\u007f]/u.test(email)) return false;
    const parts = email.split('@');
    return parts.length === 2 && parts[0].length > 0 && allowed.has(parts[1].toLowerCase());
  };
}
