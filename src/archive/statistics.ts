import { claimSource } from '../storage/claims.js';
import type { Ctx } from '../contracts.js';
import { CLAIM_STATES, DAY } from '../contracts.js';
import { ensure, integer, text, sql } from '../storage/db.js';
import { FAMILIES, merge } from './metrics.js';
import type { Bucket } from './metrics.js';

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

const day = (at: string) => `strftime('%Y-%m-%d',${at}/1000+28800,'unixepoch')`;

function aggregate(ctx: Ctx, query: StatisticsQuery) {
    const claims = query.family === 'claimEvents' || query.family === 'claimStates';
    const participation = query.family === 'participation';
    const conditions = ['1=1'];
    const filters: unknown[] = [];

    for (const [key, column] of [['user', 'user_id'], ['pool', 'pool_id'], ['state', 'state']] as const) {
        if (query[key]) {
            conditions.push(`${column}=?`);
            filters.push(query[key]);
        }
    }

    if (claims) {
        conditions.push('obtained_at IS NOT NULL');

        if (query.prize) {
            conditions.push('prize_id=?');
            filters.push(query.prize);
        }
    } else {
        if (query.kind) {
            conditions.push('kind=?');
            filters.push(query.kind);
        }

        conditions.push(participation ? "kind='POOL' AND qualifies=1" : "state='SETTLED'");

        for (const [key, column] of [['prize', 'result_prize_id'], ['award', 'result_award_id']] as const) {
            if (query[key]) {
                conditions.push(`${column}=?`);
                filters.push(query[key]);
            }
        }
    }

    const columns = claims ? 'user_id,pool_id,prize_id,state,obtained_at,fulfilled_at,cancelled_at'
        : 'user_id,qualifies,pool_id,kind,state,cost,reward,winner,business_day,settled_at,result_award_id,result_prize_id';

    const params: unknown[] = [];
    const scans: string[] = [];
    let overflow: string;
    let candidates: string | undefined;
    let budget: string | undefined;
    const direct = !participation && !query.pool && !query.prize && !query.award && (!query.kind || claims)
        && (!query.user || query.family === 'claimStates') && (!query.state || !claims && query.state === 'SETTLED');
    const scanLimit = direct ? 501 : 1001;

    if (query.family === 'claimEvents') {
        const events = ['obtained', 'fulfilled', 'cancelled'];
        const range = (event: string) => `FROM ${claimSource('claim_' + event)} WHERE bot_id=? AND ${event}_at IS NOT NULL AND ${event}_at>=? AND ${event}_at<?`;
        const exceeded = events.map(event => `(SELECT COUNT(*) FROM (SELECT 1 ${range(event)} LIMIT ${scanLimit}))>${scanLimit - 1}`).join(' OR ');
        scans.push(`range_budget AS MATERIALIZED (SELECT (${exceeded}) AS overflow)`);
        params.push(...events.flatMap(() => [ctx.botId, query.from, query.to]));

        for (const event of events) {
            scans.push(`range_${event} AS MATERIALIZED (SELECT id ${range(event)} LIMIT (SELECT CASE WHEN overflow THEN 0 ELSE ${scanLimit} END FROM range_budget))`);
            params.push(ctx.botId, query.from, query.to);
        }

        scans.push(`scan AS MATERIALIZED (SELECT id,${columns} FROM ${claimSource('claim_identity')} WHERE bot_id=? AND (SELECT overflow=0 FROM range_budget) AND id IN
            (SELECT id FROM range_obtained UNION SELECT id FROM range_fulfilled UNION SELECT id FROM range_cancelled${direct ? ' LIMIT 501' : ''}))`);
        params.push(ctx.botId);
        overflow = '(SELECT overflow FROM range_budget)';
    } else {
        const at = claims ? 'obtained_at' : participation ? 'created_at' : 'settled_at';
        const index = claims ? query.user ? 'claim_user' : 'claim_obtained' : participation ? 'draw_time' : 'draw_settled';
        const base = ['bot_id=?'];
        params.push(ctx.botId);

        if (claims) {
            base.push('obtained_at IS NOT NULL');

            if (query.user) {
                base.push('user_id=?');
                params.push(query.user);
            }
        } else {
            if (participation) { base.push('count>0'); } else { base.push("state='SETTLED'"); }

            base.push(`${at}>=? AND ${at}<?`);
            params.push(query.from, query.to);
        }

        const source = `FROM ${claims ? claimSource(index) : '{draws} INDEXED BY {' + index + '}'} WHERE ${base.join(' AND ')}`;
        const range = `SELECT ${columns} ${source}`;

        if (direct) {
            budget = `budget AS MATERIALIZED (SELECT COUNT(*) AS scanned,0 AS overflow,
                ${claims ? "COALESCE(SUM(state NOT IN ('LOCKED','PENDING','FULFILLED','CANCELLED')),0)" : '0'} AS invalid
                FROM (SELECT ${claims ? 'state' : '1'} ${source} LIMIT 501))`;
            scans.push(budget);
            candidates = `candidates AS NOT MATERIALIZED (${range} LIMIT (SELECT CASE WHEN scanned>500 OR invalid>0 THEN 0 ELSE 500 END FROM budget))`;
            // 预算和明细绑定同一组范围参数，由同一条SQL读取同一快照。
            params.push(...params);
            overflow = '0';
        } else {
            scans.push(`range_budget AS MATERIALIZED (SELECT COUNT(*)>${scanLimit - 1} AS overflow FROM (SELECT 1 ${source} LIMIT ${scanLimit}))`);
            candidates = `candidates AS MATERIALIZED (${range} AND ${conditions.join(' AND ')} LIMIT (SELECT CASE WHEN overflow THEN 0 ELSE 501 END FROM range_budget))`;
            params.push(...params, ...filters);
            overflow = '(SELECT overflow FROM range_budget)';
        }
    }

    if (!candidates) { params.push(...filters); }

    let rows: string;
    let values: string[];

    switch (query.family) {
        case 'transactions':
            rows = `SELECT ${day('settled_at')} AS day,kind,pool_id AS pool,'' AS award,'' AS prize,'' AS event,cost,reward,winner FROM candidates`;
            values = ['COUNT(*) AS commands', 'SUM(winner) AS wins', 'SUM(cost) AS cost', 'SUM(reward) AS reward', 'SUM(cost-reward) AS net'];
            break;
        case 'awards':
            rows = `SELECT ${day('settled_at')} AS day,kind,pool_id AS pool,result_award_id AS award,COALESCE(result_prize_id,'') AS prize,'' AS event,reward FROM candidates`;
            values = ['COUNT(*) AS hits', 'SUM(reward) AS reward'];
            break;
        case 'participation':
            rows = "SELECT business_day AS day,kind,pool_id AS pool,'' AS award,'' AS prize,'' AS event,state FROM candidates";
            values = ["SUM(CASE WHEN state='SETTLED' THEN 1 ELSE 0 END) AS participations", "SUM(CASE WHEN state='SETTLED' THEN 0 ELSE 1 END) AS pending"];
            break;
        case 'claimStates':
            rows = "SELECT '' AS day,'POOL' AS kind,pool_id AS pool,'' AS award,prize_id AS prize,state AS event FROM candidates";
            values = ['COUNT(*) AS count'];
            break;
        case 'claimEvents':
            rows = ['obtained', 'fulfilled', 'cancelled'].map(event => {
                params.push(query.from, query.to);

                return `SELECT ${day(event + '_at')} AS day,'POOL' AS kind,pool_id AS pool,'' AS award,prize_id AS prize,'${event}' AS event
                    FROM candidates WHERE ${event}_at>=? AND ${event}_at<?`;
            }).join(' UNION ALL ');
            values = ['COUNT(*) AS count'];
            break;
    }

    const amounts = values.map(value => {
        const [expression, alias] = value.split(' AS ');

        return `'${alias}',CAST(${expression} AS TEXT)`;
    });

    const label = `CASE ${Array.from({ length: 20 }, (_, index) =>
        `WHEN json_extract(p.rules,'$.awards[${index}].id')=k.award THEN COALESCE(NULLIF(json_extract(p.rules,'$.awards[${index}].label'),''),json_extract(p.rules,'$.awards[${index}].name'))`).join(' ')} END`;

    // 完整索引范围只探测候选上限；稀疏组合保留独立扫描预算，名称与聚合同属一个快照。
    scans.push(candidates ?? `candidates AS MATERIALIZED (SELECT ${columns} FROM scan WHERE ${conditions.join(' AND ')} LIMIT 501)`);

    if (!budget) {
        scans.push(`budget AS MATERIALIZED (SELECT COUNT(*) AS scanned,(${overflow}) AS overflow,
            ${claims ? "COALESCE(SUM(state NOT IN ('LOCKED','PENDING','FULFILLED','CANCELLED')),0)" : '0'} AS invalid FROM candidates)`);
    }

    return sql(`WITH ${scans.join(',')},
        events AS (${rows}),
        buckets AS MATERIALIZED (SELECT day,kind,pool,award,prize,event,json_object(${amounts.join(',')}) AS amounts
            FROM events WHERE (SELECT overflow=0 AND scanned<=500 FROM budget) GROUP BY day,kind,pool,award,prize,event),
        pool_labels AS MATERIALIZED (SELECT id,json_extract(rules,'$.name') AS name,rules FROM {pools}
            WHERE bot_id=? AND id IN (SELECT DISTINCT pool FROM buckets)),
        award_keys AS (SELECT DISTINCT pool,award FROM buckets WHERE award<>''),
        award_labels AS MATERIALIZED (SELECT k.pool,k.award,${label} AS label FROM award_keys k JOIN pool_labels p ON p.id=k.pool)
        SELECT m.data_revision AS revision,budget.*,
            CASE WHEN budget.scanned>0 AND budget.scanned<=500 AND budget.overflow=0 THEN (SELECT json_group_array(json_object('day',day,'kind',kind,'pool',pool,'award',award,'prize',prize,'event',event,'amounts',json(amounts))) FROM buckets) ELSE '[]' END AS buckets,
            CASE WHEN budget.scanned>0 AND budget.scanned<=500 AND budget.overflow=0 THEN (SELECT json_group_object(id,json_object('name',name,'awards',json((SELECT json_group_object(award,label)
                FROM award_labels a WHERE a.pool=pool_labels.id AND label IS NOT NULL)))) FROM pool_labels) ELSE '{}' END AS pools,
            CASE WHEN budget.scanned>0 AND budget.scanned<=500 AND budget.overflow=0 THEN (SELECT json_group_object(id,name) FROM {prizes} WHERE bot_id=? AND id IN (SELECT DISTINCT prize FROM buckets WHERE prize<>'')) ELSE '{}' END AS prizes
        FROM budget CROSS JOIN {schema_meta} m WHERE m.bot_id=?`,
        ...params, ctx.botId, ctx.botId, ctx.botId);
}

