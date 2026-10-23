import { eventKey } from '../storage/events.js';
import type { Session } from '@qqbot/sdk';
import type { Ctx, Draw, Kind, Meta, Pool, Rules } from '../contracts.js';
import { MINUTE, SOURCE, SCHEMA, POOL_FIELDS, DRAW_LIST_FIELDS } from '../contracts.js';
import { atomic, beijing, ensure, failure, LIVE, meta, NOW, settings, splitPayload, sql } from '../storage/db.js';
import { claimColumns } from '../storage/claims.js';
import { wallet, accessFailure } from '../points/operations.js';
import { validateRules } from './rules.js';
import { prepareResult } from './results.js';

export function capacity(botId: string, admissionRevision?: number): { sql: string; params: unknown[] } {
    return sql(`EXISTS(SELECT 1 FROM {schema_meta} m WHERE m.bot_id=? AND m.state='READY' AND m.schema_version=${SCHEMA} AND m.capacity_deferred=0
        ${admissionRevision === undefined ? '' : 'AND m.admission_enabled=1 AND m.admission_revision=?'}
        AND m.facts_count<json_extract(m.settings,'$.maxFacts') AND m.pending_bytes<json_extract(m.settings,'$.maxPendingBytes')
        AND (SELECT COUNT(*) FROM {draws} INDEXED BY {draw_mutex} WHERE bot_id=m.bot_id AND ${LIVE})<json_extract(m.settings,'$.maxInflight')
        AND NOT EXISTS(SELECT 1 FROM {draws} INDEXED BY {draw_mutex} WHERE bot_id=m.bot_id AND ${LIVE} AND
            (state='NEEDS_REVIEW' OR expires_at<=${NOW}+1200000 OR (retry_at<=${NOW} AND lease_until<=${NOW}))))`,
        botId, ...admissionRevision === undefined ? [] : [admissionRevision]) as { sql: string; params: unknown[] };
}

// 租约凭据只随本次成功准入返回，不从数据库记录推断当前请求的所有权。
export type Admission = Draw & { ownedLease?: string };

const eventFields = [...new Set([...DRAW_LIST_FIELDS, 'archive_ready', 'snapshot', 'body', ...Object.values(claimColumns)])]
    .map(field => ['snapshot', 'body', 'claim_award'].includes(field)
        ? `CASE WHEN state IN ('SETTLED','FAILED','REFUNDED') THEN NULL ELSE ${field} END AS ${field}` : field).join(',');

function eventDraw(ctx: Ctx, key: string): Promise<Draw | null> {
    return ctx.db.first<Draw>(`SELECT ${eventFields} FROM {draws} WHERE bot_id=? AND event_key=?`, ctx.botId, key);
}

export function quota(botId: string, poolId: string, userId: string, day: string, rules: Rules) {
    const { totalLimit: total, userLimit: user, dailyLimit: daily } = rules;

    if (total) {
        return sql(`(SELECT COUNT(*)<? ${user ? 'AND COALESCE(SUM(user_id=?),0)<?' : ''}
            ${daily ? 'AND COALESCE(SUM(user_id=? AND business_day=?),0)<?' : ''}
            FROM (SELECT user_id,business_day FROM {draws} INDEXED BY {draw_quota}
                WHERE bot_id=? AND pool_id=? AND qualifies=1 LIMIT ?))`,
            total, ...user ? [userId, user] : [], ...daily ? [userId, day, daily] : [], botId, poolId, total);
    }

    if (user && daily) {
        return sql(`(SELECT COUNT(*)<? AND COALESCE(SUM(business_day=?),0)<?
            FROM (SELECT business_day FROM {draws} INDEXED BY {draw_quota}
                WHERE bot_id=? AND pool_id=? AND user_id=? AND qualifies=1 LIMIT ?))`, user, day, daily, botId, poolId, userId, user);
    }

    if (user || daily) {
        const limit = user || daily;

        return sql(`(SELECT COUNT(*) FROM (SELECT 1 FROM {draws} WHERE bot_id=? AND pool_id=? AND user_id=? AND qualifies=1
            ${daily ? 'AND business_day=?' : ''} LIMIT ?))<?`, botId, poolId, userId, ...daily ? [day] : [], limit, limit);
    }

    return null;
}

