import type { Route, RouteInput } from '@qqbot/sdk';
import type { Claim, Draw, Meta } from '../contracts.js';
import { CLAIM_FIELDS } from '../contracts.js';
import { ensure, failure, integer, LIVE, settings, text } from '../storage/db.js';
import { ready } from '../storage/schema.js';
import { access, requiredPermissions, requiredReadPermissions } from '../access.js';
import { catalog, page } from '../storage/pages.js';
import type { Filters } from '../storage/pages.js';
import { manage } from './service.js';
import { local, lookup } from './receipts.js';
import type { AdminRequest } from './receipts.js';
import { archived, readObject } from '../archive/jobs.js';
import type { Batch } from '../archive/jobs.js';
import { statistics } from '../archive/statistics.js';
import type { StatisticsQuery } from '../archive/statistics.js';
import { maintenance } from '../maintenance.js';
import { loadEditorTemplates, moduleName } from '../messages/templates/settings.js';
import { html } from '../ui/page.js';
import { labels } from './labels.js';

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status, headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
        }
    });
}

function route(method: Route['method'], path: string, handler: (input: RouteInput & { control?: Meta }) => Promise<Response>): Route {
    return {
        method, path, auth: 'admin', handler: async input => {
            if (!input.authenticated) { return json({ ok: false, code: 'UNAUTHORIZED' }, 401); }

            try {
                const control = path.startsWith('/api/') ? await ready(input.ctx, path !== '/api/state') : undefined;

                return await handler({ ...input, control });
            } catch (error) { return json(failure(error), 400); }
        }
    };
}

async function inputBody(request: Request): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader();
    ensure(reader, 'INVALID_ARGUMENT');
    const chunks: Uint8Array[] = [];
    let length = 0;

    try {
        while (true) {
            const part = await reader.read();

            if (part.done) { break; }

            length += part.value.length;
            ensure(length <= 24_000, 'REQUEST_TOO_LARGE');
            chunks.push(part.value);
        }
    } finally { await reader.cancel(); }

    const joined = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
    }

    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(joined));
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value));

    return value as Record<string, unknown>;
}

function filters(url: URL): Filters {
    const result: Filters = {};

    for (const key of ['user', 'pool', 'prize', 'kind', 'state'] as const) {
        const value = url.searchParams.get(key);

        if (value) { result[key] = text(value, 128); }
    }

    for (const key of ['from', 'to'] as const) {
        const value = url.searchParams.get(key);

        if (value) { result[key] = integer(Number(value), 0, 8_640_000_000_000_000); }
    }

    ensure(result.from === undefined || result.to === undefined || result.to > result.from, 'QUERY_RANGE');

    return result;
}

