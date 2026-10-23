import type { Ctx, Meta } from './contracts.js';
import { MINUTE } from './contracts.js';
import { draw, meta, nextArchiveAt, NOW, settings } from './storage/db.js';
import { recoverOne, recoveryCandidate } from './lottery/recovery.js';
import { inspectRecovery } from './points/operations.js';
import { archiveStep } from './archive/jobs.js';

export async function maintenance(ctx: Ctx, initial?: Meta) {
    const control = initial ?? await meta(ctx);

    if (control.lease_until > Date.now()) {
        return { task: 'busy', error: null, at: Date.now() };
    }

    const recovery = await recoveryCandidate(ctx);
    const archive = !recovery && settings(control).archiveEnabled
        && (control.archive_requested || control.archive_due <= Date.now());

    if (!recovery && !archive) {
        // 仅确认明确受理的手动请求；空闲 Cron 不写心跳或清除上次故障。
        if (control.maintenance_requested) {
            await ctx.db.run(`UPDATE {schema_meta} SET maintenance_requested=0,last_error=NULL
                WHERE bot_id=? AND version=? AND lease_until<=${NOW} AND maintenance_requested=1`, ctx.botId, control.version);
        }

        return { task: 'idle', error: null, at: Date.now() };
    }

    const candidate = recovery ? await draw(ctx, recovery.id) : undefined;
    const inspection = candidate ? await inspectRecovery(ctx, candidate) : undefined;

    if (inspection?.pending) {
        return { task: 'recovery', status: 'pending', error: null, at: Date.now() };
    }

    const token = crypto.randomUUID();
    const owned = await ctx.db.first<Meta>(`UPDATE {schema_meta} SET lease_token=?,lease_until=${NOW}+120000
        WHERE bot_id=? AND version=? AND lease_until<=${NOW} RETURNING *`, token, ctx.botId, control.version);

    if (!owned) {
        return { task: 'busy', error: null, at: Date.now() };
    }

    const task = recovery ? 'recovery' : 'archive';
    let failure: unknown;
    let status: 'progressed' | 'pending' | 'failed' = 'pending';
    let archiveDue: number | null = null;

    try {
        if (recovery) {
            status = await recoverOne(ctx, candidate, inspection);
        } else {
            const progressed = await archiveStep(ctx, owned);
            status = 'progressed';
            archiveDue = progressed ? Date.now() + 10 * MINUTE : nextArchiveAt(Date.now());
        }
    } catch (error) {
        failure = error;
        status = 'failed';
    }

    // 只有完成推进才更新成功状态；待确认保留原故障与请求，失败不伪造成功心跳。
    await ctx.db.run(`UPDATE {schema_meta} SET heartbeat=CASE WHEN ?='progressed' THEN ${NOW} ELSE heartbeat END,
        last_error=CASE WHEN ?='failed' THEN 'MAINTENANCE_FAILED' WHEN ?='progressed' THEN NULL ELSE last_error END,
        maintenance_requested=CASE WHEN ?='progressed' THEN 0 ELSE maintenance_requested END,
        archive_requested=CASE WHEN ?='archive' AND ?='progressed' THEN 0 ELSE archive_requested END,
        archive_due=COALESCE(?,archive_due),lease_token=NULL,lease_until=0 WHERE bot_id=? AND lease_token=?`,
        status, status, status, status, task, status, archiveDue, ctx.botId, token);

    if (failure) { throw failure; }

    return { task, status, error: status === 'failed' ? 'MAINTENANCE_FAILED' : null, at: Date.now() };
}
