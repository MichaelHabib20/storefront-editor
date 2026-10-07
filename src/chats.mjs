/**
 * One chat per store: the messages the admin page shows, the current run's state (polled by the page), and the
 * agent's session id so the conversation continues across messages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** What a page note means for the AI. */
function systemNote(text) {
  if (/^Discarded/i.test(text)) return '[The owner pressed Discard: every change not yet approved was thrown away; the store is back to its last approved look.]';
  if (/^Approved/i.test(text)) return '[The owner pressed Approve: the changes so far are kept.]';
  if (/^Published/i.test(text)) return '[The owner pressed Publish: every approved change is live on the website now.]';
  if (/^Undid the last publish/i.test(text)) return '[The owner pressed Undo last publish: the website and the approved copy are back to the earlier version; the changes of that publish are gone.]';  return `[${text}]`;
}

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

    /**
     * The last few messages, for the AI's context — including the page's own notes ("Approved.", "Discarded."), so
     * it knows a change it made earlier is gone (or live) now.
     */
    recent(storeId, count = 6) {
      return read(storeId)
        .messages.filter((m) => ['merchant', 'assistant', 'system'].includes(m.role))
        .map((m) => (m.role === 'system' ? { ...m, text: systemNote(m.text) } : m))
        .slice(-count);
    },
  };
}
