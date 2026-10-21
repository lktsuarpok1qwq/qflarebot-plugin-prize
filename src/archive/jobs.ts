import type { Ctx, Draw, Claim } from '../contracts.js';
import type { AdminReceipt } from '../admin/receipts.js';
import { atomic, canonical, ensure, hash, meta, NOW, settings, sql } from '../storage/db.js';
import { contributions, FAMILY_MASK } from './metrics.js';

interface Member { table: 'draws' | 'claims' | 'admin_audit'; id: string; version: number; }
export interface Batch {
    bot_id: string;
    id: string;
    state: 'PREPARED' | 'VERIFIED' | 'COMMITTED' | 'COMPACTED';
    version: number;
    members: string;
    object_key: string | null;
    content_hash: string | null;
    payload: string | null;
    summary: string;
    bytes: number;
    created_at: number;
    lease_token: string | null;
    lease_until: number;
}
export interface ArchivePayload {
    format: 1;
    bot: string;
    batch: string;
    draws: Draw[];
    claims: Claim[];
    audits: AdminReceipt[];
}

export async function readObject(ctx: Ctx, batch: Batch): Promise<ArchivePayload> {
    ensure(batch.object_key && batch.content_hash && batch.bytes <= 65536, 'ARCHIVE_INVALID');
    const stream = await ctx.r2.getStream(batch.object_key);
    ensure(stream, 'ARCHIVE_MISSING');
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
        while (true) {
            const part = await reader.read();

            if (part.done) { break; }

            size += part.value.byteLength;
            ensure(size <= batch.bytes && size <= 65536, 'ARCHIVE_SIZE');
            chunks.push(part.value);
        }
    } finally {
        await reader.cancel();
    }

    const all = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
    }

    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all);
    ensure(size === batch.bytes && await hash(text) === batch.content_hash, 'ARCHIVE_HASH');
    const payload = JSON.parse(text) as ArchivePayload;
    ensure(payload.format === 1 && payload.bot === ctx.botId && payload.batch === batch.id, 'ARCHIVE_INVALID');

    return payload;
}

export async function archived(ctx: Ctx, table: 'draws' | 'claims', row: Draw | Claim): Promise<Draw | Claim> {
    if (!row.archive_id) { return row; }

    const batch = await ctx.db.first<Batch>("SELECT * FROM {archive_batches} WHERE bot_id=? AND id=? AND state IN ('COMMITTED','COMPACTED')",
        ctx.botId, row.archive_id);
    ensure(batch, 'ARCHIVE_NOT_PUBLISHED');
    const payload = await readObject(ctx, batch);
    const item = payload[table].find(candidate => candidate.id === row.id && candidate.bot_id === ctx.botId);
    ensure(item, 'ARCHIVE_MEMBER_MISSING');

    // 私密资料只取当前 D1，归档正文永不提供旧资料
    return table === 'claims' ? { ...item, details: (row as Claim).details, details_version: (row as Claim).details_version } as Claim : item;
}

async function prepare(ctx: Ctx): Promise<boolean> {
    const control = await meta(ctx);
    const config = settings(control);
    const now = new Date(Date.now() + 8 * 3_600_000);
    const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - config.retentionMonths + 1, 1) - 8 * 3_600_000;
    const draws = await ctx.db.all<Draw>(`SELECT d.* FROM {draws} d WHERE d.bot_id=? AND d.archive_id IS NULL
        AND d.archive_pending IS NULL AND d.state IN ('SETTLED','FAILED','REFUNDED') AND d.body IS NOT NULL
        AND COALESCE(d.settled_at,d.created_at)<? AND NOT EXISTS(SELECT 1 FROM {claims} c
            WHERE c.bot_id=d.bot_id AND c.draw_id=d.id AND c.state IN ('LOCKED','PENDING','CLAIMED'))
        ORDER BY COALESCE(d.settled_at,d.created_at),d.id LIMIT 20`, ctx.botId, cutoff);
    const claims = await ctx.db.all<Claim>(`SELECT * FROM {claims} WHERE bot_id=? AND archive_id IS NULL AND archive_pending IS NULL
        AND state IN ('FULFILLED','EXPIRED','CANCELLED') AND award IS NOT NULL AND COALESCE(obtained_at,processed_at)<?
        ORDER BY COALESCE(obtained_at,processed_at),id LIMIT 20`, ctx.botId, cutoff);
    const audits = await ctx.db.all<AdminReceipt>(`SELECT * FROM {admin_audit} WHERE bot_id=? AND archive_id IS NULL AND archive_pending IS NULL
        AND state='DONE' AND input IS NOT NULL AND created_at<? ORDER BY created_at,operation_id LIMIT 20`, ctx.botId, cutoff);
    const id = crypto.randomUUID();
    const payload: ArchivePayload = { format: 1, bot: ctx.botId, batch: id, draws: [], claims: [], audits: [] };
    const members: Member[] = [];

    for (const [table, candidates] of [['draws', draws], ['claims', claims], ['admin_audit', audits]] as const) {
        for (const item of candidates) {
            if (members.length >= 20) { break; }

            const copy = { ...item };

            if ('details' in copy) {
                copy.details = null;
                copy.details_version = 0;
                copy.purge_at = null;
            }

            const destination = table === 'admin_audit' ? payload.audits : table === 'draws' ? payload.draws : payload.claims;
            (destination as unknown[]).push(copy);

            if (new TextEncoder().encode(canonical(payload)).length > 65536) {
                destination.pop();
                continue;
            }

            members.push({ table, id: 'operation_id' in item ? item.operation_id : item.id, version: 'version' in item ? item.version : 0 });
        }
    }

    if (!members.length) { return false; }

    const conditions: string[] = [];
    const params: unknown[] = [];
    const writes = [];

    for (const member of members) {
        const column = member.table === 'admin_audit' ? 'operation_id' : 'id';
        conditions.push(`EXISTS(SELECT 1 FROM {${member.table}} WHERE bot_id=? AND ${column}=? AND archive_id IS NULL
            AND archive_pending IS NULL ${member.table === 'admin_audit' ? '' : 'AND version=?'})`);
        params.push(ctx.botId, member.id, ...member.table === 'admin_audit' ? [] : [member.version]);
        writes.push(sql(`UPDATE {${member.table}} SET archive_pending=? WHERE bot_id=? AND ${column}=?`, id, ctx.botId, member.id));
    }

    const text = canonical(payload);
    const summary = contributions(payload.draws, payload.claims);
    writes.push(sql(`INSERT INTO {archive_batches}(bot_id,id,state,members,payload,summary,family_mask,bytes,min_day,max_day,created_at)
        VALUES(?,?,'PREPARED',?,?,?,?,?,?,?,${NOW})`, ctx.botId, id, JSON.stringify(members), text,
        JSON.stringify(summary), [...new Set(summary.map(bucket => bucket.family))].reduce((mask, family) => mask | FAMILY_MASK[family], 0), new TextEncoder().encode(text).length,
        summary.filter(b => b.day).map(b => b.day).sort()[0] ?? '', summary.filter(b => b.day).map(b => b.day).sort().at(-1) ?? ''));
    await atomic(ctx, sql(conditions.join(' AND '), ...params), writes);

    return true;
}

