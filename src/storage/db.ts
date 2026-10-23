import type { DBStatement } from '@qqbot/sdk';
import { DRAW_LIST_FIELDS, SCHEMA } from '../contracts.js';
import type { Ctx, Draw, DrawBody, DrawEvidence, Meta, Outcome, Settings } from '../contracts.js';

export const NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export const LIVE = "qualifies=1 AND settled_at IS NULL AND state NOT IN ('SETTLED','FAILED','REFUNDED')";
export class Fault extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

export function ensure(value: unknown, code = 'INVALID_ARGUMENT'): asserts value {
    if (!value) {
        throw new Fault(code);
    }
}

export function sql(sql: string, ...params: unknown[]): DBStatement {
    return { sql, params };
}

export async function atomic<T = unknown>(ctx: Ctx, condition: DBStatement, writes: DBStatement[], tracked = false) {
    return ctx.db.batch<T>([
        // 成功不写守卫；失败或未知条件触发 CHECK，后续语句随整个事务回滚。
        sql(`INSERT INTO {guards}(id,ok) SELECT ?,0 WHERE NOT COALESCE((${condition.sql}),0)`, ctx.botId, ...condition.params ?? []),
        ...writes,
        ...tracked ? [] : [sql('UPDATE {schema_meta} SET data_revision=data_revision+1 WHERE bot_id=?', ctx.botId)]
    ]);
}

export function isConflict(error: unknown): boolean {
    return /prize_guard|UNIQUE constraint|constraint failed.*guards/i.test(String(error));
}

export async function meta(ctx: Ctx): Promise<Meta> {
    let row: Meta | null;

    try {
        row = await ctx.db.first<Meta>('SELECT * FROM {schema_meta} WHERE bot_id=?', ctx.botId);
    } catch (error) {
        if (/no such table:.*schema_meta/i.test(String(error))) { throw new Fault('SCHEMA_NOT_READY'); }

        throw error;
    }

    ensure(row, 'SCHEMA_NOT_READY');
    ensure(row.schema_version === SCHEMA && row.capacity_deferred === 0, 'SCHEMA_UNSUPPORTED');
    ensure(row.state !== 'INITIALIZING' && row.state !== 'VERIFYING', 'SCHEMA_INITIALIZING');
    ensure(row.state === 'READY', 'SCHEMA_UNSUPPORTED');

    return row;
}

export function settings(row: Meta): Settings {
    const value = JSON.parse(row.settings) as Settings;

    return {
        paused: value.paused === true, archiveEnabled: value.archiveEnabled,
        retentionMonths: value.retentionMonths, maxInflight: value.maxInflight,
        maxFacts: value.maxFacts, maxPendingBytes: value.maxPendingBytes
    };
}

export async function draw(ctx: Ctx, id: string): Promise<Draw> {
    const row = await ctx.db.first<Draw>('SELECT * FROM {draws} WHERE bot_id=? AND id=?', ctx.botId, id);
    ensure(row, 'NOT_FOUND');

    return row;
}

export function body(row: Draw): DrawBody {
    ensure(row.body && row.snapshot, 'ARCHIVED');
    const fixed = JSON.parse(row.snapshot) as DrawBody;
    const progress = JSON.parse(row.body) as Pick<DrawBody, 'ops' | 'manualAttempts' | 'priorState'>;
    ensure(Array.isArray(fixed.ops) && Array.isArray(progress.ops) && fixed.ops.length === progress.ops.length, 'POINTS_EVIDENCE_MISSING');
    ensure(Object.keys(progress).every(key => ['ops', 'manualAttempts', 'priorState'].includes(key)), 'POINTS_EVIDENCE_CONFLICT');
    ensure(progress.ops.every(item => !('method' in item) && !('input' in item)), 'POINTS_EVIDENCE_CONFLICT');

    return { ...fixed, ...progress, ops: fixed.ops.map((recipe, index) => ({ ...recipe, ...progress.ops[index]! })) };
}

export function splitPayload(payload: DrawBody): { snapshot: string; body: string } {
    const { ops, manualAttempts, priorState, ...fixed } = payload;

    return {
        snapshot: JSON.stringify({ ...fixed, ops: ops.map(({ method, input }) => ({ method, input })) }),
        body: JSON.stringify({
            ops: ops.map(({ method: _method, input: _input, ...progress }) => progress),
            ...manualAttempts !== undefined ? { manualAttempts } : {}, ...priorState !== undefined ? { priorState } : {}
        })
    };
}

export function progressPatch(row: Draw, payload: DrawBody): Pick<Draw, 'snapshot' | 'body'> {
    ensure(row.snapshot, 'POINTS_EVIDENCE_MISSING');
    const fixed = JSON.parse(row.snapshot) as DrawBody;
    ensure(payload.ops.length >= fixed.ops.length && payload.ops.length <= fixed.ops.length + 1, 'POINTS_EVIDENCE_CONFLICT');
    ensure(fixed.ops.every((recipe, index) => canonical(recipe) === canonical({ method: payload.ops[index]!.method, input: payload.ops[index]!.input })), 'POINTS_EVIDENCE_CONFLICT');
    let snapshot = row.snapshot;

    if (payload.ops.length > fixed.ops.length) {
        const added = payload.ops.at(-1)!;
        ensure(row.state === 'CANCELLING' && added.method === 'reverseOwn' && added.input.operationId === row.id + ':refund'
            && !fixed.ops.some(op => op.method === 'reverseOwn'), 'POINTS_EVIDENCE_CONFLICT');
        snapshot = JSON.stringify({ ...fixed, ops: payload.ops.map(({ method, input }) => ({ method, input })) });
    }

    const { ops, manualAttempts, priorState } = payload;

    return {
        snapshot, body: JSON.stringify({
            ops: ops.map(({ method: _method, input: _input, ...progress }) => progress),
            ...manualAttempts !== undefined ? { manualAttempts } : {}, ...priorState !== undefined ? { priorState } : {}
        })
    };
}

