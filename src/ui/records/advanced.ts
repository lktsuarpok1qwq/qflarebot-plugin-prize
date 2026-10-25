export const advancedUI = String.raw`
function initAdvanced({ $, api, archiveCard, button, readRegion, renderArchive, requireField, run, state, write }) {
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

    let operationCursor = null, operationSerial = 0;
    $('operationId').oninput = () => {
        operationSerial++;
        operationCursor = null;
        $('operationNext').disabled = true;
        $('operationResult').textContent = '操作号已变化，请重新查询';
    };
    document.addEventListener('prize:write', event => {
        if (event.detail?.action) { operationSerial++; }

        archiveCursor = null;
        operationCursor = null;
        $('archiveNext').disabled = true;
        $('operationNext').disabled = true;
    });

    async function readOperation(path, serial) {
        try { return await readRegion('operationResult', () => api(path)); } catch (error) {
            if (serial !== operationSerial) { return null; }

            throw error;
        }
    }

    async function loadOperations(next = false) {
        const serial = ++operationSerial;

        if (!next) {
            operationCursor = null;
            $('operationNext').disabled = true;
        }

        const result = await readOperation('/api/operations' + (next && operationCursor ? '?cursor=' + encodeURIComponent(operationCursor) : ''), serial);

        if (!result || serial !== operationSerial) { return; }

        if (!Array.isArray(result.data?.rows)) { throw new Error('操作目录响应不完整'); }

        operationCursor = result.data.next;
        $('operationNext').disabled = !operationCursor;
        $('operationResult').textContent = JSON.stringify(result.data.rows, null, 2);
    }

    $('recentOperations').onclick = () => run(() => loadOperations());
    $('operationNext').onclick = () => run(() => loadOperations(true));
    $('queryOperation').onclick = () => run(async () => {
        const id = $('operationId').value;
        const serial = ++operationSerial;
        operationCursor = null;
        $('operationNext').disabled = true;

        requireField($('operationId'), !id ? '请填写操作号' : undefined);

        const result = await readOperation('/api/operations/' + encodeURIComponent(id), serial);

        if (!result || serial !== operationSerial || $('operationId').value !== id) { return; }

        if (result.data && result.data.operationId !== id) { throw new Error('操作对象不匹配'); }

        $('operationResult').textContent = result.data ? JSON.stringify(result.data, null, 2) : '尚未找到，不能据此认定没有在途提交';
    });
}
`;
