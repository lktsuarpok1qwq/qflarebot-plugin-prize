import { claimSource } from './claims.js';
import type { Claim, Ctx, Draw, Meta, Pool } from '../contracts.js';
import { CLAIM_FIELDS, CLAIM_STATES, DRAW_LIST_FIELDS, POOL_FIELDS } from '../contracts.js';
import { bindingExists } from '../inventory/bindings.js';
import { canonical, ensure, integer, meta, Fault, NOW } from './db.js';

// SQLite BINARY 的文本顺序对应 Unicode 码点顺序；不依赖 UNION ALL 的返回顺序。
function binary(left: string, right: string): number {
    for (let i = 0, j = 0; i < left.length && j < right.length;) {
        const x = left.codePointAt(i)!, y = right.codePointAt(j)!;

        if (x !== y) { return x - y; }

        i += x > 0xffff ? 2 : 1;
        j += y > 0xffff ? 2 : 1;
    }

    return left.length - right.length;
}

function newest(a: { id: string | null; list_time: number }, b: { id: string | null; list_time: number }): number {
    return b.list_time - a.list_time || binary(b.id!, a.id!);
}

async function snapshotRows<T>(ctx: Ctx, revision: number, fields: readonly string[], query: string, params: unknown[], revisionColumn: 'data_revision' | 'pool_revision' = 'data_revision'): Promise<T[]> {
    const block = await ctx.db.all<{ revision: number | null; item: string | null }>(`SELECT ${revisionColumn} AS revision,NULL AS item FROM {schema_meta} WHERE bot_id=?
        UNION ALL SELECT NULL,json_array(${fields.join(',')}) FROM (${query}) AS snapshot_rows`, ctx.botId, ...params);
    const control = block.find(row => row.revision !== null);
    ensure(control, 'UNAVAILABLE');
    ensure(control.revision === revision, 'CURSOR_EXPIRED');

    return block.filter(row => row.item !== null).map(row => {
        const values = JSON.parse(row.item!) as unknown[];

        return Object.fromEntries(fields.map((key, index) => [key, values[index]])) as T;
    });
}

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
    settled?: boolean;
}

