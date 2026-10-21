import { eventKey } from '../storage/events.js';
import type { Session } from '@qqbot/sdk';
import type { Ctx, Draw, DrawBody, Kind, Pool, Rules } from '../contracts.js';
import { MINUTE, SOURCE } from '../contracts.js';
import { atomic, beijing, ensure, failure, LIVE, NOW, sql } from '../storage/db.js';
import { prepareDebit, wallet } from '../points/operations.js';
import { access } from '../access.js';
import { validateRules } from './rules.js';

export function capacity(botId: string): { sql: string; params: unknown[] } {
    return sql(`NOT EXISTS(SELECT 1 FROM {draws} WHERE bot_id=? AND ${LIVE} AND
            (state='NEEDS_REVIEW' OR expires_at<=${NOW}+1200000 OR (retry_at<=${NOW} AND lease_until<=${NOW})))
        AND (SELECT COUNT(*) FROM {draws} WHERE bot_id=? AND ${LIVE}) <
            (SELECT json_extract(settings,'$.maxInflight') FROM {schema_meta} WHERE bot_id=?)
        AND NOT EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND state='PENDING' AND expires_at<${NOW}-1200000)
        AND NOT EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND details IS NOT NULL AND purge_at<${NOW}-7200000)
        AND EXISTS(SELECT 1 FROM {schema_meta} WHERE bot_id=? AND heartbeat>${NOW}-1200000 AND last_error IS NULL
            AND facts_count<json_extract(settings,'$.maxFacts') AND pending_bytes<json_extract(settings,'$.maxPendingBytes'))`,
        botId, botId, botId, botId, botId, botId) as { sql: string; params: unknown[] };
}

export async function admit(ctx: Ctx, session: Session, kind: Kind, poolId: string, count: number): Promise<Draw> {
    const key = eventKey(session);
    const existing = await ctx.db.first<Draw>('SELECT * FROM {draws} WHERE bot_id=? AND event_key=?', ctx.botId, key);

    if (existing) {
        return existing;
    }

    const control = await access(ctx);
    const id = crypto.randomUUID();
    const short = 'D' + id.replaceAll('-', '');
    const created = Date.now();
    const pool = await ctx.db.first<Pool>('SELECT * FROM {pools} WHERE bot_id=? AND id=?', ctx.botId, poolId);
    let rules: Rules;

    try {
        ensure(control.admission_enabled === 1, 'ADMISSION_CLOSED');
        ensure(pool?.state === 'ACTIVE', 'POOL_CLOSED');
        rules = validateRules(JSON.parse(pool.rules));
        ensure(rules.kind === kind && Number.isInteger(count) && count === 1);
        ensure(created >= rules.starts && created < rules.ends, 'POOL_CLOSED');
        const check = await wallet(ctx).checkAccounts({ source: SOURCE, userIds: [session.userId] });

        if (!check.ok && ['SOURCE_NOT_REGISTERED', 'SOURCE_DISABLED', 'SOURCE_NOT_ALLOWED'].includes(check.code)) {
            await ctx.db.run(`UPDATE {schema_meta} SET admission_enabled=0,admission_revision=admission_revision+1,version=version+1
                WHERE bot_id=?`, ctx.botId);
        }

        ensure(check.ok, check.ok ? '' : check.code);
        ensure(check.data.accounts.some(item => item.userId === session.userId && item.exists), 'ACCOUNT_NOT_FOUND');
    } catch (error) {
        return reject(ctx, session, key, id, short, created, kind, poolId, failure(error).code);
    }

    const cost = rules.cost * count;
    const payload: DrawBody = { rules, inventoryConflicts: 0, ops: [prepareDebit(id, session.userId, cost)] };
    const cap = capacity(ctx.botId);
    const condition = sql(`EXISTS(SELECT 1 FROM {schema_meta} WHERE bot_id=? AND state='READY' AND schema_version=1
            AND admission_enabled=1 AND admission_revision=?)
        AND EXISTS(SELECT 1 FROM {pools} WHERE bot_id=? AND id=? AND state='ACTIVE' AND version=?
            AND json_extract(rules,'$.starts')<=${NOW} AND json_extract(rules,'$.ends')>${NOW}) AND (${cap.sql})
        AND (?=0 OR (SELECT COUNT(*) FROM {draws} WHERE bot_id=? AND pool_id=? AND qualifies=1)<?)
        AND (?=0 OR (SELECT COUNT(*) FROM {draws} WHERE bot_id=? AND pool_id=? AND user_id=? AND qualifies=1)<?)
        AND (?=0 OR (SELECT COUNT(*) FROM {draws} WHERE bot_id=? AND pool_id=? AND user_id=? AND business_day=? AND qualifies=1)<?)
        AND (?='ALLOW' OR NOT EXISTS(SELECT 1 FROM {draws} WHERE bot_id=? AND pool_id=? AND user_id=? AND winner=1))`,
        ctx.botId, control.admission_revision, ctx.botId, poolId, pool!.version, ...cap.params,
        rules.totalLimit, ctx.botId, poolId, rules.totalLimit, rules.userLimit, ctx.botId, poolId, session.userId, rules.userLimit,
        rules.dailyLimit, ctx.botId, poolId, session.userId, beijing(created), rules.dailyLimit,
        rules.repeat, ctx.botId, poolId, session.userId);

    try {
        await atomic(ctx, condition, [sql(`INSERT INTO {draws}(bot_id,id,short_id,user_id,scene,target,event_key,kind,pool_id,
            config_version,admission_revision,business_day,created_at,count,cost,state,qualifies,retry_at,expires_at,body)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'CREATED',1,?,?,?)`, ctx.botId, id, short, session.userId, session.scene,
            session.targetId, key, kind, poolId, pool!.version, control.admission_revision, beijing(created), created, count, cost,
            created, created + 60 * MINUTE, JSON.stringify(payload))]);
    } catch (error) {
        const found = await ctx.db.first<Draw>('SELECT * FROM {draws} WHERE bot_id=? AND event_key=?', ctx.botId, key);

        if (found) {
            return found;
        }

        return reject(ctx, session, key, id, short, created, kind, poolId, failure(error).code === 'CONFLICT' ? 'ADMISSION_LIMIT' : 'UNAVAILABLE');
    }

    return (await ctx.db.first<Draw>('SELECT * FROM {draws} WHERE bot_id=? AND id=?', ctx.botId, id))!;
}

async function reject(ctx: Ctx, session: Session, key: string, id: string, short: string, created: number,
    kind: Kind, poolId: string, code: string): Promise<Draw> {
    await ctx.db.run(`INSERT INTO {draws}(bot_id,id,short_id,user_id,scene,target,event_key,kind,pool_id,config_version,
        admission_revision,business_day,created_at,count,cost,state,error) VALUES(?,?,?,?,?,?,?,?,?,0,0,?,?,0,0,'FAILED',?)
        ON CONFLICT(bot_id,event_key) DO NOTHING`, ctx.botId, id, short, session.userId, session.scene, session.targetId,
        key, kind, poolId, beijing(created), created, code);

    return (await ctx.db.first<Draw>('SELECT * FROM {draws} WHERE bot_id=? AND event_key=?', ctx.botId, key))!;
}