export async function admit(ctx: Ctx, session: Session, kind: Kind, poolId: string, count: number,
    options: { control?: Meta; holdLease?: boolean } = {}): Promise<Admission> {
    const key = eventKey(session);
    const initial = options.control ?? await meta(ctx);
    const existing = await eventDraw(ctx, key);

    if (existing) {
        return existing;
    }

    const id = crypto.randomUUID();
    const created = Date.now();
    let pool: (Pool & { already_won: number }) | null = null;
    let rules: Rules;
    let prepared: Awaited<ReturnType<typeof prepareResult>>;

    try {
        ensure(kind === 'POOL' && count === 1);
        pool = await ctx.db.first<Pool & { already_won: number }>(`SELECT ${POOL_FIELDS.join(',')},
            CASE WHEN json_extract(p.rules,'$.repeat')='ONCE_PER_POOL' THEN EXISTS(SELECT 1 FROM {pool_winners} w
                WHERE w.bot_id=p.bot_id AND w.pool_id=p.id AND w.user_id=?) ELSE 0 END AS already_won
            FROM {pools} p WHERE bot_id=? AND id=?`, session.userId, ctx.botId, poolId);
        ensure(pool?.state === 'ACTIVE', 'POOL_CLOSED');
        rules = validateRules(JSON.parse(pool.rules));
        ensure(rules.kind === kind);
        ensure(Date.now() >= rules.starts && Date.now() < rules.ends, 'POOL_CLOSED');
    } catch (error) {
        return reject(ctx, session, key, id, created, kind, poolId, failure(error).code);
    }

    if (settings(initial).paused) {
        return reject(ctx, session, key, id, created, kind, poolId, 'ADMISSION_CLOSED');
    }

    if (pool.already_won) { return reject(ctx, session, key, id, created, kind, poolId, 'ADMISSION_LIMIT'); }

    const control = initial;

    try {
        ensure(control.admission_enabled === 1, 'ADMISSION_CLOSED');
        const balance = await wallet(ctx).getBalance({ source: SOURCE, userId: session.userId });
        ensure(balance.ok, balance.ok ? '' : balance.code);
        ensure(balance.data.status === 'active', 'ACCOUNT_SUSPENDED');
        ensure(balance.data.availableMinor >= rules.cost * count, 'INSUFFICIENT_BALANCE');
        // 余额预检只提前拒绝；实际扣款仍原子校验余额，规则竞争仍由准入守卫拒绝。
        prepared = await prepareResult(ctx, rules, id, session.userId);
    } catch (error) {
        const code = failure(error).code;

        for (const write of accessFailure(ctx, code)) { await ctx.db.run(write.sql, ...write.params!); }

        return reject(ctx, session, key, id, created, kind, poolId, code);
    }

    const cost = rules.cost * count;
    const { payload, result } = prepared;
    const token = options.holdLease ? crypto.randomUUID() : null;
    const cap = capacity(ctx.botId, control.admission_revision);
    const retryAt = token ? created + 10 * MINUTE : 0;

    if (token) { payload.ops[0]!.attempts = 1; }

    const stored = splitPayload(payload);

    const checks = [...prepared.checks];

    const participation = quota(ctx.botId, poolId, session.userId, beijing(created), rules);

    if (participation) { checks.push(participation); }

    if (rules.repeat === 'ONCE_PER_POOL') {
        checks.push(sql('NOT EXISTS(SELECT 1 FROM {pool_winners} WHERE bot_id=? AND pool_id=? AND user_id=?)', ctx.botId, poolId, session.userId));
    }

    const condition = sql(`(${cap.sql}) AND EXISTS(SELECT 1 FROM {pools} WHERE bot_id=? AND id=? AND state='ACTIVE' AND version=?
            AND json_extract(rules,'$.starts')<=${NOW} AND json_extract(rules,'$.ends')>${NOW})
        ${checks.map(check => 'AND (' + check.sql + ')').join(' ')}`,
        ...cap.params, ctx.botId, poolId, pool!.version, ...checks.flatMap(check => check.params!));

    try {
        const results = await atomic<Draw>(ctx, condition, [sql(`INSERT INTO {draws}(bot_id,id,user_id,scene,target,event_key,kind,pool_id,
            config_version,admission_revision,business_day,created_at,count,cost,state,qualifies,retry_at,expires_at,body,pool_name,reward,award_ids,result_name,result_award_id,result_prize_id,lease_token,lease_until,
            snapshot,claim_id,claim_state,claim_stock_state,claim_prize_id,claim_award,claim_award_name,claim_created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CREATED',1,?,?,?,?,?,?,?,?,?,?,${token ? NOW + '+120000' : '0'},?,?,?,?,?,?,?,?) RETURNING *`, ctx.botId, id, session.userId, session.scene,
            session.targetId, key, kind, poolId, pool!.version, control.admission_revision, beijing(created), created, count, cost,
            retryAt, created + 60 * MINUTE, stored.body, rules.name, result.reward, JSON.stringify([result.id]), result.name, result.id, result.prizeId ?? null, token,
            stored.snapshot, payload.claimId ?? null, payload.claimId ? 'LOCKED' : null, payload.claimId ? 'RESERVED' : null,
            result.prizeId ?? null, payload.claimId ? JSON.stringify(result) : null, payload.claimId ? result.name : null, payload.claimId ? created : null), ...prepared.writes], true);
        const row = results[1]!.results[0];
        ensure(row, 'ADMISSION_EVIDENCE_MISSING');

        return token ? { ...row, ownedLease: token } : row;
    } catch (error) {
        const found = await eventDraw(ctx, key);

        if (found) {
            return token && found.id === id && found.lease_token === token ? { ...found, ownedLease: token } : found;
        }

        const code = failure(error).code === 'CONFLICT' ? 'ADMISSION_LIMIT' : 'UNAVAILABLE';

        return reject(ctx, session, key, id, created, kind, poolId, code);
    }
}

async function reject(ctx: Ctx, session: Session, key: string, id: string, created: number,
    kind: Kind, poolId: string, code: string): Promise<Draw> {
    const inserted = await ctx.db.first<Draw>(`INSERT INTO {draws}(bot_id,id,user_id,scene,target,event_key,kind,pool_id,config_version,
        admission_revision,business_day,created_at,count,cost,state,error) VALUES(?,?,?,?,?,?,?,?,0,0,?,?,0,0,'FAILED',?)
        ON CONFLICT(bot_id,event_key) DO NOTHING RETURNING *`, ctx.botId, id, session.userId, session.scene, session.targetId,
        key, kind, poolId, beijing(created), created, code);

    return inserted ?? (await eventDraw(ctx, key))!;
}
