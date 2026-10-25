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

export const FAMILIES = ['transactions', 'awards', 'claimEvents', 'claimStates', 'participation'] as const;

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

    return [...map.values()].map(value => ({ value, key: JSON.stringify(value) })).sort((a, b) => a.key.localeCompare(b.key)).map(item => item.value);
}
