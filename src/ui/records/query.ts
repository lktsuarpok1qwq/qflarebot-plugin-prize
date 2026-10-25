export const recordQueryUI = String.raw`
function initRecordQuery({ $, api, canRecover, claimTime, description, drawBody, drawStates, identifier, invalidate, message, readRegion, recordCard, requireField, run, state, toast, write }) {
    $('rejectedId').oninput = () => {
        state.epoch++;
        $('rejectedResult').textContent = '编号已变化，请重新查询';
    };
    $('rejectedSearch').onsubmit = event => {
        event.preventDefault();
        run(async () => {
            const epoch = state.epoch;
            const id = $('rejectedId').value.trim();

            requireField($('rejectedId'), !id ? '请填写业务编号' : undefined);

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
    $('recover').onclick = () => run(async () => {
        requireField($('recoveryNote'), !$('recoveryNote').value ? '请填写核查说明' : undefined);

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
}
`;
