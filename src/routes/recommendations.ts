import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';

const router = Router();

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const userId = req.user!.userId;

  const userGenres = await db.query(`
    SELECT DISTINCT t.genre FROM play_history ph
    JOIN tracks t ON t.id = ph.track_id
    WHERE ph.user_id = ? AND t.genre != '' AND t.genre IS NOT NULL
  `).all(userId) as { genre: string }[];

  const genres = userGenres.map(g => g.genre);

  if (genres.length === 0) {
    const popularUsers = await db.query(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio,
        (SELECT COUNT(*) FROM tracks WHERE user_id = u.id) as track_count,
        (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count
      FROM users u
      WHERE u.id != ?
      ORDER BY followers_count DESC
      LIMIT 4
    `).all(userId) as any[];

    const popularTracks = await db.query(`
      SELECT t.*, u.username, u.display_name,
        (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as likes_count,
        (SELECT COUNT(*) FROM likes WHERE track_id = t.id AND user_id = ?) > 0 as is_liked
      FROM tracks t
      JOIN users u ON u.id = t.user_id
      WHERE t.is_public = 1 AND t.user_id != ?
        AND t.id NOT IN (SELECT track_id FROM likes WHERE user_id = ?)
      ORDER BY t.plays DESC
      LIMIT 4
    `).all(userId, userId, userId) as any[];

    return res.json({ users: popularUsers, tracks: popularTracks });
  }

  const placeholders = genres.map(() => '?').join(',');

  const suggestedUsers = await db.query(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio,
      (SELECT COUNT(*) FROM tracks WHERE user_id = u.id) as track_count,
      (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,
      (SELECT COUNT(*) FROM tracks WHERE user_id = u.id AND genre IN (${placeholders})) as genre_match
    FROM users u
    WHERE u.id != ?
      AND u.id NOT IN (SELECT following_id FROM follows WHERE follower_id = ?)
      AND EXISTS (SELECT 1 FROM tracks t2 WHERE t2.user_id = u.id AND t2.genre IN (${placeholders}))
    ORDER BY genre_match DESC, followers_count DESC
    LIMIT 4
  `).all(...genres, userId, userId, ...genres) as any[];

  const suggestedTracks = await db.query(`
    SELECT t.*, u.username, u.display_name,
      (SELECT COUNT(*) FROM likes WHERE track_id = t.id) as likes_count,
      (SELECT COUNT(*) FROM likes WHERE track_id = t.id AND user_id = ?) > 0 as is_liked
    FROM tracks t
    JOIN users u ON u.id = t.user_id
    WHERE t.genre IN (${placeholders})
      AND t.is_public = 1
      AND t.user_id != ?
      AND t.id NOT IN (SELECT track_id FROM play_history WHERE user_id = ?)
      AND t.id NOT IN (SELECT track_id FROM likes WHERE user_id = ?)
    ORDER BY t.plays DESC
    LIMIT 4
  `).all(userId, ...genres, userId, userId, userId) as any[];

  res.json({ users: suggestedUsers, tracks: suggestedTracks });
});

export default router;
