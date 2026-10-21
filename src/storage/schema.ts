import type { Ctx, Meta } from '../contracts.js';
import { CONTRACT } from '../contracts.js';
import { ensure, Fault, meta, sql } from './db.js';

// 仅缓存当前实例已通过的结构探测；每个入口仍读取持久化阶段和版本。
const verified = new Set<string>();

const statements = [
    `CREATE TABLE IF NOT EXISTS {guards}(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT prize_guard CHECK(ok=1))`,
    `CREATE TABLE IF NOT EXISTS {schema_meta}(bot_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,state TEXT NOT NULL,
        cursor_secret TEXT NOT NULL,facts_count INTEGER NOT NULL DEFAULT 0,pending_bytes INTEGER NOT NULL DEFAULT 0,data_revision INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,admission_enabled INTEGER NOT NULL DEFAULT 0,admission_revision INTEGER NOT NULL DEFAULT 0,
        policy TEXT,settings TEXT NOT NULL,heartbeat INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
        cleanup_due INTEGER NOT NULL DEFAULT 0,archive_due INTEGER NOT NULL DEFAULT 0,maintenance_requested INTEGER NOT NULL DEFAULT 0,archive_requested INTEGER NOT NULL DEFAULT 0,last_error TEXT)`,
    `CREATE TABLE IF NOT EXISTS {pools}(bot_id TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,
        inventory_revision INTEGER NOT NULL DEFAULT 0,rules TEXT NOT NULL,PRIMARY KEY(bot_id,id))`,
    `CREATE TABLE IF NOT EXISTS {pool_versions}(bot_id TEXT NOT NULL,pool_id TEXT NOT NULL,version INTEGER NOT NULL,
        rules TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(bot_id,pool_id,version))`,
    // pool_id 保留既有存储列；商品不归属奖池，新建写空值，绑定仅由规则 prizeId 表达。
    `CREATE TABLE IF NOT EXISTS {prizes}(bot_id TEXT NOT NULL,id TEXT NOT NULL,pool_id TEXT NOT NULL,name TEXT NOT NULL,
        stock_total INTEGER NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,
        fulfilled INTEGER NOT NULL DEFAULT 0,retired INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bot_id,id),
        CHECK(stock_total>=0 AND stock_total<=9007199254740991 AND available>=0 AND reserved>=0 AND fulfilled>=0 AND retired>=0),
        CHECK(stock_total=available+reserved+fulfilled+retired))`,
    `CREATE TABLE IF NOT EXISTS {draws}(bot_id TEXT NOT NULL,id TEXT NOT NULL,short_id TEXT NOT NULL,user_id TEXT NOT NULL,
        scene TEXT NOT NULL,target TEXT NOT NULL,event_key TEXT NOT NULL,kind TEXT NOT NULL,pool_id TEXT NOT NULL,
        config_version INTEGER NOT NULL,admission_revision INTEGER NOT NULL,business_day TEXT NOT NULL,created_at INTEGER NOT NULL,
        settled_at INTEGER,count INTEGER NOT NULL,cost INTEGER NOT NULL CHECK(cost>=0 AND cost<=1000000000000),
        reward INTEGER NOT NULL DEFAULT 0 CHECK(reward>=0 AND reward<=1000000000000),state TEXT NOT NULL,
        qualifies INTEGER NOT NULL DEFAULT 0,winner INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL DEFAULT 0,
        error TEXT,body TEXT,award_ids TEXT NOT NULL DEFAULT '[]',archive_id TEXT,archive_pending TEXT,
        PRIMARY KEY(bot_id,id),UNIQUE(bot_id,event_key),UNIQUE(bot_id,short_id))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS {draw_mutex} ON {draws}(bot_id,user_id,kind,pool_id)
        WHERE state NOT IN ('SETTLED','FAILED','REFUNDED')`,
    `CREATE INDEX IF NOT EXISTS {draw_user} ON {draws}(bot_id,user_id,created_at,id)`,
    `CREATE INDEX IF NOT EXISTS {draw_quota} ON {draws}(bot_id,pool_id,qualifies,user_id,business_day,winner)`,
    `CREATE INDEX IF NOT EXISTS {draw_recovery} ON {draws}(bot_id,state,retry_at,expires_at)`,
    `CREATE INDEX IF NOT EXISTS {draw_archive} ON {draws}(bot_id,archive_id,archive_pending,state,settled_at,created_at)`,
    `CREATE TABLE IF NOT EXISTS {claims}(bot_id TEXT NOT NULL,id TEXT NOT NULL,short_id TEXT NOT NULL,draw_id TEXT NOT NULL,
        user_id TEXT NOT NULL,pool_id TEXT NOT NULL,prize_id TEXT NOT NULL,award TEXT,state TEXT NOT NULL,stock_state TEXT NOT NULL,
        obtained_at INTEGER,expires_at INTEGER,claimed_at INTEGER,fulfilled_at INTEGER,expired_at INTEGER,
        cancelled_at INTEGER,processed_at INTEGER,version INTEGER NOT NULL DEFAULT 0,details_version INTEGER NOT NULL DEFAULT 0,
        details TEXT,purge_at INTEGER,note TEXT,admin_op TEXT,archive_id TEXT,archive_pending TEXT,
        PRIMARY KEY(bot_id,id),UNIQUE(bot_id,short_id),UNIQUE(bot_id,draw_id))`,
    `CREATE INDEX IF NOT EXISTS {claim_user} ON {claims}(bot_id,user_id,obtained_at,id)`,
    `CREATE INDEX IF NOT EXISTS {claim_expiry} ON {claims}(bot_id,state,expires_at)`,
    `CREATE INDEX IF NOT EXISTS {claim_purge} ON {claims}(bot_id,purge_at)`,
    `CREATE INDEX IF NOT EXISTS {claim_archive} ON {claims}(bot_id,archive_id,archive_pending,state,obtained_at)`,
    `CREATE TABLE IF NOT EXISTS {claim_actions}(bot_id TEXT NOT NULL,event_key TEXT NOT NULL,user_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,action TEXT NOT NULL,target TEXT,outcome TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(bot_id,event_key))`,
    `CREATE TABLE IF NOT EXISTS {admin_audit}(bot_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,
        action TEXT NOT NULL,target TEXT NOT NULL,input TEXT,state TEXT NOT NULL,outcome TEXT,created_at INTEGER NOT NULL,
        archive_id TEXT,archive_pending TEXT,PRIMARY KEY(bot_id,operation_id))`,
    `CREATE INDEX IF NOT EXISTS {audit_directory} ON {admin_audit}(bot_id,created_at,operation_id)`,
    `CREATE TABLE IF NOT EXISTS {archive_batches}(bot_id TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,
        members TEXT NOT NULL,min_day TEXT NOT NULL,max_day TEXT NOT NULL,object_key TEXT,content_hash TEXT,payload TEXT,summary TEXT NOT NULL,family_mask INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bot_id,id))`,
    `CREATE INDEX IF NOT EXISTS {archive_directory} ON {archive_batches}(bot_id,created_at,id)`
];

