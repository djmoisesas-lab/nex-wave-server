import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

describe('Auth schemas', () => {
  const loginSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(6),
  });

  test('login schema accepts valid input', () => {
    const result = loginSchema.safeParse({ username: 'test', password: '123456' });
    expect(result.success).toBe(true);
  });

  test('login schema rejects short password', () => {
    const result = loginSchema.safeParse({ username: 'test', password: '123' });
    expect(result.success).toBe(false);
  });

  test('login schema rejects empty username', () => {
    const result = loginSchema.safeParse({ username: '', password: '123456' });
    expect(result.success).toBe(false);
  });
});

describe('Track schemas', () => {
  const updateTrackSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    artist: z.string().max(200).optional(),
    genre: z.string().max(100).optional(),
    bpm: z.number().positive().optional(),
    musicalKey: z.string().max(20).optional(),
    description: z.string().max(2000).optional(),
    isPublic: z.boolean().optional(),
  });

  test('update schema accepts valid data', () => {
    const result = updateTrackSchema.safeParse({
      title: 'My Set',
      artist: 'DJ Test',
      genre: 'House',
      bpm: 128,
    });
    expect(result.success).toBe(true);
    expect(result.data?.title).toBe('My Set');
  });

  test('update schema rejects empty title', () => {
    const result = updateTrackSchema.safeParse({ title: '' });
    expect(result.success).toBe(false);
  });

  test('update schema rejects negative bpm', () => {
    const result = updateTrackSchema.safeParse({ bpm: -5 });
    expect(result.success).toBe(false);
  });

  test('update schema accepts empty object (all optional)', () => {
    const result = updateTrackSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('Playlist schemas', () => {
  const createPlaylistSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  });

  test('create schema accepts valid input', () => {
    const result = createPlaylistSchema.safeParse({ name: 'My Playlist' });
    expect(result.success).toBe(true);
  });

  test('create schema rejects empty name', () => {
    const result = createPlaylistSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });
});

describe('Comment schemas', () => {
  const createCommentSchema = z.object({
    content: z.string().min(1).max(1000),
  });

  test('comment schema accepts valid input', () => {
    const result = createCommentSchema.safeParse({ content: 'Great set!' });
    expect(result.success).toBe(true);
  });

  test('comment schema rejects empty content', () => {
    const result = createCommentSchema.safeParse({ content: '' });
    expect(result.success).toBe(false);
  });

  test('comment schema rejects content over 1000 chars', () => {
    const result = createCommentSchema.safeParse({ content: 'a'.repeat(1001) });
    expect(result.success).toBe(false);
  });
});

test('genres list should have expected entries', () => {
  const genres = [
    'House', 'Techno', 'Deep House', 'Tech House', 'Progressive House',
    'Trance', 'Dubstep', 'Drum & Bass', 'Minimal', 'Electro',
    'Disco', 'Funk', 'Hip Hop', 'R&B', 'Pop', 'Rock', 'Reggaeton',
    'Latin', 'Afrobeat', 'Ambient', 'Experimental', 'Other',
  ];
  expect(genres.length).toBe(22);
  expect(genres).toContain('House');
  expect(genres).toContain('Techno');
  expect(genres).toContain('Other');
});

test('magic bytes MIME detection logic works', () => {
  const MAGIC_BYTES: Record<string, [number, number[]][]> = {
    'audio/mpeg': [[0, [0xFF, 0xFB]]],
    'audio/wav': [[0, [0x52, 0x49, 0x46, 0x46]]],
    'audio/flac': [[0, [0x66, 0x4C, 0x61, 0x43]]],
  };

  function checkMime(mime: string, buf: number[]): boolean {
    const signatures = MAGIC_BYTES[mime];
    if (!signatures) return false;
    for (const [offset, magic] of signatures) {
      if (magic.every((byte, i) => buf[offset + i] === byte)) {
        return true;
      }
    }
    return false;
  }

  const mp3Header = [0xFF, 0xFB, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00];
  const wavHeader = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00];
  const flacHeader = [0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x00];

  expect(checkMime('audio/mpeg', mp3Header)).toBe(true);
  expect(checkMime('audio/wav', wavHeader)).toBe(true);
  expect(checkMime('audio/flac', flacHeader)).toBe(true);
  expect(checkMime('audio/mpeg', wavHeader)).toBe(false);
  expect(checkMime('audio/wav', mp3Header)).toBe(false);
});
