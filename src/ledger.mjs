/**
 * Spending per store (agent design §4.3): reserve before a run, settle the actual cost after. One run at a time per
 * store, so two runs cannot both spend the same remaining money. The ledger is an append-only JSON-lines file; a
 * month's spend is the sum of its lines (refunds are negative lines).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class BudgetError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const round = (usd) => Math.round(usd * 1e6) / 1e6;

export function createLedger({ file, aiConfig, now = () => new Date() }) {
  /** storeId -> the open reservation */
  const open = new Map();
  const monthOf = (date) => date.toISOString().slice(0, 7);

  function lines() {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function append(entry) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  }

  function spent(storeId, month) {
    return round(lines().filter((l) => l.storeId === storeId && l.month === month).reduce((sum, l) => sum + l.costUsd, 0));
  }

  function status(storeId) {
    const settings = aiConfig.forStore(storeId);
    const month = monthOf(now());
    const spentUsd = spent(storeId, month);
    const reservedUsd = open.get(storeId)?.amountUsd ?? 0;
    const remainingUsd = round(Math.max(0, settings.monthlyLimitUsd - spentUsd - reservedUsd));
    return {
      month,
      limitUsd: settings.monthlyLimitUsd,
      spentUsd,
      reservedUsd,
      remainingUsd,
      usedShare: settings.monthlyLimitUsd > 0 ? round(Math.min(1, spentUsd / settings.monthlyLimitUsd)) : 1,
      warn: settings.monthlyLimitUsd > 0 && spentUsd >= settings.monthlyLimitUsd * settings.warnAt,
      blocked: remainingUsd < settings.minToStartUsd,
      busy: open.has(storeId),
    };
  }

  return {
    status,

    lines(storeId, month = monthOf(now())) {
      return lines().filter((l) => l.storeId === storeId && l.month === month);
    },

    /** Holds the most this run may spend; throws `busy` or `out_of_budget`. */
    reserve(storeId) {
      if (open.has(storeId)) throw new BudgetError('busy', 'Another change is running for this store.');
      const current = status(storeId);
      if (current.blocked) throw new BudgetError('out_of_budget', 'The AI budget for this month is used up.', current);
      const settings = aiConfig.forStore(storeId);
      const reservation = { id: randomUUID(), storeId, amountUsd: round(Math.min(settings.perRequestMaxUsd, current.remainingUsd)), month: current.month };
      open.set(storeId, reservation);
      return reservation;
    },

    /**
     * Records what the run actually cost (one line per model call group) and frees the store. The actual cost may
     * pass the reservation slightly: the SDK stops between steps, after the step that crossed the line.
     * @param {{ runId: string, kind: string, model?: string, costUsd: number, usage?: object }[]} charges
     */
    settle(reservation, charges) {
      if (open.get(reservation.storeId)?.id !== reservation.id) throw new BudgetError('no_reservation', 'This reservation is not open.');
      if (charges.some((charge) => !(charge.costUsd >= 0))) throw new BudgetError('invalid_charge', 'A charge needs a cost >= 0.');
      const at = now().toISOString();
      for (const charge of charges) {
        append({ at, month: reservation.month, storeId: reservation.storeId, reservationId: reservation.id, runId: charge.runId, kind: charge.kind, model: charge.model ?? null, costUsd: round(charge.costUsd), usage: charge.usage ?? null });
      }
      open.delete(reservation.storeId);
      return status(reservation.storeId);
    },

    /** Charges a run that held no reservation (a chat that only talked while another chat built). */
    record(storeId, charges) {
      if (charges.some((charge) => !(charge.costUsd >= 0))) throw new BudgetError('invalid_charge', 'A charge needs a cost >= 0.');
      const at = now().toISOString();
      for (const charge of charges) {
        append({ at, month: monthOf(now()), storeId, reservationId: null, runId: charge.runId, kind: charge.kind, model: charge.model ?? null, costUsd: round(charge.costUsd), usage: charge.usage ?? null });
      }
      return status(storeId);
    },

    /** Frees the store without charging (the run never called a model). */
    release(reservation) {
      if (open.get(reservation.storeId)?.id === reservation.id) open.delete(reservation.storeId);
    },

    /** Gives back what a run cost (failed through our fault); a negative line in the current month. */
    refund(storeId, runId, costUsd, reason) {
      append({ at: now().toISOString(), month: monthOf(now()), storeId, reservationId: null, runId, kind: 'refund', model: null, costUsd: -round(costUsd), usage: null, reason });
      return status(storeId);
    },
  };
}
