const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Configuration is an explicit access policy, never a Google account-selection hint. */
export function createHumanAudience(domains, emailPolicy) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('Human authentication requires an allowed email domain');
  }
  const allowed = new Set(domains.map((domain) => {
    if (typeof domain !== 'string' || domain !== domain.trim() || !domainPattern.test(domain.toLowerCase())) {
      throw new Error('Invalid allowed email domain');
    }
    return domain.toLowerCase();
  }));
  // Optional narrowing of the existing domain policy, never an alternate identity source.
  let emails;
  if (emailPolicy !== undefined) {
    if (typeof emailPolicy !== 'string' || /[\u0000-\u001f\u007f]/u.test(emailPolicy)) {
      throw new Error('Invalid allowed email list');
    }
    const list = emailPolicy.split(',').map(value => value.trim().toLowerCase());
    const localPart = /^[a-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'+/=?^_`{|}~-]+)*$/;
    if (list.some(email => {
      const parts = email.split('@');
      return parts.length !== 2 || !localPart.test(parts[0]) || parts[0].length > 64
        || email.length > 254 || !allowed.has(parts[1]);
    })) throw new Error('Invalid allowed email list');
    emails = new Set(list);
  }
  return (user) => {
    if (user?.emailVerified !== true || typeof user.email !== 'string') return false;
    const email = user.email;
    if (email !== email.trim() || /[\s\u0000-\u001f\u007f]/u.test(email)) return false;
    const parts = email.split('@');
    return parts.length === 2 && parts[0].length > 0 && allowed.has(parts[1].toLowerCase())
      && (!emails || emails.has(email.toLowerCase()));
  };
}
