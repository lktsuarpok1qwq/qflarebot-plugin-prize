import type { Ctx, Draw, DrawEvidence, Claim, Meta } from '../contracts.js';
import { CLAIM_FIELDS, CLAIM_STATES } from '../contracts.js';
import type { AdminReceipt } from '../admin/receipts.js';
import { atomic, canonical, drawEvidence, ensure, hash, meta, NOW, settings, sql } from '../storage/db.js';

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
    bytes: number;
    created_at: number;
    lease_token: string | null;
    lease_until: number;
}
export interface ArchivePayload {
    format: 1;
    bot: string;
    batch: string;
    draws: DrawEvidence[];
    claims: Claim[];
    audits: AdminReceipt[];
}

export async function readObject(ctx: Ctx, batch: Pick<Batch, 'id' | 'object_key' | 'content_hash' | 'bytes'>): Promise<ArchivePayload> {
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

    payload.claims = payload.claims.map(claim => {
        ensure(CLAIM_STATES.includes(claim.state), 'ARCHIVE_INVALID');

        return Object.fromEntries(CLAIM_FIELDS.map(key => [key, claim[key]])) as unknown as Claim;
    });

    return payload;
}

export function archiveReader(ctx: Ctx) {
    const objects = new Map<string, Promise<ArchivePayload>>();

    return async (table: 'draws' | 'claims', row: Draw | Claim): Promise<DrawEvidence | Claim> => {
        const content = table === 'draws' ? (row as Draw).body : (row as Claim).award;

        if (!row.archive_id || typeof content === 'string') { return table === 'draws' ? drawEvidence(row as Draw) : row as Claim; }

        let object = objects.get(row.archive_id);

        if (!object) {
            object = (async () => {
                const batch = await ctx.db.first<Pick<Batch, 'id' | 'object_key' | 'content_hash' | 'bytes'>>("SELECT id,object_key,content_hash,bytes FROM {archive_batches} WHERE bot_id=? AND id=? AND state IN ('COMMITTED','COMPACTED')", ctx.botId, row.archive_id);
                ensure(batch, 'ARCHIVE_NOT_PUBLISHED');

                return readObject(ctx, batch);
            })();
            objects.set(row.archive_id, object);
        }

        const item = (await object)[table].find(candidate => candidate.id === row.id && candidate.bot_id === ctx.botId);
        ensure(item, 'ARCHIVE_MEMBER_MISSING');

        return table === 'draws' ? { ...item, ...drawEvidence(row as Draw), body: (item as DrawEvidence).body } : { ...item, ...row, award: (item as Claim).award } as Claim;
    };
}

export async function archived(ctx: Ctx, table: 'draws' | 'claims', row: Draw | Claim): Promise<DrawEvidence | Claim> {
    return archiveReader(ctx)(table, row);
}

