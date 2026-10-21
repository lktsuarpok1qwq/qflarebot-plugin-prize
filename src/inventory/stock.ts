import type { DBStatement } from '@qqbot/sdk';
import type { Claim, Ctx, Draw } from '../contracts.js';
import { DAY } from '../contracts.js';
import { body, ensure, NOW, sql } from '../storage/db.js';

export function moveStock(claim: Claim, mode: 'RETURN' | 'RETIRE' | 'FULFILL'): DBStatement[] {
    const column = mode === 'RETURN' ? 'available' : mode === 'RETIRE' ? 'retired' : 'fulfilled';

    return [
        sql(`UPDATE {prizes} SET reserved=reserved-1,${column}=${column}+1,version=version+1 WHERE bot_id=? AND id=?`,
            claim.bot_id, claim.prize_id),
        sql('UPDATE {pools} SET inventory_revision=inventory_revision+1 WHERE bot_id=? AND id=?', claim.bot_id, claim.pool_id)
    ];
}

export function activation(row: Draw, committedAt: number): { writes: DBStatement[]; condition?: DBStatement } {
    const payload = body(row);
    const award = payload.results?.find(item => item.prizeId);

    if (!award) { return { writes: [] }; }

    ensure(payload.claimId, 'CLAIM_EVIDENCE_MISSING');
    const claim = { id: payload.claimId, prize_id: award.prizeId! };
    const condition = sql(`EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND id=? AND draw_id=? AND award=? AND state='LOCKED' AND stock_state='RESERVED')`,
        row.bot_id, claim.id, row.id, JSON.stringify(award));
    const expires = committedAt + award.claimHours! * 3_600_000;
    const column = award.expiry === 'RETURN' ? 'available' : 'retired';

    return {
        condition, writes: [
            // 同一条语句固定到期决定，后续库存迁移只消费该决定，不重新读取时钟
            sql(`UPDATE {claims} SET state=CASE WHEN ?<=${NOW} THEN 'EXPIRED' ELSE 'PENDING' END,
            stock_state=CASE WHEN ?<=${NOW} THEN ? ELSE 'RESERVED' END,obtained_at=?,expires_at=?,
            expired_at=CASE WHEN ?<=${NOW} THEN ? END,processed_at=${NOW},
            purge_at=CASE WHEN ?<=${NOW} THEN ${NOW}+? END,version=version+1 WHERE bot_id=? AND id=?`,
                expires, expires, award.expiry === 'RETURN' ? 'RETURNED' : 'RETIRED', committedAt, expires,
                expires, expires, expires, 30 * DAY, row.bot_id, claim.id),
            sql(`UPDATE {prizes} SET reserved=reserved-1,${column}=${column}+1,version=version+1
            WHERE bot_id=? AND id=? AND EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND id=? AND state='EXPIRED')`,
                row.bot_id, claim.prize_id, row.bot_id, claim.id),
            sql(`UPDATE {pools} SET inventory_revision=inventory_revision+1 WHERE bot_id=? AND id=?
            AND EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND id=? AND state='EXPIRED')`,
                row.bot_id, row.pool_id, row.bot_id, claim.id)
        ]
    };
}

export async function rollbackClaim(ctx: Ctx, row: Draw): Promise<DBStatement[]> {
    const payload = body(row);

    if (!payload.claimId) {
        ensure(!payload.results?.some(item => item.prizeId), 'CLAIM_EVIDENCE_MISSING');

        return [];
    }

    const claim = await ctx.db.first<Claim>('SELECT * FROM {claims} WHERE bot_id=? AND draw_id=?', ctx.botId, row.id);

    if (!claim) {
        return [];
    }

    return [
        ...moveStock(claim, 'RETURN'),
        sql(`UPDATE {claims} SET state='CANCELLED',stock_state='RETURNED',cancelled_at=${NOW},processed_at=${NOW},
            purge_at=${NOW}+?,version=version+1,note='原购买未结算' WHERE bot_id=? AND id=?`, 30 * DAY, ctx.botId, claim.id)
    ];
}
