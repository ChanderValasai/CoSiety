import crypto from 'node:crypto';

const MASTER_KEY_HEX =
  process.env.COSIETY_FIELD_KEY ||
  crypto.createHash('sha256').update('cosiety-tharparkar-pilot-field-key-v1').digest('hex');

const CNIC_PEPPER =
  process.env.COSIETY_CNIC_PEPPER || 'cosiety-tharparkar-cnic-pepper-v1';

const KEY_BUF = Buffer.from(MASTER_KEY_HEX.slice(0, 64), 'hex');

export function normalizeCnic(raw: string): string {
  return raw.replace(/\D/g, '');
}

export function maskCnic(raw: string): string {
  const digits = normalizeCnic(raw);
  if (digits.length !== 13) return '4xxxx-xxxxxxx-x';
  return `${digits[0]}xxxx-xxxxxxx-${digits[12]}`;
}

export function cnicHmac(raw: string): string {
  const digits = normalizeCnic(raw);
  return crypto.createHmac('sha256', CNIC_PEPPER).update(digits).digest('hex');
}

export function encryptField(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY_BUF, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptField(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) return '';
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY_BUF, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

export function canonicalHash(obj: unknown): string {
  return sha256(canonicalJson(obj));
}

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const derived = crypto.scryptSync(pin, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(expected, 'hex'));
}

export function newId(prefix = ''): string {
  const uuid = crypto.randomUUID();
  return prefix ? `${prefix}-${uuid.slice(0, 8)}` : uuid;
}

export function generateOtp(): string {
  return String(crypto.randomInt(100000, 999999));
}
