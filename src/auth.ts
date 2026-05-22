import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

export function getJwtSecret(): string {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return JWT_SECRET;
}

export interface AuthPayload {
  userId: string;
  username: string;
}

export function generateToken(payload: AuthPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
}
