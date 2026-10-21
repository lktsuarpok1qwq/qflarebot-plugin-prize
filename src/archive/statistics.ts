import type { DBStatement } from '@qqbot/sdk';
import type { Claim, Ctx, Draw } from '../contracts.js';
import { DAY } from '../contracts.js';
import { ensure, beijing, integer, text, sql } from '../storage/db.js';
import { contributions, FAMILY_MASK, merge, participation } from './metrics.js';
import type { Bucket } from './metrics.js';
import { readObject } from './jobs.js';
import type { Batch } from './jobs.js';

export interface StatisticsQuery {
    from: number;
    to: number;
    family: Bucket['family'];
    pool?: string;
    kind?: string;
    prize?: string;
    award?: string;
    user?: string;
    state?: string;
}

function records(ctx: Ctx, query: StatisticsQuery, table: 'draws' | 'claims', detailed: boolean): DBStatement {
    const isParticipation = query.family === 'participation';
    const conditions = ['bot_id=?'];
    const params: unknown[] = [ctx.botId];
    const order = table === 'claims' ? 'obtained_at' : isParticipation ? 'created_at' : 'settled_at';
    const add = (condition: string, ...values: unknown[]) => {
        conditions.push(condition);
        params.push(...values);
    };

    for (const [key, column] of [['user', 'user_id'], ['pool', 'pool_id'], ['state', 'state']] as const) {
        if (query[key]) { add(`${column}=?`, query[key]); }
    }

    if (!detailed && !isParticipation) { add('archive_id IS NULL'); }

    if (table === 'draws') {
        add(isParticipation ? "kind='POOL' AND qualifies=1" : "state='SETTLED'");
        const at = isParticipation ? 'created_at' : 'settled_at';
        add(`${at}>=? AND ${at}<?`, query.from, query.to);

        if (query.kind) { add('kind=?', query.kind); }

        if (query.prize) {
            add('EXISTS(SELECT 1 FROM {claims} c WHERE c.bot_id={draws}.bot_id AND c.draw_id={draws}.id AND c.prize_id=?)', query.prize);
        }

        if (query.award) { add('instr(award_ids,?)>0', JSON.stringify(query.award)); }
    } else {
        add('obtained_at IS NOT NULL');

        if (query.prize) { add('prize_id=?', query.prize); }

        if (query.kind) { add("?='POOL'", query.kind); }

        if (query.family !== 'claimStates') {
            const times = ['obtained_at', 'claimed_at', 'fulfilled_at', 'expired_at', 'cancelled_at'];
            add('(' + times.map(at => `(${at}>=? AND ${at}<?)`).join(' OR ') + ')', ...times.flatMap(() => [query.from, query.to]));
        }
    }

    // 参与资格只取永久事实，归档之后也不读取正文或 R2
    const columns = isParticipation ? 'id,kind,pool_id,business_day,state,qualifies' : '*';

    return sql(`SELECT ${columns} FROM {${table}} WHERE ${conditions.join(' AND ')} ORDER BY ${order},id LIMIT 501`, ...params);
}

function summaries(ctx: Ctx, query: StatisticsQuery): DBStatement {
    const conditions = ["bot_id=? AND state IN ('COMMITTED','COMPACTED') AND (family_mask & ?)>0"];
    const params: unknown[] = [ctx.botId, FAMILY_MASK[query.family]];

    if (query.family !== 'claimStates') {
        conditions.push('max_day>=? AND min_day<=?');
        params.push(beijing(query.from), beijing(query.to - 1));
    }

    for (const key of ['pool', 'kind', 'prize', 'award'] as const) {
        if (!query[key]) { continue; }

        conditions.push('instr(summary,?)>0');
        params.push(JSON.stringify(key) + ':' + JSON.stringify(query[key]));
    }

    return sql(`SELECT * FROM {archive_batches} WHERE ${conditions.join(' AND ')} ORDER BY created_at,id LIMIT 51`, ...params);
}