export function drawEvidence(row: Draw): DrawEvidence {
    return {
        ...Object.fromEntries([...DRAW_LIST_FIELDS, 'archive_ready'].map(key => [key, row[key as keyof Draw]])),
        body: row.body ? JSON.stringify(body(row)) : null
    } as DrawEvidence;
}

export function patchDraw(row: Draw, patch: Partial<Draw>, payload?: DrawBody): DBStatement {
    const values = { ...patch, ...(payload ? progressPatch(row, payload) : {}) };
    const allowed: Array<keyof Draw> = ['state', 'retry_at', 'expires_at', 'error', 'snapshot', 'body', 'reward', 'winner', 'qualifies', 'settled_at', 'award_ids', 'result_name', 'result_award_id', 'result_prize_id', 'lease_token', 'lease_until', 'archive_ready',
        'claim_state', 'claim_stock_state', 'claim_obtained_at', 'claim_fulfilled_at', 'claim_cancelled_at', 'claim_processed_at', 'claim_version', 'claim_note', 'claim_admin_op'];
    const keys = allowed.filter(key => key in values && values[key] !== row[key]);

    return sql(`UPDATE {draws} SET version=version+1${keys.map(key => ',' + key + '=' + (key === 'claim_processed_at' ? NOW : '?')).join('')} WHERE bot_id=? AND id=?`,
        ...keys.filter(key => key !== 'claim_processed_at').map(key => values[key]), row.bot_id, row.id);
}

export function fence(row: Draw, condition?: DBStatement): DBStatement {
    return sql(`EXISTS(SELECT 1 FROM {draws} WHERE bot_id=? AND id=? AND version=? AND lease_token=? AND lease_until>${NOW}${condition ? ' AND (' + condition.sql + ')' : ''})`,
        row.bot_id, row.id, row.version, row.lease_token, ...condition?.params ?? []);
}

export async function save(ctx: Ctx, row: Draw, patch: Partial<Draw>, payload?: DrawBody, extra: DBStatement[] = [], condition?: DBStatement): Promise<Draw> {
    const terminal = patch.state && ['SETTLED', 'FAILED', 'REFUNDED'].includes(patch.state);
    const next = {
        ...patch, ...payload ? progressPatch(row, payload) : {},
        ...terminal ? {
            archive_ready: patch.state === 'SETTLED' && (patch.result_prize_id ?? row.result_prize_id) ? 0 : 1,
            lease_token: null, lease_until: 0
        } : {}
    };
    const write = patchDraw(row, next);

    if (extra.length) {
        await atomic(ctx, fence(row, condition), [write, ...extra], true);
    } else {
        // 只有一行更新时直接使用带 fencing 条件的原子 UPDATE，无需额外守卫事务
        const result = await ctx.db.run(write.sql + ` AND version=? AND lease_token=? AND lease_until>${NOW}${condition ? ' AND (' + condition.sql + ')' : ''}`,
            ...write.params!, row.version, row.lease_token, ...condition?.params ?? []);
        ensure(result.changes > 0, 'CONFLICT');
    }

    return { ...row, ...next, version: row.version + 1 };
}

export async function lease(ctx: Ctx, id: string): Promise<Draw | null> {
    const token = crypto.randomUUID();

    return ctx.db.first<Draw>(`UPDATE {draws} SET lease_token=?,lease_until=${NOW}+120000,version=version+1
        WHERE bot_id=? AND id=? AND lease_until<=${NOW} AND ${LIVE} RETURNING *`, token, ctx.botId, id);
}

export function failure(error: unknown): Outcome {
    return { ok: false, code: error instanceof Fault ? error.code : isConflict(error) ? 'CONFLICT' : 'UNAVAILABLE' };
}

export function integer(value: unknown, min = 0, max = 1_000_000_000_000): number {
    ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max);

    return value;
}

export function text(value: unknown, max: number, min = 1): string {
    ensure(typeof value === 'string' && value.length >= min && new TextEncoder().encode(value).length <= max);

    return value;
}

export function identifier(value: unknown): string {
    const result = text(value, 96);
    ensure(/^[A-Za-z][A-Za-z0-9_-]*$/.test(result));

    return result;
}

export function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return '[' + value.map(canonical).join(',') + ']';
    }

    if (value !== null && typeof value === 'object') {
        return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
    }

    ensure(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)));

    return JSON.stringify(value);
}

export async function hash(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function beijing(time: number): string {
    return new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function nextArchiveAt(time: number): number {
    const day = Math.floor((time + 8 * 3_600_000) / 86_400_000) * 86_400_000;
    const today = day + 3 * 3_600_000 - 8 * 3_600_000;

    return today > time ? today : today + 86_400_000;
}
