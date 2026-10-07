/**
 * Chats and store state.
 *
 * A store has many chats (`data/chats/<store>/<chatId>.json`: messages, the AI session, the plan waiting for OK, the
 * title) and one store state (`data/store-state/<store>.json`: the draft, the running build, the publish state),
 * because a store has one workspace, one draft and one build at a time.
 *
 * Stores from before many chats (`data/chats/<store>.json`) are split on first use: their messages, session and plan
 * become the chat `c_main`, their draft / run / publish the store state. The old file is renamed `.migrated`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const MAIN_CHAT = 'c_main';
export const NEW_CHAT_TITLE = 'New chat';
const CHAT_ID = /^c_([a-z0-9]{6,24}|main)$/;
const ARABIC = /[؀-ۿ]/;

export class ChatError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** What a page note means for the AI. */
function systemNote(text) {
  if (/^Discarded/i.test(text)) return '[The owner pressed Discard: every change not yet approved was thrown away; the store is back to its last approved look.]';
  if (/^Approved/i.test(text)) return '[The owner pressed Approve: the changes so far are kept.]';
  if (/^Published/i.test(text)) return '[The owner pressed Publish: every approved change is live on the website now.]';
  if (/^Undid the last publish/i.test(text)) return '[The owner pressed Undo last publish: the website and the approved copy are back to the earlier version; the changes of that publish are gone.]';
  return `[${text}]`;
}

