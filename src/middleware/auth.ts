import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../auth';

export interface AuthPayload {
  userId: string;
  username: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = header.slice(7);
    const decoded = jwt.verify(token, getJwtSecret()) as AuthPayload;
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const token = header.slice(7);
      req.user = jwt.verify(token, getJwtSecret()) as AuthPayload;
    } catch {

    }
  }
  next();
}
