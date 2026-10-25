export const stockUI = String.raw`
function initStock({ confirm, $, activityRequest, affects, button, node, readRegion, refreshProducts, requireField, run, sendPending, state, syncLoadButton, verifyPending, write }) {
    let stockCursor = null;
    let stockLoaded = false;
    let stockReadGeneration = 0;
    const stockDraft = { id: null, revision: 0 };
    let stockAdjustment = null;

    function syncStockControls() {
        const amount = Number($('stockAmount').value);
        $('saveStockCreate').disabled = state.busy || !$('stockName').value.trim() || !Number.isSafeInteger(amount) || amount < 1 || amount > 1e6;
        $('resumeStock').hidden = !stockDraft.id;
        const adjustmentAmount = Number($('stockAdjustAmount').value);
        const limit = $('stockMode').value === 'RETIRE' ? Math.min(stockAdjustment?.item.available || 0, 1e6) : 1e6;
        $('stockAdjustAmount').max = String(limit);
        const pending = state.pending?.request.action === 'stock' && state.pending.request.target === stockAdjustment?.item.id;
        $('stockAdjustPending').hidden = !pending;
        $('verifyStockAdjustment').disabled = state.busy;
        $('retryStockAdjustment').disabled = state.busy;
        $('closeStockAdjust').textContent = pending ? '关闭' : '取消';
        $('stockAdjustPreview').textContent = stockAdjustment && Number.isSafeInteger(adjustmentAmount) && adjustmentAmount > 0 && adjustmentAmount <= limit
            ? '可用数量：' + stockAdjustment.item.available + ' → ' + (stockAdjustment.item.available + ($('stockMode').value === 'ADD' ? adjustmentAmount : -adjustmentAmount))
            : '请输入有效的调整数量';
        $('saveStockAdjust').disabled = state.busy || !!state.pending || !stockAdjustment || !Number.isSafeInteger(adjustmentAmount) || adjustmentAmount < 1 || adjustmentAmount > limit;
    }

    function showStockList() {
        $('stockCatalog').hidden = false;
        $('stockCreate').hidden = true;
        syncStockControls();
    }

    function showStockCreate() {
        $('stockCatalog').hidden = true;
        $('stockCreate').hidden = false;
        state.focusAfter = $('stockName');
    }

    function stockSummary(p) { return '可用 ' + p.available + ' · 占用 ' + p.reserved + ' · 已发放 ' + p.fulfilled; }

    function renderStockCards() {
        $('stockList').replaceChildren(...state.prizes.filter(p => !p.deleted).map(p => {
            const card = node('article', undefined, 'stock-card');
            card.dataset.id = p.id;
            card.append(node('h3', p.name));
            const counts = node('dl', undefined, 'stock-counts');

            for (const [field, label] of [['available', '可用'], ['reserved', '占用'], ['fulfilled', '已发放']]) {
                const cell = node('div');
                cell.append(node('dt', label), node('dd', String(p[field])));
                counts.append(cell);
            }

            const actions = node('div', undefined, 'actions');
            const adjust = button('调整库存', () => openStockAdjustment(p));
            const observedRead = stockReadGeneration;
            const remove = button(p.bound || p.reserved > 0 ? '占用' : '移除', () => write('stockRemove', p.id, p.version, {},
                '确认移除“' + p.name + '”？后续不再参与抽奖，已有兑奖保持有效', result => updateStock(result.stock, observedRead)));
            remove.className = p.bound || p.reserved > 0 ? '' : 'danger';
            remove.disabled = p.bound || p.reserved > 0;
            remove.title = p.bound ? '已绑定活动，不能移除' : p.reserved > 0 ? '存在待兑奖库存，不能移除' : '';
            actions.append(adjust, remove);
            card.append(counts, actions);

            return card;
        }));
        $('stockListMessage').textContent = !stockLoaded ? '尚未加载完整列表' : state.prizes.length
            ? '' : '暂无商品，点击新建商品';
        $('stockListMessage').hidden = stockLoaded && state.prizes.length > 0;
        syncLoadButton('loadStock', stockLoaded, 'newStock');
    }

    function updateStock(p, observedRead = stockReadGeneration) {
        const current = state.prizes.find(row => row.id === p.id);

        if (!current && !p.deleted && observedRead !== stockReadGeneration) { return; }

        if (current && current.version > p.version || state.removedPrizes.has(p.id) && !p.deleted) { return; }

        if (p.deleted) { state.removedPrizes.add(p.id); }

        state.prizes = state.prizes.filter(row => row.id !== p.id);

        if (!p.deleted) { state.prizes.push(p); }

        state.prizes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        renderStockCards();
        refreshProducts();
    }

    async function loadCatalog(view = 'prizes', next = false, region = 'stockList') {
        const epoch = state.epoch;
        const params = new URLSearchParams({ view });

        if (next && stockCursor) { params.set('cursor', stockCursor); }

        if (!next) {
            stockCursor = null;
            $('stockNext').disabled = true;
        }

        try {
            const result = await readRegion(region, () => activityRequest('/api/pools?' + params));

            if (epoch !== state.epoch) { return; }

            if (!Array.isArray(result.data?.prizes) || !(result.data.prizesNext === null || typeof result.data.prizesNext === 'string')
                || result.data.prizes.some(p => typeof p.id !== 'string' || typeof p.name !== 'string' || p.deleted !== 0 || typeof p.bound !== 'boolean'
                    || !['available', 'reserved', 'fulfilled', 'version'].every(key => Number.isSafeInteger(p[key]) && p[key] >= 0))) {
                throw new Error('库存响应不完整');
            }

            const rows = result.data.prizes;
            state.prizes = next ? [...state.prizes.filter(p => !rows.some(row => row.id === p.id)), ...rows] : rows;
            stockCursor = result.data.prizesNext;
            stockLoaded = true;
            stockReadGeneration++;
            $('stockNext').disabled = !stockCursor;
            renderStockCards();
            refreshProducts();
        } catch (error) {
            $('stockListMessage').hidden = false;
            $('stockListMessage').textContent = stockLoaded ? '列表未能更新，保留上次结果，请重新加载' : '加载未完成，请重试';
            throw error;
        }
    }

    function closeStockAdjustment() {
        const card = [...$('stockList').children].find(card => card.dataset.id === stockAdjustment?.item.id);
        const focus = card?.querySelector('button') || $('newStock');
        $('stockAdjustDialog').close();
        stockAdjustment = null;
        state.focusAfter = focus;

        if (!state.busy) { focus.focus({ preventScroll: true }); }
    }

    function openStockAdjustment(p) {
        stockAdjustment = { item: p, revision: 0 };
        $('stockAdjustTitle').textContent = '调整“' + p.name + '”的库存';
        $('stockAdjustSummary').textContent = stockSummary(p);
        $('stockMode').value = 'ADD';
        $('stockAdjustAmount').value = '';
        syncStockControls();
        $('stockAdjustDialog').showModal();
        $('stockAdjustAmount').focus();
    }

    $('stockAdjustDialog').oncancel = event => {
        event.preventDefault();
        closeStockAdjustment();
    };
    $('stockAdjustDialog').onclick = event => {
        if (event.target !== $('stockAdjustDialog')) { return; }

        const r = $('stockAdjustDialog').getBoundingClientRect();

        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) { closeStockAdjustment(); }
    };
    $('closeStockAdjust').onclick = closeStockAdjustment;
    $('verifyStockAdjustment').onclick = () => run(verifyPending);
    $('retryStockAdjustment').onclick = () => run(sendPending);
    $('newStock').onclick = () => run(async () => {
        if (stockDraft.id && ($('stockName').value || $('stockAmount').value) && !await confirm('放弃当前未保存商品并重新新建？')) { return; }

        stockDraft.id = 'G' + crypto.randomUUID().replaceAll('-', '');
        stockDraft.revision++;
        $('stockForm').reset();
        $('stockId').value = stockDraft.id;
        showStockCreate();
    });
    $('resumeStock').onclick = () => run(showStockCreate);
    $('backToStock').onclick = () => {
        showStockList();
        $('resumeStock').focus();
    };
    $('loadStock').onclick = () => run(() => loadCatalog());
    $('stockNext').onclick = () => run(() => loadCatalog('prizes', true));
    $('stockForm').oninput = () => {
        stockDraft.revision++;
        syncStockControls();
    };
    $('stockAdjustForm').oninput = () => {
        if (stockAdjustment) { stockAdjustment.revision++; }

        syncStockControls();
    };
    $('stockAdjustForm').onchange = syncStockControls;
    $('stockForm').onsubmit = event => {
        event.preventDefault();
        const id = stockDraft.id;
        const revision = stockDraft.revision;
        const observedRead = stockReadGeneration;
        const params = { name: $('stockName').value, amount: Number($('stockAmount').value) };
        run(async () => {
            requireField($('stockName'));
            requireField($('stockAmount'));
            await write('stockCreate', id, 0, params, '创建“' + params.name + '”，入库 ' + params.amount + ' 份？', result => {
                updateStock(result.stock, observedRead);

                if (stockDraft.id !== id) { return; }

                if (stockDraft.revision === revision) {
                    stockDraft.id = null;
                    $('stockForm').reset();

                    if (state.tab === 'stock' && !$('stockCreate').hidden) { showStockList(); }
                } else {
                    // 原商品已创建；后续未保存输入保留为新的独立草稿。
                    stockDraft.id = 'G' + crypto.randomUUID().replaceAll('-', '');
                    $('stockId').value = stockDraft.id;
                }
            });
        });
    };
    $('stockAdjustForm').onsubmit = event => {
        event.preventDefault();
        const selected = stockAdjustment;

        if (!selected) { return; }

        const revision = selected.revision;
        const observedRead = stockReadGeneration;
        const params = { mode: $('stockMode').value, amount: Number($('stockAdjustAmount').value) };
        run(() => write('stock', selected.item.id, selected.item.version, params,
            '确认' + (params.mode === 'ADD' ? '补货 ' : '减少可用库存 ') + params.amount + ' 份“' + selected.item.name + '”？', result => {
                updateStock(result.stock, observedRead);

                if (stockAdjustment !== selected) { return; }

                const current = state.prizes.find(p => p.id === result.stock.id);
                selected.item = current && current.version > result.stock.version ? current : result.stock;
                $('stockAdjustSummary').textContent = stockSummary(selected.item);

                if (selected.revision === revision && $('stockAdjustDialog').open) { closeStockAdjustment(); }
            }));
    };
    document.addEventListener('prize:write', event => {
        if (event.detail?.ok && event.detail.action === 'pool') {
            stockLoaded = false;
            state.prizes = [];
            renderStockCards();
            refreshProducts();
        }

        stockCursor = null;
        $('stockNext').disabled = true;

        if (stockLoaded && affects('stock', event)) {
            $('stockListMessage').hidden = false;
            $('stockListMessage').textContent = '列表可能变化，请重新加载';
        }
    });

    return { syncStockControls, showStockList, loadCatalog };
}
`;
