import type { DBStatement } from '@qqbot/sdk';
import type { Ctx, Draw } from '../contracts.js';
import type { Admission } from './admission.js';
import { MINUTE, SOURCE } from '../contracts.js';
import { body, draw, ensure, lease, LIVE, NOW, save } from '../storage/db.js';
import { inspectRecovery, operation } from '../points/operations.js';
import type { OperationProof, RecoveryInspection } from '../points/operations.js';
import { activation, rollbackClaim } from '../inventory/stock.js';

async function review(ctx: Ctx, row: Draw, code: string, payload = body(row), extra: DBStatement[] = []): Promise<Draw> {
    payload.priorState = row.state;

    return save(ctx, row, { state: 'NEEDS_REVIEW', error: code }, payload, extra);
}

async function settled(ctx: Ctx, row: Draw, payload = body(row), extra: DBStatement[] = []): Promise<Draw> {
    const debit = payload.ops.find(op => op.method === 'burn');
    const reward = payload.ops.find(op => op.method === 'credit');
    ensure(debit?.outcome === 'COMMITTED' && debit.receipt && payload.results, 'POINTS_EVIDENCE_CONFLICT');
    ensure(row.reward === 0 ? !reward : reward?.outcome === 'COMMITTED' && reward.receipt, 'POINTS_EVIDENCE_CONFLICT');
    ensure(!payload.ops.some(op => op.method === 'reverseOwn'), 'POINTS_EVIDENCE_CONFLICT');
    // 完成时间以最后一笔已确认资金写入为准，恢复不会改写获得时间。
    const at = Math.max(debit.receipt.committedAtMs, reward?.receipt?.committedAtMs ?? 0);

    const claim = activation(row, at, payload);

    return save(ctx, row, {
        ...claim.patch,
        state: 'SETTLED', error: null, retry_at: 0, settled_at: at,
        winner: payload.results.some(a => a.reward > 0 || a.prizeId) ? 1 : 0
    }, payload, [...claim.writes, ...extra], claim.condition);
}

async function cancellation(ctx: Ctx, row: Draw, proof?: OperationProof): Promise<Draw> {
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
        // operation 在调用前连同 attempts 一并持久化完整退款输入。
    }

    const result = await operation(ctx, row, index, async (current, confirmed, extra) => {
        if (confirmed.ops[index]!.outcome === 'REJECTED') { return review(ctx, current, 'REFUND_REJECTED', confirmed, extra); }

        const release = await rollbackClaim(ctx, current);

        return save(ctx, current, { ...release.patch, state: 'REFUNDED', qualifies: 0, retry_at: 0 }, confirmed, [...release.writes, ...extra], release.condition);
    }, false, proof, payload);

    return result.row;
}

