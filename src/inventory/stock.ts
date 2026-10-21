import type { DBStatement } from '@qqbot/sdk';
import type { Claim, Ctx, Draw, Award } from '../contracts.js';
import { DAY } from '../contracts.js';
import { NOW, sql } from '../storage/db.js';

export function moveStock(claim: Claim, mode: 'RETURN' | 'RETIRE' | 'FULFILL'): DBStatement[] {
    const column = mode === 'RETURN' ? 'available' : mode === 'RETIRE' ? 'retired' : 'fulfilled';

    return [
        sql(`UPDATE {prizes} SET reserved=reserved-1,${column}=${column}+1,version=version+1 WHERE bot_id=? AND id=?`,
            claim.bot_id, claim.prize_id),
        sql('UPDATE {pools} SET inventory_revision=inventory_revision+1 WHERE bot_id=? AND id=?', claim.bot_id, claim.pool_id)
    ];
}

export async function activation(ctx: Ctx, row: Draw, committedAt: number): Promise<DBStatement[]> {
    const claim = await ctx.db.first<Claim>('SELECT * FROM {claims} WHERE bot_id=? AND draw_id=?', ctx.botId, row.id);

    if (!claim) {
        return [];
    }

    const award = JSON.parse(claim.award!) as Award;
    const expires = committedAt + award.claimHours! * 3_600_000;
    const column = award.expiry === 'RETURN' ? 'available' : 'retired';

    return [
        // 同一条语句固定到期决定，后续库存迁移只消费该决定，不重新读取时钟
        sql(`UPDATE {claims} SET state=CASE WHEN ?<=${NOW} THEN 'EXPIRED' ELSE 'PENDING' END,
            stock_state=CASE WHEN ?<=${NOW} THEN ? ELSE 'RESERVED' END,obtained_at=?,expires_at=?,
            expired_at=CASE WHEN ?<=${NOW} THEN ? END,processed_at=${NOW},
            purge_at=CASE WHEN ?<=${NOW} THEN ${NOW}+? END,version=version+1 WHERE bot_id=? AND id=?`,
            expires, expires, award.expiry === 'RETURN' ? 'RETURNED' : 'RETIRED', committedAt, expires,
            expires, expires, expires, 30 * DAY, ctx.botId, claim.id),
        sql(`UPDATE {prizes} SET reserved=reserved-1,${column}=${column}+1,version=version+1
            WHERE bot_id=? AND id=? AND EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND id=? AND state='EXPIRED')`,
            ctx.botId, claim.prize_id, ctx.botId, claim.id),
        sql(`UPDATE {pools} SET inventory_revision=inventory_revision+1 WHERE bot_id=? AND id=?
            AND EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND id=? AND state='EXPIRED')`,
            ctx.botId, row.pool_id, ctx.botId, claim.id)
    ];
}

export async function rollbackClaim(ctx: Ctx, row: Draw): Promise<DBStatement[]> {
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
