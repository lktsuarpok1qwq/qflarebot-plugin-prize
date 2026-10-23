import type { CommandInput, OutgoingMessage } from '@qqbot/sdk';
import type { Claim, Ctx, Draw, Meta, Pool, Rules } from '../contracts.js';
import { POOL_FIELDS } from '../contracts.js';
import { ensure, failure, identifier } from '../storage/db.js';
import { activePools, page } from '../storage/pages.js';
import { admit } from '../lottery/admission.js';
import { advance } from '../lottery/recovery.js';
import { money, probability } from '../lottery/rules.js';
import { stockSnapshots } from '../inventory/stock.js';
import { ready } from '../storage/schema.js';
import { configuration, message, piece, word } from './templates/render.js';
import { messageContext } from './templates/settings.js';
import { awardIcon, commandUrl, escapeMarkdown } from './templates/config.js';
import type { MessageModule } from './templates/fields.js';
import { joinItems } from './templates/layout.js';

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

function purchase(names: Commands, pool: Pick<Pool, 'id'>): string {
    return `${names.pool} 抽 ${pool.id}`;
}

function poolCard(ctx: Ctx, pool: Pool, names: Commands): string {
    const rules = JSON.parse(pool.rules) as Rules;

    return piece(ctx, 'pool', 'activityItem', {
        name: rules.name, cost: money(rules.cost), purchaseCommand: purchase(names, pool),
        purchaseUrl: link(ctx, purchase(names, pool)), probabilityUrl: link(ctx, `${names.pool} 奖项 ${pool.id}`)
    }, ['purchaseUrl', 'probabilityUrl']);
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
        return message(ctx, module, 'pending', { state: word(ctx, row.state === 'NEEDS_REVIEW' ? 'review' : 'processing'), id: row.short_id });
    }

    ensure(row.result_name && row.result_award_id, 'RESULT_EVIDENCE_MISSING');

    if (row.result_prize_id) {
        const needsState = /\{\{state\}\}/.test(configuration(ctx, module).replies.goodsWon!);
        const claim = needsState && row.claim_id && row.claim_state ? { state: row.claim_state } : null;

        if (needsState) { ensure(claim, 'NOT_FOUND'); }

        const instructions = piece(ctx, 'pool', 'goodsInstructions', { prizeUrl: link(ctx, names.prize) }, ['prizeUrl']);

        return message(ctx, 'pool', 'goodsWon', {
            prizeCommand: names.prize, name: row.result_name,
            state: claim ? word(ctx, 'claim_' + claim.state) : '', instructions
        }, ['instructions']);
    }

    const earnings = row.reward ? piece(ctx, module, 'earned', { reward: money(row.reward) }) : piece(ctx, module, 'noWin');

    // 购买按钮是操作入口，点击后按最新规则完整校验。

    return message(ctx, module, 'settled', { earnings, cost: money(row.cost), net: money(row.reward - row.cost), id: row.short_id }, ['earnings'], { buy: purchase(names, { id: row.pool_id }) }, { buyAllowed: true });
}

async function recordText(ctx: Ctx, row: Draw): Promise<string> {
    const module = 'pool';
    const award = row.result_prize_id && row.result_name ? { name: row.result_name } : undefined;

    if (row.state === 'SETTLED' && row.winner && row.reward === 0) { ensure(award, 'NOT_FOUND'); }

    const outcome = row.state !== 'SETTLED' ? piece(ctx, module, 'recordPending') : row.winner && row.reward === 0 && row.kind === 'POOL'
        ? piece(ctx, module, 'recordGoods', { name: award!.name }) : piece(ctx, module, 'recordReward', { reward: money(row.reward) });

    return piece(ctx, module, 'recordItem', { id: row.short_id, state: word(ctx, 'draw_' + row.state), cost: money(row.cost), outcome }, ['outcome']);
}

function claimLine(ctx: Ctx, claim: Claim): string {
    const name = claim.award_name;

    return piece(ctx, 'prize', 'item', {
        id: claim.short_id, name, state: word(ctx, 'claim_' + claim.state),
        time: new Date(claim.obtained_at! + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)
    });
}

async function listText(ctx: Ctx, result: Awaited<ReturnType<typeof page>>, command: string, module: Exclude<MessageModule, 'common'>): Promise<OutgoingMessage> {
    const rows: string[] = [];

    for (const row of result.rows) {
        rows.push('obtained_at' in row ? claimLine(ctx, row) : await recordText(ctx, row));
    }

    const nextCommand = result.next ? module === 'pool'
        ? `${command} 记录${result.scope.pool ? ' ' + result.scope.pool : ''} ~${result.next}` : `${command} ~${result.next}` : '';
    const items = joinItems(module, configuration(ctx, module), module === 'prize' ? 'item' : 'recordItem', rows) || piece(ctx, module, module === 'prize' ? 'empty' : 'noRecords');

    return message(ctx, module, module === 'prize' ? 'list' : 'records', { items, nextCommand }, ['items'], { next: nextCommand });
}