async function prepare(ctx: Ctx, control: Meta): Promise<boolean> {
    const config = settings(control);
    const now = new Date(Date.now() + 8 * 3_600_000);
    const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - config.retentionMonths + 1, 1) - 8 * 3_600_000;
    const id = crypto.randomUUID();
    const payload: ArchivePayload = { format: 1, bot: ctx.botId, batch: id, draws: [], claims: [], audits: [] };
    const members: Member[] = [];
    const encoder = new TextEncoder();
    let bytes = encoder.encode(canonical(payload)).length;

    for (const table of ['draws', 'claims', 'admin_audit'] as const) {
        const remaining = 20 - members.length;

        if (!remaining) { break; }

        const candidates = table === 'draws' ? await ctx.db.all<Draw>(`SELECT d.* FROM {draws} d INDEXED BY {draw_archive} WHERE d.bot_id=? AND d.archive_ready=1 AND d.archive_id IS NULL
            AND d.archive_pending IS NULL AND d.state IN ('SETTLED','FAILED','REFUNDED') AND d.body IS NOT NULL
            AND COALESCE(d.settled_at,d.created_at)<? AND (d.claim_id IS NULL OR d.claim_state IN ('FULFILLED','CANCELLED'))
            ORDER BY COALESCE(d.settled_at,d.created_at),d.id LIMIT ?`, ctx.botId, cutoff, remaining)
            : table === 'claims' ? await ctx.db.all<Claim>(`SELECT ${CLAIM_FIELDS.join(',')} FROM {claims} WHERE bot_id=? AND archive_id IS NULL AND archive_pending IS NULL
                AND state IN ('FULFILLED','CANCELLED') AND award IS NOT NULL AND COALESCE(obtained_at,processed_at)<?
                ORDER BY COALESCE(obtained_at,processed_at),id LIMIT ?`, ctx.botId, cutoff, remaining)
                : await ctx.db.all<AdminReceipt>(`SELECT * FROM {admin_audit} INDEXED BY {audit_archive} WHERE bot_id=? AND archive_id IS NULL AND archive_pending IS NULL
                    AND state='DONE' AND input IS NOT NULL AND created_at<? ORDER BY created_at,operation_id LIMIT ?`, ctx.botId, cutoff, remaining);

        for (const candidate of candidates) {
            const item = table === 'draws' ? drawEvidence(candidate as Draw) : candidate;
            const destination = table === 'admin_audit' ? payload.audits : table === 'draws' ? payload.draws : payload.claims;
            const added = encoder.encode(canonical(item)).length + (destination.length ? 1 : 0);

            if (bytes + added > 65536) { continue; }

            (destination as unknown[]).push(item);
            bytes += added;
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
        writes.push(sql(`UPDATE {${member.table === 'claims' ? 'draws' : member.table}} SET ${member.table === 'claims' ? 'claim_archive_pending' : 'archive_pending'}=? WHERE bot_id=? AND ${member.table === 'claims' ? 'claim_id' : column}=?`, id, ctx.botId, member.id));
    }

    const text = canonical(payload);
    ensure(encoder.encode(text).length === bytes, 'ARCHIVE_SIZE');
    writes.push(sql(`INSERT INTO {archive_batches}(bot_id,id,state,members,payload,bytes,created_at)
        VALUES(?,?,'PREPARED',?,?,?,${NOW})`, ctx.botId, id, JSON.stringify(members), text, bytes));
    await atomic(ctx, sql(conditions.join(' AND '), ...params), writes, true);

    return true;
}