export function validateStatisticsQuery(query: StatisticsQuery): void {
    integer(query.from, 0, 8_640_000_000_000_000);
    integer(query.to, 0, 8_640_000_000_000_000);
    ensure(query.to > query.from && query.to - query.from <= 31 * DAY, 'QUERY_RANGE');
    ensure(FAMILIES.includes(query.family));

    for (const key of ['pool', 'kind', 'prize', 'award', 'user', 'state'] as const) {
        if (query[key] !== undefined) { text(query[key], 128); }
    }

    ensure(!query.kind || query.kind === 'POOL');
    const participation = query.family === 'participation';
    const claims = query.family === 'claimEvents' || query.family === 'claimStates';
    ensure(!participation || !query.prize && !query.award, 'FILTER_UNSUPPORTED');
    ensure(!claims || !query.award, 'FILTER_UNSUPPORTED');
    ensure(!claims || !query.state || CLAIM_STATES.includes(query.state as typeof CLAIM_STATES[number]));
}

export async function statistics(ctx: Ctx, query: StatisticsQuery) {
    validateStatisticsQuery(query);
    const statement = aggregate(ctx, query);
    const result = await ctx.db.first<{ revision: number; scanned: number; overflow: number; invalid: number; buckets: string; pools: string; prizes: string }>(statement.sql, ...statement.params!);
    ensure(result, 'UNAVAILABLE');
    ensure(!result.overflow && result.scanned <= 500, 'QUERY_WORK_LIMIT');
    ensure(result.invalid === 0, 'CLAIM_STATE');
    const rows = JSON.parse(result.buckets) as Array<Omit<Bucket, 'family' | 'values'> & { amounts: Bucket['values'] }>;
    const buckets: Bucket[] = rows.map(({ amounts, ...row }) => ({ ...row, family: query.family, values: amounts }));
    const pools = JSON.parse(result.pools) as Record<string, { name: string; awards: Record<string, string> }>;

    const names = { pools, prizes: JSON.parse(result.prizes) as Record<string, string> };

    return {
        complete: true, source: 'permanent' as const, query, buckets: merge(buckets), snapshot: result.revision,
        currentStateTime: query.family === 'claimStates' || query.family === 'participation' ? Date.now() : null, labels: names
    };
}
