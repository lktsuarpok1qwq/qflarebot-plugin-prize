import type { Ctx, Meta } from '../contracts.js';
import { CONTRACT, SCHEMA } from '../contracts.js';
import { ensure, Fault, meta, sql } from './db.js';
import { claimColumns, claimView } from './claims.js';

// 仅缓存当前实例已通过的结构探测；每个入口仍读取持久化阶段和版本。
const verified = new Set<string>();

export const statements = [
    `CREATE TABLE IF NOT EXISTS {guards}(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT prize_guard CHECK(ok=1))`,
    `CREATE TABLE IF NOT EXISTS {schema_meta}(bot_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,state TEXT NOT NULL,
        cursor_secret TEXT NOT NULL,facts_count INTEGER NOT NULL DEFAULT 0,pending_bytes INTEGER NOT NULL DEFAULT 0,capacity_deferred INTEGER NOT NULL DEFAULT 0 CHECK(capacity_deferred IN (0,1) AND pending_bytes>=0),data_revision INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,admission_enabled INTEGER NOT NULL DEFAULT 0,admission_revision INTEGER NOT NULL DEFAULT 0,
        policy TEXT,settings TEXT NOT NULL,heartbeat INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
        archive_due INTEGER NOT NULL DEFAULT 0,maintenance_requested INTEGER NOT NULL DEFAULT 0,archive_requested INTEGER NOT NULL DEFAULT 0,last_error TEXT)`,
    `CREATE TABLE IF NOT EXISTS {pools}(bot_id TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,
        rules TEXT NOT NULL,PRIMARY KEY(bot_id,id))`,
    `CREATE INDEX IF NOT EXISTS {pool_active} ON {pools}(bot_id,id) WHERE state='ACTIVE' AND json_extract(rules,'$.kind')='POOL'`,
    `CREATE TABLE IF NOT EXISTS {pool_prizes}(bot_id TEXT NOT NULL,pool_id TEXT NOT NULL,prize_id TEXT NOT NULL,PRIMARY KEY(bot_id,pool_id,prize_id))`,
    `CREATE INDEX IF NOT EXISTS {prize_binding} ON {pool_prizes}(bot_id,prize_id,pool_id)`,
    // pool_id 保留既有存储列；商品不归属奖池，新建写空值，绑定仅由规则 prizeId 表达。
    `CREATE TABLE IF NOT EXISTS {prizes}(bot_id TEXT NOT NULL,id TEXT NOT NULL,pool_id TEXT NOT NULL,name TEXT NOT NULL,
        stock_total INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,
        fulfilled INTEGER NOT NULL DEFAULT 0,retired INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bot_id,id),
        CHECK(stock_total>=0 AND stock_total<=9007199254740991 AND available>=0 AND reserved>=0 AND fulfilled>=0 AND retired>=0),
        CHECK(stock_total=available+reserved+fulfilled+retired))`,
    `CREATE INDEX IF NOT EXISTS {prize_live} ON {prizes}(bot_id,id) WHERE deleted=0`,
    `CREATE TABLE IF NOT EXISTS {draws}(bot_id TEXT NOT NULL,id TEXT NOT NULL,short_id TEXT GENERATED ALWAYS AS ('D'||replace(id,'-','')) VIRTUAL,user_id TEXT NOT NULL,
        scene TEXT NOT NULL,target TEXT NOT NULL,event_key TEXT NOT NULL,kind TEXT NOT NULL,pool_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,admission_revision INTEGER NOT NULL,business_day TEXT NOT NULL,created_at INTEGER NOT NULL,
        settled_at INTEGER,count INTEGER NOT NULL,cost INTEGER NOT NULL CHECK(cost>=0 AND cost<=1000000000000),
        reward INTEGER NOT NULL DEFAULT 0 CHECK(reward>=0 AND reward<=1000000000000),state TEXT NOT NULL,
        qualifies INTEGER NOT NULL DEFAULT 0,winner INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL DEFAULT 0,
        error TEXT,snapshot TEXT,body TEXT,award_ids TEXT NOT NULL DEFAULT '[]',pool_name TEXT NOT NULL DEFAULT '',
        result_name TEXT,result_award_id TEXT,result_prize_id TEXT,archive_id TEXT,archive_pending TEXT,archive_ready INTEGER NOT NULL DEFAULT 0 CHECK(archive_ready IN (0,1)),
        claim_id TEXT,claim_short_id TEXT GENERATED ALWAYS AS ('P'||replace(claim_id,'-','')) VIRTUAL,
        claim_prize_id TEXT,claim_award TEXT,claim_award_name TEXT,claim_created_at INTEGER,
        claim_list_time INTEGER GENERATED ALWAYS AS (COALESCE(claim_obtained_at,claim_processed_at,claim_created_at)) VIRTUAL,
        claim_state TEXT,claim_stock_state TEXT,claim_obtained_at INTEGER,claim_fulfilled_at INTEGER,claim_cancelled_at INTEGER,
        claim_processed_at INTEGER,claim_version INTEGER NOT NULL DEFAULT 0,claim_note TEXT,claim_admin_op TEXT,claim_archive_id TEXT,claim_archive_pending TEXT,
        CHECK((claim_id IS NULL)=(claim_state IS NULL)),
        PRIMARY KEY(bot_id,id),UNIQUE(bot_id,event_key),
        CONSTRAINT prize_draw_live CHECK((state NOT IN ('SETTLED','FAILED','REFUNDED'))=(qualifies=1 AND settled_at IS NULL))) WITHOUT ROWID`,
    `CREATE UNIQUE INDEX IF NOT EXISTS {draw_mutex} ON {draws}(bot_id,user_id,kind,pool_id)
        WHERE qualifies=1 AND settled_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS {draw_user} ON {draws}(bot_id,user_id,created_at,id) WHERE count>0`,
    `CREATE INDEX IF NOT EXISTS {draw_quota} ON {draws}(bot_id,pool_id,user_id,business_day) WHERE qualifies=1`,
    `CREATE INDEX IF NOT EXISTS {draw_rejected} ON {draws}(bot_id,state,created_at,id) WHERE count>0 AND state IN ('FAILED','REFUNDED')`,
    `CREATE INDEX IF NOT EXISTS {draw_time} ON {draws}(bot_id,created_at,id) WHERE count>0`,
    `CREATE INDEX IF NOT EXISTS {draw_settled} ON {draws}(bot_id,settled_at,id) WHERE state='SETTLED'`,
    `CREATE TABLE IF NOT EXISTS {pool_winners}(bot_id TEXT NOT NULL,pool_id TEXT NOT NULL,user_id TEXT NOT NULL,
        draw_id TEXT NOT NULL,PRIMARY KEY(bot_id,pool_id,user_id)) WITHOUT ROWID`,
    `CREATE TRIGGER IF NOT EXISTS {draw_winner_insert} AFTER INSERT ON {draws} WHEN NEW.winner=1 BEGIN
        INSERT OR IGNORE INTO {pool_winners}(bot_id,pool_id,user_id,draw_id) VALUES(NEW.bot_id,NEW.pool_id,NEW.user_id,NEW.id); END`,
    `CREATE TRIGGER IF NOT EXISTS {draw_winner_update} AFTER UPDATE OF winner ON {draws} WHEN NEW.winner=1 AND OLD.winner<>1 BEGIN
        INSERT OR IGNORE INTO {pool_winners}(bot_id,pool_id,user_id,draw_id) VALUES(NEW.bot_id,NEW.pool_id,NEW.user_id,NEW.id); END`,
    `CREATE INDEX IF NOT EXISTS {draw_archive} ON {draws}(bot_id,COALESCE(settled_at,created_at),id)
        WHERE archive_ready=1 AND archive_id IS NULL AND archive_pending IS NULL AND state IN ('SETTLED','FAILED','REFUNDED') AND body IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS {claim_identity} ON {draws}(bot_id,claim_id) WHERE claim_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS {claim_obtained} ON {draws}(bot_id,claim_obtained_at,claim_id) WHERE claim_id IS NOT NULL AND claim_obtained_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS {claim_fulfilled} ON {draws}(bot_id,claim_fulfilled_at,claim_id) WHERE claim_id IS NOT NULL AND claim_fulfilled_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS {claim_cancelled} ON {draws}(bot_id,claim_cancelled_at,claim_id) WHERE claim_id IS NOT NULL AND claim_cancelled_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS {claim_user} ON {draws}(bot_id,user_id,claim_obtained_at,claim_id) WHERE claim_id IS NOT NULL AND claim_obtained_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS {claim_archive} ON {draws}(bot_id,COALESCE(claim_obtained_at,claim_processed_at),claim_id)
        WHERE claim_id IS NOT NULL AND claim_archive_id IS NULL AND claim_archive_pending IS NULL AND claim_state IN ('FULFILLED','CANCELLED') AND claim_award IS NOT NULL`,
    claimView,
    `CREATE TABLE IF NOT EXISTS {admin_audit}(bot_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,
        action TEXT NOT NULL,target TEXT NOT NULL,input TEXT,state TEXT NOT NULL,outcome TEXT,created_at INTEGER NOT NULL,
        archive_id TEXT,archive_pending TEXT,PRIMARY KEY(bot_id,operation_id)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS {audit_directory} ON {admin_audit}(bot_id,created_at,operation_id)`,
    `CREATE INDEX IF NOT EXISTS {audit_archive} ON {admin_audit}(bot_id,created_at,operation_id)
        WHERE archive_id IS NULL AND archive_pending IS NULL AND state='DONE' AND input IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS {archive_batches}(bot_id TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,
        members TEXT NOT NULL,object_key TEXT,content_hash TEXT,payload TEXT,bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bot_id,id))`,
    `CREATE INDEX IF NOT EXISTS {archive_directory} ON {archive_batches}(bot_id,created_at,id)`,
    `CREATE INDEX IF NOT EXISTS {archive_pending} ON {archive_batches}(bot_id,created_at,id) WHERE state<>'COMPACTED'`
];

