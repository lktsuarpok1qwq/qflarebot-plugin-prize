import type { CommandInput, OutgoingMessage } from '@qqbot/sdk';
import type { Award, Claim, Ctx, Draw, Pool, Rules } from '../contracts.js';
import { ensure, failure, NOW } from '../storage/db.js';
import { page, continuePage } from '../storage/pages.js';
import { archived } from '../archive/jobs.js';
import { admit } from '../lottery/admission.js';
import { advance } from '../lottery/recovery.js';
import { money } from '../lottery/rules.js';
import { act } from '../inventory/claims.js';
import { ready } from '../storage/schema.js';
import { configuration, message, piece, word } from './templates/render.js';
import { messageContext } from './templates/settings.js';
import { commandUrl } from './templates/config.js';
import type { MessageModule } from './templates/fields.js';

type Commands = { pool: string; prize: string; points: string };

function commandNames(input: CommandInput): Commands {
    const content = input.session.content.trim();
    const head = (input.argText ? content.slice(0, -input.argText.length) : content).trimEnd();
    const prefix = head.endsWith(input.command) ? head.slice(0, -input.command.length) : '';

    return { pool: prefix + '抽奖', prize: prefix + '兑奖', points: prefix + '积分' };
}

function link(ctx: Ctx, command: string, enter = true): string {
    const scene = (ctx.config as { prizeNavigation?: { scene: string } })?.prizeNavigation?.scene;

    return commandUrl(command, enter && scene === 'c2c');
}

function errorMessage(ctx: Ctx, code: string, names: Commands): OutgoingMessage {
    if (code === 'ACCOUNT_NOT_FOUND') { return message(ctx, 'common', 'accountRequired', { pointsCommand: names.points }); }

    if (code === 'PRIVATE_ONLY') { return message(ctx, 'common', 'privateOnly', { prizeCommand: names.prize }); }

    const description = configuration(ctx, 'common').words[code] ?? word(ctx, 'UNAVAILABLE');

    return message(ctx, 'common', 'error', { message: description, code });
}

async function displayDraw(ctx: Ctx, row: Draw, names: Commands): Promise<OutgoingMessage> {
    const module = 'pool';

    if (row.state === 'FAILED') { return errorMessage(ctx, row.error ?? 'UNAVAILABLE', names); }

    if (row.state === 'REFUNDED') { return message(ctx, module, 'refunded', { id: row.short_id }); }

    if (row.state !== 'SETTLED') {
        const command = `${names.pool} 继续 ${row.short_id}`;

        return message(ctx, module, 'pending', { state: word(ctx, row.state === 'NEEDS_REVIEW' ? 'review' : 'processing'), id: row.short_id, continueCommand: command, continueUrl: link(ctx, command) }, ['continueUrl'], { continue: command });
    }

    const full = await archived(ctx, 'draws', row) as Draw;
    const payload = full.body ? JSON.parse(full.body) as { results?: Award[]; claimId?: string } : {};
    const results = payload.results ?? [];

    if (results.some(a => a.prizeId)) { return message(ctx, 'pool', 'goodsWon', { prizeCommand: names.prize, name: results.find(a => a.prizeId)!.name }, [], { claim: (ctx.config as { prizeNavigation?: { scene: string } })?.prizeNavigation?.scene === 'c2c' && payload.claimId ? `${names.prize} 领取 P${payload.claimId.replaceAll('-', '')}` : '' }); }

    const earnings = row.reward ? piece(ctx, module, 'earned', { reward: money(row.reward) }) : piece(ctx, module, 'noWin');

    return message(ctx, module, 'settled', { earnings, cost: money(row.cost), net: money(row.reward - row.cost), id: row.short_id }, ['earnings'], { buy: `${names.pool} 抽 ${row.pool_id}` });
}

function recordText(ctx: Ctx, row: Draw, command: string): string {
    const module = 'pool';
    const outcome = row.state !== 'SETTLED' ? piece(ctx, module, 'recordPending') : row.winner && row.reward === 0 && row.kind === 'POOL'
        ? piece(ctx, module, 'recordGoods') : piece(ctx, module, 'recordReward', { reward: money(row.reward) });

    return piece(ctx, module, 'recordItem', { id: row.short_id, state: word(ctx, 'draw_' + row.state), cost: money(row.cost), outcome, continueUrl: link(ctx, command + ' 继续 ' + row.short_id) }, ['outcome', 'continueUrl']);
}

function claimLine(ctx: Ctx, claim: Claim, command: string): string {
    const name = claim.award ? (JSON.parse(claim.award) as Award).name : claim.prize_id;
    const deadline = claim.expires_at ? piece(ctx, 'prize', 'deadline', { expires: new Date(claim.expires_at + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19) }) : '';

    return piece(ctx, 'prize', 'item', { id: claim.short_id, name, state: word(ctx, 'claim_' + claim.state), deadline, detailUrl: link(ctx, command + ' ' + claim.short_id) }, ['deadline', 'detailUrl']);
}

