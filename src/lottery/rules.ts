import type { Award, Rules } from '../contracts.js';
import { OPEN_END } from '../contracts.js';
import { ensure, identifier, integer, text } from '../storage/db.js';

export const MAX_MINOR = 1_000_000_000_000;

export function validateRules(value: unknown): Rules {
    ensure(value !== null && typeof value === 'object');
    const input = value as Rules;
    const v: Rules = { ...input, starts: input.starts ?? 0, ends: input.ends ?? OPEN_END };
    ensure(v.kind === 'POOL');
    text(v.name, 100);
    text(v.description, 500, 0);
    integer(v.cost, 1);
    integer(v.starts, 0, OPEN_END);
    integer(v.ends, v.starts + 1, OPEN_END);
    integer(v.totalLimit);
    integer(v.userLimit);
    integer(v.dailyLimit);
    ensure(v.repeat === 'ALLOW' || v.repeat === 'ONCE_PER_POOL');
    ensure(Array.isArray(v.awards) && v.awards.length > 0 && v.awards.length <= 20);
    const ids = new Set<string>();
    let weight = 0;

    for (const award of v.awards) {
        identifier(award.id);
        text(award.name, 120);
        text(award.label, 80);
        ensure(!ids.has(award.id));
        ids.add(award.id);
        weight += integer(award.weight, 1, 2 ** 32);
        integer(award.reward);
        ensure(['NONE', 'POINTS', 'PHYSICAL', 'VIRTUAL_MANUAL'].includes(award.type));
        ensure(award.type !== 'NONE' || award.reward === 0);
        ensure(award.type !== 'POINTS' || award.reward > 0);

        if (award.type === 'PHYSICAL' || award.type === 'VIRTUAL_MANUAL') {
            ensure(v.kind === 'POOL' && award.reward === 0);
            identifier(award.prizeId);
            integer(award.claimHours, 1, 24 * 365);
            ensure(award.expiry === 'RETURN' || award.expiry === 'RETIRE');
        } else {
            ensure(award.prizeId === undefined);
        }
    }

    ensure(weight <= 2 ** 32);
    ensure(BigInt(v.cost) <= BigInt(MAX_MINOR));
    ensure(BigInt(Math.max(...v.awards.map(a => a.reward))) <= BigInt(MAX_MINOR));
    ensure(new TextEncoder().encode(JSON.stringify(v)).length <= 12_000);

    return JSON.parse(JSON.stringify(v)) as Rules;
}

export function choose(awards: Award[], random: () => number = random32): Award {
    const total = awards.reduce((n, a) => n + a.weight, 0);
    ensure(total > 0 && total <= 2 ** 32, 'NO_CANDIDATE');
    const ceiling = Math.floor(2 ** 32 / total) * total;
    let value: number;

    do {
        value = random();
    } while (value >= ceiling);

    let pick = value % total;

    for (const award of awards) {
        if (pick < award.weight) {
            return { ...award };
        }

        pick -= award.weight;
    }

    throw new Error('随机范围错误');
}

function random32(): number {
    return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

export function money(minor: number): string {
    return (minor / 100).toFixed(2);
}