export async function advance(ctx: Ctx, input: string | Admission, stages = 2, inspected?: RecoveryInspection): Promise<Draw> {
    const id = typeof input === 'string' ? input : input.id;

    if (typeof input !== 'string' && ['SETTLED', 'FAILED', 'REFUNDED'].includes(input.state)) { return input; }

    const owned = typeof input !== 'string' && input.ownedLease && input.ownedLease === input.lease_token;
    let proof: OperationProof | undefined;

    if (!owned) {
        const existing = typeof input === 'string' ? await draw(ctx, id) : input;

        if (['SETTLED', 'FAILED', 'REFUNDED'].includes(existing.state) || existing.lease_until > Date.now()) { return existing; }

        const inspection = inspected?.rowId === existing.id && inspected.version === existing.version
            ? inspected : await inspectRecovery(ctx, existing);

        if (inspection.pending) { return existing; }

        proof = inspection.proof;
    }

    let row = owned ? { ...input as Admission } : await lease(ctx, id);

    if (!row) { return draw(ctx, id); }

    const token = row.lease_token;
    let preparedIndex = typeof input !== 'string' && input.ownedLease === token && row.state === 'CREATED' ? 0 : -1;

    if (typeof input !== 'string') { delete input.ownedLease; }

    delete (row as Admission).ownedLease;

    try {
        if (row.kind !== 'POOL' || row.count !== 1) {
            return row.state === 'NEEDS_REVIEW' ? row : await review(ctx, row, 'DRAW_INPUT_UNSUPPORTED');
        }

        // 不重写已持久化的其它资金配方；保留证据交由管理员核查。
        const preparedPayload = body(row);

        if (preparedPayload.ops.some(op => !['burn', 'credit', 'reverseOwn'].includes(op.method))) {
            return row.state === 'NEEDS_REVIEW' ? row : await review(ctx, row, 'POINTS_INPUT_UNSUPPORTED');
        }

        const prepared = preparedPayload.results;
        ensure(prepared?.length === 1 && prepared[0]!.id === row.result_award_id && prepared[0]!.name === row.result_name
            && prepared[0]!.reward === row.reward && (prepared[0]!.prizeId ?? null) === row.result_prize_id
            && (!prepared[0]!.prizeId || preparedPayload.claimId), 'RESULT_EVIDENCE_MISSING');

        for (let step = 0; step < stages; step++) {
            if (row.state === 'CREATED') {
                const payload = step === 0 ? preparedPayload : body(row);
                ensure(payload.ops[0]?.method === 'burn', 'DEBIT_INPUT_MISSING');
                const result = await operation(ctx, row, 0, async (current, confirmed, extra) => {
                    if (confirmed.ops[0]!.outcome === 'COMMITTED') {
                        if (current.reward === 0) { return settled(ctx, current, confirmed, extra); }

                        const credit = confirmed.ops.findIndex(op => op.method === 'credit');
                        ensure(credit > 0, 'REWARD_INPUT_MISSING');

                        if (step + 1 < stages && confirmed.ops[credit]!.attempts === 0) {
                            confirmed.ops[credit]!.attempts = 1;
                            const next = await save(ctx, current, { state: 'SETTLING', retry_at: Date.now() + 10 * MINUTE }, confirmed, extra);
                            preparedIndex = credit;

                            return next;
                        }

                        return save(ctx, current, { state: 'DEBITED', retry_at: 0 }, confirmed, extra);
                    }

                    const release = await rollbackClaim(ctx, current);

                    return save(ctx, current, { ...release.patch, state: 'FAILED', qualifies: 0, retry_at: 0, error: confirmed.ops[0]!.error ?? 'DEBIT_REJECTED' },
                        confirmed, [...release.writes, ...extra], release.condition);
                }, preparedIndex === 0, proof, payload);
                row = result.row;

                if (result.unknown) { break; }
            } else if (row.state === 'DEBITED' || row.state === 'DRAWN' || row.state === 'SETTLING') {
                const payload = step === 0 ? preparedPayload : body(row);
                ensure(payload.ops[0]?.outcome === 'COMMITTED' && payload.ops[0]?.receipt, 'POINTS_EVIDENCE_CONFLICT');

                if (row.reward === 0) {
                    row = await settled(ctx, row, payload);
                } else {
                    const index = payload.ops.findIndex(op => op.method === 'credit');
                    ensure(index >= 0, 'REWARD_INPUT_MISSING');
                    const result = await operation(ctx, row, index, (current, payload, extra) => payload.ops[index]!.outcome === 'COMMITTED'
                        ? settled(ctx, current, payload, extra)
                        : save(ctx, current, { state: 'CANCELLING', retry_at: 0, error: payload.ops[index]!.error ?? 'REWARD_REJECTED' }, payload, extra), preparedIndex === index, proof, payload);
                    row = result.row;

                    if (result.unknown) { break; }
                }
            } else if (row.state === 'CANCELLING') {
                row = await cancellation(ctx, row, proof);
                break;
            } else {
                break;
            }

            if (['SETTLED', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW'].includes(row.state)) { break; }
        }

        return row;
    } catch (error) {
        row = await draw(ctx, id);

        if (row.lease_token === token && row.state !== 'NEEDS_REVIEW' && !['SETTLED', 'FAILED', 'REFUNDED'].includes(row.state)
            && /EVIDENCE|MISSING|CONTRACT/.test(String(error))) {
            row = await review(ctx, row, 'RECOVERY_EVIDENCE_REQUIRED');
        }

        return row;
    } finally {
        if (row.lease_token === token) {
            await ctx.db.run('UPDATE {draws} SET lease_token=NULL,lease_until=0 WHERE bot_id=? AND id=? AND lease_token=?', ctx.botId, id, token);
        }
    }
}

export async function recoveryCandidate(ctx: Ctx): Promise<Pick<Draw, 'id'> | null> {
    return ctx.db.first<Pick<Draw, 'id'>>(`SELECT id FROM {draws} INDEXED BY {draw_mutex} WHERE bot_id=? AND ${LIVE} AND state<>'NEEDS_REVIEW'
        AND retry_at<=${NOW} AND lease_until<=${NOW} ORDER BY expires_at,retry_at,id LIMIT 1`, ctx.botId);
}

export async function recoverOne(ctx: Ctx, candidate?: Draw, inspection?: RecoveryInspection): Promise<'progressed' | 'pending' | 'failed'> {
    const id = candidate?.id ?? (await recoveryCandidate(ctx))?.id;

    if (!id) { return 'pending'; }

    const before = candidate ?? await draw(ctx, id);

    if (['SETTLED', 'FAILED', 'REFUNDED'].includes(before.state)) { return 'pending'; }

    const after = await advance(ctx, before, 1, inspection);

    if (after.state === 'NEEDS_REVIEW') { return 'failed'; }

    // 尝试次数与租约版本变化不是成功；未知调用必须继续保留待确认状态。
    const confirmed = (row: Draw) => body(row).ops.filter(op => op.outcome).length;

    return after.state !== before.state && ['SETTLED', 'FAILED', 'REFUNDED', 'DEBITED', 'CANCELLING'].includes(after.state)
        || confirmed(after) > confirmed(before) ? 'progressed' : 'pending';
}
