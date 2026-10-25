import type { OperationReceipt, PointsService, Result } from 'qflarebot-plugin-points';
import type { DBStatement } from '@qqbot/sdk';
import type { Ctx, Draw, DrawBody, Operation } from '../contracts.js';
import { SOURCE, MINUTE } from '../contracts.js';
import { body, canonical, ensure, fence, save, sql } from '../storage/db.js';

export function wallet(ctx: Ctx): PointsService {
    return ctx.service<PointsService>('points.wallet');
}

export function accessFailure(ctx: Ctx, code?: string): DBStatement[] {
    return code && ['SOURCE_NOT_REGISTERED', 'SOURCE_DISABLED', 'SOURCE_NOT_ALLOWED'].includes(code)
        ? [sql(`UPDATE {schema_meta} SET admission_enabled=0,admission_revision=admission_revision+1,version=version+1 WHERE bot_id=? AND admission_enabled=1`, ctx.botId)] : [];
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

type Finish = (row: Draw, payload: DrawBody, extra: DBStatement[]) => Promise<Draw>;

export interface OperationProof {
    version: number;
    recipe: string;
    result: Awaited<ReturnType<PointsService['getOperation']>>;
}

export interface RecoveryInspection {
    rowId: string;
    version: number;
    pending: boolean;
    proof?: OperationProof;
}

// 恢复先只读核对原操作；查询失败不取得租约，也不改变库存、输入或重试次数。
export async function inspectRecovery(ctx: Ctx, row: Draw): Promise<RecoveryInspection> {
    const inspection = { rowId: row.id, version: row.version, pending: false };

    if (row.kind !== 'POOL' || row.count !== 1) { return inspection; }

    let op: Operation | undefined;

    try {
        const method = row.state === 'CREATED' ? 'burn'
            : ['DEBITED', 'DRAWN', 'SETTLING'].includes(row.state) ? 'credit'
                : row.state === 'CANCELLING' ? 'reverseOwn' : null;
        op = body(row).ops.find(item => item.method === method);
    } catch { return inspection; }

    if (!op || op.outcome || op.attempts <= 0 || typeof op.input?.operationId !== 'string') { return inspection; }

    try {
        const result = await wallet(ctx).getOperation({ source: SOURCE, operationId: op.input.operationId });

        if (!result.ok || result.data.status === 'NOT_FOUND' && row.retry_at > Date.now()) { return { ...inspection, pending: true }; }

        return { ...inspection, proof: { version: row.version + 1, recipe: canonical({ method: op.method, input: op.input }), result } };
    } catch { return { ...inspection, pending: true }; }
}

export async function operation(ctx: Ctx, initial: Draw, index: number, finish: Finish, prepared = false, proof?: OperationProof, inputPayload?: DrawBody): Promise<{ row: Draw; op: Operation; unknown: boolean }> {
    let row = initial;
    const payload = inputPayload ?? body(row);
    const op = payload.ops[index]!;
    const service = wallet(ctx);
    let permissionClosed = false;
    const persist = () => finish(row, payload, permissionClosed ? [] : accessFailure(ctx, op.error));

    if (op.outcome) {
        return { row: await persist(), op, unknown: false };
    }

    if (!prepared && op.attempts > 0) {
        // 仅复用本请求在取得租约前查到的同版本、同配方证明；发生竞争或阶段改变时重新查询。
        const found = proof?.version === row.version && proof.recipe === canonical({ method: op.method, input: op.input })
            ? proof.result : await service.getOperation({ source: SOURCE, operationId: op.input.operationId });

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

    if (!prepared && op.attempts > 0 && initial.retry_at > Date.now()) {
        return { row, op, unknown: true };
    }

    if (op.attempts >= 3 + (payload.manualAttempts?.[op.input.operationId] ?? 0)) {
        row = await save(ctx, row, { state: 'NEEDS_REVIEW', error: 'POINTS_ATTEMPTS_EXHAUSTED' },
            { ...payload, priorState: row.state });

        return { row, op, unknown: true };
    }

    if (prepared) {
        // 发起证据已与上一阶段同批保存；只读核对 fencing，不能借用过期或被接管的快照。
        ensure(op.attempts === 1 && !op.outcome && row.retry_at > 0, 'POINTS_EVIDENCE_CONFLICT');
        const guard = fence(row);
        ensure(await ctx.db.first(`SELECT 1 AS owned WHERE ${guard.sql}`, ...guard.params!), 'CONFLICT');
    } else {
        op.attempts++;
        row = await save(ctx, row, { retry_at: Date.now() + (op.attempts === 1 ? 10 : 20) * MINUTE, ...(op.method === 'credit' ? { state: 'SETTLING' as const } : {}) }, payload);
    }

    let result: Result<OperationReceipt>;

    try {
        result = await invoke(service, op);
    } catch {
        return { row, op, unknown: true };
    }

    if (!result.ok) {
        const writes = accessFailure(ctx, result.code);

        for (const write of writes) { await ctx.db.run(write.sql, ...write.params!); }

        permissionClosed = writes.length > 0;
    }

    if (result.ok) {
        committed(op, result.data);
    } else if (op.method === 'burn' && ['INSUFFICIENT_BALANCE', 'ACCOUNT_SUSPENDED', 'ACCOUNT_NOT_FOUND', 'SOURCE_NOT_REGISTERED', 'SOURCE_DISABLED'].includes(result.code) && result.retryable === false) {
        // burn 的这些业务错误仅在永久拒绝提交后返回；参数错误、权限歧义及编号冲突仍须核对。
        op.outcome = 'REJECTED';
        op.error = result.code;
    } else if (!result.retryable) {
        // 其它不可重试错误仍核对原操作，不能把参数错误或冲突当作未扣款证明。
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
