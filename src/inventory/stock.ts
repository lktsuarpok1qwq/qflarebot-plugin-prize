import type { DBStatement } from '@qqbot/sdk';
import type { Claim, Ctx, Draw, DrawBody, Prize } from '../contracts.js';
import { body, ensure, sql } from '../storage/db.js';

// 仅读取规则引用的库存；同一 SQL 内逐个完整主键定位，缺失或已移除项不参与候选。
export async function stockSnapshots(ctx: Ctx, input: string[]): Promise<Pick<Prize, 'id' | 'version' | 'available'>[]> {
    const ids = [...new Set(input)];
    ensure(ids.length <= 20);

    if (!ids.length) { return []; }

    if (ids.length === 1) {
        const row = await ctx.db.first<Pick<Prize, 'id' | 'version' | 'available'>>(
            'SELECT id,version,available FROM {prizes} WHERE bot_id=? AND id=? AND deleted=0', ctx.botId, ids[0]);

        return row ? [row] : [];
    }

    const row = await ctx.db.first<{ items: string }>(`SELECT json_array(${ids.map(() => `json((SELECT json_array(id,version,available)
        FROM {prizes} WHERE bot_id=? AND id=? AND deleted=0))`).join(',')}) AS items`, ...ids.flatMap(id => [ctx.botId, id]));
    ensure(row, 'UNAVAILABLE');

    return (JSON.parse(row.items) as ([string, number, number] | null)[])
        .flatMap(item => item ? [{ id: item[0], version: item[1], available: item[2] }] : []);
}

export function moveStock(claim: Claim, mode: 'RETURN' | 'RETIRE' | 'FULFILL'): DBStatement[] {
    const column = mode === 'RETURN' ? 'available' : mode === 'RETIRE' ? 'retired' : 'fulfilled';

    return [
        sql(`UPDATE {prizes} SET reserved=reserved-1,${column}=${column}+1,version=version+1 WHERE bot_id=? AND id=?`,
            claim.bot_id, claim.prize_id)
    ];
}

export function activation(row: Draw, committedAt: number, payload: DrawBody): { writes: DBStatement[]; patch?: Partial<Draw>; condition?: DBStatement } {
    const award = payload.results?.find(item => item.prizeId);

    if (!award) { return { writes: [] }; }

    ensure(payload.claimId && row.claim_id === payload.claimId && row.claim_prize_id === award.prizeId
        && row.claim_award === JSON.stringify(award), 'CLAIM_EVIDENCE_MISSING');

    return {
        writes: [], patch: { claim_state: 'PENDING', claim_obtained_at: committedAt, claim_processed_at: committedAt, claim_version: row.claim_version + 1 },
        condition: sql("claim_id=? AND claim_state='LOCKED' AND claim_stock_state='RESERVED' AND claim_obtained_at IS NULL AND claim_version=?", row.claim_id, row.claim_version)
    };
}

export async function rollbackClaim(ctx: Ctx, row: Draw): Promise<{ writes: DBStatement[]; patch?: Partial<Draw>; condition?: DBStatement }> {
    const payload = body(row);

    if (!payload.claimId) {
        ensure(!payload.results?.some(item => item.prizeId) && !row.claim_id, 'CLAIM_EVIDENCE_MISSING');

        return { writes: [] };
    }

    const award = payload.results?.find(item => item.prizeId);
    ensure(award && row.claim_id === payload.claimId && row.claim_prize_id === award.prizeId
        && row.claim_award === JSON.stringify(award) && row.claim_state === 'LOCKED' && row.claim_stock_state === 'RESERVED'
        && row.claim_obtained_at === null, 'CLAIM_EVIDENCE_CONFLICT');

    return {
        patch: {
            claim_state: 'CANCELLED', claim_stock_state: 'RETURNED', claim_processed_at: Date.now(),
            claim_version: row.claim_version + 1, claim_note: '购买未完成，库存已释放'
        },
        condition: sql(`claim_id=? AND claim_version=?
            AND claim_state='LOCKED' AND claim_stock_state='RESERVED' AND claim_obtained_at IS NULL
            AND EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND reserved>0)`,
            row.claim_id, row.claim_version, ctx.botId, row.claim_prize_id),
        writes: [sql('UPDATE {prizes} SET reserved=reserved-1,available=available+1,version=version+1 WHERE bot_id=? AND id=?', ctx.botId, row.claim_prize_id)]
    };
}
