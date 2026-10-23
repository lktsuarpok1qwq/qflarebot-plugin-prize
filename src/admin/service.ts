import type { DBStatement } from '@qqbot/sdk';
import type { Claim, Ctx, Draw, Pool, Prize, Rules, Settings, Outcome, StockView, Meta } from '../contracts.js';
import { configurationError } from '../messages/templates/config.js';
import type { MessageConfiguration } from '../messages/templates/config.js';
import { moduleName, templateSnapshots } from '../messages/templates/settings.js';
import { messageError } from '../messages/templates/validation.js';
import { CLAIM_FIELDS, CONTRACT, SOURCE, POOL_FIELDS } from '../contracts.js';
import { body, ensure, integer, meta, nextArchiveAt, NOW, progressPatch, settings, sql, text, identifier } from '../storage/db.js';
import { wallet } from '../points/operations.js';
import { validateRules } from '../lottery/rules.js';
import { bindingExists } from '../inventory/bindings.js';
import { moveStock, stockSnapshots } from '../inventory/stock.js';
import { capacity } from '../lottery/admission.js';
import { local } from './receipts.js';
import type { AdminRequest, Plan } from './receipts.js';
import { access, policyAllowed } from '../access.js';

function versionGuard(ctx: Ctx, table: 'pools' | 'prizes' | 'claims' | 'schema_meta', id: string, version: number): DBStatement {
    return sql(`EXISTS(SELECT 1 FROM {${table}} WHERE bot_id=? ${table === 'schema_meta' ? '' : 'AND id=?'} AND version=?)`,
        ...table === 'schema_meta' ? [ctx.botId, version] : [ctx.botId, id, version]);
}

