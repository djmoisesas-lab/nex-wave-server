import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import jwt from 'jsonwebtoken';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { getJwtSecret } from '../auth';
import { addClient, sendToUser } from '../services/sse';

const router = Router();

router.get('/stream', (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const payload = jwt.verify(token, getJwtSecret()) as { userId: string };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: connected\ndata: {}\n\n');
    addClient(payload.userId, res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30000);
    req.on('close', () => clearInterval(heartbeat));
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  const notifications = await db.query(`
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

router.post('/:id/read', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  await db.query(
    'UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?'
  ).run(req.params.id, req.user!.userId);
  res.json({ success: true });
});

router.post('/read-all', authMiddleware, async (req: Request, res: Response) => {
  const db = getDb();
  await db.query(
    'UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0'
  ).run(req.user!.userId);
  res.json({ success: true });
});

export default router;

export async function createNotification(
  userId: string,
  type: string,
  message: string,
  trackId: string,
  actorId: string,
) {
  if (userId === actorId) return;
  const db = getDb();
  const id = uuid();
  await db.query(
    'INSERT INTO notifications (id, user_id, type, message, track_id, actor_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, type, message, trackId, actorId);
  const notification = await db.query(`
    SELECT n.*, u.username as actor_username, u.display_name as actor_display_name,
      u.avatar_url as actor_avatar_url, t.title as track_title
    FROM notifications n
    LEFT JOIN users u ON u.id = n.actor_id
    LEFT JOIN tracks t ON t.id = n.track_id
    WHERE n.id = ?
  `).get(id) as any;
  sendToUser(userId, 'notification', notification);
}
