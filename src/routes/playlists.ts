import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { getDb } from '../db';
import { authMiddleware, optionalAuth } from '../middleware/auth';
import { uploadToFirebase, isValidImage } from '../services/firebase';

const coverUpload = multer({
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

const createPlaylistSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const updatePlaylistSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  isPublic: z.boolean().optional(),
});

const router = Router();

router.get('/', optionalAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const playlists = await db.query(`
    SELECT p.*, u.username, u.display_name,
      (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) as track_count
    FROM playlists p
    JOIN users u ON p.user_id = u.id
    WHERE p.is_public = 1
    ORDER BY p.created_at DESC
  `).all() as any[];


  res.json(playlists);
});

router.get('/my', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const playlists = await db.query(`
    SELECT p.*,
      (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) as track_count
    FROM playlists p
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC
  `).all(req.user!.userId);

  res.json(playlists);
});

router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const playlist = await db.query(`
    SELECT p.*, u.username, u.display_name
    FROM playlists p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(req.params.id) as any;

  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  if (!playlist.is_public && (!req.user || req.user.userId !== playlist.user_id)) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  const tracks = await db.query(`
    SELECT t.*, pt.position, pt.added_at
    FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position ASC
  `).all(req.params.id);

  res.json({ ...playlist, tracks });
});

router.post('/', authMiddleware, async (req: Request, res: Response) => {
  const parsed = createPlaylistSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map(e => e.message).join(', ') });
  }
  const { name, description } = parsed.data;

  const db = getDb();
  const id = uuid();

  await db.query(
    'INSERT INTO playlists (id, user_id, name, description) VALUES (?, ?, ?, ?)'
  ).run(id, req.user!.userId, name, description || '');

  const created = await db.query('SELECT * FROM playlists WHERE id = ?').get(id);
  res.status(201).json(created);
});

router.put('/:id', authMiddleware, async (req: Request, res: Response) => {
  const parsed = updatePlaylistSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map(e => e.message).join(', ') });
  }

  const db = getDb();
  const existing = await db.query('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId) as any;

  if (!existing) return res.status(404).json({ error: 'Playlist not found' });

  const { name, description, isPublic } = parsed.data;
  await db.query(`
    UPDATE playlists SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      is_public = COALESCE(?, is_public)
    WHERE id = ?
  `).run(name || null, description || null, isPublic !== undefined ? (isPublic ? 1 : 0) : null, req.params.id);

  const updated = await db.query('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
  res.json(updated);
});

router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const existing = await db.query('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId);

  if (!existing) return res.status(404).json({ error: 'Playlist not found' });

  await db.query('DELETE FROM playlists WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/tracks', authMiddleware, async (req: Request, res: Response) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId is required' });

  const db = getDb();
  const playlist = await db.query('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId) as any;
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const maxPos = await db.query('SELECT MAX(position) as max FROM playlist_tracks WHERE playlist_id = ?').get(req.params.id) as any;
  const position = (maxPos?.max ?? -1) + 1;

  await db.query(
    'INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'
  ).run(req.params.id, trackId, position);

  res.status(201).json({ success: true });
});

router.delete('/:playlistId/tracks/:trackId', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const playlist = await db.query('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.playlistId, req.user!.userId);

  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  await db.query('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(req.params.playlistId, req.params.trackId);
  res.json({ success: true });
});

router.post('/:id/cover', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const existing = await db.query('SELECT p.*, u.username FROM playlists p JOIN users u ON p.user_id = u.id WHERE p.id = ? AND p.user_id = ?').get(req.params.id, req.user!.userId) as any;
  if (!existing) return res.status(404).json({ error: 'Playlist not found' });

  coverUpload.single('cover')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    try {
      if (!isValidImage(req.file.buffer)) {
        return res.status(400).json({ error: 'El archivo no es una imagen v\u00e1lida' });
      }

      const ext = path.extname(req.file.originalname) || '.jpg';
      const shortId = uuid().slice(0, 8);
      const dest = `playlists/${existing.username}-${shortId}${ext}`;
      const coverUrl = await uploadToFirebase(req.file.buffer, dest, req.file.mimetype);

      await db.query('UPDATE playlists SET cover_url = ? WHERE id = ?').run(coverUrl, req.params.id);
      res.json({ coverUrl });
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Error al subir cover' });
    }
  });
});

export default router;