export function createChats(dataDir) {
  const chatsDir = path.join(dataDir, 'chats');
  const stateDir = path.join(dataDir, 'store-state');
  const chatFile = (storeId, chatId) => path.join(chatsDir, storeId, `${chatId}.json`);
  const oldFile = (storeId) => path.join(chatsDir, `${storeId}.json`);
  const stateFile = (storeId) => path.join(stateDir, `${storeId}.json`);
  /** Told about every change of a store (the event streams push the views to the admin page). */
  const changes = new EventEmitter();
  changes.setMaxListeners(0);
  const migrated = new Set();

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  };
  const blankChat = (storeId, id, title = NEW_CHAT_TITLE) => {
    const now = new Date().toISOString();
    return { id, storeId, title, createdAt: now, updatedAt: now, sessionId: null, sessionCostUsd: 0, pending: null, lightRun: null, messages: [] };
  };

  /** Splits a pre-many-chats chat file (see the top of this file). Runs once per store and process. */
  function migrate(storeId) {
    if (migrated.has(storeId)) return;
    migrated.add(storeId);
    const old = readJson(oldFile(storeId));
    if (!old || typeof old !== 'object' || !fs.existsSync(oldFile(storeId))) return;
    const messages = Array.isArray(old.messages) ? old.messages : [];
    const arabic = messages.filter((m) => ARABIC.test(String(m.text ?? ''))).length * 2 > messages.length;
    const chat = {
      ...blankChat(storeId, MAIN_CHAT, arabic ? 'المحادثة الأولى' : 'First chat'),
      sessionId: old.sessionId ?? null,
      sessionCostUsd: old.sessionCostUsd ?? 0,
      pending: old.pending ?? null,
      messages,
    };
    const last = messages.at(-1)?.at;
    if (last) chat.updatedAt = last;
    writeJson(chatFile(storeId, MAIN_CHAT), chat);
    const state = { draft: old.draft ?? null, run: old.run ?? null, publish: old.publish ?? undefined };
    if (state.draft) state.draft.chatId ??= MAIN_CHAT;
    if (state.run) state.run.chatId ??= MAIN_CHAT;
    writeJson(stateFile(storeId), state);
    fs.renameSync(oldFile(storeId), `${oldFile(storeId)}.migrated`);
  }

  function checkId(chatId) {
    if (typeof chatId !== 'string' || !CHAT_ID.test(chatId)) throw new ChatError('not_found', 'No such chat.');
  }

  /** The chat as stored; `c_main` is created on first use (the old single-chat routes), others must exist. */
  function read(storeId, chatId) {
    migrate(storeId);
    checkId(chatId);
    const chat = readJson(chatFile(storeId, chatId));
    if (chat) return chat;
    if (chatId === MAIN_CHAT) return blankChat(storeId, MAIN_CHAT);
    throw new ChatError('not_found', 'No such chat.');
  }

  function write(chat) {
    writeJson(chatFile(chat.storeId, chat.id), chat);
    return chat;
  }

  const readState = (storeId) => {
    migrate(storeId);
    return { draft: null, run: null, ...(readJson(stateFile(storeId)) ?? {}) };
  };

  const api = {
    get: read,

    /** Every chat of a store, newest first, as the list shows it. */
    list(storeId) {
      migrate(storeId);
      let names = [];
      try {
        names = fs.readdirSync(path.join(chatsDir, storeId));
      } catch {
        // no chats yet
      }
      const run = readState(storeId).run;
      const building = run && run.state !== 'done' ? run.chatId : null;
      return names
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(chatsDir, storeId, name)))
        .filter((chat) => chat?.id)
        .map((chat) => {
          const last = [...chat.messages].reverse().find((m) => ['merchant', 'assistant'].includes(m.role));
          return { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, lastText: String(last?.text ?? '').slice(0, 80), building: building === chat.id };
        })
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    create(storeId, { title } = {}) {
      migrate(storeId);
      const chat = blankChat(storeId, `c_${randomBytes(6).toString('hex')}`, cleanTitle(title) ?? NEW_CHAT_TITLE);
      write(chat);
      changes.emit('change', storeId, chat.id);
      return chat;
    },

    rename(storeId, chatId, title) {
      const clean = cleanTitle(title);
      if (!clean) throw new ChatError('invalid_title', 'A chat title is 1-40 characters.');
      return this.update(storeId, chatId, (chat) => {
        chat.title = clean;
      });
    },

    /** Deletes a chat unless it holds the running build or the open draft. */
    remove(storeId, chatId) {
      read(storeId, chatId);
      const { run, draft } = readState(storeId);
      if ((run && run.state !== 'done' && run.chatId === chatId) || draft?.chatId === chatId) {
        throw new ChatError('chat_busy', 'This chat is making a change or holds a change waiting for approval.');
      }
      fs.rmSync(chatFile(storeId, chatId), { force: true });
      changes.emit('change', storeId, chatId);
    },

    /** The chat that notes about store-level actions (publish...) go to when none is named: the latest one. */
    latestId(storeId) {
      return this.list(storeId)[0]?.id ?? MAIN_CHAT;
    },

    /** Calls `listener(chatId)` after every change of this store's chats or state; returns the unsubscribe function. */
    watch(storeId, listener) {
      const handler = (id, chatId) => id === storeId && listener(chatId);
      changes.on('change', handler);
      return () => changes.off('change', handler);
    },

    update(storeId, chatId, change) {
      const chat = read(storeId, chatId);
      change(chat);
      chat.updatedAt = new Date().toISOString();
      write(chat);
      changes.emit('change', storeId, chatId);
      return chat;
    },

    say(storeId, chatId, role, text, extra = {}) {
      const message = { id: randomUUID(), role, text, at: new Date().toISOString(), ...extra };
      this.update(storeId, chatId, (chat) => chat.messages.push(message));
      return message;
    },

    /** A note in the named chat (when it still exists), else in the latest one. */
    note(storeId, chatId, role, text, extra = {}) {
      let target = chatId;
      try {
        read(storeId, chatId ?? '');
      } catch {
        target = this.latestId(storeId);
      }
      return this.say(storeId, target, role, text, extra);
    },

    /**
     * The last few messages, for the AI's context — including the page's own notes ("Approved.", "Discarded."), so
     * it knows a change it made earlier is gone (or live) now.
     */
    recent(storeId, chatId, count = 6) {
      return read(storeId, chatId)
        .messages.filter((m) => ['merchant', 'assistant', 'system'].includes(m.role))
        .map((m) => (m.role === 'system' ? { ...m, text: systemNote(m.text) } : m))
        .slice(-count);
    },

    /** Store-level things: the draft, the running build, the publish state. */
    state: {
      get: readState,
      update(storeId, change) {
        const state = readState(storeId);
        change(state);
        writeJson(stateFile(storeId), state);
        changes.emit('change', storeId, null);
        return state;
      },
    },
  };
  return api;
}

/** 1-40 characters, or null. */
export function cleanTitle(title) {
  if (typeof title !== 'string') return null;
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  return clean || null;
}
