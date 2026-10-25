import type { DBStatement } from '@qqbot/sdk';
import type { Ctx, DrawBody, Rules } from '../contracts.js';
import { SOURCE } from '../contracts.js';
import { ensure, sql } from '../storage/db.js';
import { prepareDebit } from '../points/operations.js';
import { choose } from './rules.js';
import { stockSnapshots } from '../inventory/stock.js';

export async function prepareResult(ctx: Ctx, rules: Rules, id: string, userId: string) {
    const ids = [...new Set(rules.awards.flatMap(award => award.prizeId ? [award.prizeId] : []))];
    const snapshots = await stockSnapshots(ctx, ids);
    const versions = ids.map(id => ({ id, version: snapshots.find(prize => prize.id === id)?.version ?? null }));
    const weights = rules.awards.map(award => ({
        id: award.id, weight: award.weight,
        available: !award.prizeId || snapshots.some(prize => prize.id === award.prizeId && prize.available > 0)
    }));
    const candidates = rules.awards.filter(award => weights.some(weight => weight.id === award.id && weight.available));
    ensure(candidates.length, 'NO_CANDIDATE');
    const result = choose(candidates);
    const claimId = result.prizeId ? crypto.randomUUID() : undefined;
    const payload: DrawBody = {
        rules, results: [result], weights, inventoryVersions: versions,
        claimId, ops: [prepareDebit(id, userId, rules.cost)]
    };

    if (result.reward > 0) {
        payload.ops.push({
            method: 'credit', attempts: 0, input: {
                source: SOURCE, operationId: id + ':reward', referenceId: id,
                userId, amountMinor: result.reward, reason: '奖品中心奖励'
            }
        });
    }

    const checks = versions.map(prize => prize.version === null
        ? sql('NOT EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND deleted=0)', ctx.botId, prize.id)
        : sql(`EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND version=? AND deleted=0${prize.id === result.prizeId ? ' AND available>0' : ''})`, ctx.botId, prize.id, prize.version));

    const writes: DBStatement[] = [];

    if (result.prizeId && claimId) {
        writes.push(sql('UPDATE {prizes} SET available=available-1,reserved=reserved+1,version=version+1 WHERE bot_id=? AND id=?', ctx.botId, result.prizeId));
    }

    return { payload, result, writes, checks };
}
