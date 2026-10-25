import type { DBStatement } from '@qqbot/sdk';
import type { Ctx, Outcome } from '../contracts.js';
import { atomic, canonical, ensure, failure, hash, NOW, sql, text } from '../storage/db.js';

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

export type ReceiptSummary = Pick<AdminReceipt, 'operation_id' | 'request_hash' | 'action' | 'target' | 'state' | 'outcome'>;

export async function lookup(ctx: Ctx, id: string): Promise<ReceiptSummary | null> {
    return ctx.db.first<ReceiptSummary>('SELECT operation_id,request_hash,action,target,state,outcome FROM {admin_audit} WHERE bot_id=? AND operation_id=?', ctx.botId, id);
}

async function identity(ctx: Ctx, request: AdminRequest): Promise<{ digest: string; previous: ReceiptSummary | null }> {
    text(request.operationId, 96);
    ensure(/^[A-Za-z0-9_-]+$/.test(request.operationId));
    text(request.action, 40);
    text(request.target, 96, 0);
    const digest = await hash(canonical({ format: 1, ...request }));
    const previous = await lookup(ctx, request.operationId);
    ensure(!previous || previous.request_hash === digest, 'OPERATION_CONFLICT');

    return { digest, previous };
}

function insert(ctx: Ctx, request: AdminRequest, digest: string, outcome: Outcome): DBStatement {
    return sql(`INSERT INTO {admin_audit}(bot_id,operation_id,request_hash,action,target,input,state,outcome,created_at)
        VALUES(?,?,?,?,?,?,?, ?,${NOW})`, ctx.botId, request.operationId, digest, request.action, request.target,
        canonical(request), 'DONE', JSON.stringify(outcome));
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
        await atomic(ctx, next.guard, [...next.writes, insert(ctx, request, digest, next.outcome)], true);

        return next.outcome;
    } catch (error) {
        const winner = await lookup(ctx, request.operationId);

        if (winner) {
            ensure(winner.request_hash === digest, 'OPERATION_CONFLICT');

            return winner.outcome ? JSON.parse(winner.outcome) as Outcome : { ok: false, code: 'PENDING' };
        }

        const outcome = failure(error);
        const inserted = await ctx.db.first<Pick<ReceiptSummary, 'request_hash' | 'outcome'>>(`INSERT INTO {admin_audit}(bot_id,operation_id,request_hash,action,target,input,state,outcome,created_at)
            VALUES(?,?,?,?,?,?,'DONE',?,${NOW}) ON CONFLICT(bot_id,operation_id) DO NOTHING RETURNING request_hash,outcome`, ctx.botId,
            request.operationId, digest, request.action, request.target, canonical(request), JSON.stringify(outcome));
        const actual = inserted ?? await lookup(ctx, request.operationId);
        ensure(actual?.request_hash === digest, 'OPERATION_CONFLICT');

        return JSON.parse(actual.outcome!) as Outcome;
    }
}
