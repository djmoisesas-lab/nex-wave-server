import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { createNotification } from './notifications';
import { uploadToFirebase, isValidImage, setupBucketCors } from '../services/firebase';

const router = Router();

router.get('/setup-cors', async (_req: Request, res: Response) => {
  try {
    await setupBucketCors();
    res.json({ success: true, message: 'CORS configured on Firebase bucket' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/list', async (_req: Request, res: Response) => {
  const db = getDb();
  const users = await db.query('SELECT id, username, email, display_name, created_at FROM users ORDER BY created_at DESC LIMIT 50').all();
  res.json(users);
});

router.get('/clean-test', async (_req: Request, res: Response) => {
  const db = getDb();
  const ids = [
    '00fec39a-1e89-436b-9df8-8a9455c9665b',
    'df54f0e6-a5a6-45c7-b277-e6dc4f8a632e',
    '37d2a707-f9ad-4221-9855-1b1c1c53ca65',
    '1b959fd0-9031-45d7-b2eb-c4f6ec51a97f',
    '63f4d5da-8d0b-4bad-9aa9-7d360ae00773',
    'c7945611-d6a2-4a52-9664-f57f34de7ed9',
    '1b39d209-118d-46a1-9ed7-e5229c4be2b8',
  ];
  await db.query('DELETE FROM users WHERE id = ANY($1::text[])').run(ids);
  res.json({ deleted: ids.length });
});

router.get('/', async (_req: Request, res: Response) => {
  const db = getDb();
  const users = await db.query(
    'SELECT id, username, display_name, email, bio, avatar_url, banner_url, social_instagram, social_tiktok, social_facebook, is_public, created_at FROM users ORDER BY created_at DESC'
  ).all();
  res.json(users);
});

router.get('/db-check', async (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const userCount = await db.query('SELECT COUNT(*)::int as count FROM users').get() as any;
    const users = await db.query('SELECT username, email, created_at FROM users').all();
    res.json({
      databaseUrl: process.env.DATABASE_URL ? '(set)' : '(not set)',
      userCount: userCount?.count || 0,
      users,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const IMAGE_MEMORY_UPLOAD = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  },
});

router.get('/search', async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim();
  if (!q) return res.json([]);

  const db = getDb();
  const users = await db.query(`
    SELECT id, username, display_name, bio, avatar_url, banner_url
    FROM users
    WHERE username ILIKE ? OR display_name ILIKE ?
    LIMIT 20
  `).all(`%${q}%`, `%${q}%`);

  res.json(users);
});

router.post('/follow/:id/notify-toggle', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const { userId } = req.user!;
  const targetId = req.params.id;
  const row = await db.query('SELECT notify_on_upload FROM follows WHERE follower_id = ? AND following_id = ?').get(userId, targetId) as any;
  if (!row) {
    return res.status(400).json({ error: 'No estás siguiendo a este usuario' });
  }
  const newVal = row.notify_on_upload ? 0 : 1;
  await db.query('UPDATE follows SET notify_on_upload = ? WHERE follower_id = ? AND following_id = ?').run(newVal, userId, targetId);
  res.json({ notify_on_upload: !!newVal });
});

router.post('/follow/:id', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const targetId = req.params.id;
  if (targetId === req.user!.userId) return res.status(400).json({ error: 'Cannot follow yourself' });

  const exists = await db.query('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!exists) return res.status(404).json({ error: 'User not found' });

  await db.query('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').run(req.user!.userId, targetId);

  createNotification(targetId, 'follow', 'empezó a seguirte', '', req.user!.userId);

  res.json({ followed: true });
});

router.post('/unfollow/:id', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  await db.query('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(req.user!.userId, req.params.id);
  res.json({ followed: false });
});

router.get('/followers/:id', async (req: Request, res: Response) => {
  const db = getDb();
  const followers = await db.query(`
    SELECT u.id, u.username, u.display_name, u.avatar_url
    FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.following_id = ? AND u.is_public = 1
    ORDER BY f.created_at DESC
  `).all(req.params.id);
  res.json(followers);
});

router.get('/following/:id', async (req: Request, res: Response) => {
  const db = getDb();
  const following = await db.query(`
    SELECT u.id, u.username, u.display_name, u.avatar_url
    FROM follows f JOIN users u ON u.id = f.following_id
    WHERE f.follower_id = ? AND u.is_public = 1
    ORDER BY f.created_at DESC
  `).all(req.params.id);
  res.json(following);
});

router.get('/check-follow/:id', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const row = await db.query('SELECT notify_on_upload FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user!.userId, req.params.id) as any;
  res.json({ following: !!row, notify_on_upload: row ? !!row.notify_on_upload : false });
});

router.get('/:id', async (req: Request, res: Response) => {
  const db = getDb();
  const user = await db.query(`
    SELECT id, username, display_name, bio, avatar_url, banner_url, social_instagram, social_tiktok, social_facebook,
      (SELECT COUNT(*) FROM follows WHERE following_id = users.id) as followers_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = users.id) as following_count
    FROM users WHERE id = ?
  `).get(req.params.id) as any;

  if (!user) return res.status(404).json({ error: 'User not found' });

  const tracks = await db.query(`
    SELECT t.*,
      (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as likes_count
    FROM tracks t WHERE t.user_id = ? AND t.is_public = 1 ORDER BY t.created_at DESC
  `).all(req.params.id);

  const playlists = await db.query(`
    SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) as track_count
    FROM playlists p WHERE p.user_id = ? AND p.is_public = 1 ORDER BY p.created_at DESC
  `).all(req.params.id);

  const recentPlays = await db.query(`
    SELECT t.id, t.title, t.artist, t.cover_url, t.plays, t.duration,
      u.username, u.display_name, MAX(ph.created_at) as last_played
    FROM play_history ph
    JOIN tracks t ON t.id = ph.track_id
    JOIN users u ON u.id = t.user_id
    WHERE ph.user_id = ? AND t.is_public = 1
    GROUP BY t.id, t.title, t.artist, t.cover_url, t.plays, t.duration, u.username, u.display_name
    ORDER BY last_played DESC
    LIMIT 10
  `).all(req.params.id);

  res.json({ ...user, tracks, playlists, recentPlays });
});

router.get('/:id/recent-plays', async (req: Request, res: Response) => {
  const db = getDb();
  const tracks = await db.query(`
    SELECT t.id, t.title, t.artist, t.cover_url, t.plays, t.duration,
      u.username, u.display_name, MAX(ph.created_at) as last_played
    FROM play_history ph
    JOIN tracks t ON t.id = ph.track_id
    JOIN users u ON u.id = t.user_id
    WHERE ph.user_id = ? AND t.is_public = 1
    GROUP BY t.id, t.title, t.artist, t.cover_url, t.plays, t.duration, u.username, u.display_name
    ORDER BY last_played DESC
    LIMIT 20
  `).all(req.params.id);
  res.json(tracks);
});

router.put('/profile', authMiddleware, async (req: Request, res: Response) => {
  const { displayName, bio, socialInstagram, socialTiktok, socialFacebook, isPublic } = req.body;
  const db = getDb();

  await db.query(`
    UPDATE users SET
      display_name = COALESCE(?, display_name),
      bio = COALESCE(?, bio),
      social_instagram = COALESCE(?, social_instagram),
      social_tiktok = COALESCE(?, social_tiktok),
      social_facebook = COALESCE(?, social_facebook),
      is_public = COALESCE(?, is_public)
    WHERE id = ?
  `).run(
    displayName || null, bio || null,
    socialInstagram || null, socialTiktok || null, socialFacebook || null,
    isPublic !== undefined ? (isPublic ? 1 : 0) : null,
    req.user!.userId
  );

  const updated = await db.query('SELECT id, username, display_name, bio, avatar_url, banner_url, social_instagram, social_tiktok, social_facebook, is_public FROM users WHERE id = ?').get(req.user!.userId);
  res.json(updated);
});

router.post('/avatar', authMiddleware, (req: Request, res: Response) => {
  IMAGE_MEMORY_UPLOAD.single('avatar')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    try {
      if (!isValidImage(req.file.buffer)) {
        return res.status(400).json({ error: 'El archivo no es una imagen v\u00e1lida' });
      }

      const db = getDb();
      const user = await db.query('SELECT username FROM users WHERE id = ?').get(req.user!.userId) as any;

      const ext = path.extname(req.file.originalname) || '.jpg';
      const dest = `avatars/${user.username}${ext}`;
      const avatarUrl = await uploadToFirebase(req.file.buffer, dest, req.file.mimetype);

      await db.query('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user!.userId);

      res.json({ avatarUrl });
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Error al subir avatar' });
    }
  });
});

router.post('/banner', authMiddleware, (req: Request, res: Response) => {
  IMAGE_MEMORY_UPLOAD.single('banner')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    try {
      if (!isValidImage(req.file.buffer)) {
        return res.status(400).json({ error: 'El archivo no es una imagen v\u00e1lida' });
      }

      const db = getDb();
      const user = await db.query('SELECT username FROM users WHERE id = ?').get(req.user!.userId) as any;

      const ext = path.extname(req.file.originalname) || '.jpg';
      const dest = `banners/${user.username}${ext}`;
      const bannerUrl = await uploadToFirebase(req.file.buffer, dest, req.file.mimetype);

      await db.query('UPDATE users SET banner_url = ? WHERE id = ?').run(bannerUrl, req.user!.userId);

      res.json({ bannerUrl });
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Error al subir banner' });
    }
  });
});

export default router;
