import type { DBStatement } from '@qqbot/sdk';
import type { Ctx, Outcome } from '../contracts.js';
import { atomic, canonical, ensure, failure, Fault, isConflict, hash, NOW, sql, text } from '../storage/db.js';

export interface AdminRequest {
    operationId: string;
    action: string;
    target: string;
    expectedVersion: number;
    params: Record<string, unknown>;
}
export interface AdminReceipt {
    bot_id: string;
    operation_id: string;
    request_hash: string;
    action: string;
    target: string;
    input: string | null;
    state: 'PENDING' | 'DONE';
    outcome: string | null;
    created_at: number;
    archive_id: string | null;
    archive_pending: string | null;
}

export async function lookup(ctx: Ctx, id: string): Promise<AdminReceipt | null> {
    return ctx.db.first<AdminReceipt>('SELECT * FROM {admin_audit} WHERE bot_id=? AND operation_id=?', ctx.botId, id);
}

async function identity(ctx: Ctx, request: AdminRequest): Promise<{ digest: string; previous: AdminReceipt | null }> {
    text(request.operationId, 96);
    ensure(/^[A-Za-z0-9_-]+$/.test(request.operationId));
    text(request.action, 40);
    text(request.target, 96, 0);
    const digest = await hash(canonical({ format: 1, ...request }));
    const previous = await lookup(ctx, request.operationId);
    ensure(!previous || previous.request_hash === digest, 'OPERATION_CONFLICT');

    return { digest, previous };
}

function insert(ctx: Ctx, request: AdminRequest, digest: string, outcome: Outcome | null): DBStatement {
    return sql(`INSERT INTO {admin_audit}(bot_id,operation_id,request_hash,action,target,input,state,outcome,created_at)
        VALUES(?,?,?,?,?,?,?, ?,${NOW})`, ctx.botId, request.operationId, digest, request.action, request.target,
        canonical(request), outcome ? 'DONE' : 'PENDING', outcome ? JSON.stringify(outcome) : null);
}

export interface Plan {
    guard: DBStatement;
    writes: DBStatement[];
    outcome: Outcome;
}

export async function local(ctx: Ctx, request: AdminRequest, plan: () => Promise<Plan>): Promise<Outcome> {
    const { digest, previous } = await identity(ctx, request);

    if (previous) {
        return previous.outcome ? JSON.parse(previous.outcome) as Outcome : { ok: false, code: 'PENDING', target: request.target };
    }

    try {
        const next = await plan();
        await atomic(ctx, next.guard, [...next.writes, insert(ctx, request, digest, next.outcome)]);

        return next.outcome;
    } catch (error) {
        const winner = await lookup(ctx, request.operationId);

        if (winner) {
            ensure(winner.request_hash === digest, 'OPERATION_CONFLICT');

            return winner.outcome ? JSON.parse(winner.outcome) as Outcome : { ok: false, code: 'PENDING' };
        }

        const outcome = failure(error);
        await ctx.db.run(`INSERT INTO {admin_audit}(bot_id,operation_id,request_hash,action,target,input,state,outcome,created_at)
            VALUES(?,?,?,?,?,?,'DONE',?,${NOW}) ON CONFLICT(bot_id,operation_id) DO NOTHING`, ctx.botId,
            request.operationId, digest, request.action, request.target, canonical(request), JSON.stringify(outcome));
        const actual = await lookup(ctx, request.operationId);
        ensure(actual?.request_hash === digest, 'OPERATION_CONFLICT');

        return JSON.parse(actual.outcome!) as Outcome;
    }
}

export async function external(ctx: Ctx, request: AdminRequest, perform: () => Promise<Outcome>): Promise<Outcome> {
    const { digest, previous } = await identity(ctx, request);

    if (previous?.outcome) {
        return JSON.parse(previous.outcome) as Outcome;
    }

    if (!previous) {
        try {
            await ctx.db.batch([insert(ctx, request, digest, null)]);
        } catch {
            const winner = await lookup(ctx, request.operationId);
            ensure(winner?.request_hash === digest, 'OPERATION_CONFLICT');

            if (winner.outcome) {
                return JSON.parse(winner.outcome) as Outcome;
            }
        }
    }

    // 跨 Service 的不明结果保留 PENDING，后续仍以同一意图和原资金 ID 核查
    let result: Outcome;

    try {
        result = await perform();
    } catch (error) {
        const actual = await lookup(ctx, request.operationId);

        if (actual?.outcome) {
            return JSON.parse(actual.outcome) as Outcome;
        }

        if (isConflict(error) || error instanceof Fault && ['POINTS_NOT_READY', 'VERIFICATION_REQUIRED', 'INVALID_ARGUMENT', 'ARCHIVE_DISABLED'].includes(error.code)) {
            result = failure(error);
        } else {
            throw error;
        }
    }

    await ctx.db.run(`UPDATE {admin_audit} SET state='DONE',outcome=? WHERE bot_id=? AND operation_id=? AND state='PENDING'`,
        JSON.stringify(result), ctx.botId, request.operationId);
    const actual = await lookup(ctx, request.operationId);

    return JSON.parse(actual!.outcome!) as Outcome;
}
