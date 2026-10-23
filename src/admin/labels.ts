import type { Ctx } from '../contracts.js';

export async function labels(ctx: Ctx, poolIds: string[]) {
    const pools: Record<string, { name: string }> = Object.create(null);
    const ids = [...new Set(poolIds)];

    for (let at = 0; at < ids.length; at += 80) {
        const part = ids.slice(at, at + 80);
        const rows = await ctx.db.all<{ id: string; name: string }>(`SELECT id,json_extract(rules,'$.name') AS name FROM {pools} WHERE bot_id=? AND id IN (${part.map(() => '?').join(',')})`, ctx.botId, ...part);

        for (const row of rows) { pools[row.id] = { name: row.name }; }
    }

    return { pools };
}