async function listText(ctx: Ctx, result: Awaited<ReturnType<typeof page>>, command: string, module: Exclude<MessageModule, 'common'>): Promise<OutgoingMessage> {
    const rows: string[] = [];

    for (const row of result.rows) {
        rows.push('obtained_at' in row ? claimLine(ctx, await archived(ctx, 'claims', row) as Claim, command) : recordText(ctx, row, command));
    }

    const nextCommand = result.next ? `${command} 翻页 ${result.next}` : '';
    const items = rows.join('\n\n') || piece(ctx, module, module === 'prize' ? 'empty' : 'noRecords');

    const claim = module === 'prize' ? result.rows.find(row => row.state === 'PENDING') as Claim | undefined : undefined;

    return message(ctx, module, module === 'prize' ? 'list' : 'records', { items, nextCommand }, ['items'], { next: nextCommand, claim: claim ? command + ' 领取 ' + claim.short_id : '' });
}

async function prize(input: CommandInput, names: Commands): Promise<OutgoingMessage> {
    const { ctx, session, args, argText } = input;

    if (session.scene !== 'c2c') { return message(ctx, 'common', 'privateOnly', { prizeCommand: names.prize }); }

    const [action, short] = args;

    if (!action || action === '记录') {
        ensure(args.length <= 1, 'INVALID_ARGUMENT');

        return listText(ctx, await page(ctx, 'claims', { user: session.userId, history: action === '记录' }, 5), names.prize, 'prize');
    }

    if (action === '翻页') {
        ensure(args.length === 2);

        return listText(ctx, await continuePage(ctx, short!, session.userId, 'PRIZES'), names.prize, 'prize');
    }

    if (['领取', '资料'].includes(action)) {
        ensure(action === '资料' || args.length <= 2);
        const match = action === '资料' ? /^资料\s+(\S+)\s+(\d+)\s+([\s\S]+)$/.exec(argText) : null;
        ensure(action !== '资料' || match, 'INVALID_ARGUMENT');
        const result = await act(ctx, session, action === '领取' ? 'claim' : 'details',
            short, match ? Number(match[2]) : undefined, match?.[3]);

        if (!result.ok) { return errorMessage(ctx, result.code, names); }

        const row = await ctx.db.first<Claim>('SELECT * FROM {claims} WHERE bot_id=? AND id=? AND user_id=?', ctx.botId, result.target, session.userId);
        ensure(row, 'NOT_FOUND');
        const full = await archived(ctx, 'claims', row) as Claim;

        return message(ctx, 'prize', 'actionResult', { action: word(ctx, action === '领取' ? 'actionClaim' : 'actionDetails'), info: claimLine(ctx, full, names.prize), detailsVersion: String(row.details_version) }, ['info'], { details: row.state === 'CLAIMED' ? `${names.prize} 资料 ${row.short_id} ${row.details_version} ` : '' });
    }

    ensure(args.length === 1 && action.startsWith('P'));
    const row = await ctx.db.first<Claim>(`SELECT c.* FROM {claims} c JOIN {draws} d ON d.bot_id=c.bot_id AND d.id=c.draw_id
        WHERE c.bot_id=? AND c.user_id=? AND c.short_id=? AND d.state='SETTLED'`, ctx.botId, session.userId, action);
    ensure(row, 'NOT_FOUND');
    const full = await archived(ctx, 'claims', row) as Claim;

    const claimCommand = row.state === 'PENDING' ? `${names.prize} 领取 ${row.short_id}` : '';
    const detailsCommand = row.state === 'CLAIMED' ? `${names.prize} 资料 ${row.short_id} ${row.details_version} ` : '';
    const instructions = claimCommand || detailsCommand ? piece(ctx, 'prize', row.state === 'CLAIMED' ? 'claimedInstructions' : 'pendingInstructions', { prizeCommand: names.prize, id: row.short_id, detailsVersion: String(row.details_version), claimUrl: link(ctx, claimCommand), detailsUrl: link(ctx, detailsCommand, false) }, ['claimUrl', 'detailsUrl']) : '';

    return message(ctx, 'prize', 'detail', { info: claimLine(ctx, full, names.prize), detailsVersion: String(row.details_version), instructions }, ['info', 'instructions'], { claim: claimCommand, details: detailsCommand });
}

