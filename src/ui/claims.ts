export const claimsUI = String.raw`
function initClaims({ $, claimStates, claimTime, node, requireField, run, state, write }) {
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

    $('closeClaim').onclick = () => {
        state.claim = null;
        $('claimDetail').hidden = true;
        state.epoch++;
    };
    $('fulfill').onclick = () => run(async () => {
        requireField($('claimNote'), !$('claimNote').value ? '请填写发放说明' : undefined);

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
        requireField($('notDelivered'), !$('notDelivered').checked ? '请核实奖品尚未交付' : undefined);
        requireField($('cancelInventory'), !$('cancelInventory').value ? '请选择库存去向' : undefined);
        requireField($('claimNote'), !$('claimNote').value ? '请填写撤销原因' : undefined);

        const c = state.claim;
        await write('cancel', c.id, c.version, { note: $('claimNote').value, notDelivered: true, inventory: $('cancelInventory').value }, '撤销 ' + c.short_id + ' 的兑奖？' + ($('cancelInventory').value === 'RETURN' ? '退回可用库存' : '退出可抽库存') + '，不退积分', () => {
            if (state.claim?.id === c.id) {
                $('claimDetail').hidden = true;
                state.claim = null;
            }

            $('claimList').textContent = '记录可能变化，请重新查询';
        });
    });

    return { showClaim };
}
`;
