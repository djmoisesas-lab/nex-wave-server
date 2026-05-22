import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';

const router = Router();

router.get('/', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  const notifications = db.query(`
    SELECT n.*,
      u.username as actor_username,
      u.display_name as actor_display_name,
      u.avatar_url as actor_avatar_url,
      t.title as track_title
    FROM notifications n
    LEFT JOIN users u ON u.id = n.actor_id
    LEFT JOIN tracks t ON t.id = n.track_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 50
  `).all(req.user!.userId);
  res.json(notifications);
});

router.post('/:id/read', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  db.query(
    'UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.user!.userId);
  res.json({ success: true });
});

router.post('/read-all', authMiddleware, (req: Request, res: Response) => {
  const db = getDb();
  db.query(
    'UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0'
  ).run(req.user!.userId);
  res.json({ success: true });
});

export default router;

export function createNotification(
  userId: string,
  type: string,
  message: string,
  trackId: string,
  actorId: string,
) {
  if (userId === actorId) return;
  const db = getDb();
  const id = uuid();
  db.query(
    'INSERT INTO notifications (id, user_id, type, message, track_id, actor_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, type, message, trackId, actorId);
}
