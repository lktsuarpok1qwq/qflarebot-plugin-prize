import type { Claim, Ctx, Draw } from '../contracts.js';
import { bindingExists } from '../inventory/bindings.js';
import { canonical, ensure, integer, meta, Fault } from './db.js';

interface Cursor {
    bot: string;
    scope: string;
    upper: number;
    at: number;
    id: string;
    epoch: number;
    expires: number;
}

async function cursorKey(secret: string): Promise<CryptoKey> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));

    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(secret: string, value: Cursor): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cursorKey(secret), new TextEncoder().encode(JSON.stringify(value)));
    const packed = new Uint8Array(iv.length + encrypted.byteLength);
    packed.set(iv);
    packed.set(new Uint8Array(encrypted), iv.length);

    return btoa(String.fromCharCode(...packed)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function open(secret: string, token: string): Promise<Cursor> {
    ensure(token.length <= 4000 && /^[A-Za-z0-9_-]+$/.test(token), 'CURSOR_INVALID');

    try {
        const bytes = Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/')), x => x.charCodeAt(0));
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await cursorKey(secret), bytes.slice(12));

        return JSON.parse(new TextDecoder().decode(plain)) as Cursor;
    } catch {
        throw new Fault('CURSOR_INVALID');
    }
}

export interface Filters {
    user?: string;
    pool?: string;
    prize?: string;
    kind?: string;
    state?: string;
    from?: number;
    to?: number;
    history?: boolean;
}

export async function page(ctx: Ctx, table: 'draws' | 'claims', filter: Filters, limit: number, cursor?: string) {
    integer(limit, 1, 50);
    const control = await meta(ctx);
    const key = control.cursor_secret;
    const scope = canonical({ table, filter, limit });
    let bound: Cursor = {
        bot: ctx.botId, scope, upper: Date.now(), at: Number.MAX_SAFE_INTEGER,
        id: '~', epoch: control.data_revision, expires: Date.now() + 30 * 60_000
    };

    if (cursor) {
        bound = await open(key, cursor);
        ensure(bound.bot === ctx.botId && bound.scope === scope && bound.expires > Date.now()
            && bound.epoch === control.data_revision, 'CURSOR_EXPIRED');
    }

    const time = table === 'draws' ? 'created_at' : `COALESCE(obtained_at,processed_at,
        (SELECT d.created_at FROM {draws} d WHERE d.bot_id={claims}.bot_id AND d.id={claims}.draw_id))`;
    const clauses = ['bot_id=?', `${time}<=?`, `(${time}<? OR (${time}=? AND id<?))`];
    const args: unknown[] = [ctx.botId, bound.upper, bound.at, bound.at, bound.id];

    for (const [name, value] of Object.entries(filter)) {
        if (value === undefined || name === 'history') { continue; }

        const column = ({ user: 'user_id', pool: 'pool_id', prize: 'prize_id', kind: 'kind', state: 'state' } as Record<string, string>)[name];

        if (column) {
            if (table === 'draws' && name === 'prize') {
                clauses.push('EXISTS(SELECT 1 FROM {claims} c WHERE c.bot_id={draws}.bot_id AND c.draw_id={draws}.id AND c.prize_id=?)');
                args.push(value);
                continue;
            }

            ensure(!(table === 'claims' && name === 'kind'), 'FILTER_UNSUPPORTED');
            clauses.push(`${column}=?`);
            args.push(value);
        } else if (name === 'from' || name === 'to') {
            clauses.push(`${time}${name === 'from' ? '>=' : '<'}?`);
            args.push(value);
        }
    }

    if (table === 'claims' && filter.history !== undefined) {
        clauses.push(`state ${filter.history ? 'IN' : 'NOT IN'} ('FULFILLED','EXPIRED','CANCELLED')`);
        clauses.push("state<>'LOCKED' AND EXISTS(SELECT 1 FROM {draws} d WHERE d.bot_id={claims}.bot_id AND d.id={claims}.draw_id AND d.state='SETTLED')");
    }

    const rows = await ctx.db.all<(Draw | Claim) & { list_time: number }>(`SELECT *,${time} AS list_time FROM {${table}} WHERE ${clauses.join(' AND ')}
        ORDER BY ${time} DESC,id DESC LIMIT ?`, ...args, limit + 1);
    const more = rows.length > limit;
    rows.length = Math.min(rows.length, limit);
    let next: string | null = null;

    if (more && rows.length) {
        const last = rows.at(-1)!;
        next = await seal(key, { ...bound, at: last.list_time, id: last.id });
    }

    return { rows, next, scope: filter, snapshot: bound.upper };
}

export async function continuePage(ctx: Ctx, cursor: string, user: string, expected: 'POOL' | 'PRIZES') {
    const control = await meta(ctx);
    const bound = await open(control.cursor_secret, cursor);
    const scope = JSON.parse(bound.scope) as { table: 'draws' | 'claims'; filter: Filters; limit: number };
    ensure(scope.filter.user === user && (expected === 'PRIZES' ? scope.table === 'claims'
        : scope.table === 'draws' && scope.filter.kind === expected), 'CURSOR_INVALID');

    return page(ctx, scope.table, scope.filter, scope.limit, cursor);
}

export async function catalog(ctx: Ctx, table: 'pools' | 'prizes' | 'archive_batches' | 'admin_audit', cursor?: string, kind?: 'POOL') {
    ensure(!kind || table === 'pools' && kind === 'POOL', 'INVALID_ARGUMENT');
    const control = await meta(ctx);
    const scope = canonical({ table, limit: 20, kind: kind ?? null });
    const chronological = table === 'archive_batches' || table === 'admin_audit';
    const key = table === 'admin_audit' ? 'operation_id' : 'id';
    let bound: Cursor = {
        bot: ctx.botId, scope, upper: Date.now(), at: Number.MAX_SAFE_INTEGER,
        id: chronological ? '~' : '', epoch: control.data_revision, expires: Date.now() + 30 * 60000
    };

    if (cursor) {
        bound = await open(control.cursor_secret, cursor);
        ensure(bound.bot === ctx.botId && bound.scope === scope && bound.expires > Date.now()
            && bound.epoch === control.data_revision, 'CURSOR_EXPIRED');
    }

    const columns = table === 'prizes' ? 'id,name,available,reserved,fulfilled,version,deleted,' + bindingExists() + ' AS bound' : table === 'archive_batches' ? 'id,state,version,object_key,content_hash,bytes,created_at'
        : table === 'admin_audit' ? 'operation_id,action,target,state,outcome,created_at' : '*';
    const condition = chronological ? `created_at<=? AND (created_at<? OR (created_at=? AND ${key}<?))` : `${key}>?`;
    const params = chronological ? [bound.upper, bound.at, bound.at, bound.id] : [bound.id];
    const rows = await ctx.db.all<Record<string, unknown>>(`SELECT ${columns} FROM {${table}} WHERE bot_id=? AND ${condition}${table === 'prizes' ? ' AND deleted=0' : ''}${kind ? " AND json_extract(rules,'$.kind')=?" : ''}
        ORDER BY ${chronological ? 'created_at DESC,' : ''}${key} ${chronological ? 'DESC' : 'ASC'} LIMIT 21`, ctx.botId, ...params, ...kind ? [kind] : []);

    if (table === 'prizes') { rows.forEach(row => { row.bound = row.bound === 1; }); }

    const more = rows.length > 20;
    rows.length = Math.min(rows.length, 20);
    const last = rows.at(-1);
    const next = more && last ? await seal(control.cursor_secret,
        { ...bound, id: last[key] as string, at: chronological ? last.created_at as number : 0 }) : null;

    return { rows, next };
}