async function lottery(input: CommandInput, names: Commands): Promise<OutgoingMessage> {
    const { ctx, session, args } = input;
    const [action, arg] = args;
    const kind = 'POOL';
    const module = 'pool';
    const command = names.pool;

    if (action === '继续') {
        ensure(args.length === 2);
        const row = await ctx.db.first<Draw>('SELECT * FROM {draws} WHERE bot_id=? AND user_id=? AND short_id=? AND kind=?',
            ctx.botId, session.userId, arg, kind);
        ensure(row, 'NOT_FOUND');

        return displayDraw(ctx, await advance(ctx, row.id, 4), names);
    }

    if (action === '记录') {
        ensure(args.length <= 2);

        return listText(ctx, await page(ctx, 'draws', { user: session.userId, kind, ...arg ? { pool: arg } : {} }, 5), command, module);
    }

    if (action === '翻页') {
        ensure(args.length === 2);

        return listText(ctx, await continuePage(ctx, arg!, session.userId, kind), command, module);
    }

    if (action === '抽') {
        ensure(args.length === 2 && arg, 'INVALID_ARGUMENT');
        const row = await admit(ctx, session, kind, arg!, 1);

        return displayDraw(ctx, await advance(ctx, row.id, 4), names);
    }

    if (action === '概率') {
        ensure(args.length === 2);
        const pool = await ctx.db.first<Pool>("SELECT * FROM {pools} WHERE bot_id=? AND id=?", ctx.botId, arg);
        ensure(pool, 'NOT_FOUND');
        const rules = JSON.parse(pool.rules) as Rules;
        const ids = [...new Set(rules.awards.flatMap(a => a.prizeId ? [a.prizeId] : []))];
        const stock = await ctx.db.all<{ id: string; available: number }>(`SELECT id,available FROM {prizes} WHERE bot_id=? AND deleted=0 AND id IN (${ids.map(() => '?').join(',') || 'NULL'})`,
            ctx.botId, ...ids);
        const active = rules.awards.filter(a => !a.prizeId || stock.some(p => p.id === a.prizeId && p.available > 0));
        const total = active.reduce((n, a) => n + a.weight, 0);

        const items = active.map(a => piece(ctx, module, 'probabilityItem', { label: a.label, probability: (a.weight / total * 100).toFixed(4) })).join('\n') || piece(ctx, module, 'noCandidates');

        return message(ctx, module, 'probability', { name: rules.name, state: word(ctx, 'pool_' + pool.state), items, time: new Date().toISOString() }, ['items'], { buy: pool.state === 'ACTIVE' && Date.now() >= rules.starts && Date.now() < rules.ends && total > 0 ? `${names.pool} 抽 ${pool.id}` : '' });
    }

    if (!action) {
        const pools = await ctx.db.all<Pool>(`SELECT * FROM {pools} WHERE bot_id=? AND state='ACTIVE'
            AND json_extract(rules,'$.kind')=? AND json_extract(rules,'$.starts')<=${NOW} AND json_extract(rules,'$.ends')>${NOW}
            ORDER BY id LIMIT 20`, ctx.botId, kind);

        const items = pools.map(p => {
            const r = JSON.parse(p.rules) as Rules;

            return piece(ctx, module, 'activityItem', { name: r.name, cost: money(r.cost), purchaseCommand: names.pool + ' 抽 ' + p.id, purchaseUrl: link(ctx, names.pool + ' 抽 ' + p.id), probabilityUrl: link(ctx, names.pool + ' 概率 ' + p.id) }, ['purchaseUrl', 'probabilityUrl']);
        }).join('\n\n') || piece(ctx, module, 'noActivities');

        return message(ctx, module, 'activities', { items }, ['items']);
    }

    return message(ctx, module, 'help', { command });
}

export async function command(input: CommandInput, entry: 'pool' | 'prize'): Promise<OutgoingMessage> {
    const names = commandNames(input);
    let ctx = input.ctx;

    try {
        const control = await ready(input.ctx, true);
        ctx = await messageContext(ctx, entry, control);
        ctx = { ...ctx, config: { ...ctx.config as object, prizeNavigation: { userId: input.session.userId, scene: input.session.scene, commands: { pool: names.pool, records: names.pool + ' 记录', prizes: names.prize, history: names.prize + ' 记录', account: names.points + ' 开户' } } } };
        ensure(input.session.botId === input.ctx.botId && input.session.userId && input.session.targetId, 'IDENTITY_REQUIRED');

        return entry === 'prize' ? await prize({ ...input, ctx }, names) : await lottery({ ...input, ctx }, names);
    } catch (error) {
        const code = failure(error).code;

        return code === 'INVALID_ARGUMENT' ? message(ctx, entry, 'help', entry === 'prize' ? { prizeCommand: names.prize } : { command: names.pool })
            : errorMessage(ctx, code, names);
    }
}
