export const statisticsUI = String.raw`
function initStatistics({ $, api, readRegion, renderStatistics, run, state, statsDates }) {
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
}
`;