export async function manage(ctx: Ctx, request: AdminRequest, initial?: Meta): Promise<Outcome> {
    const control = initial ?? await meta(ctx);
    const p = request.params;
    integer(request.expectedVersion, 0, 1_000_000_000);

    return local(ctx, request, async (): Promise<Plan> => {
        let guard: DBStatement;
        const writes: DBStatement[] = [];
        let state: string | undefined;
        let delta: number | undefined;
        let stock: StockView | undefined;
        let templates: Outcome['templates'];

        switch (request.action) {
            case 'enable': {
                const result = await wallet(ctx).getSourcePolicy({ source: SOURCE });
                ensure(result.ok, result.ok ? '' : result.code);
                const policy = result.data;
                const ready = policyAllowed(policy);
                const cap = capacity(ctx.botId);
                const check = versionGuard(ctx, 'schema_meta', '', request.expectedVersion);
                const guard = sql(`(${check.sql}) AND EXISTS(SELECT 1 FROM {schema_meta} WHERE bot_id=? AND admission_revision=?)
                    ${ready ? `AND (${cap.sql})` : ''}`, ...check.params!, ctx.botId, control.admission_revision, ...ready ? cap.params! : []);

                return {
                    guard,
                    writes: [sql(`UPDATE {schema_meta} SET policy=?,admission_enabled=?,
                        settings=CASE WHEN ?=1 THEN json_set(settings,'$.paused',json('false')) ELSE settings END,
                        admission_revision=admission_revision+1,version=version+1 WHERE bot_id=?`,
                        JSON.stringify({ ...policy, checkedAt: Date.now(), contract: CONTRACT }), ready ? 1 : 0, ready ? 1 : 0, ctx.botId)],
                    outcome: { ok: true, code: ready ? 'POINTS_READY' : 'POINTS_NOT_READY', target: SOURCE, version: request.expectedVersion + 1 }
                };
            }

            case 'messages': {
                const module = moduleName(request.target);
                const config = p.config as MessageConfiguration;
                ensure(!configurationError(module, config), 'TEMPLATES_INVALID');
                const related = templateSnapshots(control.settings, module === 'common' ? ['pool', 'prize'] : ['common']);
                const common = module === 'common' ? config : related.common!.config;
                ensure(!messageError(module, config, common), 'TEMPLATES_INVALID');

                for (const [name, value] of Object.entries(related)) {
                    ensure(name === 'common' || !messageError(name as 'pool' | 'prize', value.config, common), 'TEMPLATES_INVALID');
                }

                const path = '$.messages.' + module;
                const dependencies = Object.entries(related);
                guard = sql(`EXISTS(SELECT 1 FROM {schema_meta} WHERE bot_id=? AND COALESCE(json_extract(settings,?),0)=?
                    ${dependencies.map(() => 'AND COALESCE(json_extract(settings,?),0)=?').join(' ')})`,
                    ctx.botId, path + '.version', request.expectedVersion, ...dependencies.flatMap(([name, value]) => ['$.messages.' + name + '.version', value.version]));
                templates = { version: request.expectedVersion + 1, config };
                writes.push(sql('UPDATE {schema_meta} SET settings=json_set(settings,?,json(?)),version=version+1 WHERE bot_id=?', path, JSON.stringify(templates), ctx.botId));
                break;
            }
            case 'settings': {
                const config = p as unknown as Settings;
                ensure(typeof config.paused === 'boolean' && typeof config.archiveEnabled === 'boolean');
                ensure(config.paused === settings(control).paused, 'INVALID_ARGUMENT');
                integer(config.retentionMonths, 1, 24);
                integer(config.maxInflight, 1, 10);
                integer(config.maxFacts, 100, 1_000_000);
                integer(config.maxPendingBytes, 64000, 100_000_000);
                guard = versionGuard(ctx, 'schema_meta', '', request.expectedVersion);
                writes.push(sql(`UPDATE {schema_meta} SET settings=json_set(settings,'$.paused',json(?),'$.archiveEnabled',json(?),'$.retentionMonths',?,'$.maxInflight',?,'$.maxFacts',?,'$.maxPendingBytes',?),version=version+1,
                    admission_revision=admission_revision+1,archive_due=CASE WHEN archive_due=0 THEN ? ELSE archive_due END WHERE bot_id=?`, JSON.stringify(config.paused), JSON.stringify(config.archiveEnabled), config.retentionMonths, config.maxInflight, config.maxFacts, config.maxPendingBytes, nextArchiveAt(Date.now()), ctx.botId));
                break;
            }
            case 'disable': {
                guard = versionGuard(ctx, 'schema_meta', '', request.expectedVersion);
                writes.push(sql(`UPDATE {schema_meta} SET admission_enabled=0,settings=json_set(settings,'$.paused',json('true')),admission_revision=admission_revision+1,
                    version=version+1 WHERE bot_id=?`, ctx.botId));
                break;
            }
            case 'pool': {
                const id = identifier(request.target);
                const rules = validateRules(p.rules);
                const previous = await ctx.db.first<Pool>(`SELECT ${POOL_FIELDS.join(',')} FROM {pools} WHERE bot_id=? AND id=?`, ctx.botId, id);
                ensure(!previous || previous.state !== 'CLOSED' && previous.state !== 'ARCHIVED', 'POOL_TERMINAL');
                ensure(!previous || (JSON.parse(previous.rules) as Rules).kind === rules.kind, 'KIND_IMMUTABLE');
                guard = previous ? versionGuard(ctx, 'pools', id, request.expectedVersion)
                    : sql('NOT EXISTS(SELECT 1 FROM {pools} WHERE bot_id=? AND id=?) AND ?=0', ctx.botId, id, request.expectedVersion);

                for (const id of new Set(rules.awards.flatMap(award => award.prizeId ? [award.prizeId] : []))) {
                    guard = sql(`(${guard.sql}) AND EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND deleted=0)`, ...guard.params!, ctx.botId, id);
                }

                writes.push(sql(`INSERT INTO {pools}(bot_id,id,state,version,rules) VALUES(?,?,'DRAFT',1,?)
                    ON CONFLICT(bot_id,id) DO UPDATE SET rules=excluded.rules,version={pools}.version+1`, ctx.botId, id, JSON.stringify(rules)));
                const references = [...new Set(rules.awards.flatMap(award => award.prizeId ? [award.prizeId] : []))];
                const original = new Set(previous ? (JSON.parse(previous.rules) as Rules).awards.flatMap(award => award.prizeId ? [award.prizeId] : []) : []);
                const removed = [...original].filter(prize => !references.includes(prize));
                const added = references.filter(prize => !original.has(prize));

                if (removed.length) {
                    writes.push(sql(`DELETE FROM {pool_prizes} WHERE bot_id=? AND pool_id=? AND prize_id IN (${removed.map(() => '?').join(',')})`, ctx.botId, id, ...removed));
                }

                if (added.length) {
                    writes.push(sql(`INSERT INTO {pool_prizes}(bot_id,pool_id,prize_id) VALUES ${added.map(() => '(?,?,?)').join(',')}`,
                        ...added.flatMap(prize => [ctx.botId, id, prize])));
                }

                state = previous?.state ?? 'DRAFT';
                break;
            }
            case 'poolState': {
                const target = p.state;
                ensure(['ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'].includes(String(target)));
                const previous = await ctx.db.first<Pool>(`SELECT ${POOL_FIELDS.join(',')} FROM {pools} WHERE bot_id=? AND id=?`, ctx.botId, request.target);
                ensure(previous && previous.state !== 'ARCHIVED' && previous.state !== 'CLOSED', 'POOL_TERMINAL');
                const rules = validateRules(JSON.parse(previous.rules));

                const permission = target === 'ACTIVE' ? await access(ctx, control) : null;

                const check = versionGuard(ctx, 'pools', request.target, request.expectedVersion);
                guard = target === 'ACTIVE' ? sql(`${check.sql} AND EXISTS(SELECT 1 FROM {schema_meta} WHERE bot_id=? AND admission_enabled=1 AND admission_revision=? AND version=?)`,
                    ...check.params!, ctx.botId, permission!.admission_revision, permission!.version) : check;

                if (target === 'ACTIVE') {
                    const ids = [...new Set(rules.awards.flatMap(award => award.prizeId ? [award.prizeId] : []))];
                    const prizes = await stockSnapshots(ctx, ids);

                    for (const id of ids) {
                        const prize = prizes.find(prize => prize.id === id);
                        ensure(prize, 'PRIZE_NOT_READY');
                        guard = sql(`(${guard.sql}) AND EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND deleted=0)`,
                            ...guard.params!, ctx.botId, id);
                    }
                }

                writes.push(sql('UPDATE {pools} SET state=?,version=version+1 WHERE bot_id=? AND id=?', target, ctx.botId, request.target));

                state = String(target);
                break;
            }
            case 'stockCreate': {
                const id = identifier(request.target);
                const name = text(p.name, 120);
                delta = integer(p.amount, 1, 1_000_000);
                guard = sql('NOT EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=?) AND ?=0', ctx.botId, id, request.expectedVersion);
                writes.push(sql(`INSERT INTO {prizes}(bot_id,id,pool_id,name,stock_total,available,version) VALUES(?,?,'',?,?,?,1)`,
                    ctx.botId, id, name, delta, delta));
                stock = { id, name, available: delta, reserved: 0, fulfilled: 0, version: 1, deleted: 0, bound: false };
                break;
            }
            case 'stock':
            case 'stockRemove': {
                const id = identifier(request.target);
                const previous = await ctx.db.first<Prize & { bound: number }>(`SELECT *,${bindingExists()} AS bound FROM {prizes} WHERE bot_id=? AND id=?`, ctx.botId, id);
                ensure(previous, 'NOT_FOUND');
                ensure(!previous.deleted, 'PRIZE_REMOVED');
                const removing = request.action === 'stockRemove';
                const amount = removing ? 0 : integer(p.amount, 1, 1_000_000);

                if (!removing) { ensure(p.mode === 'ADD' || p.mode === 'RETIRE'); }

                guard = sql(`EXISTS(SELECT 1 FROM {prizes} WHERE bot_id=? AND id=? AND version=? AND deleted=0 AND (${bindingExists()})=?
                    ${removing ? 'AND reserved=0' : "AND (?='ADD' OR available>=?)"})`, ctx.botId, id, request.expectedVersion, previous.bound,
                    ...removing ? [] : [p.mode, amount]);
                stock = {
                    id, name: previous.name, available: previous.available, reserved: previous.reserved,
                    fulfilled: previous.fulfilled, version: request.expectedVersion + 1, deleted: 0, bound: !!previous.bound
                };

                if (request.action === 'stockRemove') {
                    ensure(!previous.bound && previous.reserved === 0, 'PRIZE_IN_USE');
                    writes.push(sql('UPDATE {prizes} SET deleted=1,version=version+1 WHERE bot_id=? AND id=?', ctx.botId, id));
                    stock.deleted = 1;
                    delta = 0;
                    state = 'REMOVED';
                } else {
                    delta = p.mode === 'ADD' ? amount : -amount;
                    stock.available += delta;
                    writes.push(p.mode === 'ADD'
                        ? sql('UPDATE {prizes} SET stock_total=stock_total+?,available=available+?,version=version+1 WHERE bot_id=? AND id=?', amount, amount, ctx.botId, id)
                        : sql('UPDATE {prizes} SET available=available-?,retired=retired+?,version=version+1 WHERE bot_id=? AND id=?', amount, amount, ctx.botId, id));
                }

                break;
            }
            case 'fulfill':
            case 'cancel': {
                const claim = await ctx.db.first<Claim>(`SELECT ${CLAIM_FIELDS.join(',')} FROM {claims} WHERE bot_id=? AND id=?`, ctx.botId, request.target);
                ensure(claim && claim.stock_state === 'RESERVED', 'CLAIM_STATE');
                const note = text(p.note, 1000);
                const cancel = request.action === 'cancel';
                ensure(claim.state === 'PENDING', 'CLAIM_STATE');
                ensure(!cancel || p.notDelivered === true && (p.inventory === 'RETURN' || p.inventory === 'RETIRE'), 'DELIVERY_CHECK_REQUIRED');
                guard = sql(`EXISTS(SELECT 1 FROM {draws} WHERE bot_id=? AND id=? AND state='SETTLED'
                    AND claim_id=? AND claim_version=? AND claim_stock_state='RESERVED' AND claim_state='PENDING')`,
                    ctx.botId, claim.draw_id, claim.id, request.expectedVersion);
                const mode = cancel ? p.inventory as 'RETURN' | 'RETIRE' : 'FULFILL';
                state = cancel ? 'CANCELLED' : 'FULFILLED';
                writes.push(...moveStock(claim, mode));
                writes.push(sql(`UPDATE {draws} SET claim_state=?,claim_stock_state=?,claim_version=claim_version+1,claim_note=?,claim_admin_op=?,archive_ready=1,
                    ${cancel ? 'claim_cancelled_at' : 'claim_fulfilled_at'}=${NOW},claim_processed_at=${NOW} WHERE bot_id=? AND claim_id=?`,
                    state, mode === 'RETURN' ? 'RETURNED' : mode === 'RETIRE' ? 'RETIRED' : 'FULFILLED', note,
                    request.operationId, ctx.botId, claim.id));
                break;
            }
            case 'recover': {
                const row = await ctx.db.first<Draw>('SELECT * FROM {draws} WHERE bot_id=? AND id=?', ctx.botId, request.target);
                ensure(row && !['SETTLED', 'FAILED', 'REFUNDED'].includes(row.state), 'DRAW_TERMINAL');
                text(p.note, 1000);
                const payload = body(row);
                const next = row.state === 'NEEDS_REVIEW' ? payload.priorState : row.state;
                ensure(next && next !== 'NEEDS_REVIEW', 'RECOVERY_EVIDENCE_REQUIRED');
                guard = sql(`EXISTS(SELECT 1 FROM {draws} WHERE bot_id=? AND id=? AND version=? AND lease_until<=${NOW})`,
                    ctx.botId, row.id, request.expectedVersion);
                const unresolved = payload.ops.find(op => !op.outcome && op.attempts >= 3);

                if (unresolved) {
                    payload.manualAttempts ??= {};
                    payload.manualAttempts[unresolved.input.operationId] = (payload.manualAttempts[unresolved.input.operationId] ?? 0) + 1;
                }

                const progress = progressPatch(row, payload);
                writes.push(sql('UPDATE {draws} SET state=?,body=?,version=version+1,error=NULL,retry_at=0 WHERE bot_id=? AND id=?',
                    next, progress.body, ctx.botId, row.id));
                state = 'ACCEPTED';
                break;
            }
            default: throw new Error('未知管理操作');
        }

        return {
            guard, writes, outcome: {
                ok: true, code: 'OK', target: request.target,
                version: request.expectedVersion + 1, ...(state ? { state } : {}), ...(delta !== undefined ? { delta } : {}), ...(stock ? { stock } : {}), ...(templates ? { templates } : {})
            }
        };
    });
}
