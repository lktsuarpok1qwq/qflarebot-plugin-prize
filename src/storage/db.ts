import type { DBStatement } from '@qqbot/sdk';
import type { Ctx, Draw, DrawBody, Meta, Outcome, Settings } from '../contracts.js';

export const NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export const LIVE = "state NOT IN ('SETTLED','FAILED','REFUNDED')";
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

export async function atomic(ctx: Ctx, condition: DBStatement, writes: DBStatement[]): Promise<void> {
    const token = crypto.randomUUID();
    await ctx.db.batch([
        sql(`INSERT INTO {guards}(id,ok) SELECT ?,CASE WHEN (${condition.sql}) THEN 1 ELSE 0 END`, token, ...condition.params ?? []),
        ...writes,
        sql('UPDATE {schema_meta} SET data_revision=data_revision+1 WHERE bot_id=?', ctx.botId),
        sql('DELETE FROM {guards} WHERE id=?', token)
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
    ensure(row.schema_version === 1, 'SCHEMA_UNSUPPORTED');
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
    ensure(row.body, 'ARCHIVED');

    return JSON.parse(row.body) as DrawBody;
}

export function patchDraw(row: Draw, patch: Partial<Draw>, payload?: DrawBody): DBStatement {
    const next = { ...row, ...patch };

    return sql(`UPDATE {draws} SET state=?,version=version+1,retry_at=?,expires_at=?,error=?,body=?,
        reward=?,winner=?,qualifies=?,settled_at=?,award_ids=? WHERE bot_id=? AND id=?`,
        next.state, next.retry_at, next.expires_at, next.error, payload ? JSON.stringify(payload) : next.body,
        next.reward, next.winner, next.qualifies, next.settled_at, next.award_ids, row.bot_id, row.id);
}

export function fence(row: Draw): DBStatement {
    return sql(`EXISTS(SELECT 1 FROM {draws} WHERE bot_id=? AND id=? AND version=? AND lease_token=? AND lease_until>${NOW})`,
        row.bot_id, row.id, row.version, row.lease_token);
}

export async function save(ctx: Ctx, row: Draw, patch: Partial<Draw>, payload?: DrawBody, extra: DBStatement[] = [], condition?: DBStatement): Promise<Draw> {
    const write = patchDraw(row, patch, payload);

    if (extra.length) {
        const guard = fence(row);
        await atomic(ctx, condition ? sql(`(${guard.sql}) AND (${condition.sql})`, ...guard.params!, ...condition.params ?? []) : guard, [write, ...extra]);
    } else {
        // 只有一行更新时直接使用带 fencing 条件的原子 UPDATE，无需额外守卫事务
        const result = await ctx.db.run(write.sql + ` AND version=? AND lease_token=? AND lease_until>${NOW}`,
            ...write.params!, row.version, row.lease_token);
        ensure(result.changes > 0, 'CONFLICT');
    }

    return { ...row, ...patch, version: row.version + 1, body: payload ? JSON.stringify(payload) : patch.body ?? row.body };
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

export function shortNumber(prefix: 'D' | 'P' | 'G', id: string): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    // UUID 最后60位均为随机位；保留内部 UUID，只压缩面向用户的编号。
    let value = BigInt('0x' + id.replaceAll('-', '').slice(-15));
    let code = '';

    for (let i = 0; i < 12; i++) {
        code = alphabet[Number(value & 31n)]! + code;
        value >>= 5n;
    }

    return prefix + code;
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