export async function archiveStep(ctx: Ctx, initial?: Meta): Promise<boolean> {
    const control = initial ?? await meta(ctx);
    ensure(settings(control).archiveEnabled, 'ARCHIVE_DISABLED');
    const batch = await ctx.db.first<Batch>(`SELECT bot_id,id,state,version,members,object_key,content_hash,bytes,created_at,lease_token,lease_until,
        CASE WHEN state='PREPARED' THEN payload ELSE NULL END AS payload FROM {archive_batches} INDEXED BY {archive_pending} WHERE bot_id=? AND state<>'COMPACTED'
        AND lease_until<=${NOW} ORDER BY created_at,id LIMIT 1`, ctx.botId);

    if (!batch) { return prepare(ctx, control); }

    const token = crypto.randomUUID();
    const got = await ctx.db.run(`UPDATE {archive_batches} SET lease_token=?,lease_until=${NOW}+120000
        WHERE bot_id=? AND id=? AND version=? AND lease_until<=${NOW}`, token, ctx.botId, batch.id, batch.version);

    if (!got.changes) { return false; }

    const members = JSON.parse(batch.members) as Member[];
    const guard = sql(`EXISTS(SELECT 1 FROM {archive_batches} WHERE bot_id=? AND id=? AND version=?
        AND lease_token=? AND lease_until>${NOW})`, ctx.botId, batch.id, batch.version, token);

    let released = false;

    try {
        if (batch.state === 'PREPARED') {
            ensure(batch.payload, 'ARCHIVE_PAYLOAD_MISSING');
            const digest = await hash(batch.payload);
            const key = `${ctx.botId}/${new Date(batch.created_at).toISOString().slice(0, 7)}/${batch.id}/${digest}.json`;
            await ctx.r2.put(key, batch.payload, { contentType: 'application/json' });
            await readObject(ctx, { ...batch, object_key: key, content_hash: digest });
            await atomic(ctx, guard, [sql(`UPDATE {archive_batches} SET state='VERIFIED',object_key=?,content_hash=?,version=version+1,lease_token=NULL,lease_until=0
                WHERE bot_id=? AND id=?`, key, digest, ctx.botId, batch.id)]);
        } else if (batch.state === 'VERIFIED') {
            const writes = members.map(member => sql(`UPDATE {${member.table === 'claims' ? 'draws' : member.table}} SET ${member.table === 'claims' ? 'claim_archive_id' : 'archive_id'}=? WHERE bot_id=?
                AND ${member.table === 'admin_audit' ? 'operation_id' : member.table === 'claims' ? 'claim_id' : 'id'}=? AND ${member.table === 'claims' ? 'claim_archive_pending' : 'archive_pending'}=?`, batch.id, ctx.botId, member.id, batch.id));
            const membersGuard = members.map(member => `EXISTS(SELECT 1 FROM {${member.table}} WHERE bot_id=?
                AND ${member.table === 'admin_audit' ? 'operation_id' : 'id'}=? AND archive_pending=? AND archive_id IS NULL
                ${member.table === 'admin_audit' ? '' : 'AND version=?'})`).join(' AND ');
            const params = members.flatMap(member => [ctx.botId, member.id, batch.id, ...member.table === 'admin_audit' ? [] : [member.version]]);
            await atomic(ctx, sql(`${guard.sql} AND ${membersGuard}`, ...guard.params!, ...params), [...writes,
            sql("UPDATE {archive_batches} SET state='COMMITTED',version=version+1,lease_token=NULL,lease_until=0 WHERE bot_id=? AND id=?", ctx.botId, batch.id)]);
        } else {
            const writes = members.map(member => sql(`UPDATE {${member.table === 'claims' ? 'draws' : member.table}} SET
                ${member.table === 'draws' ? 'body=NULL,snapshot=NULL,archive_pending=NULL' : member.table === 'claims' ? 'claim_award=NULL,claim_archive_pending=NULL' : 'input=NULL,archive_pending=NULL'}
                WHERE bot_id=? AND ${member.table === 'admin_audit' ? 'operation_id' : member.table === 'claims' ? 'claim_id' : 'id'}=? AND ${member.table === 'claims' ? 'claim_archive_id' : 'archive_id'}=? AND ${member.table === 'claims' ? 'claim_archive_pending' : 'archive_pending'}=?`,
                ctx.botId, member.id, batch.id, batch.id));
            const memberChecks = members.map(member => `EXISTS(SELECT 1 FROM {${member.table}} WHERE bot_id=?
                AND ${member.table === 'admin_audit' ? 'operation_id' : 'id'}=? AND archive_id=? AND archive_pending=archive_id
                AND ${member.table === 'draws' ? 'body' : member.table === 'claims' ? 'award' : 'input'} IS NOT NULL
                ${member.table === 'admin_audit' ? '' : 'AND version=?'})`);
            const checkParams = members.flatMap(member => [ctx.botId, member.id, batch.id, ...member.table === 'admin_audit' ? [] : [member.version]]);
            const lengths = members.map(member => `(SELECT ${member.table === 'draws' ? 'length(CAST(body AS BLOB))+length(CAST(snapshot AS BLOB))' : 'length(CAST(' + (member.table === 'claims' ? 'award' : 'input') + ' AS BLOB))'}
                FROM {${member.table}} WHERE bot_id=? AND ${member.table === 'admin_audit' ? 'operation_id' : 'id'}=?)`);
            lengths.push('(SELECT length(CAST(payload AS BLOB)) FROM {archive_batches} WHERE bot_id=? AND id=?)');
            const lengthParams = [...members.flatMap(member => [ctx.botId, member.id]), ctx.botId, batch.id];
            // 延迟计量只存在于同一个受租约和成员守卫保护的原子批次内；失败整批回滚。
            await atomic(ctx, sql(`${guard.sql} AND EXISTS(SELECT 1 FROM {schema_meta} WHERE bot_id=? AND capacity_deferred=0)
                AND ${memberChecks.join(' AND ')}`, ...guard.params!, ctx.botId, ...checkParams), [
                sql(`UPDATE {schema_meta} SET capacity_deferred=1,pending_bytes=pending_bytes-(${lengths.join('+')}) WHERE bot_id=?`, ...lengthParams, ctx.botId),
                ...writes,
                sql(`UPDATE {archive_batches} SET state='COMPACTED',payload=NULL,version=version+1,lease_token=NULL,lease_until=0
                    WHERE bot_id=? AND id=?`, ctx.botId, batch.id),
                sql('UPDATE {schema_meta} SET capacity_deferred=0,data_revision=data_revision+1 WHERE bot_id=?', ctx.botId)
            ], true);
        }

        released = true;

        return true;
    } finally {
        if (!released) {
            await ctx.db.run('UPDATE {archive_batches} SET lease_token=NULL,lease_until=0 WHERE bot_id=? AND id=? AND lease_token=?',
                ctx.botId, batch.id, token);
        }
    }
}
