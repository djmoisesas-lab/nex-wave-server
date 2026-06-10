import admin from 'firebase-admin';
import fs from 'fs';

const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET || 'dj-catalog-web.firebasestorage.app';

function parsePrivateKey(raw?: string): string | undefined {
  if (!raw) return undefined;
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\n/g, '\n');
  return key;
}

function getCert() {
  const keyPath = process.env.FIREBASE_KEY_PATH;
  if (keyPath) {
    return require(keyPath);
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: parsePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  };
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(getCert()),
    storageBucket: BUCKET_NAME,
  });
}

const bucket = admin.storage().bucket();

export async function uploadToFirebase(
  buffer: Buffer,
  destination: string,
  contentType: string,
): Promise<string> {
  const file = bucket.file(destination);
  await file.save(buffer, { contentType, public: true });
  return `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`;
}

export async function uploadToFirebaseFromPath(
  filePath: string,
  destination: string,
  contentType: string,
): Promise<string> {
  const file = bucket.file(destination);
  const buffer = fs.readFileSync(filePath);
  await file.save(buffer, { contentType, public: true });
  return `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`;
}

export async function generateUploadUrl(destination: string, contentType: string): Promise<string> {
  const [url] = await bucket.file(destination).getSignedUrl({
    action: 'write',
    expires: Date.now() + 60 * 60 * 1000,
    contentType,
    version: 'v4',
  });
  return url;
}

export async function deleteFromFirebase(destination: string) {
  await bucket.file(destination).delete().catch(() => {});
}

export function getFirebaseUrl(destination: string): string {
  return `https://storage.googleapis.com/${BUCKET_NAME}/${destination}`;
}

const IMAGE_SIGNATURES: [number, number[]][] = [
  [0, [0xFF, 0xD8, 0xFF]],
  [0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  [0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
  [0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
];

const AVIF_FTYP = [
  [0x61, 0x76, 0x69, 0x66],
  [0x6D, 0x69, 0x66, 0x31],
];

export function isValidImage(buf: Buffer): boolean {
  for (const [offset, magic] of IMAGE_SIGNATURES) {
    if (magic.every((byte, i) => buf[offset + i] === byte)) return true;
  }
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x00 && buf[3] > 0 && buf.slice(4, 8).equals(Buffer.from('ftyp'))) {
    const brand = buf.slice(8, 12);
    if (AVIF_FTYP.some((b) => brand.equals(Buffer.from(b)))) return true;
  }
  if (buf.readUInt32BE(0) === 0x52494646 && buf.readUInt32BE(8) === 0x57454250) return true;
  return false;
}

export function extractFirebasePath(url: string): string | null {
  const parts = url.split('/o/');
  if (!parts[1]) return null;
  return decodeURIComponent(parts[1].split('?')[0]);
}

export { bucket };