async function materialize<T extends Draw | Claim>(ctx: Ctx, table: 'draws' | 'claims', rows: T[]): Promise<T[]> {
    const needed = new Set(rows.map(row => row.archive_id).filter((id): id is string => !!id));
    ensure(needed.size <= 5, 'QUERY_WORK_LIMIT');
    let bytes = 0;
    const material = new Map<string, Awaited<ReturnType<typeof readObject>>>();

    for (const id of needed) {
        const batch = await ctx.db.first<Batch>("SELECT * FROM {archive_batches} WHERE bot_id=? AND id=? AND state IN ('COMMITTED','COMPACTED')", ctx.botId, id);
        ensure(batch, 'ARCHIVE_NOT_PUBLISHED');
        bytes += batch.bytes;
        ensure(bytes <= 320 * 1024, 'QUERY_WORK_LIMIT');
        material.set(id, await readObject(ctx, batch));
    }

    return rows.map(row => {
        const full = row.archive_id ? material.get(row.archive_id)![table].find(item => item.id === row.id && item.bot_id === ctx.botId) : row;
        ensure(full, 'ARCHIVE_MEMBER_MISSING');

        return full as T;
    });
}

export async function statistics(ctx: Ctx, query: StatisticsQuery) {
    integer(query.from, 0, 8_640_000_000_000_000);
    integer(query.to, 0, 8_640_000_000_000_000);
    ensure(query.to > query.from && query.to - query.from <= 31 * DAY, 'QUERY_RANGE');
    ensure(Object.hasOwn(FAMILY_MASK, query.family));

    for (const key of ['pool', 'kind', 'prize', 'award', 'user', 'state'] as const) {
        if (query[key] !== undefined) { text(query[key], 128); }
    }

    ensure(!query.kind || query.kind === 'POOL');
    const isParticipation = query.family === 'participation';
    const claimsFamily = query.family === 'claimEvents' || query.family === 'claimStates';
    ensure(!isParticipation || !query.prize && !query.award, 'FILTER_UNSUPPORTED');
    ensure(!claimsFamily || !query.award, 'FILTER_UNSUPPORTED');
    const table = claimsFamily ? 'claims' : 'draws';
    const exactDays = (query.from + 8 * 3_600_000) % DAY === 0 && (query.to + 8 * 3_600_000) % DAY === 0;
    const detailed = !!query.user || !!query.state || !exactDays || query.family === 'transactions' && (!!query.prize || !!query.award);
    const statements = [
        sql('SELECT data_revision FROM {schema_meta} WHERE bot_id=?', ctx.botId),
        records(ctx, query, table, detailed)
    ];

    if (!detailed && !isParticipation) { statements.push(summaries(ctx, query)); }

    const results = await ctx.db.batch<Record<string, unknown>>(statements);
    let rows = results[1]!.results as unknown as Array<Draw | Claim>;
    const batches = (results[2]?.results ?? []) as unknown as Batch[];
    ensure(rows.length <= 500 && batches.length <= 50, 'QUERY_WORK_LIMIT');

    if (detailed && !isParticipation) { rows = await materialize(ctx, table, rows); }

    let buckets = isParticipation ? participation(rows as Draw[])
        : contributions(table === 'draws' ? rows as Draw[] : [], table === 'claims' ? rows as Claim[] : [], { from: query.from, to: query.to });
    buckets.push(...batches.flatMap(batch => JSON.parse(batch.summary) as Bucket[]));
    buckets = buckets.filter(bucket => bucket.family === query.family && (claimsFamily && query.family === 'claimStates'
        || bucket.day >= beijing(query.from) && bucket.day <= beijing(query.to - 1))
        && (!query.pool || bucket.pool === query.pool) && (!query.kind || bucket.kind === query.kind)
        && (!query.prize || bucket.prize === query.prize || query.family === 'transactions' && detailed)
        && (!query.award || bucket.award === query.award || query.family === 'transactions' && detailed));
    const after = await ctx.db.first<{ data_revision: number }>('SELECT data_revision FROM {schema_meta} WHERE bot_id=?', ctx.botId);
    ensure(after?.data_revision === results[0]!.results[0]!.data_revision, 'QUERY_SNAPSHOT_CHANGED');

    return {
        complete: true, source: isParticipation ? 'permanent' : detailed ? 'details' : 'summary', query, buckets: merge(buckets),
        snapshot: after!.data_revision, currentStateTime: query.family === 'claimStates' || isParticipation ? Date.now() : null
    };
}
