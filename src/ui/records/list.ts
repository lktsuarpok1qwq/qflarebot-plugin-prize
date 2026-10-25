export const listUI = String.raw`
function initLists({ $, api, button, claimDates, claimStates, claimTime, fields, invalidate, node, readRegion, recordCard, recordDates, run, showClaim, showDraw, state }) {
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

            if (!next) {
                for (const [key, value] of Object.entries((table === 'draws' ? recordDates : claimDates).read())) { params.set(key, String(value)); }
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
                claimDates.reset();
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

    return { setupList };
}
`;
