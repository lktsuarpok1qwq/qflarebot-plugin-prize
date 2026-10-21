import type { CommandInput, OutgoingMessage } from '@qqbot/sdk';
import type { Award, Claim, Ctx, Draw, Pool, Rules } from '../contracts.js';
import { ensure, failure, meta, NOW } from '../storage/db.js';
import { page, continuePage } from '../storage/pages.js';
import { archived } from '../archive/jobs.js';
import { admit } from '../lottery/admission.js';
import { advance } from '../lottery/recovery.js';
import { money } from '../lottery/rules.js';
import { act } from '../inventory/claims.js';
import { ready } from '../storage/schema.js';
import { configuration, message, piece, word } from './templates/render.js';
import { messageContext } from './templates/settings.js';
import type { MessageModule } from './templates/fields.js';

type Commands = { pool: string; prize: string; points: string };

function commandNames(input: CommandInput): Commands {
    const content = input.session.content.trim();
    const head = (input.argText ? content.slice(0, -input.argText.length) : content).trimEnd();
    const prefix = head.endsWith(input.command) ? head.slice(0, -input.command.length) : '';

    return { pool: prefix + '抽奖', prize: prefix + '兑奖', points: prefix + '积分' };
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

        return message(ctx, module, 'pending', { state: word(ctx, row.state === 'NEEDS_REVIEW' ? 'review' : 'processing'), id: row.short_id, continueCommand: command }, [], { continue: command });
    }

    const full = await archived(ctx, 'draws', row) as Draw;
    const payload = full.body ? JSON.parse(full.body) as { results?: Award[] } : {};
    const results = payload.results ?? [];

    if (results.some(a => a.prizeId)) { return message(ctx, 'pool', 'goodsWon', { prizeCommand: names.prize, name: results.find(a => a.prizeId)!.name }); }

    const earnings = row.reward ? piece(ctx, module, 'earned', { reward: money(row.reward) }) : piece(ctx, module, 'noWin');

    return message(ctx, module, 'settled', { earnings, cost: money(row.cost), net: money(row.reward - row.cost), id: row.short_id }, ['earnings']);
}

function recordText(ctx: Ctx, row: Draw): string {
    const module = 'pool';
    const outcome = row.state !== 'SETTLED' ? piece(ctx, module, 'recordPending') : row.winner && row.reward === 0 && row.kind === 'POOL'
        ? piece(ctx, module, 'recordGoods') : piece(ctx, module, 'recordReward', { reward: money(row.reward) });

    return piece(ctx, module, 'recordItem', { id: row.short_id, state: word(ctx, 'draw_' + row.state), cost: money(row.cost), outcome }, ['outcome']);
}

function claimLine(ctx: Ctx, claim: Claim): string {
    const name = claim.award ? (JSON.parse(claim.award) as Award).name : claim.prize_id;
    const deadline = claim.expires_at ? piece(ctx, 'prize', 'deadline', { expires: new Date(claim.expires_at + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19) }) : '';

    return piece(ctx, 'prize', 'item', { id: claim.short_id, name, state: word(ctx, 'claim_' + claim.state), deadline }, ['deadline']);
}

async function listText(ctx: Ctx, result: Awaited<ReturnType<typeof page>>, command: string, module: Exclude<MessageModule, 'common'>): Promise<OutgoingMessage> {
    const rows: string[] = [];

    for (const row of result.rows) {
        rows.push('obtained_at' in row ? claimLine(ctx, await archived(ctx, 'claims', row) as Claim) : recordText(ctx, row));
    }

    const nextCommand = result.next ? `${command} 翻页 ${result.next}` : '';
    const items = rows.join('\n\n') || piece(ctx, module, module === 'prize' ? 'empty' : 'noRecords');

    return message(ctx, module, module === 'prize' ? 'list' : 'records', { items, nextCommand }, ['items'], { next: nextCommand });
}

