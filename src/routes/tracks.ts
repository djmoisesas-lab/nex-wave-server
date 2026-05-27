import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import { exec } from 'child_process';
import { z } from 'zod';
import { getDb } from '../db';
import { authMiddleware, optionalAuth } from '../middleware/auth';
import { createNotification } from './notifications';
import { uploadToFirebase, deleteFromFirebase, extractFirebasePath, isValidImage, bucket } from '../services/firebase';

const updateTrackSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  artist: z.string().max(200).optional(),
  genre: z.string().max(100).optional(),
  bpm: z.number().positive().optional(),
  musicalKey: z.string().max(20).optional(),
  description: z.string().max(2000).optional(),
  isPublic: z.boolean().optional(),
  cover_url: z.string().nullable().optional(),
});

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_CONCURRENT_UPLOADS = 5;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const TEMP_DIR = path.resolve(UPLOAD_DIR, 'temp');

let activeUploads = 0;

type Signature = [offset: number, bytes: number[], mask?: number[]];

const MAGIC_BYTES: Record<string, Signature[]> = {
  'audio/mpeg': [[0, [0xFF, 0xE0], [0xFF, 0xE0]]],
  'audio/mp3': [[0, [0xFF, 0xE0], [0xFF, 0xE0]]],
  'audio/wav': [[0, [0x52, 0x49, 0x46, 0x46]]],
  'audio/x-wav': [[0, [0x52, 0x49, 0x46, 0x46]]],
  'audio/flac': [[0, [0x66, 0x4C, 0x61, 0x43]]],
  'audio/x-flac': [[0, [0x66, 0x4C, 0x61, 0x43]]],
  'audio/aac': [[0, [0xFF, 0xF1]], [0, [0xFF, 0xF9]]],
  'audio/ogg': [[0, [0x4F, 0x67, 0x67, 0x53]]],
  'audio/x-m4a': [[0, [0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]], [4, [0x66, 0x74, 0x79, 0x70]]],
};

const EXT_MIME_MAP: Record<string, string[]> = {
  '.mp3': ['audio/mpeg', 'audio/mp3'],
  '.wav': ['audio/wav', 'audio/x-wav'],
  '.flac': ['audio/flac', 'audio/x-flac'],
  '.aac': ['audio/aac'],
  '.ogg': ['audio/ogg'],
  '.m4a': ['audio/mp4', 'audio/x-m4a'],
};

function detectMimeType(filePath: string, ext: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);

    if (bytesRead === 0) return null;

    const candidates = EXT_MIME_MAP[ext];
    if (!candidates) return null;

    for (const mime of candidates) {
      const signatures = MAGIC_BYTES[mime];
      if (!signatures) continue;

      if (mime.startsWith('audio/mp')) {
        const id3Offset = buf.indexOf(Buffer.from('ID3'));
        const startOffset = id3Offset >= 0 ? id3Offset + 10 : 0;
        for (let offset = startOffset; offset < Math.min(bytesRead - 1, startOffset + 2048); offset++) {
          if (buf[offset] === 0xFF && (buf[offset + 1] & 0xE0) === 0xE0) {
            return mime;
          }
        }
        if (ext === '.mp3') return 'audio/mpeg';
      } else {
        for (const [offset, magic, mask] of signatures) {
          if (magic.every((byte, i) => (buf[offset + i] & (mask?.[i] ?? 0xFF)) === byte)) {
            return mime;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, {
      timeout: 30000,
    }, (err, stdout) => {
      if (err || !stdout) {
        const stat = fs.statSync(filePath);
        resolve(Math.max(1, Math.round(stat.size / 25000)));
        return;
      }
      const dur = parseFloat(stdout.trim());
      resolve(isNaN(dur) ? 0 : Math.round(dur));
    });
  });
}

function generateWaveform(filePath: string, points: number = 200): number[] {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const CHUNK_SIZE = Math.max(1024, Math.floor(fileSize / points));
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(CHUNK_SIZE);
  const waveform: number[] = [];

  try {
    for (let i = 0; i < points; i++) {
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, Math.min(i * CHUNK_SIZE, fileSize - CHUNK_SIZE));
      if (bytesRead === 0) break;

      let sum = 0;
      for (let j = 0; j < bytesRead - 1; j += 2) {
        const sample = buf.readInt16LE(j);
        sum += Math.abs(sample);
      }
      const avg = sum / Math.max(1, bytesRead / 2);
      const norm = Math.min(1, avg / 32768);
      waveform.push(Math.max(0.02, norm));
    }
  } finally {
    fs.closeSync(fd);
  }

  return waveform;
}

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: mp3, wav, flac, aac, ogg, m4a'));
    }
  },
});

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image type. Allowed: jpg, png, webp, gif'));
    }
  },
});

