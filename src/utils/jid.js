const normalizeDigits = (value) => value.replace(/[^0-9]/g, '');

const ensureCountryCode = (value) => {
  if (value.startsWith('62')) {
    return value;
  }

  if (value.startsWith('0')) {
    return `62${value.slice(1)}`;
  }

  if (value.startsWith('8')) {
    return `62${value}`;
  }

  throw new Error('Unsupported phone number format');
};

const normalizeJid = (input) => {
  if (!input) {
    throw new Error('Empty JID');
  }

  const value = String(input).trim();

  if (value.endsWith('@g.us')) {
    return value;
  }

  if (value.endsWith('@c.us')) {
    return value;
  }

  if (value.includes('@')) {
    return value;
  }

  const digits = normalizeDigits(value.replace(/^\+/, ''));
  const normalized = ensureCountryCode(digits);
  return `${normalized}@c.us`;
};

const isGroupJid = (jid) => jid?.endsWith('@g.us');

module.exports = {
  normalizeJid,
  isGroupJid,
};
