import express from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { getDb } from './db';
import authRoutes from './routes/auth';
import trackRoutes from './routes/tracks';
import commentRoutes from './routes/comments';
import playlistRoutes from './routes/playlists';
import userRoutes from './routes/users';
import notificationRoutes from './routes/notifications';
import recommendationRoutes from './routes/recommendations';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const isProd = process.env.NODE_ENV === 'production';

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : isProd
    ? [process.env.DOMAIN || 'https://tudominio.com']
    : ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173', 'http://127.0.0.1:5174'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

app.use(express.json({ limit: '10mb' }));

app.use('/uploads', express.static(path.resolve(import.meta.dir!, '..', 'uploads'))); // legacy files only

app.use('/api/auth', authRoutes);
app.use('/api/tracks', trackRoutes);
app.use('/api/tracks', commentRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/recommendations', recommendationRoutes);

app.get('/api/genres', (_req, res) => {
  const db = getDb();
  const rows = db.query(
    "SELECT DISTINCT genre FROM tracks WHERE genre != '' AND genre IS NOT NULL ORDER BY genre ASC"
  ).all() as { genre: string }[];
  const dbGenres = rows.map(r => r.genre);
  const defaults = ['House', 'Techno', 'Deep House', 'Tech House', 'Progressive House',
    'Trance', 'Dubstep', 'Drum & Bass', 'Minimal', 'Electro',
    'Disco', 'Funk', 'Hip Hop', 'R&B', 'Pop', 'Rock', 'Reggaeton',
    'Latin', 'Afrobeat', 'Ambient', 'Experimental', 'Other'];
  const all = [...new Set([...defaults, ...dbGenres])];
  res.json(all);
});

if (isProd) {
  const clientDist = path.resolve(import.meta.dir!, '..', '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: isProd ? 'Internal server error' : err.message });
});

app.listen(PORT, () => {
  console.log(`DJ Catalog API running on http://localhost:${PORT} [${isProd ? 'production' : 'development'}]`);
});