const bytes = (alias: string) => ['snapshot', 'body', 'claim_award'].map(column => `COALESCE(length(CAST(${alias}.${column} AS BLOB)),0)`).join('+');
const changed = ['snapshot', 'body', 'claim_award', 'state', 'reward', 'winner', 'qualifies', 'settled_at', 'result_name', 'result_award_id', 'result_prize_id',
    'claim_state', 'claim_obtained_at', 'claim_fulfilled_at', 'claim_cancelled_at', 'claim_note'];

export const capacityStatements = [
    `CREATE TRIGGER IF NOT EXISTS {draws_capacity_insert} AFTER INSERT ON {draws} BEGIN
        UPDATE {schema_meta} SET facts_count=facts_count+1+(NEW.claim_id IS NOT NULL),pending_bytes=pending_bytes+(${bytes('NEW')}),
            data_revision=data_revision+1 WHERE bot_id=NEW.bot_id; END`,
    `CREATE TRIGGER IF NOT EXISTS {draws_capacity_update} AFTER UPDATE OF ${changed.join(',')} ON {draws}
        WHEN ${changed.map(column => `NEW.${column} IS NOT OLD.${column}`).join(' OR ')} BEGIN
        UPDATE {schema_meta} SET pending_bytes=pending_bytes+(${bytes('NEW')})-(${bytes('OLD')}),data_revision=data_revision+1
            WHERE bot_id=NEW.bot_id AND capacity_deferred=0; END`,
    ...[['admin_audit', 'input'], ['archive_batches', 'payload']].flatMap(([table, column]) => [
        `CREATE TRIGGER IF NOT EXISTS {${table}_capacity_insert} AFTER INSERT ON {${table}} BEGIN
            UPDATE {schema_meta} SET facts_count=facts_count+1,pending_bytes=pending_bytes+COALESCE(length(CAST(NEW.${column} AS BLOB)),0),
                data_revision=data_revision+1 WHERE bot_id=NEW.bot_id; END`,
        `CREATE TRIGGER IF NOT EXISTS {${table}_capacity_update} AFTER UPDATE OF ${column} ON {${table}}
            WHEN NEW.${column} IS NOT OLD.${column} BEGIN
            UPDATE {schema_meta} SET pending_bytes=pending_bytes+COALESCE(length(CAST(NEW.${column} AS BLOB)),0)
                -COALESCE(length(CAST(OLD.${column} AS BLOB)),0),data_revision=data_revision+1 WHERE bot_id=NEW.bot_id AND capacity_deferred=0; END`
    ])
];

