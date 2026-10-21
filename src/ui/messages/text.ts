// 文本工具复用浏览器原生编辑事务，保留撤销、重做和输入法行为。
export const TEXT_EDITOR_SCRIPT = String.raw`
function createTextTools(body, changed) {
    let composing = false;
    body.addEventListener('compositionstart', () => { composing = true; });
    body.addEventListener('compositionend', () => { composing = false; });

    function insert(before, after = '', fallback = '文字', replaceSelection = false, line = false) {
        if (composing) { return; }

        let start = body.selectionStart, end = body.selectionEnd;
        const scroll = body.scrollTop;
        let selected = body.value.slice(start, end), text;

        if (line) {
            start = start === 0 ? 0 : body.value.lastIndexOf('\n', start - 1) + 1;
            const boundary = end > start && body.value[end - 1] === '\n' ? end - 1 : end;
            const next = body.value.indexOf('\n', boundary);
            end = next < 0 ? body.value.length : next;
            selected = body.value.slice(start, end);
            text = selected.split('\n').map(value => before + (value || fallback) + after).join('\n');
        } else {
            text = before + (replaceSelection ? '' : selected || fallback) + after;
        }

        body.focus({ preventScroll: true });
        body.setSelectionRange(start, end);

        // insertText 进入浏览器撤销栈；setRangeText 不会生成对应的原生撤销记录。
        if (!document.execCommand('insertText', false, text)) { throw Error('当前浏览器无法执行文本工具，请直接编辑正文'); }

        body.setSelectionRange(start + text.length, start + text.length);
        body.scrollTop = scroll;
        changed();
    }

    // 鼠标点击工具不让正文提前失焦，输入法组合期间由 insert 拦截。
    function retainSelection(container) {
        container.addEventListener('pointerdown', event => {
            if (event.target.closest('button')) { event.preventDefault(); }
        });
    }

    return { insert, retainSelection };
}
`;