async function verify(ctx: Ctx, readOnly = false): Promise<void> {
    const tables = statements.filter(statement => statement.startsWith('CREATE TABLE'));
    const indexes = statements.filter(statement => /CREATE (UNIQUE )?INDEX/.test(statement));
    const probes = tables.map(statement => {
        const table = /\{(\w+)\}/.exec(statement)![1]!;
        const columns = [...statement.matchAll(/\b(\w+)\s+(?:TEXT|INTEGER)\b/g)].map(match => match[1]);
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
    await ctx.db.batch(readOnly ? probes.filter(probe => /INSERT INTO \{(?:draws|claims)\}/.test(probe.sql)) : probes);
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
    await ctx.db.first(`SELECT ${[...columns, ...selections].join(',')}`);
}

export async function install(ctx: Ctx): Promise<void> {
    try {
        const existing = await ctx.db.first<{ schema_version: number }>('SELECT schema_version FROM {schema_meta} WHERE bot_id=?', ctx.botId);
        ensure(!existing || existing.schema_version === 1, 'SCHEMA_UNSUPPORTED');

        if (existing) { return; }
    } catch (error) {
        if (!/no such table:.*schema_meta/i.test(String(error))) { throw error; }
    }

    await ctx.db.exec(statements[1]!);
    await ctx.db.run(`INSERT INTO {schema_meta}(bot_id,schema_version,state,settings,cursor_secret) VALUES(?,1,'INITIALIZING',?,?)
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

    ensure(!existing || existing.schema_version === 1 && ['READY', 'INITIALIZING', 'VERIFYING', 'UNSUPPORTED'].includes(existing.state), 'SCHEMA_UNSUPPORTED');

    if (existing && existing.state !== 'INITIALIZING') {
        await verifyReady(ctx);

        return 'READY';
    }

    // 先登记初始化状态，未完成的结构不能作为 READY 对外使用
    await install(ctx);

    for (const statement of statements.filter(value => value !== statements[1])) {
        await ctx.db.exec(statement);
    }

    // 仅维护准入容量控制事实，避免每次购买扫描全部永久收据
    for (const [table, column] of [['draws', 'body'], ['claims', 'award'], ['claim_actions', 'outcome'], ['admin_audit', 'input'], ['archive_batches', 'payload']]) {
        await ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS {${table}_capacity_insert} AFTER INSERT ON {${table}} BEGIN
            UPDATE {schema_meta} SET facts_count=facts_count+1,pending_bytes=pending_bytes+COALESCE(length(CAST(NEW.${column} AS BLOB)),0),
                data_revision=data_revision+1 WHERE bot_id=NEW.bot_id; END`);
        await ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS {${table}_capacity_update} AFTER UPDATE OF ${column} ON {${table}} BEGIN
            UPDATE {schema_meta} SET pending_bytes=pending_bytes+COALESCE(length(CAST(NEW.${column} AS BLOB)),0)
                -COALESCE(length(CAST(OLD.${column} AS BLOB)),0),data_revision=data_revision+1 WHERE bot_id=NEW.bot_id; END`);
    }

    await ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS {claims_details_capacity} AFTER UPDATE OF details ON {claims} BEGIN
        UPDATE {schema_meta} SET pending_bytes=pending_bytes+COALESCE(length(CAST(NEW.details AS BLOB)),0)
            -COALESCE(length(CAST(OLD.details AS BLOB)),0) WHERE bot_id=NEW.bot_id; END`);

    await ctx.db.run("UPDATE {schema_meta} SET state='VERIFYING' WHERE bot_id=? AND schema_version=1 AND state='INITIALIZING'", ctx.botId);

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

async function verifyReady(ctx: Ctx, readOnly = false): Promise<void> {
    try {
        await verify(ctx, readOnly);
    } catch (error) {
        if (/no such (?:column|table|index)|has no column|ON CONFLICT clause does not match|no query solution/i.test(String(error))) {
            await ctx.db.run(`UPDATE {schema_meta} SET state='UNSUPPORTED',admission_enabled=0,
                admission_revision=admission_revision+1,version=version+1 WHERE bot_id=?`, ctx.botId);
            throw new Fault('SCHEMA_UNSUPPORTED');
        }

        throw error;
    }

    if (!readOnly) {
        await ctx.db.run("UPDATE {schema_meta} SET state='READY' WHERE bot_id=? AND schema_version=1 AND state<>'READY'", ctx.botId);
        await meta(ctx);
    }

    verified.add(ctx.botId);
    ctx.logger.info(`Prize ${CONTRACT} Schema ready`);
}