const deferredDefinition = (value: string) => /CREATE INDEX IF NOT EXISTS \{(?:pool_active|prize_live)\}|CREATE TRIGGER IF NOT EXISTS \{draw_winner_(?:insert|update)\}/.test(value);

async function verify(ctx: Ctx, readOnly = false): Promise<void> {
    const tables = statements.filter(statement => statement.startsWith('CREATE TABLE'));
    const indexes = statements.filter(statement => /CREATE (UNIQUE )?INDEX/.test(statement));
    const probes = tables.map(statement => {
        const table = /\{(\w+)\}/.exec(statement)![1]!;
        const columns = [...statement.matchAll(/\b(\w+)\s+(?:TEXT|INTEGER)\b(?! GENERATED)/g)].map(match => match[1]);
        const keys = [...statement.matchAll(/(?:PRIMARY KEY|UNIQUE)\(([^)]+)\)/g)].map(match => match[1]);
        const inline = /\b(\w+)\s+(?:TEXT|INTEGER) PRIMARY KEY\b/.exec(statement);

        if (inline) { keys.push(inline[1]); }

        const conflicts = keys.map(key => `ON CONFLICT(${key}) DO NOTHING`);

        for (const index of indexes.filter(value => value.startsWith('CREATE UNIQUE') && value.includes(`ON {${table}}`))) {
            const target = /ON \{\w+\}(\([^)]+\))\s*(WHERE[\s\S]+)?/.exec(index)!;
            conflicts.push(`ON CONFLICT${target[1]} ${target[2] ?? ''} DO NOTHING`);
        }

        // 零行 UPSERT 由数据库编译核验全部必需列及唯一冲突目标，不写探测业务数据
        return sql(`INSERT INTO {${table}}(${columns.join(',')}) SELECT ${columns.join(',')} FROM {${table}}
            WHERE 0 ${conflicts.join(' ')}`);
    });

    try {
        await ctx.db.batch([
            ...readOnly ? probes.filter(probe => /INSERT INTO \{draws\}/.test(probe.sql)) : probes,
            sql('INSERT INTO {guards}(id,ok) VALUES(?,0)', ctx.botId),
            // 若 CHECK 缺失，下一条仍强制整批回滚，不能留下探测行。
            sql("SELECT json('')")
        ]);
        throw new Fault('SCHEMA_UNSUPPORTED');
    } catch (error) {
        if (!/prize_guard/i.test(String(error))) {
            if (/malformed JSON|CHECK constraint failed|UNIQUE constraint failed:.*guards/i.test(String(error))) { throw new Fault('SCHEMA_UNSUPPORTED'); }

            throw error;
        }
    }

    try {
        // 故意违反非终态资格约束；约束缺失时下一句仍保证整批回滚，不留下业务探测行。
        await ctx.db.batch([
            sql(`INSERT INTO {draws}(bot_id,id,user_id,scene,target,event_key,kind,pool_id,config_version,admission_revision,
                business_day,created_at,count,cost,state,qualifies,settled_at)
                VALUES(?,?,'','c2c','',?,'POOL','',0,0,'',0,1,0,'CREATED',0,NULL)`, ctx.botId, crypto.randomUUID(), crypto.randomUUID()),
            sql("SELECT json('')")
        ]);
        throw new Fault('SCHEMA_UNSUPPORTED');
    } catch (error) {
        if (!/prize_draw_live/i.test(String(error))) {
            if (/malformed JSON|CHECK constraint failed|UNIQUE constraint failed|NOT NULL constraint failed/i.test(String(error))) { throw new Fault('SCHEMA_UNSUPPORTED'); }

            throw error;
        }
    }

    const selections = indexes.map((statement, i) => {
        const index = /INDEX IF NOT EXISTS (\{\w+\}) ON (\{\w+\})/.exec(statement)!;
        const condition = /\bWHERE ([\s\S]+)/.exec(statement)?.[1];

        return `(SELECT 1 FROM ${index[2]} INDEXED BY ${index[1]} ${condition ? 'WHERE ' + condition : ''} LIMIT 0) AS i${i}`;
    });
    const columns = tables.map((statement, i) => {
        const table = /\{(\w+)\}/.exec(statement)![1]!;
        const names = [...statement.matchAll(/\b(\w+)\s+(?:TEXT|INTEGER)\b/g)].map(match => match[1]);

        return `(SELECT 1 FROM (SELECT ${names.join(',')} FROM {${table}} LIMIT 0)) AS t${i}`;
    });
    await ctx.db.first(`SELECT ${[...columns, ...selections].join(',')},(SELECT 1 FROM (SELECT ${Object.keys(claimColumns).join(',')},purchase_state FROM {claims} LIMIT 0)) AS claims_view`);
}

