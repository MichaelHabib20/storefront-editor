/**
 * One chat per store: the messages the admin page shows, the current run's state (polled by the page), and the
 * agent's session id so the conversation continues across messages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export function createChats(dataDir) {
  const dir = path.join(dataDir, 'chats');
  const fileOf = (storeId) => path.join(dir, `${storeId}.json`);
  /** Told about every change (the event streams push it to the admin page). */
  const changes = new EventEmitter();
  changes.setMaxListeners(0);

  function read(storeId) {
    try {
      return JSON.parse(fs.readFileSync(fileOf(storeId), 'utf8'));
    } catch {
      return { storeId, sessionId: null, sessionCostUsd: 0, messages: [], run: null, draft: null };
    }
  }

  function write(chat) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileOf(chat.storeId), JSON.stringify(chat, null, 2));
    return chat;
  }

  return {
    get: read,

    /** Calls `listener(chat)` after every change of this store's chat; returns the unsubscribe function. */
    watch(storeId, listener) {
      const handler = (id, chat) => id === storeId && listener(chat);
      changes.on('change', handler);
      return () => changes.off('change', handler);
    },

    update(storeId, change) {
      const chat = read(storeId);
      change(chat);
      write(chat);
      changes.emit('change', storeId, chat);
      return chat;
    },

    say(storeId, role, text, extra = {}) {
      const message = { id: randomUUID(), role, text, at: new Date().toISOString(), ...extra };
      this.update(storeId, (chat) => chat.messages.push(message));
      return message;
    },

    /** The last few messages, for triage context. */
    recent(storeId, count = 6) {
      return read(storeId)
        .messages.filter((m) => m.role === 'merchant' || m.role === 'assistant')
        .slice(-count);
    },
  };
}
