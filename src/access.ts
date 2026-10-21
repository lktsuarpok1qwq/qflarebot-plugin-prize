import type { Ctx, Meta } from './contracts.js';
import { CONTRACT, SOURCE } from './contracts.js';
import { canonical, ensure, meta, settings } from './storage/db.js';
import { wallet } from './points/operations.js';
import { maintenance } from './maintenance.js';

export const requiredPermissions = ['burn', 'reverseOwn'];

export async function access(ctx: Ctx, initial?: Meta): Promise<Meta> {
    let control = initial ?? await meta(ctx);
    const service = wallet(ctx);
    let result = await service.getSourcePolicy({ source: SOURCE });
    ensure(result.ok, result.ok ? '' : result.code);

    if (!result.data.registered) {
        const registered = await service.registerSource({ source: SOURCE });
        ensure(registered.ok, registered.ok ? '' : registered.code);
        result = await service.getSourcePolicy({ source: SOURCE });
        ensure(result.ok, result.ok ? '' : result.code);
    }

    const policy = result.data;
    const allowed = policy.registered && policy.enabled && requiredPermissions.every(name => policy.operationPermissions.includes(name));
    const admission = allowed && !settings(control).paused ? 1 : 0;
    const snapshot = { ...policy, contract: CONTRACT };
    const previous = control.policy ? JSON.parse(control.policy) : null;

    if (previous) { delete previous.checkedAt; }

    if (control.admission_enabled !== admission || canonical(previous) !== canonical(snapshot)) {
        // 核验开始后的人工暂停、权限拒绝和其他控制写入都使本次结果失效。
        const updated = await ctx.db.run(`UPDATE {schema_meta} SET policy=?,admission_enabled=?,
            admission_revision=admission_revision+1,version=version+1 WHERE bot_id=? AND version=? AND admission_revision=?`,
            JSON.stringify({ ...snapshot, checkedAt: Date.now() }), admission, ctx.botId, control.version, control.admission_revision);
        ensure(updated.changes, 'CONFLICT');
        control = await meta(ctx);
    }

    // 首次运行只做有界健康检查；后台 Cron 承担实际队列恢复及清理。
    if (!control.heartbeat) {
        await maintenance(ctx, 'check');
        control = await meta(ctx);
    }

    return control;
}
