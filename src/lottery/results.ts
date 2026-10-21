import type { Ctx, Draw, Prize } from '../contracts.js';
import { atomic, body, draw, ensure, fence, isConflict, patchDraw, save, sql } from '../storage/db.js';
import { choose } from './rules.js';
import { SOURCE } from '../contracts.js';

export async function fixResult(ctx: Ctx, row: Draw): Promise<Draw> {
    const payload = body(row);
    ensure(payload.rules, 'RULES_MISSING');
    const awards = payload.rules.awards;
    const ids = [...new Set(awards.flatMap(a => a.prizeId ? [a.prizeId] : []))];
    const snapshots = await ctx.db.all<Prize & { revision: number }>(`SELECT p.*,l.inventory_revision AS revision
        FROM {pools} l LEFT JOIN {prizes} p ON p.bot_id=l.bot_id AND p.id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND p.deleted=0
        WHERE l.bot_id=? AND l.id=?`, ...ids, ctx.botId, row.pool_id);
    const revision = snapshots[0]?.revision;
    ensure(revision !== undefined, 'INVENTORY_MISSING');
    const versions = ids.map(id => ({ id, version: snapshots.find(p => p.id === id)?.version ?? null }));
    const weights = awards.map(a => ({
        id: a.id, weight: a.weight,
        available: !a.prizeId || snapshots.some(p => p.id === a.prizeId && p.available > 0)
    }));
    const candidates = awards.filter(a => weights.some(w => w.id === a.id && w.available));

    if (!candidates.length) {
        return save(ctx, row, { state: 'CANCELLING', error: 'NO_CANDIDATE' });
    }

    const results = [choose(candidates)];
    const reward = results.reduce((sum, a) => sum + a.reward, 0);
    const goods = results.find(a => a.prizeId);
    const claimId = goods ? crypto.randomUUID() : undefined;
    payload.results = results;
    payload.weights = weights;
    payload.inventoryRevision = revision;
    payload.inventoryVersions = versions;
    payload.claimId = claimId;

    if (reward > 0) {
        payload.ops.push({
            method: 'credit', attempts: 0, input: {
                source: SOURCE, operationId: row.id + ':reward', referenceId: row.id,
                userId: row.user_id, amountMinor: reward, reason: '奖品中心奖励'
            }
        });
    }

    const guard = fence(row);
    const stockGuards = versions.map(p => p.version === null
        ? sql('NOT EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND deleted=0)', ctx.botId, p.id)
        : sql('EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND version=? AND deleted=0)', ctx.botId, p.id, p.version));
    const writes = [patchDraw(row, { state: 'DRAWN', reward, award_ids: JSON.stringify([...new Set(results.map(a => a.id))]) }, payload)];

    if (goods && claimId) {
        writes.push(sql('UPDATE {prizes} SET available=available-1,reserved=reserved+1,version=version+1 WHERE bot_id=? AND id=?',
            ctx.botId, goods.prizeId));
        writes.push(sql('UPDATE {pools} SET inventory_revision=inventory_revision+1 WHERE bot_id=? AND id=?', ctx.botId, row.pool_id));
        writes.push(sql(`INSERT INTO {claims}(bot_id,id,short_id,draw_id,user_id,pool_id,prize_id,award,state,stock_state)
            VALUES(?,?,?,?,?,?,?,?,'LOCKED','RESERVED')`, ctx.botId, claimId, 'P' + claimId.replaceAll('-', ''), row.id,
            row.user_id, row.pool_id, goods.prizeId, JSON.stringify(goods)));
    }

    try {
        await atomic(ctx, sql(`${guard.sql} AND EXISTS(SELECT 1 FROM {pools} WHERE bot_id=? AND id=? AND inventory_revision=?)
            AND (${stockGuards.map(g => g.sql).join(' AND ') || '1'})
            AND (? IS NULL OR EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND available>0))`,
            ...guard.params!, ctx.botId, row.pool_id, revision, ...stockGuards.flatMap(g => g.params!), goods?.prizeId ?? null, ctx.botId, goods?.prizeId ?? null), writes);

        return draw(ctx, row.id);
    } catch (error) {
        const actual = await draw(ctx, row.id);

        if (actual.state !== 'DEBITED' || actual.version !== row.version) {
            return actual;
        }

        if (!isConflict(error)) {
            throw error;
        }

        const original = body(actual);
        original.inventoryConflicts++;

        return save(ctx, actual, original.inventoryConflicts >= 3
            ? { state: 'CANCELLING', error: 'INVENTORY_CONFLICT' } : { retry_at: Date.now() }, original);
    }
}