export async function archiveStep(ctx: Ctx): Promise<boolean> {
    const control = await meta(ctx);
    ensure(settings(control).archiveEnabled, 'ARCHIVE_DISABLED');
    const batch = await ctx.db.first<Batch>(`SELECT * FROM {archive_batches} WHERE bot_id=? AND state<>'COMPACTED'
        AND lease_until<=${NOW} ORDER BY created_at,id LIMIT 1`, ctx.botId);

    if (!batch) { return prepare(ctx); }

    const token = crypto.randomUUID();
    const got = await ctx.db.run(`UPDATE {archive_batches} SET lease_token=?,lease_until=${NOW}+120000
        WHERE bot_id=? AND id=? AND version=? AND lease_until<=${NOW}`, token, ctx.botId, batch.id, batch.version);

    if (!got.changes) { return false; }

    const members = JSON.parse(batch.members) as Member[];
    const guard = sql(`EXISTS(SELECT 1 FROM {archive_batches} WHERE bot_id=? AND id=? AND version=?
        AND lease_token=? AND lease_until>${NOW})`, ctx.botId, batch.id, batch.version, token);

    try {
        if (batch.state === 'PREPARED') {
            ensure(batch.payload, 'ARCHIVE_PAYLOAD_MISSING');
            const digest = await hash(batch.payload);
            const key = `${ctx.botId}/${new Date(batch.created_at).toISOString().slice(0, 7)}/${batch.id}/${digest}.json`;
            await ctx.r2.put(key, batch.payload, { contentType: 'application/json' });
            await readObject(ctx, { ...batch, object_key: key, content_hash: digest });
            await atomic(ctx, guard, [sql(`UPDATE {archive_batches} SET state='VERIFIED',object_key=?,content_hash=?,version=version+1
                WHERE bot_id=? AND id=?`, key, digest, ctx.botId, batch.id)]);
        } else if (batch.state === 'VERIFIED') {
            const writes = members.map(member => sql(`UPDATE {${member.table}} SET archive_id=? WHERE bot_id=?
                AND ${member.table === 'admin_audit' ? 'operation_id' : 'id'}=? AND archive_pending=?`, batch.id, ctx.botId, member.id, batch.id));
            const membersGuard = members.map(member => `EXISTS(SELECT 1 FROM {${member.table}} WHERE bot_id=?
                AND ${member.table === 'admin_audit' ? 'operation_id' : 'id'}=? AND archive_pending=? AND archive_id IS NULL
                ${member.table === 'admin_audit' ? '' : 'AND version=?'})`).join(' AND ');
            const params = members.flatMap(member => [ctx.botId, member.id, batch.id, ...member.table === 'admin_audit' ? [] : [member.version]]);
            await atomic(ctx, sql(`${guard.sql} AND ${membersGuard}`, ...guard.params!, ...params), [...writes,
            sql("UPDATE {archive_batches} SET state='COMMITTED',version=version+1 WHERE bot_id=? AND id=?", ctx.botId, batch.id)]);
        } else {
            const writes = members.map(member => sql(`UPDATE {${member.table}} SET
                ${member.table === 'draws' ? 'body=NULL' : member.table === 'claims' ? 'award=NULL' : 'input=NULL'},archive_pending=NULL
                WHERE bot_id=? AND ${member.table === 'admin_audit' ? 'operation_id' : 'id'}=? AND archive_id=? AND archive_pending=?`,
                ctx.botId, member.id, batch.id, batch.id));
            await atomic(ctx, guard, [...writes, sql(`UPDATE {archive_batches} SET state='COMPACTED',payload=NULL,version=version+1
                WHERE bot_id=? AND id=?`, ctx.botId, batch.id)]);
        }

        return true;
    } finally {
        await ctx.db.run('UPDATE {archive_batches} SET lease_token=NULL,lease_until=0 WHERE bot_id=? AND id=? AND lease_token=?',
            ctx.botId, batch.id, token);
    }
}