async function prize(input: CommandInput, names: Commands): Promise<OutgoingMessage> {
    const { ctx, session, args, argText } = input;

    if (session.scene !== 'c2c') { return message(ctx, 'common', 'privateOnly', { prizeCommand: names.prize }); }

    await meta(ctx);
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

        return message(ctx, 'prize', 'actionResult', { action: word(ctx, action === '领取' ? 'actionClaim' : 'actionDetails'), info: claimLine(ctx, full), detailsVersion: String(row.details_version) }, ['info']);
    }

    ensure(args.length === 1 && action.startsWith('P'));
    const row = await ctx.db.first<Claim>(`SELECT c.* FROM {claims} c JOIN {draws} d ON d.bot_id=c.bot_id AND d.id=c.draw_id
        WHERE c.bot_id=? AND c.user_id=? AND c.short_id=? AND d.state='SETTLED'`, ctx.botId, session.userId, action);
    ensure(row, 'NOT_FOUND');
    const full = await archived(ctx, 'claims', row) as Claim;

    const instructions = piece(ctx, 'prize', row.state === 'CLAIMED' ? 'claimedInstructions' : 'pendingInstructions', { prizeCommand: names.prize, id: row.short_id, detailsVersion: String(row.details_version) });

    return message(ctx, 'prize', 'detail', { info: claimLine(ctx, full), detailsVersion: String(row.details_version), instructions }, ['info', 'instructions']);
}

async function lottery(input: CommandInput, names: Commands, singleStage: boolean): Promise<OutgoingMessage> {
    const { ctx, session, args } = input;
    const [action, arg] = args;
    const kind = 'POOL';
    const module = 'pool';
    const command = names.pool;
    await meta(ctx);

    if (action === '继续') {
        ensure(args.length === 2);
        const row = await ctx.db.first<Draw>('SELECT * FROM {draws} WHERE bot_id=? AND user_id=? AND short_id=? AND kind=?',
            ctx.botId, session.userId, arg, kind);
        ensure(row, 'NOT_FOUND');

        return displayDraw(ctx, await advance(ctx, row.id, singleStage), names);
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

        return displayDraw(ctx, await advance(ctx, row.id, singleStage), names);
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

        return message(ctx, module, 'probability', { name: rules.name, state: word(ctx, 'pool_' + pool.state), items, time: new Date().toISOString() }, ['items']);
    }

    if (!action) {
        const pools = await ctx.db.all<Pool>(`SELECT * FROM {pools} WHERE bot_id=? AND state='ACTIVE'
            AND json_extract(rules,'$.kind')=? AND json_extract(rules,'$.starts')<=${NOW} AND json_extract(rules,'$.ends')>${NOW}
            ORDER BY id LIMIT 20`, ctx.botId, kind);

        const items = pools.map(p => {
            const r = JSON.parse(p.rules) as Rules;

            return piece(ctx, module, 'activityItem', { name: r.name, cost: money(r.cost), purchaseCommand: names.pool + ' 抽 ' + p.id });
        }).join('\n\n') || piece(ctx, module, 'noActivities');

        return message(ctx, module, 'activities', { items }, ['items']);
    }

    return message(ctx, module, 'help', { command });
}

export async function command(input: CommandInput, entry: 'pool' | 'prize'): Promise<OutgoingMessage> {
    const names = commandNames(input);
    let ctx = input.ctx;

    try {
        const verifiedNow = await ready(input.ctx, true);
        ctx = await messageContext(ctx, entry);
        ensure(input.session.botId === input.ctx.botId && input.session.userId && input.session.targetId, 'IDENTITY_REQUIRED');

        return entry === 'prize' ? await prize({ ...input, ctx }, names) : await lottery({ ...input, ctx }, names, verifiedNow);
    } catch (error) {
        const code = failure(error).code;

        return code === 'INVALID_ARGUMENT' ? message(ctx, entry, 'help', entry === 'prize' ? { prizeCommand: names.prize } : { command: names.pool })
            : errorMessage(ctx, code, names);
    }
}
