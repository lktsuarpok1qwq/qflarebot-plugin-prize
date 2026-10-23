import { probability } from '../lottery/rules.js';

export const editor = 'const formatProbability = ' + probability.toString() + ';\n' + String.raw`
function fields(form) { return Object.fromEntries(new FormData(form).entries()); }

const openEnd = Number($('content').dataset.openEnd);

function stamp(ms) { return ms === 0 || ms === openEnd ? '' : new Date(ms + 8 * 3600000).toISOString().slice(0, 16); }

function timeValue(value, fallback) { return value ? Date.parse(value + ':00+08:00') : fallback; }

function amount(value) {
    const raw = String(value);

    if (!/^\d+(\.\d{1,2})?$/.test(raw)) { throw new Error('积分最多两位小数'); }

    const parts = raw.split('.');
    const minor = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));

    if (!Number.isSafeInteger(minor) || minor > 1e12) { throw new Error('积分超出范围'); }

    return minor;
}

function validateRequest(action, target, version, params) {
    const validInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
    const bounded = (value, max, min = 1) => typeof value === 'string' && value.length >= min && new TextEncoder().encode(value).length <= max;

    if (!validInteger(version, 0, 1e9)) { throw new Error('请先加载当前版本'); }

    if (action === 'messages') {
        const error = configurationError(target, params.config);

        if (error) { throw new Error(error.message); }
    }

    if (action === 'pool') {
        const r = params.rules;
        const ids = new Set(r.awards.map(a => a.id));

        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(target) || !bounded(target, 96) || !bounded(r.name, 100) || !bounded(r.description, 500, 0)
            || !validInteger(r.cost, 1, 1e12) || !Number.isFinite(r.starts) || !Number.isFinite(r.ends) || r.ends <= r.starts
            || ids.size !== r.awards.length || !r.awards.length
            || r.awards.length > 20 || r.awards.reduce((n, a) => n + a.weight, 0) > 2 ** 32) { throw new Error('请检查活动字段、时间和权重'); }

        for (const a of r.awards) {
            if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(a.id) || !bounded(a.name, 120) || !bounded(a.label, 80)
                || !validInteger(a.weight, 1, 2 ** 32) || !validInteger(a.reward, 0, 1e12)
                || a.type === 'NONE' && a.reward !== 0 || a.type === 'POINTS' && a.reward <= 0
                || a.prizeId !== undefined && (r.kind !== 'POOL' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(a.prizeId) || a.reward !== 0)) {
                throw new Error('请检查奖项的编号、名称、公开标签、奖励及商品绑定');
            }
        }
    }

    if (action === 'stockCreate' && (!bounded(params.name, 120) || !validInteger(params.amount, 1, 1e6) || version !== 0)) { throw new Error('请检查商品名称和数量'); }

    if (action === 'stock' && (!['ADD', 'RETIRE'].includes(params.mode) || !validInteger(params.amount, 1, 1e6))) { throw new Error('请检查库存操作和数量'); }

    if (action === 'settings' && (!validInteger(params.maxInflight, 1, 10) || !validInteger(params.retentionMonths, 1, 24)
        || !validInteger(params.maxFacts, 100, 1e6) || !validInteger(params.maxPendingBytes, 64000, 1e8)
    )) { throw new Error('请填写有效的容量上限'); }
}

const page$ = $;

function createRuleEditor() {
    const fragment = page$('ruleEditorTemplate').content.cloneNode(true);
    page$('poolEditorSlot').append(fragment);
    const $ = page$;
    const draft = { pool: null, baseline: null, revision: 0 };
    const listId = 'poolCatalog';
    const resumeId = 'resumePool';
    const title = '奖池';

    function showEditor() {
        page$(listId).hidden = true;
        page$('poolEditorSlot').hidden = false;
        $('editorHeading').textContent = (draft.pool.version ? '编辑' : '新建') + title;
        state.focusAfter = $('poolName');
    }

    function showList() {
        page$('poolEditorSlot').hidden = true;
        page$(listId).hidden = false;
        syncDirty();
    }

    $('backToList').textContent = '返回' + title + '列表';
    $('backToList').onclick = () => {
        showList();
        state.focusAfter = null;
        page$('newPool').focus();
    };
    page$(resumeId).onclick = () => run(showEditor);
    $('poolEditor').querySelector('h2').firstChild.textContent = '奖池规则 ';
    $('loadProducts').onclick = () => run(() => loadCatalog('prizes', false, 'awards'));

    function syncTime() {
        for (const id of ['starts', 'ends']) { $(id).disabled = state.busy || !$('timeEnabled').checked; }
    }

    $('timeEnabled').onchange = syncTime;

    function ruleValue() {
        return {
            kind: 'POOL', name: $('poolName').value, description: $('poolDescription').value, cost: amount($('poolCost').value), starts: $('timeEnabled').checked ? timeValue($('starts').value, 0) : 0, ends: $('timeEnabled').checked ? timeValue($('ends').value, openEnd) : openEnd, totalLimit: Number($('totalLimit').value), userLimit: Number($('userLimit').value), dailyLimit: Number($('dailyLimit').value), repeat: $('repeat').value, awards: [...$('awards').children].map(row => {
                const get = name => row.querySelector('[data-field=' + name + ']').value;
                const type = get('type');
                const a = { id: get('id'), name: state.prizes.find(p => p.id === get('prizeId'))?.name || (['PHYSICAL', 'VIRTUAL_MANUAL'].includes(type) ? row.dataset.name : '') || get('label'), label: get('label'), type, weight: Number(get('weight')), reward: type === 'POINTS' ? amount(get('reward')) : 0 };

                if (type === 'PHYSICAL' || type === 'VIRTUAL_MANUAL') {
                    a.prizeId = get('prizeId');
                }

                return a;
            })
        };
    }

    function syncDirty() {
        syncTime();
        let changed = false;

        try { changed = draft.baseline !== null && JSON.stringify({ id: $('poolId').value, rules: ruleValue() }) !== draft.baseline; } catch { changed = draft.baseline !== null; }

        $('ruleDirty').textContent = changed ? '有未保存修改' : '';
        page$(resumeId).hidden = !draft.pool || !changed && draft.pool.version > 0;

        if (draft.pool) { $('editorHeading').textContent = (draft.pool.version ? '编辑' : '新建') + title; }

        $('saveRules').disabled = state.busy || !changed;
        $('resetRules').disabled = state.busy || !changed;
    }

    function fillProducts(select, current) {
        const products = state.prizes.filter(p => !p.deleted);
        select.replaceChildren();
        const empty = node('option', '请选择已加载商品');
        empty.value = '';
        select.append(empty);

        for (const p of products) {
            const option = node('option', p.name + '（可用 ' + p.available + '）');
            option.value = p.id;
            select.append(option);
        }

        if (current && !products.some(p => p.id === current)) {
            const removed = state.removedPrizes.has(current);
            const option = node('option', removed ? '已移除商品，请重新选择' : '当前商品（尚未加载）');
            option.disabled = removed;
            option.value = current;
            select.append(option);
        }

        select.value = current;
    }

    function addAward(a = { id: 'A' + crypto.randomUUID().replaceAll('-', ''), name: '', label: '', type: 'NONE', weight: 1, reward: 0 }) {
        const row = node('div', undefined, 'award');
        row.dataset.name = a.name;
        const grid = node('div', undefined, 'grid');

        for (const [key, label, type, options] of [['id', '', 'hidden'], ['label', '公开标签', 'text'], ['type', '类型', 'select', ['NONE', 'POINTS', 'VIRTUAL_MANUAL', 'PHYSICAL']], ['weight', '权重', 'number'], ['reward', '奖励（积分）', 'number'], ['prizeId', '商品', 'select', []]]) {
            const wrap = node('label', label);
            wrap.hidden = type === 'hidden';
            const control = node(type === 'select' ? 'select' : 'input');
            control.dataset.field = key;

            if (type === 'select') {
                for (const v of options) {
                    const opt = node('option', ({ NONE: '未中奖', POINTS: '积分', PHYSICAL: '其他', VIRTUAL_MANUAL: '虚拟奖品' })[v] || v);
                    opt.value = v;
                    control.append(opt);
                }
            } else {
                control.type = type;
                control.required = ['id', 'name', 'label', 'weight', 'reward'].includes(key);

                if (type === 'number') {
                    control.min = key === 'reward' ? '0' : '1';
                    control.step = key === 'reward' ? '.01' : '1';
                }
            }

            control.value = key === 'reward' ? String(a.reward / 100) : a[key] ?? '';

            if (key === 'prizeId') { fillProducts(control, a.prizeId || ''); }

            wrap.append(control);
            grid.append(wrap);
        }

        const actions = node('div', undefined, 'award-actions');
        const remove = button('删除此奖项', async () => {
            const adjacent = row.nextElementSibling || row.previousElementSibling;
            state.focusAfter = adjacent?.querySelector('[data-field=label]') || $('addAward');
            row.remove();
            draft.revision++;
            syncDirty();
        });
        remove.className = 'danger';
        actions.append(remove);
        row.append(grid, actions);
        const updateType = () => {
            const type = row.querySelector('[data-field=type]').value;
            row.dataset.awardType = type;
            const goods = type === 'PHYSICAL' || type === 'VIRTUAL_MANUAL';

            for (const field of ['prizeId']) {
                const input = row.querySelector('[data-field=' + field + ']');
                input.parentElement.hidden = !goods;
                input.required = goods;
                input.disabled = !goods;
            }

            const reward = row.querySelector('[data-field=reward]');
            reward.parentElement.hidden = type !== 'POINTS';
            reward.required = type === 'POINTS';
            reward.disabled = type !== 'POINTS';
            reward.min = '0.01';
        };
        row.querySelector('[data-field=type]').onchange = () => {
            updateType();
            syncDirty();
        };
        updateType();
        $('awards').append(row);
        row.querySelector('[data-field=label]').focus({ preventScroll: true });
    }

    function fillPool(pool, show = true) {
        draft.revision++;
        draft.pool = pool;
        const r = pool.rules;
        $('poolEditor').hidden = false;
        $('poolId').value = pool.id;
        $('poolCode').textContent = pool.id;
        $('poolId').readOnly = pool.version > 0;
        $('poolVersion').textContent = ({ DRAFT: '草稿', ACTIVE: '开放中', PAUSED: '已暂停', CLOSED: '已关闭', ARCHIVED: '已归档' })[pool.state];
        $('poolVersion').dataset.version = String(pool.version);
        $('timeEnabled').checked = r.starts !== 0 || r.ends !== openEnd;
        syncTime();

        for (const [id, value] of Object.entries({ poolName: r.name, poolDescription: r.description, poolCost: r.cost / 100, starts: stamp(r.starts), ends: stamp(r.ends), totalLimit: r.totalLimit, userLimit: r.userLimit, dailyLimit: r.dailyLimit, repeat: r.repeat })) { $(id).value = value; }

        $('awards').replaceChildren();
        r.awards.forEach(addAward);
        draft.baseline = JSON.stringify({ id: pool.id, rules: ruleValue() });
        syncPoolStates();
        syncDirty();

        if (show) { showEditor(); }
    }

    function syncPoolStates() {
        const pool = draft.pool;
        $('poolStates').querySelectorAll('button').forEach(b => {
            b.disabled = !pool.version || ['CLOSED', 'ARCHIVED'].includes(pool.state);
        });
    }

    function blank() {
        fillPool({ id: 'P' + crypto.randomUUID().replaceAll('-', ''), kind: 'POOL', version: 0, state: 'DRAFT', rules: { kind: 'POOL', name: '', description: '', cost: 100, starts: 0, ends: openEnd, totalLimit: 0, userLimit: 0, dailyLimit: 0, repeat: 'ALLOW', awards: [{ id: 'none', name: '未中奖', label: '未中奖', type: 'NONE', weight: 1, reward: 0 }] } });
    }

    async function choosePool(pool) {
        if (draft.pool?.id === pool.id && $('ruleDirty').textContent) {
            showEditor();

            return;
        }

        if ($('ruleDirty').textContent && !await confirm('放弃当前活动未保存修改并切换对象？')) { return; }

        if (pool.kind !== 'POOL') { throw new Error('活动类型不匹配'); }

        fillPool(pool);
        invalidate();
    }

    $('addAward').onclick = () => {
        if ($('awards').children.length >= 20) {
            toast('最多20个奖项', 'warning');

            return;
        }

        addAward();
        draft.revision++;
        syncDirty();
    };
    $('rulesForm').oninput = () => {
        draft.revision++;
        syncDirty();

        try {
            const r = ruleValue();
            const total = r.awards.reduce((n, a) => n + a.weight, 0);
            $('probability').textContent = r.awards.map(a => a.label + ' ' + formatProbability(a.weight, total) + '%').join(' · ');
        } catch { $('probability').textContent = '请检查金额和权重'; }
    };
    $('resetRules').onclick = () => fillPool(draft.pool);
    $('copyPool').onclick = () => {
        const rules = ruleValue();
        fillPool({ id: 'P' + crypto.randomUUID().replaceAll('-', ''), kind: rules.kind, version: 0, state: 'DRAFT', rules });
        $('poolName').focus();
    };
    $('rulesForm').onsubmit = event => {
        event.preventDefault();
        run(async () => {
            const rules = ruleValue();
            const id = $('poolId').value;
            const revision = draft.revision;

            if (!id || !rules.name || rules.ends <= rules.starts || !rules.awards.length) { throw new Error('请填写完整有效规则'); }

            await write('pool', id, draft.pool.version, { rules }, '保存“' + rules.name + '”的活动规则？已购买业务不受影响', result => {
                const saved = { id, kind: rules.kind, version: result.version, state: result.state, rules };
                updateActivity(saved);

                if ($('poolId').value !== id || draft.pool.version > result.version) { return; }

                if (revision === draft.revision) { fillPool(saved, false); } else {
                    draft.pool = saved;
                    draft.baseline = JSON.stringify({ id, rules });
                    $('poolId').readOnly = true;
                    $('poolVersion').textContent = '已保存 · ' + saved.state;
                    $('poolVersion').dataset.version = String(saved.version);
                    syncPoolStates();
                    syncDirty();
                }
            });
        });
    };
    $('poolStates').onclick = event => {
        const target = event.target.dataset.state;

        if (!target) { return; }

        const selected = draft.pool;
        run(() => write('poolState', selected.id, selected.version, { state: target }, '确认' + ({ ACTIVE: '开放', PAUSED: '暂停', CLOSED: '关闭', ARCHIVED: '归档' })[target] + '“' + draft.pool.rules.name + '”？' + (['CLOSED', 'ARCHIVED'].includes(target) ? '结束后不可重新开放' : ''), result => {
            updateActivity({ ...selected, version: result.version, state: result.state });

            if (draft.pool.id !== result.target || draft.pool.version > result.version) { return; }

            draft.pool.version = result.version;
            draft.pool.state = result.state;
            $('poolVersion').textContent = ({ ACTIVE: '开放中', PAUSED: '已暂停', CLOSED: '已关闭', ARCHIVED: '已归档' })[result.state];
            $('poolVersion').dataset.version = String(result.version);
            syncPoolStates();
        }));
    };

    page$('newPool').onclick = () => run(async () => {
        if ($('ruleDirty').textContent && !await confirm('放弃当前未保存修改并新建' + title + '？')) { return; }

        blank();
        invalidate();
    });

    return {
        choosePool, showList, syncDirty, isDirty: () => !!$('ruleDirty').textContent,
        refreshProducts: () => $('awards').querySelectorAll('[data-field=prizeId]').forEach(select => fillProducts(select, select.value))
    };
}

const poolEditor = createRuleEditor();
const ruleEditors = [poolEditor];
`;
