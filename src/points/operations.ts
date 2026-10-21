import type { OperationReceipt, PointsService, Result } from 'qflarebot-plugin-points';
import type { Ctx, Draw, Operation } from '../contracts.js';
import { SOURCE, MINUTE } from '../contracts.js';
import { body, ensure, save, sql } from '../storage/db.js';

export function wallet(ctx: Ctx): PointsService {
    return ctx.service<PointsService>('points.wallet');
}

export function prepareDebit(id: string, userId: string, cost: number): Operation {
    return {
        method: 'burn', attempts: 0, input: {
            source: SOURCE, operationId: id + ':debit', referenceId: id,
            userId, amountMinor: cost, reason: '奖品中心购买'
        }
    };
}

function committed(op: Operation, receipt: OperationReceipt): void {
    ensure(receipt.operationId === op.input.operationId && Number.isSafeInteger(receipt.committedAtMs) && receipt.committedAtMs > 0
        && typeof receipt.transactionId === 'string' && receipt.transactionId.length > 0, 'POINTS_CONTRACT');
    op.outcome = 'COMMITTED';
    op.receipt = receipt;
}

async function invoke(service: PointsService, op: Operation): Promise<Result<OperationReceipt>> {
    switch (op.method) {
        case 'burn': return service.burn(op.input);
        case 'credit': return service.credit(op.input);
        case 'reverseOwn': return service.reverseOwn(op.input);
    }
}

export async function operation(ctx: Ctx, initial: Draw, index: number): Promise<{ row: Draw; op: Operation; unknown: boolean }> {
    let row = initial;
    const payload = body(row);
    const op = payload.ops[index]!;
    const service = wallet(ctx);
    const persist = () => save(ctx, row, { retry_at: 0 }, payload,
        op.error && ['SOURCE_NOT_REGISTERED', 'SOURCE_DISABLED', 'SOURCE_NOT_ALLOWED'].includes(op.error)
            ? [sql(`UPDATE {schema_meta} SET admission_enabled=0,admission_revision=admission_revision+1,version=version+1
                WHERE bot_id=?`, ctx.botId)] : []);

    if (op.outcome) {
        return { row, op, unknown: false };
    }

    if (op.attempts > 0) {
        const found = await service.getOperation({ source: SOURCE, operationId: op.input.operationId });

        if (!found.ok) {
            return { row, op, unknown: true };
        }

        ensure(['COMMITTED', 'REJECTED', 'NOT_FOUND'].includes(found.data.status), 'POINTS_CONTRACT');

        if (found.data.status === 'COMMITTED') {
            committed(op, found.data.receipt);
        } else if (found.data.status === 'REJECTED') {
            op.outcome = 'REJECTED';
            op.error = found.data.error.code;
        }

        if (op.outcome) {
            row = await persist();

            return { row, op, unknown: false };
        }
    }

    if (op.attempts > 0 && initial.retry_at > Date.now()) {
        return { row, op, unknown: true };
    }

    if (op.attempts >= 3 + (payload.manualAttempts?.[op.input.operationId] ?? 0)) {
        row = await save(ctx, row, { state: 'NEEDS_REVIEW', error: 'POINTS_ATTEMPTS_EXHAUSTED' },
            { ...payload, priorState: row.state });

        return { row, op, unknown: true };
    }

    op.attempts++;
    row = await save(ctx, row, { retry_at: Date.now() + (op.attempts === 1 ? 10 : 20) * MINUTE }, payload);
    let result: Result<OperationReceipt>;

    try {
        result = await invoke(service, op);
    } catch {
        return { row, op, unknown: true };
    }

    if (result.ok) {
        committed(op, result.data);
    } else if (!result.retryable) {
        // 非重试业务拒绝仍通过原操作查询确认，查询失败保留未决输入
        const proof = await service.getOperation({ source: SOURCE, operationId: op.input.operationId });

        if (proof.ok && proof.data.status === 'REJECTED') {
            op.outcome = 'REJECTED';
            op.error = proof.data.error.code;
        } else if (proof.ok && proof.data.status === 'COMMITTED') {
            committed(op, proof.data.receipt);
        }
    }

    if (op.outcome) {
        row = await persist();
    }

    return { row, op, unknown: !op.outcome };
}