async function prize(input: CommandInput, names: Commands, control: Meta): Promise<OutgoingMessage> {
    const { ctx, session, args } = input;
    const cursor = args[0];
    ensure(args.length <= 1 && (!cursor || cursor.startsWith('~') && cursor.length > 1), 'INVALID_ARGUMENT');

    return listText(ctx, await page(ctx, 'claims', { user: session.userId, settled: true }, 5, cursor?.slice(1), control), names.prize, 'prize');
}

async function lottery(input: CommandInput, names: Commands, control: Meta): Promise<OutgoingMessage> {
    const { ctx, session, args } = input;
    const [action, arg] = args;
    const kind = 'POOL';
    const module = 'pool';
    const command = names.pool;

    if (action === '记录') {
        ensure(args.length <= 3);
        const pool = arg && !arg.startsWith('~') ? identifier(arg) : undefined;
        const cursor = pool ? args[2] : arg;
        ensure(!cursor || cursor.startsWith('~') && cursor.length > 1);
        ensure(pool || args.length <= 2);

        return listText(ctx, await page(ctx, 'draws', { user: session.userId, kind, ...pool ? { pool } : {} }, 5, cursor?.slice(1), control), command, module);
    }

    if (action === '抽') {
        ensure(args.length === 2 && arg, 'INVALID_ARGUMENT');
        const row = await admit(ctx, session, kind, identifier(arg), 1, { control, holdLease: true });

        return displayDraw(ctx, await advance(ctx, row, 4), names);
    }

    if (action === '奖项') {
        ensure(args.length === 2);
        const pool = await ctx.db.first<Pool>(`SELECT ${POOL_FIELDS.join(',')} FROM {pools} WHERE bot_id=? AND id=?`, ctx.botId, arg);
        ensure(pool, 'NOT_FOUND');
        const rules = JSON.parse(pool.rules) as Rules;
        const ids = [...new Set(rules.awards.flatMap(a => a.prizeId ? [a.prizeId] : []))];
        const stock = await stockSnapshots(ctx, ids);
        const active = rules.awards.filter(a => !a.prizeId || stock.some(p => p.id === a.prizeId && p.available > 0));
        const total = active.reduce((n, a) => n + a.weight, 0);

        const items = joinItems(module, configuration(ctx, module), 'probabilityItem', active.map(a => piece(ctx, module, 'probabilityItem', {
            label: a.label, probability: probability(a.weight, total),
            icon: awardIcon(configuration(ctx, module), a.type),
            reward: a.prizeId ? escapeMarkdown(a.name) : piece(ctx, module, 'recordReward', { reward: money(a.reward) })
        }, ['reward']))) || piece(ctx, module, 'noCandidates');

        return message(ctx, module, 'probability', { name: rules.name, cost: money(rules.cost), state: word(ctx, 'pool_' + pool.state), items, time: new Date().toISOString() }, ['items'], { buy: purchase(names, pool) }, { buyAllowed: pool.state === 'ACTIVE' && Date.now() >= rules.starts && Date.now() < rules.ends && total > 0 });
    }

    if (!action || action.startsWith('~')) {
        ensure(args.length <= 1 && (!action || action.length > 1));
        const pools = await activePools(ctx, control, action?.slice(1));
        const items = joinItems(module, configuration(ctx, module), 'activityItem', pools.rows.map(pool => poolCard(ctx, pool, names))) || piece(ctx, module, 'noActivities');
        const nextCommand = pools.next ? `${command} ~${pools.next}` : '';

        return message(ctx, module, 'activities', { items, nextCommand }, ['items'], { next: nextCommand });
    }

    return message(ctx, module, 'help', { command });
}

export async function command(input: CommandInput, entry: 'pool' | 'prize'): Promise<OutgoingMessage> {
    const names = commandNames(input);
    let ctx = input.ctx;

    try {
        const control = await ready(input.ctx, true);
        const privateOnly = entry === 'prize' && input.session.scene !== 'c2c';
        ctx = await messageContext(ctx, privateOnly ? 'common' : entry, control);
        ctx = { ...ctx, config: { ...ctx.config as object, prizeNavigation: { userId: input.session.userId, scene: input.session.scene, commands: { pool: names.pool, records: names.pool + ' 记录', prizes: names.prize, account: names.points + ' 开户' } } } };
        ensure(input.session.botId === input.ctx.botId && input.session.userId && input.session.targetId, 'IDENTITY_REQUIRED');

        if (privateOnly) { return message(ctx, 'common', 'privateOnly', { prizeCommand: names.prize }); }

        return entry === 'prize' ? await prize({ ...input, ctx }, names, control) : await lottery({ ...input, ctx }, names, control);
    } catch (error) {
        const code = failure(error).code;

        return code === 'INVALID_ARGUMENT' ? message(ctx, entry, 'help', entry === 'prize' ? { prizeCommand: names.prize } : { command: names.pool })
            : errorMessage(ctx, code, names);
    }
}