export async function install(ctx: Ctx): Promise<void> {
    try {
        const existing = await ctx.db.first<{ schema_version: number }>('SELECT schema_version FROM {schema_meta} WHERE bot_id=?', ctx.botId);
        ensure(!existing || existing.schema_version === SCHEMA, 'SCHEMA_UNSUPPORTED');

        if (existing) { return; }
    } catch (error) {
        if (!/no such table:.*schema_meta/i.test(String(error))) { throw error; }
    }

    await seed(ctx);
}

async function seed(ctx: Ctx): Promise<void> {
    await ctx.db.exec(statements[1]!);
    await ctx.db.run(`INSERT INTO {schema_meta}(bot_id,schema_version,state,settings,cursor_secret) VALUES(?,${SCHEMA},'INITIALIZING',?,?)
        ON CONFLICT(bot_id) DO NOTHING`, ctx.botId, JSON.stringify({
        paused: false, archiveEnabled: false, retentionMonths: 1, maxInflight: 1,
        maxFacts: 100000, maxPendingBytes: 10_000_000
    }), crypto.randomUUID() + crypto.randomUUID());
}

export async function initialize(ctx: Ctx): Promise<'VERIFYING' | 'READY'> {
    let existing: { schema_version: number; state: string } | null = null;

    try {
        existing = await ctx.db.first('SELECT schema_version,state FROM {schema_meta} WHERE bot_id=?', ctx.botId);
    } catch (error) {
        if (!/no such table:.*schema_meta/i.test(String(error))) { throw error; }
    }

    ensure(!existing || existing.schema_version === SCHEMA && ['READY', 'INITIALIZING', 'VERIFYING', 'UNSUPPORTED'].includes(existing.state), 'SCHEMA_UNSUPPORTED');

    if (existing && existing.state !== 'INITIALIZING') {
        await verifyReady(ctx, false, existing.state === 'VERIFYING');

        return 'READY';
    }

    // 先登记初始化状态，未完成的结构不能作为 READY 对外使用
    if (!existing) { await seed(ctx); }

    for (const statement of statements.filter(value => value !== statements[1] && !deferredDefinition(value))) {
        await ctx.db.exec(statement);
    }

    for (const statement of capacityStatements) { await ctx.db.exec(statement); }

    await ctx.db.run(`UPDATE {schema_meta} SET state='VERIFYING' WHERE bot_id=? AND schema_version=${SCHEMA} AND state='INITIALIZING'`, ctx.botId);

    return 'VERIFYING';
}

