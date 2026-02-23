const BASE = '/api';

export interface Thread {
  id: string;
  title: string;
  soul: string | null;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

export interface Status {
  pending: number;
  lastHeartbeat: number | null;
  uptime: number;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  listThreads: () => json<Thread[]>('/threads'),
  createThread: (title?: string) =>
    json<Thread>('/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  deleteThread: (id: string) =>
    json<{ ok: boolean }>(`/threads/${id}`, { method: 'DELETE' }),
  listMessages: (threadId: string) =>
    json<Message[]>(`/threads/${threadId}/messages`),
  sendMessage: (threadId: string, content: string) =>
    json<Message>(`/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, role: 'user' }),
    }),
  getStatus: () => json<Status>('/status'),
};
