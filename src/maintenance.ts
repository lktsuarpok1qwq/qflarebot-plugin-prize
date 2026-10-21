import type { Award, Claim, Ctx } from './contracts.js';
import { DAY, MINUTE } from './contracts.js';
import { atomic, ensure, meta, nextArchiveAt, NOW, settings, sql } from './storage/db.js';
import { moveStock } from './inventory/stock.js';
import { recoverOne } from './lottery/recovery.js';
import { archiveStep } from './archive/jobs.js';

export async function expireOne(ctx: Ctx): Promise<boolean> {
    const claim = await ctx.db.first<Claim>(`SELECT * FROM {claims} WHERE bot_id=? AND state='PENDING'
        AND expires_at<=${NOW} ORDER BY expires_at,id LIMIT 1`, ctx.botId);

    if (!claim) { return false; }

    const award = JSON.parse(claim.award!) as Award;
    const mode = award.expiry!;
    await atomic(ctx, sql(`EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND id=? AND version=? AND state='PENDING'
        AND stock_state='RESERVED' AND expires_at<=${NOW}) AND EXISTS(SELECT 1 FROM {draws} WHERE bot_id=? AND id=? AND state='SETTLED')`,
        ctx.botId, claim.id, claim.version, ctx.botId, claim.draw_id), [
        ...moveStock(claim, mode),
        sql(`UPDATE {claims} SET state='EXPIRED',stock_state=?,expired_at=expires_at,processed_at=${NOW},
            purge_at=${NOW}+?,version=version+1 WHERE bot_id=? AND id=?`, mode === 'RETURN' ? 'RETURNED' : 'RETIRED',
            30 * DAY, ctx.botId, claim.id)
    ]);

    return true;
}

export async function maintenance(ctx: Ctx, mode: 'auto' | 'check' | 'archive' = 'auto') {
    const control = await meta(ctx);
    const token = crypto.randomUUID();
    const got = await ctx.db.run(`UPDATE {schema_meta} SET lease_token=?,lease_until=${NOW}+120000
        WHERE bot_id=? AND lease_until<=${NOW}`, token, ctx.botId);
    ensure(got.changes, 'MAINTENANCE_BUSY');
    let error: string | null = null;
    let task = 'check';

    try {
        if (mode === 'archive') {
            await archiveStep(ctx);
            task = 'archive';
        } else if (mode === 'auto') {
            // 初始预算每轮只执行一种任务，避免恢复与解析归档共享 CPU 峰值
            if (await recoverOne(ctx)) {
                task = 'recovery';
            } else if (await expireOne(ctx)) {
                task = 'expiry';
            } else if (control.cleanup_due <= Date.now()) {
                await ctx.db.run(`UPDATE {claims} SET details=NULL,details_version=details_version+1 WHERE bot_id=? AND id IN
                    (SELECT id FROM {claims} WHERE bot_id=? AND details IS NOT NULL AND purge_at<=${NOW}
                        AND state IN ('FULFILLED','EXPIRED','CANCELLED') ORDER BY purge_at,id LIMIT 5)`, ctx.botId, ctx.botId);
                await ctx.db.run(`UPDATE {schema_meta} SET cleanup_due=${NOW}+? WHERE bot_id=?`, 60 * MINUTE, ctx.botId);
                task = 'cleanup';
            } else if (settings(control).archiveEnabled && (control.archive_requested || control.archive_due <= Date.now())) {
                const progressed = await archiveStep(ctx);
                await ctx.db.run(`UPDATE {schema_meta} SET archive_due=${NOW}+? WHERE bot_id=?`, progressed ? 10 * MINUTE : nextArchiveAt(Date.now()) - Date.now(), ctx.botId);
                task = 'archive';
            }
        }

        const overdue = await ctx.db.first<{ overdue: number }>(`SELECT
            EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND state='PENDING' AND expires_at<${NOW}-1200000)
            OR EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND details IS NOT NULL AND purge_at<${NOW}-7200000) AS overdue`, ctx.botId, ctx.botId);
        error = overdue?.overdue ? 'MAINTENANCE_BACKLOG' : null;
        await ctx.db.run(`UPDATE {schema_meta} SET heartbeat=${NOW},last_error=?,maintenance_requested=0,archive_requested=CASE WHEN ?='archive' THEN 0 ELSE archive_requested END WHERE bot_id=? AND lease_token=?`, error, task, ctx.botId, token);

        return { task, error, at: Date.now() };
    } catch (cause) {
        error = 'MAINTENANCE_FAILED';
        await ctx.db.run('UPDATE {schema_meta} SET last_error=? WHERE bot_id=? AND lease_token=?', error, ctx.botId, token);
        throw cause;
    } finally {
        await ctx.db.run('UPDATE {schema_meta} SET lease_token=NULL,lease_until=0 WHERE bot_id=? AND lease_token=?', ctx.botId, token);
    }
}
