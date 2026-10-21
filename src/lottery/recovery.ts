import type { Ctx, Draw } from '../contracts.js';
import { SOURCE } from '../contracts.js';
import { body, draw, ensure, lease, LIVE, NOW, save } from '../storage/db.js';
import { operation } from '../points/operations.js';
import { activation, rollbackClaim } from '../inventory/stock.js';
import { fixResult } from './results.js';

async function review(ctx: Ctx, row: Draw, code: string): Promise<Draw> {
    const payload = body(row);
    payload.priorState = row.state;

    return save(ctx, row, { state: 'NEEDS_REVIEW', error: code }, payload);
}

async function settled(ctx: Ctx, row: Draw): Promise<Draw> {
    const payload = body(row);
    const debit = payload.ops.find(op => op.method === 'burn');
    const reward = payload.ops.find(op => op.method === 'credit');
    ensure(debit?.outcome === 'COMMITTED' && debit.receipt && payload.results, 'POINTS_EVIDENCE_CONFLICT');
    ensure(row.reward === 0 ? !reward : reward?.outcome === 'COMMITTED' && reward.receipt, 'POINTS_EVIDENCE_CONFLICT');
    ensure(!payload.ops.some(op => op.method === 'reverseOwn'), 'POINTS_EVIDENCE_CONFLICT');
    // 完成时间以最后一笔已确认资金写入为准，恢复不会延长兑奖期限。
    const at = Math.max(debit.receipt.committedAtMs, reward?.receipt?.committedAtMs ?? 0);

    return save(ctx, row, {
        state: 'SETTLED', error: null, settled_at: at,
        winner: payload.results.some(a => a.reward > 0 || a.prizeId) ? 1 : 0
    }, undefined, await activation(ctx, row, at));
}

async function cancellation(ctx: Ctx, row: Draw): Promise<Draw> {
    const payload = body(row);
    const debit = payload.ops.find(op => op.method === 'burn');
    const reward = payload.ops.find(op => op.method === 'credit');
    ensure(debit?.outcome === 'COMMITTED' && debit.receipt && typeof debit.receipt.transactionId === 'string', 'POINTS_EVIDENCE_CONFLICT');
    // 未知奖励可能仍在途，绝不在此时退款；恢复原资金阶段核对。
    ensure(!reward || reward.outcome === 'REJECTED', 'POINTS_EVIDENCE_CONFLICT');
    let index = payload.ops.findIndex(op => op.method === 'reverseOwn');

    if (index < 0) {
        index = payload.ops.length;
        payload.ops.push({
            method: 'reverseOwn', attempts: 0, input: {
                source: SOURCE, operationId: row.id + ':refund', referenceId: row.id,
                originalTransactionId: debit.receipt.transactionId, reason: '奖品中心取消购买'
            }
        });
        row = await save(ctx, row, {}, payload);
    }

    const result = await operation(ctx, row, index);

    if (result.unknown) { return result.row; }

    if (result.op.outcome === 'REJECTED') {
        return review(ctx, result.row, 'REFUND_REJECTED');
    }

    return save(ctx, result.row, { state: 'REFUNDED', qualifies: 0 }, undefined, await rollbackClaim(ctx, result.row));
}

export async function advance(ctx: Ctx, id: string, singleStage = false): Promise<Draw> {
    let row = await lease(ctx, id);

    if (!row) { return draw(ctx, id); }

    const token = row.lease_token;

    try {
        if (row.kind !== 'POOL' || row.count !== 1) {
            return row.state === 'NEEDS_REVIEW' ? row : await review(ctx, row, 'DRAW_INPUT_UNSUPPORTED');
        }

        // 不重写已持久化的其它资金配方；保留证据交由管理员核查。
        if (body(row).ops.some(op => !['burn', 'credit', 'reverseOwn'].includes(op.method))) {
            return row.state === 'NEEDS_REVIEW' ? row : await review(ctx, row, 'POINTS_INPUT_UNSUPPORTED');
        }

        for (let step = 0; step < (singleStage ? 1 : 2); step++) {
            if (row.state === 'CREATED') {
                ensure(body(row).ops[0]?.method === 'burn', 'DEBIT_INPUT_MISSING');
                const result = await operation(ctx, row, 0);
                row = result.row;

                if (result.unknown) { break; }

                row = result.op.outcome === 'COMMITTED'
                    ? await save(ctx, row, { state: 'DEBITED' })
                    : await save(ctx, row, { state: 'FAILED', qualifies: 0, error: result.op.error ?? 'DEBIT_REJECTED' });
            } else if (row.state === 'DEBITED') {
                row = await fixResult(ctx, row);
            } else if (row.state === 'DRAWN' || row.state === 'SETTLING') {
                if (row.reward === 0) {
                    row = await settled(ctx, row);
                } else {
                    if (row.state === 'DRAWN') { row = await save(ctx, row, { state: 'SETTLING' }); }

                    const index = body(row).ops.findIndex(op => op.method === 'credit');
                    ensure(index >= 0, 'REWARD_INPUT_MISSING');
                    const result = await operation(ctx, row, index);
                    row = result.row;

                    if (result.unknown) { break; }

                    row = result.op.outcome === 'COMMITTED' ? await settled(ctx, row)
                        : await save(ctx, row, { state: 'CANCELLING', error: result.op.error ?? 'REWARD_REJECTED' });
                }
            } else if (row.state === 'CANCELLING') {
                row = await cancellation(ctx, row);
                break;
            } else {
                break;
            }

            if (['SETTLED', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW'].includes(row.state)) { break; }
        }

        return row;
    } catch (error) {
        const current = await draw(ctx, id);

        if (current.lease_token === token && current.state !== 'NEEDS_REVIEW' && !['SETTLED', 'FAILED', 'REFUNDED'].includes(current.state)
            && /EVIDENCE|MISSING|CONTRACT/.test(String(error))) {
            return review(ctx, current, 'RECOVERY_EVIDENCE_REQUIRED');
        }

        return current;
    } finally {
        await ctx.db.run('UPDATE {draws} SET lease_token=NULL,lease_until=0 WHERE bot_id=? AND id=? AND lease_token=?', ctx.botId, id, token);
    }
}

export async function recoverOne(ctx: Ctx): Promise<boolean> {
    const row = await ctx.db.first<Draw>(`SELECT * FROM {draws} WHERE bot_id=? AND ${LIVE} AND state<>'NEEDS_REVIEW'
        AND retry_at<=${NOW} AND lease_until<=${NOW} ORDER BY expires_at,retry_at,id LIMIT 1`, ctx.botId);

    if (!row) { return false; }

    await advance(ctx, row.id, true);

    return true;
}