// 返回本次已核验的控制快照；READY 冷实例探测列、索引和业务互斥约束。
export async function ready(ctx: Ctx, deferBusiness = false): Promise<Meta> {
    let control: Meta;

    try {
        control = await meta(ctx);
    } catch (error) {
        if (!(error instanceof Fault) || !['SCHEMA_NOT_READY', 'SCHEMA_INITIALIZING'].includes(error.code)) { throw error; }

        // 创建与核验分属独立请求，避免首次使用耗尽宿主与 Points 的共享预算。
        ensure(await initialize(ctx) === 'READY' && !deferBusiness, 'SCHEMA_INITIALIZING');

        return meta(ctx);
    }

    if (!verified.has(ctx.botId)) {
        await verifyReady(ctx, true);
    }

    return control;
}

async function verifyReady(ctx: Ctx, readOnly = false, createDeferred = false): Promise<void> {
    try {
        // 目录索引与中奖触发器在核验阶段创建，各阶段保留独立请求预算。
        if (createDeferred) {
            for (const statement of statements.filter(deferredDefinition)) { await ctx.db.exec(statement); }
        }

        await verify(ctx, readOnly);
    } catch (error) {
        if (error instanceof Fault && error.code === 'SCHEMA_UNSUPPORTED'
            || /no such (?:column|table|index)|has no column|ON CONFLICT clause does not match|no query solution/i.test(String(error))) {
            await ctx.db.run(`UPDATE {schema_meta} SET state='UNSUPPORTED',admission_enabled=0,
                admission_revision=admission_revision+1,version=version+1 WHERE bot_id=?`, ctx.botId);
            throw new Fault('SCHEMA_UNSUPPORTED');
        }

        throw error;
    }

    if (!readOnly) {
        await ctx.db.run(`UPDATE {schema_meta} SET state='READY' WHERE bot_id=? AND schema_version=${SCHEMA} AND state<>'READY'`, ctx.botId);
        await meta(ctx);
    }

    verified.add(ctx.botId);
    ctx.logger.info(`Prize ${CONTRACT} Schema ready`);
}
