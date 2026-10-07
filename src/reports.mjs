/**
 * Bug reports for our team (v2 plan §4.4): what the diagnosing AI could not fix on the store's side (a platform bug,
 * or something the store needs from us) is stored here with everything the team needs to look at it: the owner's
 * words, the steps, screenshots, the page's errors. `data/reports/<id>.json`, its files in `data/reports/<id>/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const STATUSES = ['new', 'in_progress', 'fixed', 'wont_fix'];
const ID = /^r_[a-f0-9]{12}$/;
const FILE = /^(shot|image)-\d\.(png|jpg|webp)$/;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const cut = (value, length) => String(value ?? '').slice(0, length);

/**
 * @param onFixed  called with the report when its status becomes "fixed" (the owner's chat gets a note)
 */
export function createReports({ dataDir, onFixed = () => {} }) {
  const dir = path.join(dataDir, 'reports');
  const fileOf = (id) => path.join(dir, `${id}.json`);

  function read(id) {
    if (!ID.test(String(id))) throw new ReportError('not_found', 'No such report.');
    try {
      return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    } catch {
      throw new ReportError('not_found', 'No such report.');
    }
  }

  const write = (report) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileOf(report.id), JSON.stringify(report, null, 2));
    return report;
  };

  const summary = (r) => ({ id: r.id, createdAt: r.createdAt, status: r.status, summary: r.summary });

  function all() {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    } catch {
      return [];
    }
  }

  return {
    /**
     * @param files  { images: [{ path, name }], screenshots: [{ path, name }] } copied into the report's folder
     */
    create({ storeId, chatId, summary: text, steps = [], ownerText = '', files = {}, consoleErrors = [], failedRequests = [] }) {
      const id = `r_${randomBytes(6).toString('hex')}`;
      const folder = path.join(dir, id);
      const copy = (list, prefix) => {
        const kept = [];
        for (const file of (list ?? []).slice(0, 3)) {
          const ext = String(file.name).split('.').pop();
          if (!TYPES[ext] || !fs.existsSync(file.path)) continue;
          fs.mkdirSync(folder, { recursive: true });
          const name = `${prefix}-${kept.length + 1}.${ext}`;
          fs.copyFileSync(file.path, path.join(folder, name));
          kept.push(name);
        }
        return kept;
      };
      return write({
        id,
        storeId,
        chatId,
        createdAt: new Date().toISOString(),
        status: 'new',
        summary: cut(text, 300),
        steps: steps.slice(0, 15).map((s) => cut(s, 160)),
        ownerText: cut(ownerText, 4000),
        images: copy(files.images, 'image'),
        screenshots: copy(files.screenshots, 'shot'),
        consoleErrors: consoleErrors.slice(0, 20).map((e) => cut(e, 300)),
        failedRequests: failedRequests.slice(0, 20),
        notes: [],
      });
    },

    get: read,

    /** One store's own reports, newest first (what the owner may see: no notes, no errors). */
    listForStore(storeId) {
      return all().filter((r) => r.storeId === storeId).map(summary);
    },

    /** For our team: every store, filtered. */
    list({ status = null, store = null } = {}) {
      return all()
        .filter((r) => (!status || r.status === status) && (!store || r.storeId === store))
        .map((r) => ({ ...summary(r), storeId: r.storeId }));
    },

    /** `{ status?, note? }`; "fixed" tells the owner's chat. */
    patch(id, { status, note, by = 'team' } = {}) {
      const report = read(id);
      const before = report.status;
      if (status !== undefined) {
        if (!STATUSES.includes(status)) throw new ReportError('invalid_status', `Status is one of ${STATUSES.join(', ')}.`);
        report.status = status;
      }
      if (note !== undefined && String(note).trim()) report.notes.push({ at: new Date().toISOString(), by, text: cut(String(note).trim(), 1000) });
      write(report);
      if (status === 'fixed' && before !== 'fixed') onFixed(report);
      return report;
    },

    /** A saved picture or screenshot of a report. */
    file(id, name) {
      read(id);
      if (!FILE.test(String(name))) throw new ReportError('not_found', 'No such file.');
      try {
        return { bytes: fs.readFileSync(path.join(dir, id, name)), mediaType: TYPES[name.split('.').pop()] };
      } catch {
        throw new ReportError('not_found', 'No such file.');
      }
    },
  };
}
