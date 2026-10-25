export const navigationUI = String.raw`
function initNavigation({ $, state, invalidate, messageEditor, showStockList, poolEditor, syncDirty }) {
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
}
`;
