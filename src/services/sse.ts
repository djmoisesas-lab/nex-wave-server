import { Response } from 'express';

const clients = new Map<string, Response>();

export function addClient(userId: string, res: Response) {
  const existing = clients.get(userId);
  if (existing) {
    existing.end();
  }
  clients.set(userId, res);
  res.on('close', () => {
    if (clients.get(userId) === res) {
      clients.delete(userId);
    }
  });
}

export function sendToUser(userId: string, event: string, data: unknown) {
  const res = clients.get(userId);
  if (!res) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(message);
}