export const routes: Route[] = [
    route('GET', '/ui/', async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })),
    route('GET', '/api/state', async ({ ctx, control: initial }) => {
        const control = await access(ctx, initial);
        const queue = await ctx.db.all<{ state: string; count: number; earliest: number }>(`SELECT state,COUNT(*) AS count,MIN(expires_at) AS earliest
            FROM {draws} INDEXED BY {draw_mutex} WHERE bot_id=? AND ${LIVE} GROUP BY state`, ctx.botId);

        return json({
            ok: true, data: {
                version: control.version, admission: !!control.admission_enabled,
                missingPermissions: [
                    ...requiredPermissions.filter(name => !control.policy || !(JSON.parse(control.policy).operationPermissions ?? []).includes(name)),
                    ...requiredReadPermissions.filter(name => !control.policy || !(JSON.parse(control.policy).readPermissions ?? []).includes(name))
                ],
                admissionRevision: control.admission_revision, policy: control.policy ? JSON.parse(control.policy) : null,
                settings: settings(control), heartbeat: control.heartbeat,
                archiveDue: control.archive_due, error: control.last_error, facts: control.facts_count, logicalBytes: control.pending_bytes, queue
            }
        });
    }),
    route('GET', '/api/messages/:module', async ({ ctx, params, control }) => json({ ok: true, data: await loadEditorTemplates(ctx, moduleName(params.module), control) })),
    route('GET', '/api/pools', async ({ ctx, request, control }) => {
        const url = new URL(request.url);
        const view = url.searchParams.get('view') ?? 'all';
        ensure(['all', 'pools', 'prizes'].includes(view));
        const kind = url.searchParams.get('kind');
        ensure(kind === null || view === 'pools' && kind === 'POOL');
        const data: Record<string, unknown> = {};

        for (const table of ['pools', 'prizes'] as const) {
            if (view !== 'all' && view !== table) { continue; }

            const result = await catalog(ctx, table, url.searchParams.get('cursor') ?? undefined, kind ?? undefined, control);
            data[table] = result.rows;
            data[table + 'Next'] = result.next;
        }

        return json({ ok: true, data });
    }),
    ...(['draws', 'claims'] as const).map(table => route('GET', '/api/' + table, async ({ ctx, request, control }) => {
        const url = new URL(request.url);
        const result = await page(ctx, table, filters(url), 20, url.searchParams.get('cursor') ?? undefined, control);
        const draws = result.rows.filter((row): row is Draw & { list_time: number } => 'settled_at' in row);
        const names = await labels(ctx, draws.filter(row => !row.pool_name).map(row => row.pool_id));
        const rows = result.rows.map(row => {
            if ('obtained_at' in row) { return { ...row, award: null, awardName: row.award_name }; }

            return {
                ...row, body: null, poolName: row.pool_name || names.pools[row.pool_id]?.name || null,
                goodsNames: row.result_prize_id && row.result_name ? [row.result_name] : null
            };
        });

        return json({ ok: true, data: { ...result, rows } });
    })),
    route('GET', '/api/detail/:table/:id', async ({ ctx, params, request }) => {
        const table = params.table;
        ensure(table === 'draws' || table === 'claims');
        const id = text(params.id, 96);
        const publicId = table === 'draws' && /^D[0-9a-f]{32}$/i.test(id) ? id.slice(1).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toLowerCase() : null;
        const ids = publicId ? [id, publicId] : [id];
        const rejected = new URL(request.url).searchParams.get('rejected') === '1';
        ensure(!rejected || table === 'draws');
        const row = await ctx.db.first<Draw | Claim>(`SELECT ${table === 'claims' ? CLAIM_FIELDS.join(',') : '*'} FROM {${table}} WHERE bot_id=?
            AND id IN (${ids.map(() => '?').join(',')})${rejected ? " AND count=0 AND state='FAILED'" : ''} ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`, ctx.botId, ...ids, id);
        ensure(row, 'NOT_FOUND');
        const full = await archived(ctx, table, row);

        return json({ ok: true, data: full });
    }),
    route('GET', '/api/operations/:id', async ({ ctx, params }) => {
        const receipt = await lookup(ctx, params.id!);

        return json({
            ok: true, data: receipt ? {
                operationId: receipt.operation_id, action: receipt.action, target: receipt.target,
                state: receipt.state, outcome: receipt.outcome ? JSON.parse(receipt.outcome) : null
            } : null
        });
    }),
    route('POST', '/api/manage', async ({ ctx, request, control }) => {
        const value = await inputBody(request);
        const operation = value as unknown as AdminRequest;
        ensure(typeof operation.action === 'string' && typeof operation.target === 'string' && operation.params
            && typeof operation.params === 'object' && !Array.isArray(operation.params));
        let outcome;

        if (operation.action === 'maintenance' || operation.action === 'archive') {
            ensure(control, 'SCHEMA_NOT_READY');
            let newlyAccepted = false;
            outcome = await local(ctx, operation, async () => {
                ensure(operation.action !== 'archive' || settings(control).archiveEnabled, 'ARCHIVE_DISABLED');
                newlyAccepted = true;

                return {
                    guard: { sql: "EXISTS(SELECT 1 FROM {schema_meta} WHERE bot_id=? AND state='READY' AND version=?)", params: [ctx.botId, control.version] },
                    writes: [{ sql: `UPDATE {schema_meta} SET ${operation.action === 'archive' ? 'archive_requested' : 'maintenance_requested'}=1 WHERE bot_id=?`, params: [ctx.botId] }],
                    outcome: { ok: true, code: 'MAINTENANCE_ACCEPTED', target: operation.target, state: 'QUEUED' }
                };
            });

            if (outcome.ok && newlyAccepted) {
                // 受理收据先提交，重放不再次选择队列；中断后的请求由 Cron 继续
                try { await maintenance(ctx); } catch { /* 维护状态中保留故障与待处理标记 */ }
            }
        } else {
            outcome = await manage(ctx, operation, control);
        }

        return json({ operationId: operation.operationId, action: operation.action, target: operation.target, ...outcome });
    }),
    route('POST', '/api/statistics', async ({ ctx, request }) => json({
        ok: true,
        data: await statistics(ctx, await inputBody(request) as unknown as StatisticsQuery)
    })),
    route('GET', '/api/archives', async ({ ctx, request, control }) => json({
        ok: true,
        data: await catalog(ctx, 'archive_batches', new URL(request.url).searchParams.get('cursor') ?? undefined, undefined, control)
    })),
    route('GET', '/api/operations', async ({ ctx, request, control }) => json({
        ok: true,
        data: await catalog(ctx, 'admin_audit', new URL(request.url).searchParams.get('cursor') ?? undefined, undefined, control)
    })),
    route('GET', '/api/archives/:id', async ({ ctx, params }) => {
        const batch = await ctx.db.first<Pick<Batch, 'id' | 'object_key' | 'content_hash' | 'bytes'>>("SELECT id,object_key,content_hash,bytes FROM {archive_batches} WHERE bot_id=? AND id=? AND state IN ('COMMITTED','COMPACTED')", ctx.botId, params.id);
        ensure(batch, 'NOT_FOUND');

        return json({ ok: true, data: await readObject(ctx, batch) });
    })
];