router.get('/', optionalAuth, (req: Request, res: Response) => {
  const db = getDb();
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const genre = req.query.genre as string;
  const search = req.query.search as string;
  const sort = req.query.sort as string || 'created_at';

  const isLikedSub = req.user
    ? `(SELECT COUNT(*) FROM likes WHERE track_id = t.id AND user_id = ?) > 0`
    : '0';
  let query = `SELECT t.*, u.username, u.display_name,
    (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as likes_count,
    ${isLikedSub} as is_liked
    FROM tracks t JOIN users u ON t.user_id = u.id WHERE t.is_public = 1`;
  const params: any[] = [];
  if (req.user) params.push(req.user.userId);

  if (genre) {
    query += ' AND t.genre = ?';
    params.push(genre);
  }
  if (search) {
    query += ' AND (t.title LIKE ? OR t.artist LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const sortMap: Record<string, string> = {
    plays: 't.plays DESC',
    likes: 'likes_count DESC',
    date: 't.created_at DESC',
    title: 't.title ASC',
  };
  query += ' ORDER BY ' + (sortMap[sort] || 't.created_at DESC') + ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const tracks = db.query(query).all(...params);
  const total = db.query(
    'SELECT COUNT(*) as count FROM tracks WHERE is_public = 1'
  ).get() as any;

  res.json({ tracks, total: total.count, page, limit });
});

router.get('/my', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const tracks = db.query(`
    SELECT t.*,
      (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as likes_count,
      (SELECT COUNT(*) FROM likes WHERE track_id = t.id AND user_id = ?) > 0 as is_liked
    FROM tracks t WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ? OFFSET ?
  `).all(req.user!.userId, req.user!.userId, limit, offset);
  const total = db.query(
    'SELECT COUNT(*) as count FROM tracks WHERE user_id = ?'
  ).get(req.user!.userId) as any;
  res.json({ tracks, total: total.count, page, limit });
});

router.get('/:id', optionalAuth, (req: Request, res: Response) => {
  const db = getDb();
  const isLikedSub = req.user
    ? `(SELECT COUNT(*) FROM likes WHERE track_id = t.id AND user_id = ?) > 0`
    : '0';
  const params: any[] = [];
  if (req.user) params.push(req.user.userId);
  params.push(req.params.id);
  const track = db.query(`
    SELECT t.*, u.username, u.display_name,
      (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as likes_count,
      ${isLikedSub} as is_liked
    FROM tracks t JOIN users u ON t.user_id = u.id WHERE t.id = ?
  `).get(...params) as any;

  if (!track) return res.status(404).json({ error: 'Track not found' });
  if (!track.is_public && (!req.user || req.user.userId !== track.user_id)) {
    return res.status(404).json({ error: 'Track not found' });
  }

  res.json(track);
});

router.post('/:id/play', optionalAuth, (req: Request, res: Response) => {
  const db = getDb();
  const track = db.query('SELECT id, user_id, is_public FROM tracks WHERE id = ?').get(req.params.id) as any;
  if (!track) return res.status(404).json({ error: 'Track not found' });
  if (!track.is_public && (!req.user || req.user.userId !== track.user_id)) {
    return res.status(404).json({ error: 'Track not found' });
  }

  let shouldCount = false;

  if (req.user) {
    const existing = db.query(
      'SELECT id FROM track_plays WHERE track_id = ? AND user_id = ?'
    ).get(req.params.id, req.user.userId);
    if (!existing) shouldCount = true;
  } else {
    const ip = req.ip || req.socket.remoteAddress || '';
    const recent = db.query(
      "SELECT id FROM track_plays WHERE track_id = ? AND ip = ? AND created_at > datetime('now', '-1 day')"
    ).get(req.params.id, ip);
    if (!recent) shouldCount = true;
  }

  if (shouldCount) {
    db.query('UPDATE tracks SET plays = plays + 1 WHERE id = ?').run(req.params.id);
    db.query(
      'INSERT INTO track_plays (id, track_id, user_id, ip) VALUES (?, ?, ?, ?)'
    ).run(uuid(), req.params.id, req.user?.userId || null, req.ip || req.socket.remoteAddress || '');
    if (req.user) {
      db.query(
        'INSERT INTO play_history (id, user_id, track_id) VALUES (?, ?, ?)'
      ).run(uuid(), req.user.userId, req.params.id);
    }
  }

  const updated = db.query('SELECT plays FROM tracks WHERE id = ?').get(req.params.id) as any;
  res.json({ plays: updated.plays });
});



