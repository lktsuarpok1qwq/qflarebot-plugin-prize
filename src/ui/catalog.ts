export const catalogUI = String.raw`
const catalogCursors = { pools: null };
const activityLoaded = { pools: false };
const activityStates = { DRAFT: '草稿', ACTIVE: '开放中', PAUSED: '已暂停', CLOSED: '已关闭', ARCHIVED: '已归档' };

function renderActivities(tab) {
    const rows = state.pools;
    const list = $('poolList');
    list.replaceChildren(...rows.map(pool => {
        const r = pool.rules;
        const card = node('article');
        card.className = 'activity-card';
        card.dataset.id = pool.id;
        card.dataset.state = pool.state;
        card.setAttribute('aria-label', r.name);
        const cover = node('span', undefined, 'activity-cover');
        const top = node('span', undefined, 'activity-top');
        top.append(node('span', '奖池'), node('span', activityStates[pool.state], 'badge'));
        const price = node('span', formatMoney(r.cost), 'activity-price');
        price.append(node('small', '积分 / ' + '次'));
        cover.append(top, node('h3', r.name, 'activity-name'), price);
        const body = node('span', undefined, 'activity-body');
        body.append(node('span', r.description || '暂无说明', 'activity-description'));

        const tags = node('span', undefined, 'award-tags');
        r.awards.slice(0, 3).forEach(a => tags.append(node('span', a.label, 'badge')));

        if (r.awards.length > 3) { tags.append(node('span', '+' + (r.awards.length - 3), 'badge')); }

        const info = r.awards.length + ' 个奖项';
        const actions = node('div', undefined, 'actions');

        const edit = button('编辑规则', () => poolEditor.choosePool(pool));
        edit.dataset.edit = pool.id;
        edit.setAttribute('aria-label', '编辑“' + r.name + '”');
        actions.append(edit);
        body.append(tags, node('span', info, 'muted'), actions);
        card.append(cover, body);

        return card;
    }));
    $('poolListMessage').textContent = !activityLoaded[tab] ? '尚未加载'
        : rows.length ? ''
            : '暂无奖池，点击新建奖池';
    $('poolListMessage').hidden = activityLoaded[tab] && rows.length > 0;
    syncLoadButton('loadPools', activityLoaded[tab], 'newPool');
}

function updateActivity(pool) {
    const current = state.pools.find(p => p.id === pool.id);

    if (current && current.version > pool.version) { return; }

    state.pools = state.pools.filter(p => p.id !== pool.id).concat(pool).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const tab = 'pools';
    renderActivities(tab);
}

async function activityRequest(path) {
    // 自动准备按独立请求推进，最多三次；其它错误直接交给重试入口。
    for (let attempt = 0; attempt < 3; attempt++) {
        try { return await api(path); } catch (error) {
            if (error.result?.code !== 'SCHEMA_INITIALIZING' || attempt === 2) { throw error; }
        }
    }
}

async function loadActivities(tab, refresh = false, next = false) {
    if (activityLoaded[tab] && !refresh && !next) { return; }

    if (!next) {
        catalogCursors.pools = null;
        $('poolNext').disabled = true;
    }

    const epoch = state.epoch;
    const message = $('poolListMessage');

    try {
        const params = new URLSearchParams({ view: 'pools', kind: 'POOL' });

        if (next && catalogCursors.pools) { params.set('cursor', catalogCursors.pools); }

        const result = await readRegion('poolList', () => activityRequest('/api/pools?' + params));

        if (epoch !== state.epoch) { return; }

        if (!Array.isArray(result.data?.pools) || !(result.data.poolsNext === null || typeof result.data.poolsNext === 'string')) { throw new Error('奖池响应不完整'); }

        const rows = result.data.pools.map(p => ({ ...p, kind: 'POOL', rules: JSON.parse(p.rules) }));

        if (rows.some(p => p.rules.kind !== 'POOL')) { throw new Error('活动类型不匹配'); }

        state.pools = next ? [...state.pools.filter(p => !rows.some(row => row.id === p.id)), ...rows] : rows;
        catalogCursors.pools = result.data.poolsNext;
        $('poolNext').disabled = !catalogCursors.pools;

        activityLoaded[tab] = true;
        renderActivities(tab);
    } catch (error) {
        message.hidden = false;
        message.textContent = activityLoaded[tab] ? '列表未能更新，保留上次结果，请重新加载' : '加载未完成，请重试';
        throw error;
    }
}

document.addEventListener('prize:write', () => {
    catalogCursors.pools = null;
    $('poolNext').disabled = true;

    if (activityLoaded.pools) {
        $('poolListMessage').hidden = false;
        $('poolListMessage').textContent = '列表可能变化，请重新加载';
    }
});

$('loadPools').onclick = () => run(() => loadActivities('pools', true));
$('poolNext').onclick = () => run(() => loadActivities('pools', false, true));
`;
