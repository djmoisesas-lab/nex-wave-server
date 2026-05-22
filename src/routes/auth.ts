import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db';
import jwt from 'jsonwebtoken';
import { generateToken, getJwtSecret, AuthPayload } from '../auth';
import { z } from 'zod';
import nodemailer from 'nodemailer';

const registerSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, 'Username must be alphanumeric'),
  email: z.string().email(),
  password: z.string().min(6).max(128),
  displayName: z.string().max(60).optional(),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const router = Router();

router.post('/register', (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors.map(e => e.message).join(', ') });
  }
  const { username, email, password, displayName } = parsed.data;

  const db = getDb();
  const existingUser = db.query('SELECT id FROM users WHERE username = ?').get(username);
  if (existingUser) {
    return res.status(409).json({ error: 'El nombre de usuario ya está en uso' });
  }
  const existingEmail = db.query('SELECT id FROM users WHERE email = ?').get(email);
  if (existingEmail) {
    return res.status(409).json({ error: 'El email ya está registrado' });
  }

  const id = uuid();
  const hashed = bcrypt.hashSync(password, 10);

  db.query(
    'INSERT INTO users (id, username, email, password, display_name) VALUES (?, ?, ?, ?, ?)'
  ).run(id, username, email, hashed, displayName || username);

  const token = generateToken({ userId: id, username });
  res.status(201).json({ token, user: { id, username, displayName: displayName || username } });
});

router.post('/login', (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid credentials format' });
  }
  const { username, password } = parsed.data;

  const db = getDb();
  const user = db.query('SELECT * FROM users WHERE username = ?').get(username) as any;

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken({ userId: user.id, username: user.username });
  res.json({ token, user: { id: user.id, username: user.username, displayName: user.display_name } });
});

router.get('/me', (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }

  try {
    const decoded = jwt.verify(header.slice(7), getJwtSecret()) as AuthPayload;
    const db = getDb();
    const user = db.query(
      'SELECT id, username, display_name, email, bio, avatar_url, banner_url, social_instagram, social_soundcloud, social_mixcloud, is_public FROM users WHERE id = ?'
    ).get(decoded.userId) as any;

    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
});

router.post('/forgot-password', (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Email inválido' });
  }
  const { email } = parsed.data;
  const db = getDb();
  const user = db.query('SELECT id, email FROM users WHERE email = ?').get(email) as any;
  if (!user) {
    return res.json({ message: 'Si el email existe, recibirás un enlace de recuperación' });
  }

  const token = uuid() + uuid();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  db.query(
    'INSERT INTO password_resets (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
  ).run(uuid(), user.id, token, expiresAt);

  const resetLink = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpUser || !smtpPass) {
    console.log(`[DEV] Reset link for ${email}: ${resetLink}`);
    return res.json({ message: `Enlace de recuperación: ${resetLink}` });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: smtpUser, pass: smtpPass },
  });

  transporter.sendMail({
    from: smtpUser,
    to: email,
    subject: 'Recuperación de contraseña - NexWave',
    html: `
      <h2>Recuperación de contraseña</h2>
      <p>Hacé click en el siguiente enlace para restablecer tu contraseña:</p>
      <a href="${resetLink}" style="display:inline-block;padding:12px 24px;background:#8b5cf6;color:#fff;text-decoration:none;border-radius:8px">Restablecer contraseña</a>
      <p>Este enlace expira en 1 hora.</p>
      <p>Si no solicitaste este cambio, ignorá este mensaje.</p>
    `,
  }).then(() => {
    res.json({ message: 'Si el email existe, recibirás un enlace de recuperación' });
  }).catch((err) => {
    console.error('Email send error:', err);
    res.status(500).json({ error: 'Error al enviar el email. Verificá la configuración SMTP.' });
  });
});

const changePasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(6).max(128),
});

router.post('/reset-password', (req: Request, res: Response) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Token inválido o contraseña muy corta (mín 6 caracteres)' });
  }
  const { token, password } = parsed.data;
  const db = getDb();

  const row = db.query(
    'SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > datetime(\'now\')'
  ).get(token) as any;

  if (!row) {
    return res.status(400).json({ error: 'Token inválido o expirado' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  db.query('UPDATE users SET password = ? WHERE id = ?').run(hashed, row.user_id);
  db.query('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);

  res.json({ message: 'Contraseña actualizada correctamente' });
});

export default router;
