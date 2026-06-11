import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { getDb } from '../db';
import { authMiddleware, optionalAuth } from '../middleware/auth';
import { createNotification } from './notifications';

const createCommentSchema = z.object({
  content: z.string().min(1).max(1000),
  parentId: z.string().optional(),
});

const router = Router();

router.get('/:trackId/comments', optionalAuth, async (req: Request, res: Response) => {
  const { trackId } = req.params;
  const db = getDb();

  const isLikedSub = req.user
    ? `(SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id AND user_id = ?) > 0`
    : '0';
  const params: any[] = [];
  if (req.user) params.push(req.user.userId);
  params.push(trackId);

  const comments = await db.query(
    `SELECT c.id, c.track_id, c.user_id, c.content, c.parent_id, c.created_at,
            u.username, u.display_name, u.avatar_url,
            (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id) as likes_count,
            ${isLikedSub} as is_liked
     FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.track_id = ?
     ORDER BY c.created_at ASC`
  ).all(...params);

  res.json(comments);
});

router.post('/:trackId/comments', authMiddleware, async (req: Request, res: Response) => {
  const parsed = createCommentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { trackId } = req.params;
  const { content, parentId } = parsed.data;
  const db = getDb();
  const userId = req.user!.userId;

  const track = await db.query('SELECT id, user_id, title FROM tracks WHERE id = ?').get(trackId) as any;
  if (!track) {
    res.status(404).json({ error: 'Track no encontrado' });
    return;
  }

  if (parentId) {
    const parent = await db.query('SELECT id, user_id FROM comments WHERE id = ? AND track_id = ?').get(parentId, trackId) as any;
    if (!parent) {
      res.status(404).json({ error: 'Comentario padre no encontrado' });
      return;
    }
  }

  const id = uuid();

  await db.query(
    'INSERT INTO comments (id, track_id, user_id, content, parent_id) VALUES (?, ?, ?, ?, ?)'
  ).run(id, trackId, userId, content, parentId || null);

  const mentionedUsers = new Set<string>();
  const mentionRegex = /@(\w+)/g;
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const mentioned = await db.query('SELECT id FROM users WHERE username = ?').get(match[1]) as any;
    if (mentioned && mentioned.id !== userId && !mentionedUsers.has(mentioned.id)) {
      mentionedUsers.add(mentioned.id);
      createNotification(
        mentioned.id,
        'mention',
        `te mencionó en "${track.title}"`,
        trackId,
        userId,
      );
    }
  }

  if (parentId) {
    const parent = await db.query('SELECT user_id FROM comments WHERE id = ?').get(parentId) as any;
    if (parent && parent.user_id !== userId) {
      createNotification(
        parent.user_id,
        'comment',
        `respondió a tu comentario en "${track.title}"`,
        trackId,
        userId,
      );
    }
  } else if (track.user_id !== userId) {
    createNotification(
      track.user_id,
      'comment',
      `comentó en tu set "${track.title}"`,
      trackId,
      userId,
    );
  }

  const comment = await db.query(
    `SELECT c.id, c.track_id, c.user_id, c.content, c.parent_id, c.created_at,
            u.username, u.display_name, u.avatar_url,
            0 as likes_count, 0 as is_liked
     FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.id = ?`
  ).get(id);

  res.status(201).json(comment);
});

router.delete('/:trackId/comments/:commentId', authMiddleware, async (req: Request, res: Response) => {
  const { commentId } = req.params;
  const db = getDb();
  const userId = req.user!.userId;

  const comment = await db.query('SELECT * FROM comments WHERE id = ?').get(commentId) as any;
  if (!comment) {
    res.status(404).json({ error: 'Comentario no encontrado' });
    return;
  }

  if (comment.user_id !== userId) {
    res.status(403).json({ error: 'No autorizado' });
    return;
  }

  await db.query('DELETE FROM comments WHERE id = ? OR parent_id = ?').run(commentId, commentId);
  res.json({ success: true });
});

router.post('/:trackId/comments/:commentId/like', authMiddleware, async (req: Request, res: Response) => {
  const { commentId } = req.params;
  const db = getDb();
  const userId = req.user!.userId;

  const comment = await db.query('SELECT id, user_id FROM comments WHERE id = ?').get(commentId) as any;
  if (!comment) return res.status(404).json({ error: 'Comentario no encontrado' });

  await db.query('INSERT OR IGNORE INTO comment_likes (user_id, comment_id) VALUES (?, ?)').run(userId, commentId);
  const count = await db.query('SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?').get(commentId) as any;

  if (comment.user_id !== userId) {
    createNotification(
      comment.user_id,
      'like',
      `le gustó tu comentario`,
      null,
      userId,
    );
  }

  res.json({ liked: true, likes_count: count.count });
});

router.post('/:trackId/comments/:commentId/unlike', authMiddleware, async (req: Request, res: Response) => {
  const { commentId } = req.params;
  const db = getDb();
  await db.query('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?').run(req.user!.userId, commentId);
  const count = await db.query('SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?').get(commentId) as any;
  res.json({ liked: false, likes_count: count.count });
});

export default router;
