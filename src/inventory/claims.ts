import type { Session } from '@qqbot/sdk';
import type { Claim, Ctx, Outcome } from '../contracts.js';
import { atomic, canonical, ensure, failure, hash, NOW, sql, text } from '../storage/db.js';
import { eventKey } from '../storage/events.js';

export type ClaimAction = 'claim' | 'details';
interface ActionReceipt {
    request_hash: string;
    outcome: string;
}

export async function act(ctx: Ctx, session: Session, action: ClaimAction, short?: string,
    detailsVersion?: number, details?: string): Promise<Outcome> {
    ensure(session.scene === 'c2c', 'PRIVATE_ONLY');
    const key = eventKey(session);
    const digest = await hash(canonical({
        action, short: short ?? null, version: detailsVersion ?? null,
        detailsHash: details === undefined ? null : await hash(details)
    }));
    const previous = await ctx.db.first<ActionReceipt>('SELECT * FROM {claim_actions} WHERE bot_id=? AND event_key=?', ctx.botId, key);

    if (previous) {
        ensure(previous.request_hash === digest, 'OPERATION_CONFLICT');

        return JSON.parse(previous.outcome) as Outcome;
    }

    let claim: Claim | undefined;
    let outcome: Outcome;

    try {
        if (action === 'details') {
            text(details, 2000);
            ensure(short && Number.isSafeInteger(detailsVersion) && detailsVersion! >= 0);
        }

        const rows = short ? await ctx.db.all<Claim>(`SELECT c.* FROM {claims} c JOIN {draws} d
            ON d.bot_id=c.bot_id AND d.id=c.draw_id WHERE c.bot_id=? AND c.user_id=? AND c.short_id=? AND d.state='SETTLED'`,
            ctx.botId, session.userId, short)
            : await ctx.db.all<Claim>(`SELECT c.* FROM {claims} c JOIN {draws} d ON d.bot_id=c.bot_id AND d.id=c.draw_id
                WHERE c.bot_id=? AND c.user_id=? AND d.state='SETTLED' AND c.state='PENDING'
                AND c.expires_at>${NOW} LIMIT 2`, ctx.botId, session.userId);
        ensure(rows.length === 1, rows.length ? 'SPECIFY_PRIZE' : 'NO_ELIGIBLE_PRIZE');
        claim = rows[0]!;

        if (action === 'claim') {
            ensure(claim.state !== 'PENDING' || claim.expires_at! > Date.now(), 'CLAIM_EXPIRED');
            ensure(claim.state === 'PENDING' || claim.state === 'CLAIMED', 'CLAIM_STATE');
        } else {
            ensure(claim.state === 'CLAIMED' && claim.details_version === detailsVersion, 'DETAILS_VERSION_CONFLICT');
        }

        const changing = action === 'claim' ? claim.state === 'PENDING' : true;
        outcome = {
            ok: true, code: 'OK', target: claim.id,
            version: action === 'details' ? claim.details_version + 1 : claim.version + Number(changing)
        };
    } catch (error) {
        outcome = { ...failure(error), target: claim?.id };
    }

    const receipt = sql(`INSERT INTO {claim_actions}(bot_id,event_key,user_id,request_hash,action,target,outcome,created_at)
        VALUES(?,?,?,?,?,?,?,${NOW})`, ctx.botId, key, session.userId, digest, action, claim?.id ?? null, JSON.stringify(outcome));

    try {
        if (!outcome.ok || !claim) {
            await ctx.db.batch([receipt]);
        } else {
            const writes = [receipt];
            const changing = action === 'details' || action === 'claim' && claim.state === 'PENDING';
            let guard = `EXISTS(SELECT 1 FROM {claims} c JOIN {draws} d ON d.bot_id=c.bot_id AND d.id=c.draw_id
                WHERE c.bot_id=? AND c.id=? AND c.version=? AND c.user_id=? AND d.state='SETTLED')`;
            const args: unknown[] = [ctx.botId, claim.id, claim.version, session.userId];

            if (changing && action !== 'details') {
                guard += ` AND EXISTS(SELECT 1 FROM {claims} WHERE bot_id=? AND id=? AND state='PENDING' AND expires_at>${NOW})`;
                args.push(ctx.botId, claim.id);
            }

            if (!short) {
                guard += ` AND (SELECT COUNT(*) FROM {claims} c JOIN {draws} d ON d.bot_id=c.bot_id AND d.id=c.draw_id
                    WHERE c.bot_id=? AND c.user_id=? AND c.state='PENDING' AND c.expires_at>${NOW}
                    AND d.state='SETTLED')=1`;
                args.push(ctx.botId, session.userId);
            }

            if (changing) {
                if (action === 'claim') {
                    writes.unshift(sql(`UPDATE {claims} SET state='CLAIMED',claimed_at=${NOW},version=version+1 WHERE bot_id=? AND id=?`, ctx.botId, claim.id));
                } else {
                    writes.unshift(sql('UPDATE {claims} SET details=?,details_version=details_version+1,version=version+1 WHERE bot_id=? AND id=?',
                        details, ctx.botId, claim.id));
                }
            }

            await atomic(ctx, sql(guard, ...args), writes);
        }
    } catch (error) {
        const winner = await ctx.db.first<ActionReceipt>('SELECT * FROM {claim_actions} WHERE bot_id=? AND event_key=?', ctx.botId, key);

        if (winner) {
            ensure(winner.request_hash === digest, 'OPERATION_CONFLICT');

            return JSON.parse(winner.outcome) as Outcome;
        }

        const current = action === 'claim' && claim ? await ctx.db.first<{ state: string; expired: number }>(
            `SELECT state,CASE WHEN expires_at<=${NOW} THEN 1 ELSE 0 END AS expired FROM {claims}
                WHERE bot_id=? AND id=? AND user_id=?`, ctx.botId, claim.id, session.userId) : null;
        const rejected = { ok: false, code: current?.state === 'PENDING' && current.expired ? 'CLAIM_EXPIRED' : 'CONFLICT', target: claim?.id };
        await ctx.db.run(`INSERT INTO {claim_actions}(bot_id,event_key,user_id,request_hash,action,target,outcome,created_at)
            VALUES(?,?,?,?,?,?,?,${NOW}) ON CONFLICT(bot_id,event_key) DO NOTHING`, ctx.botId, key, session.userId,
            digest, action, claim?.id ?? null, JSON.stringify(rejected));
        const stored = await ctx.db.first<ActionReceipt>('SELECT * FROM {claim_actions} WHERE bot_id=? AND event_key=?', ctx.botId, key);
        ensure(stored?.request_hash === digest, 'OPERATION_CONFLICT');

        return JSON.parse(stored.outcome) as Outcome;
    }

    return outcome;
}
