export const settingsUI = String.raw`
function initSettings({ confirm, $, api, bridge, fieldError, node, readRegion, requireField, run, state, syncLoadButton, syncMessages, syncRules, syncStockControls, write }) {
    function renderStatus() {
        const c = state.control;
        const paused = c.settings.paused;
        const missing = c.missingPermissions || [];
        const points = !c.policy?.registered ? '积分：正在准备，请刷新' : !c.policy.enabled ? '积分：请在 Points 启用 Prize'
            : missing.length ? '积分：请在 Points 授权' + missing.map(name => ({ burn: '销毁', reverseOwn: '本来源完整冲正', balance: '余额读取' })[name] || name).join('、') : '积分：已就绪';
        $('statusSummary').replaceChildren(...[
            paused ? '抽奖：已暂停' : c.admission ? '抽奖：按活动设置开放' : '抽奖：待授权',
            points, '待处理：' + c.queue.reduce((sum, row) => sum + row.count, 0) + ' 笔' + (c.error ? '（后台任务异常，请查看诊断信息）' : '')
        ].map(text => node('div', text, 'item')));
    }

    const settingKeys = ['archiveEnabled', 'retentionMonths', 'maxInflight', 'maxFacts', 'maxPendingBytes'];

    function settingsValue() { return { paused: state.control?.settings.paused === true, ...Object.fromEntries(settingKeys.map(key => [key, $(key).type === 'checkbox' ? $(key).checked : Number($(key).value)])) }; }

    function syncDirty() {
        syncMessages();

        document.querySelectorAll('[data-load-action]').forEach(control => { control.disabled = state.busy; });

        if (state.control) {
            $('enable').disabled = state.busy || !state.control.settings.paused && state.control.admission;
            $('disable').disabled = state.busy || state.control.settings.paused;
        }

        syncRules();
        syncStockControls();
        const dirty = state.settingsBaseline !== null && JSON.stringify(settingsValue()) !== state.settingsBaseline;
        $('settingsFields').disabled = state.busy || state.settingsBaseline === null;
        $('settingsDirty').textContent = dirty ? '有未保存修改' : '';
        $('saveSettings').disabled = state.busy || !dirty;
        $('resetSettings').disabled = state.busy || !dirty;
    }

    $('loadState').onclick = () => run(async () => {
        if ($('settingsDirty').textContent && !await confirm('放弃未保存的设置修改并重新加载？')) { return; }

        const epoch = state.epoch;
        let result;

        await readRegion('statusSummary', async () => {
            for (let phase = 0; phase < 2; phase++) {
                try {
                    result = await api('/api/state');
                    break;
                } catch (error) {
                    if (phase || error.result?.code !== 'SCHEMA_INITIALIZING') { throw error; }
                }
            }
        });

        if (epoch !== state.epoch) { return; }

        const c = result.data;

        if (!c || !Number.isInteger(c.version) || typeof c.admission !== 'boolean' || !c.settings || !Array.isArray(c.queue)
            || typeof c.heartbeat !== 'number' || !settingKeys.every(key => Object.hasOwn(c.settings, key))
            || typeof c.settings.paused !== 'boolean' || typeof c.settings.archiveEnabled !== 'boolean'
            || !['retentionMonths', 'maxInflight', 'maxFacts', 'maxPendingBytes'].every(key => Number.isSafeInteger(c.settings[key]))) {
            throw new Error('状态响应不完整');
        }

        state.control = c;

        for (const key of settingKeys) {
            fieldError($(key), '');

            if ($(key).type === 'checkbox') { $(key).checked = c.settings[key]; } else { $(key).value = c.settings[key]; }
        }

        state.settingsBaseline = JSON.stringify(settingsValue());
        $('retentionField').hidden = !c.settings.archiveEnabled;
        $('stateResult').textContent = JSON.stringify(c, null, 2);
        renderStatus();
        syncLoadButton('loadState', true);

        for (const id of ['maintenance']) { $(id).disabled = false; }

        syncDirty();
    });
    $('pointsLink').onclick = () => bridge.navigate('/plugin-ui/points');

    for (const action of ['enable', 'disable', 'maintenance']) {
        $(action).onclick = () => run(() => write(action, 'prize', state.control.version, {}, '确认执行“' + $(action).textContent + '”？', result => {
            if (state.control.version > result.version) { return; }

            if (result.version > state.control.version) { state.control.version = result.version; }

            if (action === 'disable' || action === 'enable' && result.code === 'POINTS_READY') {
                state.control.settings.paused = action === 'disable';
                state.control.admission = action === 'enable';
                renderStatus();

                if (state.settingsBaseline) {
                    const baseline = JSON.parse(state.settingsBaseline);
                    baseline.paused = action === 'disable';
                    state.settingsBaseline = JSON.stringify(baseline);
                }

                syncDirty();
            }
        }));
    }

    $('archiveEnabled').onchange = () => { $('retentionField').hidden = !$('archiveEnabled').checked; };
    $('settingsForm').oninput = syncDirty;
    $('resetSettings').onclick = () => {
        const c = JSON.parse(state.settingsBaseline);

        for (const key of settingKeys) {
            fieldError($(key), '');

            if ($(key).type === 'checkbox') { $(key).checked = c[key]; } else { $(key).value = c[key]; }
        }

        $('retentionField').hidden = !$('archiveEnabled').checked;
        syncDirty();
    };
    $('settingsForm').onsubmit = event => {
        event.preventDefault();
        run(async () => {
            if (state.settingsBaseline === null || !state.control) { throw new Error('请先加载状态'); }

            for (const key of settingKeys) { if (!$(key).disabled) { requireField($(key)); } }

            const config = settingsValue();
            await write('settings', 'prize', state.control.version, config, '保存高级设置？', result => {
                if (state.control.version > result.version) { return; }

                state.control.version = result.version;
                state.settingsBaseline = JSON.stringify(config);
                syncDirty();
            });
        });
    };

    return { syncDirty };
}
`;
