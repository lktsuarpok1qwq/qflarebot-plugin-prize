import type { DrawState } from '../../contracts.js';

const states = {
    CREATED: ['扣款处理中', 'warning'], DEBITED: ['已扣款，待发奖', 'warning'], DRAWN: ['已开奖，待结算', 'warning'],
    SETTLING: ['结算中', 'warning'], CANCELLING: ['取消处理中', 'warning'], SETTLED: ['已完成', 'success'],
    FAILED: ['已失败', 'danger'], REFUNDED: ['已退款', ''], NEEDS_REVIEW: ['待核查', 'danger']
} satisfies Record<DrawState, [string, string]>;

export const recordsUI = String.raw`function initRecordView({ $, button, message, node, state, toast }) {
const drawStates = ${JSON.stringify(states)};
const claimStates = { LOCKED: '处理中', PENDING: '待发放', FULFILLED: '已发放', CANCELLED: '已撤销' };

function claimTime(at) { return at ? new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : '—'; }


function points(value) {
    const amount = BigInt(value);
    const absolute = amount < 0n ? -amount : amount;
    const fraction = String(absolute % 100n).padStart(2, '0').replace(/0+$/, '');

    return (amount < 0n ? '-' : '') + String(absolute / 100n) + (fraction ? '.' + fraction : '') + ' 积分';
}

function description(fields) {
    const list = node('dl', undefined, 'detail-grid');

    for (const [name, value] of fields) { list.append(node('dt', name), value instanceof Node ? value : node('dd', String(value ?? '—'))); }

    return list;
}

function identifier(value) {
    const item = node('dd', undefined, 'copy-value');
    item.append(node('code', value || '—'));

    if (value) {
        item.append(button('复制', async () => {
            try { await navigator.clipboard.writeText(value); } catch {
                const input = node('textarea');
                input.value = value;
                input.style.position = 'fixed';
                input.style.opacity = '0';
                document.body.append(input);
                input.select();
                const copied = document.execCommand('copy');
                input.remove();

                if (!copied) { throw new Error('复制不可用，请选中编号复制'); }
            }

            toast('已复制', 'success');
        }));
    }

    return item;
}

function statusBadge(code) {
    const [label, tone] = drawStates[code] || ['未知状态', 'danger'];
    const badge = node('span', label, 'status-badge');
    badge.dataset.tone = tone;

    return badge;
}

function recordCard(row, name) {
    const card = node('article', undefined, 'record-card');
    const heading = node('div', undefined, 'record-heading');
    heading.append(node('h3', name || row.poolName || '奖池 ' + row.pool_id), statusBadge(row.state));
    const meta = node('div', undefined, 'record-meta');
    const goods = row.goodsNames || drawBody(row)?.results?.filter(award => ['PHYSICAL', 'VIRTUAL_MANUAL'].includes(award.type)).map(award => award.name);
    const reward = goods?.length ? goods.join('、') : row.reward || !row.winner ? points(row.reward) : '奖项（查看详情）';
    meta.append(node('div', '用户：' + row.user_id));
    meta.append(node('div', row.state === 'SETTLED' ? '消耗 ' + points(row.cost) + ' · 获得 ' + reward
        : row.state === 'REFUNDED' ? '已退回 ' + points(row.cost) : '价格 ' + points(row.cost)));
    meta.append(node('div', '购买时间：' + claimTime(row.created_at).slice(0, 16) + '（北京时间）'));
    card.append(heading, meta);

    return card;
}

function drawBody(draw) {
    return typeof draw.body === 'string' ? JSON.parse(draw.body) : draw.body;
}

function canRecover(draw) {
    if (!draw || !drawStates[draw.state] || ['SETTLED', 'FAILED', 'REFUNDED'].includes(draw.state)) { return false; }

    const body = drawBody(draw);

    return Array.isArray(body?.ops) && Number.isSafeInteger(draw.version) && draw.lease_until <= Date.now()
        && (draw.state !== 'NEEDS_REVIEW' || Object.hasOwn(drawStates, body.priorState) && !['NEEDS_REVIEW', 'SETTLED', 'FAILED', 'REFUNDED'].includes(body.priorState));
}

function showDraw(draw) {
    const body = drawBody(draw);
    const content = $('drawText');
    content.replaceChildren(recordCard(draw, body?.rules?.name), node('h3', '基本信息'), description([
        ['业务编号', identifier(draw.short_id)], ['奖池编号', identifier(draw.pool_id)],
        ['结算时间（北京）', claimTime(draw.settled_at)]
    ]), node('h3', '积分收支'), description([
        ['购买价格', points(draw.cost)], ['已结算积分奖励', draw.state === 'SETTLED' ? points(draw.reward) : '尚未结算'],
        ['净积分消耗', draw.state === 'SETTLED' ? points(BigInt(draw.cost) - BigInt(draw.reward)) : '尚未结算']
    ]));
    content.append(node('p', '净积分消耗不包含商品价值', 'stats-note'), node('h3', draw.state === 'SETTLED' ? '抽奖结果' : '预备奖项'));

    if (body?.results?.length) {
        for (const award of body.results) {
            content.append(description([
                ['奖项', award.label || award.name],
                ['奖励', ['NONE', 'POINTS'].includes(award.type) ? points(award.reward) : award.name]
            ]));
        }

        if (draw.state !== 'SETTLED') { content.append(node('p', '预备奖项不代表已获得奖励', 'stats-note')); }
    } else { content.append(node('p', '尚未形成抽奖结果', 'muted')); }

    if (draw.error) { content.append(node('h3', '处理提示'), node('p', message(draw.error), 'record-error')); }

    if (body?.ops?.length) {
        const operations = node('details');
        operations.append(node('summary', '资金处理记录'));

        for (const operation of body.ops) {
            operations.append(description([
                ['操作', ({ burn: '扣除积分', credit: '发放积分', reverseOwn: '退回原扣款' })[operation.method] || '资金操作'],
                ['结果', ({ COMMITTED: '已确认成功', REJECTED: '已确定拒绝' })[operation.outcome] || '等待确认'],
                ['操作编号', identifier(operation.input?.operationId)]
            ]));
        }

        content.append(operations);
    }

    state.draw = draw;
    $('drawDetail').hidden = false;
    $('openRecovery').hidden = !canRecover(draw);
    $('recoveryPanel').hidden = true;
    $('recoveryEmpty').hidden = false;
    $('recoveryNote').value = '';
    state.focusAfter = $('closeDraw');
}

function metricCards(values, definitions) {
    const grid = node('dl', undefined, 'metric-grid');

    for (const [key, name, money] of definitions) {
        const card = node('div', undefined, 'metric-card');
        const value = values[key] || '0';
        card.append(node('dt', name), node('dd', money ? points(value) : BigInt(value).toLocaleString('zh-CN')));
        grid.append(card);
    }

    return grid;
}

function renderStatistics(data) {
    if (data?.complete !== true || !data.query || !Array.isArray(data.buckets)) { throw new Error('统计响应不完整，请重新查询'); }

    const family = data.query.family;
    const required = ({ transactions: ['commands', 'wins', 'cost', 'reward', 'net'], awards: ['hits', 'reward'], claimEvents: ['count'], claimStates: ['count'], participation: ['participations', 'pending'] })[family];

    if (!required || data.buckets.some(bucket => !bucket?.values || !required.every(key => typeof bucket.values[key] === 'string' && /^-?\d+$/.test(bucket.values[key])))) { throw new Error('统计指标不完整，请重新查询'); }

    const sums = Object.create(null);

    for (const bucket of data.buckets) {
        for (const [key, value] of Object.entries(bucket.values)) {
            const name = family === 'claimEvents' || family === 'claimStates' ? bucket.event : key;
            sums[name] = String(BigInt(sums[name] || '0') + BigInt(value));
        }
    }

    const definitions = {
        transactions: [['commands', '抽奖次数'], ['wins', '中奖次数'], ['cost', '消耗积分', true], ['reward', '奖励积分', true], ['net', '净积分消耗', true]],
        awards: [['hits', '奖项命中次数'], ['reward', '积分奖励合计', true]],
        claimEvents: [['obtained', '获得奖品'], ['fulfilled', '已发放'], ['cancelled', '已撤销']],
        claimStates: [['PENDING', '待发放'], ['FULFILLED', '已发放'], ['CANCELLED', '已撤销']],
        participation: [['participations', '有效参与次数'], ['pending', '处理中占用次数']]
    }[family];

    if (!definitions) { throw new Error('统计类型无效'); }

    if (family === 'claimStates' && BigInt(sums.LOCKED || '0') > 0n) { definitions.unshift(['LOCKED', '处理中']); }

    const content = $('statsResult');
    const from = claimTime(data.query.from).slice(0, 10), to = claimTime(data.query.to - 1).slice(0, 10);
    content.replaceChildren(node('p', family === 'claimStates' ? '截至本次查询：' + claimTime(data.currentStateTime) + '（北京时间）'
        : from + ' 至 ' + to + '（北京时间，包含首尾日期）', 'stats-note'));

    if (!data.buckets.length) { content.append(node('p', family === 'claimStates' ? '当前暂无已获得奖品' : '该范围暂无记录', 'muted')); }

    content.append(metricCards(sums, definitions));

    if (family === 'transactions') { content.append(node('p', '净积分消耗＝消耗积分－奖励积分，不含商品价值', 'stats-note')); }

    if (family === 'awards') {
        const groups = new Map();

        for (const bucket of data.buckets) {
            const key = JSON.stringify([bucket.pool, bucket.award, bucket.prize]);
            const row = groups.get(key) || { ...bucket, values: { hits: '0', reward: '0' } };

            for (const field of ['hits', 'reward']) { row.values[field] = String(BigInt(row.values[field]) + BigInt(bucket.values[field] || '0')); }

            groups.set(key, row);
        }

        const list = node('div', undefined, 'result-list');

        for (const row of groups.values()) {
            const pool = data.labels?.pools?.[row.pool];
            const card = node('article', undefined, 'record-card');
            card.append(node('h3', pool?.awards?.[row.award] || '奖项 ' + row.award), node('div', pool?.name || '奖池 ' + row.pool, 'muted'));

            if (row.prize) { card.append(node('p', '商品：' + (data.labels?.prizes?.[row.prize] || row.prize))); }

            card.append(metricCards(row.values, definitions));
            list.append(card);
        }

        content.append(node('p', '名称使用当前配置；已移除的奖项显示编号，统计仍按原标识区分', 'stats-note'), list);
    } else if (data.buckets.length) {
        const details = node('details');
        details.append(node('summary', '查看分项'));
        const list = node('div', undefined, 'result-list');

        for (const bucket of data.buckets) {
            const card = node('article', undefined, 'record-card');
            const title = data.labels?.pools?.[bucket.pool]?.name || '奖池 ' + bucket.pool;
            card.append(node('h3', title), node('div', bucket.day || '截至本次查询', 'muted'));

            if (bucket.prize) { card.append(node('p', '商品：' + (data.labels?.prizes?.[bucket.prize] || bucket.prize))); }

            const event = family === 'claimEvents' || family === 'claimStates';
            card.append(metricCards(event ? { [bucket.event]: bucket.values.count } : bucket.values,
                event ? definitions.filter(([key]) => key === bucket.event) : definitions));
            list.append(card);
        }

        details.append(list);
        content.append(details);
    }
}

function archiveCard(batch) {
    const names = { PREPARED: '等待验证', VERIFIED: '已验证，待发布', COMMITTED: '已发布', COMPACTED: '归档完成' };
    const card = node('article', undefined, 'record-card');
    const members = typeof batch.members === 'string' ? JSON.parse(batch.members) : batch.members;
    card.append(node('h3', names[batch.state] || '未知状态'), description([
        ['归档编号', identifier(batch.id)], ['记录数量', Array.isArray(members) ? members.length + ' 条' : '—'],
        ['大小', batch.bytes + ' 字节'], ['创建时间（北京）', claimTime(batch.created_at)]
    ]));

    return card;
}

function renderArchive(payload) {
    if (!Array.isArray(payload?.draws) || !Array.isArray(payload.claims) || !Array.isArray(payload.audits)) { throw new Error('归档内容不完整'); }

    const content = $('archiveText');
    content.replaceChildren(node('h3', '归档详情'), description([['归档编号', identifier(payload.batch)]]), metricCards({ draws: String(payload.draws.length), claims: String(payload.claims.length), audits: String(payload.audits.length) }, [['draws', '业务记录'], ['claims', '兑奖记录'], ['audits', '管理操作']]));

    for (const draw of payload.draws) {
        const card = recordCard(draw, drawBody(draw)?.rules?.name);
        card.append(description([['业务编号', identifier(draw.short_id)]]));
        content.append(card);
    }

    for (const claim of payload.claims) {
        const award = typeof claim.award === 'string' ? JSON.parse(claim.award) : claim.award;
        const card = node('article', undefined, 'record-card');
        card.append(node('h3', award?.name || '奖品 ' + claim.prize_id), description([
            ['状态', claimStates[claim.state] || '未知状态'], ['兑奖编号', identifier(claim.short_id)], ['用户', claim.user_id],
            ['获得时间（北京）', claimTime(claim.obtained_at)], ['发放时间（北京）', claimTime(claim.fulfilled_at)], ['撤销时间（北京）', claimTime(claim.cancelled_at)]
        ]));
        content.append(card);
    }

    const actions = { pool: '保存奖池', poolState: '调整奖池状态', stockCreate: '创建商品', stock: '调整库存', stockRemove: '移除商品', settings: '保存设置', messages: '保存消息模板', enable: '恢复抽奖', disable: '暂停抽奖', fulfill: '确认发放', cancel: '撤销兑奖', recover: '恢复原业务', maintenance: '运行后台任务', archive: '推进归档' };

    for (const audit of payload.audits) {
        const outcome = typeof audit.outcome === 'string' ? JSON.parse(audit.outcome) : audit.outcome;
        const card = node('article', undefined, 'record-card');
        card.append(node('h3', actions[audit.action] || '管理操作'), description([
            ['操作编号', identifier(audit.operation_id)], ['对象编号', identifier(audit.target)],
            ['处理结果', outcome?.ok ? '操作成功' : outcome ? message(outcome.code) : '等待确认'], ['操作时间（北京）', claimTime(audit.created_at)]
        ]));
        content.append(card);
    }

    content.hidden = false;
}

return { drawStates, claimStates, claimTime, recordCard, description, identifier, drawBody, canRecover, showDraw, renderStatistics, archiveCard, renderArchive };
}
`;