router.post('/:id/report', optionalAuth, (req: Request, res: Response) => {
  const { reason, description } = req.body;
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return res.status(400).json({ error: 'Motivo requerido' });
  }
  const db = getDb();
  const track = db.query('SELECT id FROM tracks WHERE id = ?').get(req.params.id) as any;
  if (!track) return res.status(404).json({ error: 'Track not found' });
  db.query(
    'INSERT INTO reports (id, track_id, user_id, reason, description) VALUES (?, ?, ?, ?, ?)'
  ).run(uuid(), req.params.id, req.user?.userId || null, reason.trim(), (description || '').trim());
  res.json({ success: true, message: 'Reporte enviado. Gracias por ayudar a mantener la comunidad.' });
});

router.post('/', authMiddleware, (req: Request, res: Response) => {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({ error: 'Demasiadas subidas concurrentes. Intentá de nuevo en unos minutos.' });
  }

  req.setTimeout(UPLOAD_TIMEOUT_MS, () => {
    activeUploads--;
    res.status(408).json({ error: 'La subida superó el tiempo máximo (30 min). Intentá de nuevo.' });
  });

  activeUploads++;

  audioUpload.single('audio')(req, res, async (err) => {
    if (err) {
      activeUploads--;
      const msg = err.message === 'File too large'
        ? 'El archivo supera el límite de 500 MB'
        : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      activeUploads--;
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const { title, artist, genre, bpm, musicalKey, description, coverUrl } = req.body;
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      activeUploads--;
      return res.status(400).json({ error: 'Title is required' });
    }
    if (title.length > 200) {
      activeUploads--;
      return res.status(400).json({ error: 'Title must be 200 characters or less' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();

    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    const tempPath = path.resolve(TEMP_DIR, `${uuid()}${ext}`);
    fs.writeFileSync(tempPath, req.file.buffer);

    const detectedMime = detectMimeType(tempPath, ext);
    if (!detectedMime) {
      fs.unlinkSync(tempPath);
      activeUploads--;
      return res.status(400).json({ error: 'El archivo no parece un formato de audio v\u00e1lido' });
    }

    const duration = await getAudioDuration(tempPath);

    const db = getDb();
    const id = uuid();
    const user = db.query('SELECT username FROM users WHERE id = ?').get(req.user!.userId) as any;

    let waveformJson: string | null = null;
    try {
      const waveformData = generateWaveform(tempPath, 200);
      waveformJson = JSON.stringify(waveformData);
      await uploadToFirebase(Buffer.from(waveformJson), `waveforms/${id}.json`, 'application/json');
    } catch {
    }

    const shortId = uuid().slice(0, 8);
    const firebaseDest = `audios/${user.username}-${shortId}${ext}`;
    await uploadToFirebase(req.file.buffer, firebaseDest, detectedMime);

    fs.unlinkSync(tempPath);

    const track = {
      id,
      user_id: req.user!.userId,
      title,
      artist: artist || '',
      genre: genre || '',
      bpm: bpm ? parseFloat(bpm) : null,
      musical_key: musicalKey || '',
      description: description || '',
      filename: firebaseDest,
      original_name: req.file.originalname,
      mime_type: detectedMime,
      file_size: req.file.size,
      duration,
      cover_url: coverUrl || null,
      is_public: 1,
    };

    db.query(`
      INSERT INTO tracks (id, user_id, title, artist, genre, bpm, musical_key, description, filename, original_name, mime_type, file_size, duration, cover_url, is_public, waveform_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user!.userId, title, track.artist, track.genre, track.bpm, track.musical_key, track.description, track.filename, track.original_name, track.mime_type, track.file_size, track.duration, track.cover_url, track.is_public, waveformJson);

    const followers = db.query(`
      SELECT follower_id FROM follows WHERE following_id = ? AND notify_on_upload = 1
    `).all(req.user!.userId) as { follower_id: string }[];
    for (const f of followers) {
      createNotification(f.follower_id, 'upload', `subió un nuevo set: "${title}"`, id, req.user!.userId);
    }

    activeUploads--;
    res.status(201).json({ id, ...track });
  });
});

router.put('/:id', authMiddleware, (req: Request, res: Response) => {
  const parsed = updateTrackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors.map(e => e.message).join(', ') });
  }

  const db = getDb();
  const existing = db.query('SELECT * FROM tracks WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId) as any;

  if (!existing) return res.status(404).json({ error: 'Track not found' });

  const { title, artist, genre, bpm, musicalKey, description, isPublic, cover_url } = parsed.data;
  db.query(`
    UPDATE tracks SET title = COALESCE(?, title), artist = COALESCE(?, artist), genre = COALESCE(?, genre),
    bpm = COALESCE(?, bpm), musical_key = COALESCE(?, musical_key), description = COALESCE(?, description),
    is_public = COALESCE(?, is_public), cover_url = COALESCE(?, cover_url) WHERE id = ?
  `).run(
    title || null, artist || null, genre || null,
    bpm ? parseFloat(bpm) : null, musicalKey || null, description || null,
    isPublic !== undefined ? (isPublic ? 1 : 0) : null,
    cover_url !== undefined ? cover_url : null,
    req.params.id
  );

  const updated = db.query('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  res.json(updated);
});

router.post('/:id/cover', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const track = db.query('SELECT t.*, u.username FROM tracks t JOIN users u ON t.user_id = u.id WHERE t.id = ? AND t.user_id = ?').get(req.params.id, req.user!.userId) as any;

  if (!track) return res.status(404).json({ error: 'Track not found' });

  coverUpload.single('cover')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    try {
      if (!isValidImage(req.file.buffer)) {
        return res.status(400).json({ error: 'El archivo no es una imagen v\u00e1lida' });
      }

      if (track.cover_url?.includes('storage.googleapis.com')) {
        const dest = extractFirebasePath(track.cover_url);
        if (dest) await deleteFromFirebase(dest);
      }

      const ext = path.extname(req.file.originalname) || '.jpg';
      const shortId = uuid().slice(0, 8);
      const dest = `covers/${track.username}-${shortId}${ext}`;
      const coverUrl = await uploadToFirebase(req.file.buffer, dest, req.file.mimetype);

      db.query('UPDATE tracks SET cover_url = ? WHERE id = ?').run(coverUrl, req.params.id);

      res.json({ coverUrl });
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Error al subir cover' });
    }
  });
});

router.delete('/:id', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const track = db.query('SELECT * FROM tracks WHERE id = ? AND user_id = ?').get(req.params.id, req.user!.userId) as any;

  if (!track) return res.status(404).json({ error: 'Track not found' });

  if (track.filename) {
    deleteFromFirebase(track.filename);
  }

  if (track.cover_url?.includes('storage.googleapis.com')) {
    const dest = extractFirebasePath(track.cover_url);
    if (dest) deleteFromFirebase(dest);
  }

  deleteFromFirebase(`waveforms/${track.id}.json`);

  db.query('DELETE FROM tracks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/:id/stream', optionalAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const track = db.query('SELECT t.*, u.username, u.display_name FROM tracks t JOIN users u ON t.user_id = u.id WHERE t.id = ?').get(req.params.id) as any;

  if (!track) return res.status(404).json({ error: 'Track not found' });
  if (!track.is_public && (!req.user || req.user.userId !== track.user_id)) {
    return res.status(404).json({ error: 'Track not found' });
  }
  if (!track.filename) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const file = bucket.file(track.filename);
    const [meta] = await file.getMetadata();
    const fileSize = parseInt(meta.size, 10);
    const mimeType = track.mime_type || meta.contentType || 'audio/mpeg';
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = file.createReadStream({ start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });
      stream.pipe(res);
    } else {
      const stream = file.createReadStream();
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      });
      stream.pipe(res);
    }
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

router.post('/:id/like', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const track = db.query('SELECT id, user_id, title FROM tracks WHERE id = ?').get(req.params.id) as any;
  if (!track) return res.status(404).json({ error: 'Track not found' });

  db.query('INSERT OR IGNORE INTO likes (user_id, track_id) VALUES (?, ?)').run(req.user!.userId, req.params.id);
  const count = db.query('SELECT COUNT(*) as count FROM likes WHERE track_id = ?').get(req.params.id) as any;

  if (track.user_id !== req.user!.userId) {
    createNotification(
      track.user_id,
      'like',
      `le gustó tu set "${track.title}"`,
      req.params.id,
      req.user!.userId,
    );
  }

  res.json({ liked: true, likes_count: count.count });
});

router.post('/:id/unlike', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  db.query('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(req.user!.userId, req.params.id);
  const count = db.query('SELECT COUNT(*) as count FROM likes WHERE track_id = ?').get(req.params.id) as any;
  res.json({ liked: false, likes_count: count.count });
});

router.get('/:id/download', optionalAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const track = db.query('SELECT t.*, u.username, u.display_name FROM tracks t JOIN users u ON t.user_id = u.id WHERE t.id = ?').get(req.params.id) as any;

  if (!track) return res.status(404).json({ error: 'Track not found' });
  if (!track.is_public && (!req.user || req.user.userId !== track.user_id)) {
    return res.status(404).json({ error: 'Track not found' });
  }
  if (!track.filename) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    db.query('UPDATE tracks SET downloads = downloads + 1 WHERE id = ?').run(req.params.id);

    const [url] = await bucket.file(track.filename).getSignedUrl({
      action: 'read',
      expires: Date.now() + 3600 * 1000,
      responseDisposition: `attachment; filename="${track.title}${path.extname(track.original_name) || ''}"`,
    });
    res.redirect(url);
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

export default router;