export async function page(ctx: Ctx, table: 'draws' | 'claims', filter: Filters, limit: number, cursor?: string, initial?: Meta) {
    if (table === 'claims') { filter = { ...filter, settled: true }; }

    integer(limit, 1, 50);
    ensure(table !== 'claims' || !filter.state || CLAIM_STATES.includes(filter.state as Claim['state']));
    const control = initial ?? await meta(ctx);
    const key = control.cursor_secret;
    const scope = canonical({ table, filter, limit });
    let bound: Cursor = {
        bot: ctx.botId, scope, upper: Date.now(), at: Number.MAX_SAFE_INTEGER,
        id: '~', epoch: control.data_revision, expires: Date.now() + 30 * 60_000
    };

    if (cursor) {
        bound = await open(key, cursor);
        ensure(bound.bot === ctx.botId && bound.scope === scope && bound.expires > Date.now()
            && bound.epoch === control.data_revision && bound.at <= bound.upper, 'CURSOR_EXPIRED');
    }

    const time = table === 'draws' ? 'created_at' : filter.settled ? 'obtained_at' : 'list_time';
    // 后续页的已认证游标不晚于首页上界，直接按时间和 ID 定位，避免重新扫描前页。
    const clauses = ['bot_id=?', ...table === 'draws' ? ['count>0'] : [], ...cursor ? [`(${time},id)<(?,?)`] : []];
    const args: unknown[] = cursor ? [ctx.botId, bound.at, bound.id] : [ctx.botId];

    for (const [name, value] of Object.entries(filter)) {
        if (value === undefined || name === 'settled') { continue; }

        const column = ({ user: 'user_id', pool: 'pool_id', prize: 'prize_id', kind: 'kind', state: 'state' } as Record<string, string>)[name];

        if (column) {
            if (table === 'draws' && name === 'prize') {
                clauses.push('claim_id IS NOT NULL AND claim_prize_id=?');
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

    if (table === 'claims' && filter.settled) {
        clauses.push("state<>'LOCKED' AND obtained_at IS NOT NULL AND purchase_state='SETTLED'");
    }

    const userIndex = filter.user && (table === 'draws' || filter.settled) ? table === 'draws' ? ' INDEXED BY {draw_user}' : ' ' : '';
    const columns = table === 'claims' ? CLAIM_FIELDS.filter(key => key !== 'award').join(',') + ',NULL AS award' : DRAW_LIST_FIELDS.join(',') + ',NULL AS body';
    const projection = columns + (table === 'draws' ? `,${time} AS list_time${filter.prize ? ',claim_id,claim_prize_id' : ''}` : ',purchase_state');
    const rejected = table === 'draws' && !userIndex && ['FAILED', 'REFUNDED'].includes(filter.state ?? '');
    const bounded = !!(filter.pool || filter.prize || filter.state && !rejected || table === 'claims' && filter.user && !filter.settled);
    const rejectedIndex = rejected ? ' INDEXED BY {draw_rejected}' : '';
    let rows: Array<(Draw | Claim) & { list_time: number }> = [];

    if (bounded) {
        let after = cursor ? { at: bound.at, id: bound.id } : null;
        const fields: string[] = table === 'claims' ? [...CLAIM_FIELDS.filter(key => key !== 'award'), 'award'] : [...DRAW_LIST_FIELDS, 'body', 'list_time'];

        // 每块和控制修订号属于同一 SQL 快照，跨块有变化就拒绝拼接。
        for (const size of [64, 256, 681]) {
            const base = ['bot_id=?', ...table === 'draws' ? ['count>0'] : [], ...after ? [`(${time},id)<(?,?)`] : []];
            const params: unknown[] = after ? [ctx.botId, after.at, after.id] : [ctx.botId];

            for (const [key, operator] of [['from', '>='], ['to', '<']] as const) {
                if (filter[key] !== undefined) {
                    base.push(`${time}${operator}?`);
                    params.push(filter[key]);
                }
            }

            if (userIndex) {
                base.push('user_id=?');
                params.push(filter.user);
            }

            if (table === 'claims' && filter.settled) { base.push('obtained_at IS NOT NULL'); }

            if (rejected) {
                base.push("state IN ('FAILED','REFUNDED') AND state=?");
                params.push(filter.state);
            }

            const index = table === 'claims' ? '' : userIndex || rejectedIndex || ' INDEXED BY {draw_time}';
            const block = await ctx.db.all<{ id: string | null; list_time: number; revision: number | null; item: string | null }>(`SELECT NULL AS id,NULL AS list_time,data_revision AS revision,NULL AS item FROM {schema_meta} WHERE bot_id=?
                UNION ALL SELECT {${table}}.id,{${table}}.list_time,NULL,
                CASE WHEN ${clauses.join(' AND ')} THEN json_array(${fields.join(',')}) ELSE NULL END
                FROM (SELECT ${projection} FROM ${table === 'claims' ? claimSource(userIndex ? 'claim_user' : 'claim_obtained') : '{draws}' + index}
                    WHERE ${base.join(' AND ')} ORDER BY ${time} DESC,id DESC LIMIT ?) AS {${table}}`,
                ctx.botId, ...args, ...params, size);
            const revision = block.find(row => row.revision !== null);
            ensure(revision, 'UNAVAILABLE');
            ensure(revision.revision === bound.epoch, 'CURSOR_EXPIRED');
            const scanned = block.filter((row): row is typeof row & { id: string } => row.id !== null).sort(newest);

            for (const row of scanned) {
                if (row.item && rows.length <= limit) {
                    const values = JSON.parse(row.item) as unknown[];
                    rows.push(Object.fromEntries(fields.map((key, index) => [key, values[index]])) as unknown as typeof rows[number]);
                }
            }

            if (rows.length > limit || scanned.length < size) { break; }

            ensure(size !== 681, 'QUERY_WORK_LIMIT');
            const last = scanned.at(-1)!;
            after = { at: last.list_time, id: last.id };
        }
    } else {
        const fields = table === 'claims' ? [...CLAIM_FIELDS.filter(key => key !== 'award'), 'award'] : [...DRAW_LIST_FIELDS, 'body', 'list_time'];
        rows = await snapshotRows<(Draw | Claim) & { list_time: number }>(ctx, bound.epoch, fields, `SELECT ${projection} FROM ${table === 'claims' ? claimSource(userIndex ? 'claim_user' : 'claim_obtained') : '{draws}' + (userIndex || rejectedIndex)}
            WHERE ${clauses.join(' AND ')}${rejected ? " AND state IN ('FAILED','REFUNDED')" : ''}
            ORDER BY ${time} DESC,id DESC LIMIT ?`, [...args, limit + 1]);
        rows.sort(newest);
    }

    // 已提交业务的时间可能领先本实例；首页从实际结果建立游标上界，不按本机时钟漏读。
    if (!cursor && rows.length) { bound.upper = Math.max(bound.upper, rows[0]!.list_time); }

    const more = rows.length > limit;
    rows.length = Math.min(rows.length, limit);
    let next: string | null = null;

    if (more && rows.length) {
        const last = rows.at(-1)!;
        next = await seal(key, { ...bound, at: last.list_time, id: last.id });
    }

    return { rows, next, scope: filter, snapshot: bound.upper };
}

export async function activePools(ctx: Ctx, control: Meta, cursor?: string) {
    const scope = 'active-pools';
    let bound: Cursor = {
        bot: ctx.botId, scope, upper: Date.now(), at: 0, id: '', epoch: control.pool_revision,
        expires: Date.now() + 30 * 60_000
    };

    if (cursor) {
        bound = await open(control.cursor_secret, cursor);
        ensure(bound.bot === ctx.botId && bound.scope === scope && bound.expires > Date.now()
            && bound.epoch === control.pool_revision, 'CURSOR_EXPIRED');
    }

    const rows = await snapshotRows<Pool>(ctx, bound.epoch, POOL_FIELDS, `SELECT ${POOL_FIELDS.join(',')} FROM {pools} INDEXED BY {pool_active} WHERE bot_id=? AND id>? AND state='ACTIVE'
        AND json_extract(rules,'$.kind')='POOL' AND json_extract(rules,'$.starts')<=?
        AND json_extract(rules,'$.ends')>? ORDER BY id LIMIT 6`, [ctx.botId, bound.id, bound.upper, Date.now()], 'pool_revision');
    rows.sort((a, b) => binary(a.id, b.id));
    const more = rows.length > 5;
    rows.length = Math.min(rows.length, 5);
    const next = more ? await seal(control.cursor_secret, { ...bound, id: rows.at(-1)!.id }) : null;

    return { rows, next };
}

export async function catalog(ctx: Ctx, table: 'pools' | 'prizes' | 'archive_batches' | 'admin_audit', cursor?: string, kind?: 'POOL', initial?: Meta) {
    ensure(!kind || table === 'pools' && kind === 'POOL', 'INVALID_ARGUMENT');
    const control = initial ?? await meta(ctx);
    const revisionColumn = table === 'pools' ? 'pool_revision' : 'data_revision';
    const revision = control[revisionColumn];
    const scope = canonical({ table, limit: 20, kind: kind ?? null });
    const chronological = table === 'archive_batches' || table === 'admin_audit';
    const key = table === 'admin_audit' ? 'operation_id' : 'id';
    let bound: Cursor = {
        bot: ctx.botId, scope, upper: Date.now(), at: Number.MAX_SAFE_INTEGER,
        id: chronological ? '~' : '', epoch: revision, expires: Date.now() + 30 * 60000
    };

    if (cursor) {
        bound = await open(control.cursor_secret, cursor);
        ensure(bound.bot === ctx.botId && bound.scope === scope && bound.expires > Date.now()
            && bound.epoch === revision && (!chronological || bound.at <= bound.upper), 'CURSOR_EXPIRED');
    }

    const columns = table === 'prizes' ? 'id,name,available,reserved,fulfilled,version,deleted,' + bindingExists() + ' AS bound' : table === 'archive_batches' ? 'id,state,version,object_key,content_hash,bytes,created_at'
        : table === 'admin_audit' ? 'operation_id,action,target,state,outcome,created_at' : POOL_FIELDS.join(',');
    const snapshot = chronological && !cursor;
    const fields = table === 'prizes' ? ['id', 'name', 'available', 'reserved', 'fulfilled', 'version', 'deleted', 'bound']
        : table === 'archive_batches' ? ['id', 'state', 'version', 'object_key', 'content_hash', 'bytes', 'created_at']
            : table === 'admin_audit' ? ['operation_id', 'action', 'target', 'state', 'outcome', 'created_at'] : [...POOL_FIELDS];

    if (snapshot) { fields.push('snapshot_at'); }

    const condition = chronological ? cursor ? `(created_at,${key})<(?,?)` : `created_at<=${NOW}` : `${key}>?`;
    const params = chronological ? cursor ? [bound.at, bound.id] : [] : [bound.id];
    const rows = await snapshotRows<Record<string, unknown>>(ctx, bound.epoch, fields, `SELECT ${columns}${snapshot ? ',' + NOW + ' AS snapshot_at' : ''} FROM {${table}}${table === 'prizes' ? ' INDEXED BY {prize_live}' : ''} WHERE bot_id=? AND ${condition}${table === 'prizes' ? ' AND deleted=0' : ''}${kind ? " AND json_extract(rules,'$.kind')=?" : ''}
        ORDER BY ${chronological ? 'created_at DESC,' : ''}${key} ${chronological ? 'DESC' : 'ASC'} LIMIT 21`, [ctx.botId, ...params, ...kind ? [kind] : []], revisionColumn);
    rows.sort((a, b) => chronological ? newest({ id: a[key] as string, list_time: a.created_at as number }, { id: b[key] as string, list_time: b.created_at as number }) : binary(a[key] as string, b[key] as string));

    if (snapshot && rows.length) {
        bound.upper = integer(rows[0]!.snapshot_at, 0, 8_640_000_000_000_000);
        rows.forEach(row => { delete row.snapshot_at; });
    }

    if (table === 'prizes') { rows.forEach(row => { row.bound = row.bound === 1; }); }

    const more = rows.length > 20;
    rows.length = Math.min(rows.length, 20);
    const last = rows.at(-1);
    const next = more && last ? await seal(control.cursor_secret,
        { ...bound, id: last[key] as string, at: chronological ? last.created_at as number : 0 }) : null;

    return { rows, next };
}
