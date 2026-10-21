import type { Claim, Draw, DrawBody } from '../contracts.js';
import { beijing } from '../storage/db.js';

export interface Bucket {
    family: 'transactions' | 'awards' | 'claimEvents' | 'claimStates' | 'participation';
    day: string;
    kind: string;
    pool: string;
    award: string;
    prize: string;
    event: string;
    values: Record<string, string>;
}

export const FAMILY_MASK = { transactions: 1, awards: 2, claimEvents: 4, claimStates: 8, participation: 16 };

export function participation(draws: Draw[]): Bucket[] {
    return merge(draws.filter(row => row.kind === 'POOL' && row.qualifies === 1).map(row => ({
        family: 'participation', day: row.business_day, kind: row.kind, pool: row.pool_id, award: '', prize: '', event: '',
        values: { participations: row.state === 'SETTLED' ? '1' : '0', pending: row.state === 'SETTLED' ? '0' : '1' }
    })));
}

export function contributions(draws: Draw[], claims: Claim[], window?: { from: number; to: number }): Bucket[] {
    const buckets: Bucket[] = [];

    for (const draw of draws) {
        if (draw.state !== 'SETTLED') { continue; }

        const day = beijing(draw.settled_at!);
        const common = { day, kind: draw.kind, pool: draw.pool_id, award: '', prize: '', event: '' };
        buckets.push({
            ...common, family: 'transactions', values: {
                commands: '1',
                wins: String(draw.winner), cost: String(draw.cost), reward: String(draw.reward), net: String(draw.cost - draw.reward)
            }
        });
        const results = draw.body ? (JSON.parse(draw.body) as DrawBody).results ?? [] : [];

        for (const award of results) {
            buckets.push({
                ...common, family: 'awards', award: award.id, prize: award.prizeId ?? '',
                values: { hits: '1', reward: String(award.reward) }
            });
        }
    }

    for (const claim of claims) {
        // 未结算 LOCKED 的取消没有获得时间，不生成已获得奖品指标
        if (claim.obtained_at === null) { continue; }

        const common = { kind: 'POOL', pool: claim.pool_id, award: '', prize: claim.prize_id };
        const events: Array<[string, number | null]> = [['obtained', claim.obtained_at], ['claimed', claim.claimed_at],
        ['fulfilled', claim.fulfilled_at], ['expired', claim.expired_at], ['cancelled', claim.cancelled_at]];

        for (const [event, time] of events) {
            if (time !== null && (!window || time >= window.from && time < window.to)) {
                buckets.push({ ...common, family: 'claimEvents', day: beijing(time), event, values: { count: '1' } });
            }
        }

        buckets.push({ ...common, family: 'claimStates', day: '', event: claim.state, values: { count: '1' } });
    }

    return merge(buckets);
}

export function merge(buckets: Bucket[]): Bucket[] {
    const map = new Map<string, Bucket>();

    for (const bucket of buckets) {
        const key = JSON.stringify([bucket.family, bucket.day, bucket.kind, bucket.pool, bucket.award, bucket.prize, bucket.event]);
        const target = map.get(key) ?? { ...bucket, values: {} };

        for (const [name, value] of Object.entries(bucket.values)) {
            target.values[name] = (BigInt(target.values[name] ?? '0') + BigInt(value)).toString();
        }

        map.set(key, target);
    }

    return [...map.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
