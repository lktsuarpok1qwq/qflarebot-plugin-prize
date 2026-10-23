export const queries = String.raw`
const claimStates = { LOCKED: '处理中', PENDING: '待发放', FULFILLED: '已发放', CANCELLED: '已撤销' };

function claimTime(at) { return at ? new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : '—'; }

function showClaim(c) {
    if (!Object.hasOwn(claimStates, c.state) || !Number.isSafeInteger(c.version)
        || !['short_id', 'user_id', 'pool_id', 'prize_id'].every(key => typeof c[key] === 'string' && c[key])) { throw new Error('兑奖详情不完整'); }

    const award = typeof c.award === 'string' ? JSON.parse(c.award) : c.award;
    const fields = [['奖品', award?.name || c.prize_id], ['状态', claimStates[c.state]], ['兑奖编号', c.short_id], ['用户', c.user_id], ['奖池', c.pool_id],
    ['获得时间（北京）', claimTime(c.obtained_at)], ['发放时间（北京）', claimTime(c.fulfilled_at)], ['已有说明', c.note || '—']];
    const fragment = document.createDocumentFragment();
    fields.forEach(([label, value]) => fragment.append(node('dt', label), node('dd', value)));
    $('claimText').replaceChildren(fragment);
    state.claim = c;
    $('claimNote').value = '';
    $('notDelivered').checked = false;
    $('cancelInventory').value = '';
    $('claimCancelOptions').open = false;
    $('claimDetail').hidden = false;
    $('fulfill').disabled = c.state !== 'PENDING';
    $('claimCancelOptions').hidden = c.state !== 'PENDING';
    $('cancelClaim').disabled = c.state !== 'PENDING';
    state.focusAfter = $('closeClaim');
}

function setupList(formId, listId, nextId, table) {
    let cursor = null;
    let serial = 0;
    let search = null;
    const form = $(formId);
    document.addEventListener('prize:write', () => {
        serial++;
        cursor = null;
        $(nextId).disabled = true;
    });
    form.oninput = () => {
        serial++;
        cursor = null;
        $(nextId).disabled = true;
        $(listId).textContent = '筛选已变化，请重新查询';
        invalidate();
    };

    async function load(next = false) {
        const ticket = ++serial;
        const epoch = state.epoch;
        const params = next && search ? new URLSearchParams(search) : new URLSearchParams();

        for (const [key, value] of Object.entries(next && search ? {} : fields(form))) {
            if (!value) { continue; }

            const normalized = key === 'from' || key === 'to' ? Date.parse(value + '+08:00') : value;

            if (typeof normalized === 'number' && !Number.isSafeInteger(normalized)) { throw new Error('请填写有效的北京时间范围'); }

            params.set(key, String(normalized));
        }

        if (params.has('from') && params.has('to') && Number(params.get('to')) <= Number(params.get('from'))) { throw new Error('结束时间必须晚于开始时间'); }

        if (table === 'draws' && !next) {
            for (const [key, value] of Object.entries(recordDates.read())) { params.set(key, String(value)); }
        }

        if (!next) { search = params.toString(); }

        if (next && cursor) { params.set('cursor', cursor); }

        const result = await readRegion(listId, () => api('/api/' + table + '?' + params));

        if (ticket !== serial || epoch !== state.epoch) { return; }

        if (!Array.isArray(result.data?.rows) || !(result.data.next === null || typeof result.data.next === 'string')) { throw new Error('列表响应不完整'); }

        cursor = result.data.next;
        $(nextId).disabled = !cursor;
        $(listId).replaceChildren(...result.data.rows.map(row => {
            const card = table === 'draws' ? recordCard(row) : node('div', undefined, 'item');
            const summary = node('div', undefined, 'claim-meta');

            if (table === 'claims') {
                if (!Object.hasOwn(claimStates, row.state)) { throw new Error('兑奖状态不完整'); }

                card.classList.add('claim-row');
                const heading = node('div', undefined, 'claim-heading');
                heading.append(node('strong', row.awardName || row.prize_id), node('span', claimStates[row.state], 'badge'));
                summary.append(heading, node('div', row.short_id, 'muted'), node('div', '用户：' + row.user_id, 'muted'), node('div', '获得时间（北京）：' + claimTime(row.obtained_at), 'muted'));
            }

            card.append(summary, button('查看详情', async () => {
                const turn = state.epoch;
                const detail = await readRegion(listId, () => api('/api/detail/' + table + '/' + encodeURIComponent(row.id)));

                if (turn !== state.epoch || ticket !== serial) { return; }

                if (detail.data?.id !== row.id) { throw new Error('详情对象不匹配'); }

                if (table === 'claims') {
                    showClaim(detail.data);
                } else {
                    showDraw(detail.data);
                }
            }));

            return card;
        }));

        if (!result.data.rows.length) { $(listId).textContent = '没有符合条件的记录'; }
    }

    form.onsubmit = event => {
        event.preventDefault();
        cursor = null;
        $(nextId).disabled = true;
        invalidate();
        run(() => load());
    };

    if (table === 'claims') {
        $('loadLatestClaims').onclick = () => run(async () => {
            form.reset();
            cursor = null;
            $(nextId).disabled = true;
            invalidate();
            await load();
        });
    }

    $(nextId).onclick = () => {
        invalidate();
        run(() => load(true));
    };
}

setupList('claimSearch', 'claimList', 'claimNext', 'claims');
setupList('recordSearch', 'recordList', 'recordNext', 'draws');
$('rejectedId').oninput = () => {
    state.epoch++;
    $('rejectedResult').textContent = '编号已变化，请重新查询';
};
$('rejectedSearch').onsubmit = event => {
    event.preventDefault();
    run(async () => {
        const epoch = state.epoch;
        const id = $('rejectedId').value.trim();

        if (!id) { throw new Error('请填写业务编号'); }

        let result;

        try {
            result = await readRegion('rejectedResult', () => api('/api/detail/draws/' + encodeURIComponent(id) + '?rejected=1'));
        } catch (error) {
            if (epoch !== state.epoch) { return; }

            throw error;
        }

        if (epoch !== state.epoch) { return; }

        const draw = result.data;

        if (!draw || draw.count !== 0 || draw.state !== 'FAILED' || !(draw.id === id || draw.short_id?.toLowerCase() === id.toLowerCase())) { throw new Error('未受理记录不匹配'); }

        $('rejectedResult').replaceChildren(description([['业务编号', identifier(draw.short_id)], ['用户', draw.user_id],
        ['奖池编号', identifier(draw.pool_id)], ['时间（北京）', claimTime(draw.created_at)], ['原因', message(draw.error)], ['资金处理', '未受理，未扣款']]));
    });
};
$('closeClaim').onclick = () => {
    state.claim = null;
    $('claimDetail').hidden = true;
    state.epoch++;
};
$('closeDraw').onclick = () => {
    invalidate();
};
$('openRecovery').onclick = () => {
    if (!canRecover(state.draw)) {
        toast('该业务当前不支持恢复，请重新查询', 'warning');

        return;
    }

    $('recordAdvanced').open = true;
    $('recoveryOptions').open = true;
    $('recoveryEmpty').hidden = true;
    $('recoveryPanel').hidden = false;
    $('recoverySummary').replaceChildren(recordCard(state.draw, drawBody(state.draw)?.rules?.name), description([['业务编号', identifier(state.draw.short_id)]]));
    $('recoveryNote').focus();
};
$('fulfill').onclick = () => run(async () => {
    if (!$('claimNote').value) { throw new Error('请填写发放说明'); }

    const c = state.claim;
    await write('fulfill', c.id, c.version, { note: $('claimNote').value }, '确认 ' + c.short_id + ' 已发放？确认后计入已发放库存', () => {
        if (state.claim?.id === c.id) {
            $('claimDetail').hidden = true;
            state.claim = null;
        }

        $('claimList').textContent = '记录可能变化，请重新查询';
    });
});
$('cancelClaim').onclick = () => run(async () => {
    if (!$('notDelivered').checked || !$('cancelInventory').value || !$('claimNote').value) { throw new Error('请核实未交付并填写原因与库存去向'); }

    const c = state.claim;
    await write('cancel', c.id, c.version, { note: $('claimNote').value, notDelivered: true, inventory: $('cancelInventory').value }, '撤销 ' + c.short_id + ' 的兑奖？' + ($('cancelInventory').value === 'RETURN' ? '退回可用库存' : '退出可抽库存') + '，不退积分', () => {
        if (state.claim?.id === c.id) {
            $('claimDetail').hidden = true;
            state.claim = null;
        }

        $('claimList').textContent = '记录可能变化，请重新查询';
    });
});
$('recover').onclick = () => run(async () => {
    if (!$('recoveryNote').value) { throw new Error('请填写核查说明'); }

    const d = state.draw;
    const epoch = state.epoch;

    if (!canRecover(d)) { throw new Error('该业务当前不支持恢复，请重新查询'); }

    await write('recover', d.id, d.version, { note: $('recoveryNote').value }, '受理原业务 ' + d.short_id + ' 的恢复？仅复用原资金操作，不修改固定结果', () => {
        if (state.epoch === epoch && state.draw?.id === d.id) {
            $('drawDetail').hidden = true;
            state.draw = null;
            $('recoveryPanel').hidden = true;
            $('recoveryEmpty').hidden = false;
            $('recordList').textContent = '恢复已受理，后台自动处理，请稍后重新查询';
        }
    });
});
const recordState = $('recordState');
recordState.append(new Option('全部', ''));

for (const [key, value] of Object.entries(drawStates)) { recordState.append(new Option(value[0], key)); }

function updateStatsForm() {
    const family = $('statsFamily').value;
    statsDates.enable(family !== 'claimStates');
    $('statsPrize').disabled = family === 'participation';
    $('statsPrize').parentElement.hidden = $('statsPrize').disabled;
    $('statsHint').textContent = ({ transactions: '按结算时间统计', awards: '按结算时间统计，名称使用当前配置', claimEvents: '按获得、发放、撤销各自发生时间统计', claimStates: '截至本次查询，不代表历史时刻的状态', participation: '按购买时间统计，有效参与与当前处理中占用分别列出' })[family];
}

updateStatsForm();
$('statsForm').onsubmit = event => {
    event.preventDefault();
    run(async () => {
        const epoch = state.epoch;

        try {
            const query = { ...statsDates.read(), family: $('statsFamily').value };

            for (const [id, key] of [['statsPool', 'pool'], ['statsUser', 'user'], ['statsPrize', 'prize']]) { if ($(id).value && !$(id).disabled) { query[key] = $(id).value; } }

            const result = await readRegion('statsResult', () => api('/api/statistics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) }));

            if (epoch === state.epoch) { renderStatistics(result.data); }
        } catch (error) {
            if (epoch === state.epoch) { $('statsResult').textContent = '查询未完成：' + error.message; }

            throw error;
        }
    });
};
$('statsForm').oninput = () => {
    updateStatsForm();
    state.epoch++;
    $('statsResult').textContent = '筛选已变化，请重新查询';
};
let archiveCursor = null;

async function loadArchives(next = false) {
    const epoch = state.epoch;
    $('archiveText').hidden = true;
    const result = await readRegion('archiveList', () => api('/api/archives' + (next && archiveCursor ? '?cursor=' + encodeURIComponent(archiveCursor) : '')));

    if (epoch !== state.epoch) { return; }

    archiveCursor = result.data?.next;
    $('archiveNext').disabled = !archiveCursor;

    if (!Array.isArray(result.data?.rows)) { throw new Error('归档响应不完整'); }

    $('archiveList').replaceChildren(...result.data.rows.map(b => {
        const card = archiveCard(b);

        if (['COMMITTED', 'COMPACTED'].includes(b.state)) {
            card.append(button('查看归档', async () => {
                const turn = state.epoch;
                $('archiveText').hidden = true;
                const detail = await readRegion('archiveList', () => api('/api/archives/' + encodeURIComponent(b.id)));

                if (turn !== state.epoch) { return; }

                if (detail.data?.batch !== b.id) { throw new Error('归档对象不匹配'); }

                renderArchive(detail.data);
            }));
        }

        return card;
    }));

    if (!result.data.rows.length) { $('archiveList').textContent = '暂无归档'; }
}

$('loadArchives').onclick = () => run(() => loadArchives());
$('archiveNext').onclick = () => run(() => loadArchives(true));

$('archiveStep').onclick = () => run(() => write('archive', 'prize', state.control?.version || 0, {}, '有界推进一个归档阶段？验证成功之前保留原数据', () => { }));

let operationCursor = null;
document.addEventListener('prize:write', () => {
    archiveCursor = null;
    operationCursor = null;
    $('archiveNext').disabled = true;
    $('operationNext').disabled = true;
});

async function loadOperations(next = false) {
    const result = await readRegion('operationResult', () => api('/api/operations' + (next && operationCursor ? '?cursor=' + encodeURIComponent(operationCursor) : '')));

    if (!Array.isArray(result.data?.rows)) { throw new Error('操作目录响应不完整'); }

    operationCursor = result.data.next;
    $('operationNext').disabled = !operationCursor;
    $('operationResult').textContent = JSON.stringify(result.data.rows, null, 2);
}

$('recentOperations').onclick = () => run(() => loadOperations());
$('operationNext').onclick = () => run(() => loadOperations(true));
$('queryOperation').onclick = () => run(async () => {
    const id = $('operationId').value;

    if (!id) { throw new Error('请填写操作号'); }

    const result = await readRegion('operationResult', () => api('/api/operations/' + encodeURIComponent(id)));
    $('operationResult').textContent = result.data ? JSON.stringify(result.data, null, 2) : '尚未找到，不能据此认定没有在途提交';
});

function changeTab(target) {
    if (state.busy) { return false; }

    messageEditor.leave();
    state.tab = target;
    invalidate();
    document.querySelectorAll('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== target);
    document.querySelectorAll('[data-tab]').forEach(b => {
        b.setAttribute('aria-selected', String(b.dataset.tab === target));
        b.tabIndex = b.dataset.tab === target ? 0 : -1;
    });

    if (target === 'stock') {
        showStockList();
    }

    if (target === 'pools') {
        poolEditor.showList();
    }

    return true;
}

document.querySelectorAll('[data-tab]').forEach((tab, index, tabs) => {
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.onclick = () => changeTab(tab.dataset.tab);
    tab.onkeydown = event => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next].focus();
            tabs[next].click();
        }
    };
});
syncDirty();
$('content').inert = false;
$('content').setAttribute('aria-busy', 'false');
`;
