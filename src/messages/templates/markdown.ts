import { safeCommandUrl, safeHttpUrl } from './config.js';

// 仅用于浏览器预览的 QQ 文档子集；原始 HTML 始终转义，网页链接只接受 HTTP(S)，命令链接仅接受严格校验的 QQ 内联协议。
export function createMarkdown(safeHttpUrl: (value: unknown) => value is string, safeCommandUrl: (value: string) => boolean) {
    return function renderQQMarkdown(source: string, markers?: { start: string; end: string }): string {
        const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

        // 先移除来源标记并记录原文范围，Markdown 识别始终使用无标记正文。
        const ranges: Array<{ start: number; end: number }> = [];
        let offset = 0, opened = -1;
        const normalized = source.replace(/\r\n?/g, '\n');
        source = markers ? normalized.split(new RegExp('(' + markers.start + '|' + markers.end + ')', 'g')).map(part => {
            if (part === markers.start) {
                opened = offset;

                return '';
            }

            if (part === markers.end) {
                if (opened >= 0) { ranges.push({ start: opened, end: offset }); }

                opened = -1;

                return '';
            }

            offset += part.length;

            return part;
        }).join('') : normalized;
        const selected = (start: number, length: number) => ranges.some(range => range.start < start + length && range.end > start);
        const decorated = (text: string, start: number) => text.split('').map((char, index) => selected(start + index, 1) && char.trim() ? '<mark>' + escape(char) + '</mark>' : escape(char)).join('').replace(/<\/mark><mark>/g, '');

        function inline(text: string, start: number, nested = false): string {
            let html = '', cursor = 0;

            while (cursor < text.length) {
                if (text[cursor] === '\\' && cursor + 1 < text.length) {
                    html += decorated(text[cursor + 1]!, start + cursor);
                    cursor += 2;
                    continue;
                }

                const tail = text.slice(cursor);
                const link = /^(!?)\[([^\]\n]*)\]\(((?:https?:\/\/|mqqapi:\/\/aio\/inlinecmd\?)[^\s)]+)\)/i.exec(tail);
                const automatic = /^<(https?:\/\/[^\s>]+)>/i.exec(tail);

                if (link && (safeHttpUrl(link[3]) || !link[1] && safeCommandUrl(link[3]!))) {
                    const label = link[2]!, url = escape(link[3]!);

                    if (link[1]) {
                        const size = /\s+#(\d+)px\s+#(\d+)px$/.exec(label);
                        const alt = escape(size ? label.slice(0, size.index) : label);
                        html += '<span class="reply-image' + (selected(start + cursor, link[0].length) ? ' sample-highlight' : '') + '" data-preview-src="' + url + '" data-preview-alt="' + alt + '"'
                            + (size ? ' data-preview-width="' + size[1] + '" data-preview-height="' + size[2] + '"' : '') + '><span data-image-content>图片：' + alt + '</span> <button type="button" class="qb-btn" data-image-load>加载图片</button></span>';
                    } else if (safeCommandUrl(link[3]!)) {
                        html += '<button type="button" disabled title="命令链接，仅预览">' + decorated(label, start + cursor + 1) + '</button>';
                    } else {
                        html += '<a target="_blank" rel="noopener noreferrer" href="' + url + '">' + decorated(label, start + cursor + 1) + '</a>';
                    }

                    cursor += link[0].length;
                    continue;
                }

                if (automatic && safeHttpUrl(automatic[1])) {
                    const url = escape(automatic[1]!);
                    html += '<a target="_blank" rel="noopener noreferrer" href="' + url + '">' + decorated(automatic[1]!, start + cursor + 1) + '</a>';
                    cursor += automatic[0].length;
                    continue;
                }

                let matched = false;

                for (const [mark, open, close] of [['***', '<strong><em>', '</em></strong>'], ['___', '<strong><em>', '</em></strong>'], ['**', '<strong>', '</strong>'], ['__', '<strong>', '</strong>'], ['~~', '<del>', '</del>'], ['*', '<em>', '</em>'], ['_', '<em>', '</em>']]) {
                    if (!tail.startsWith(mark!)) { continue; }

                    let end = text.indexOf(mark!, cursor + mark!.length);

                    while (end > 0 && text[end - 1] === '\\') { end = text.indexOf(mark!, end + mark!.length); }

                    if (end <= cursor + mark!.length) { continue; }

                    const content = text.slice(cursor + mark!.length, end);
                    html += open + (nested ? decorated(content, start + cursor + mark!.length) : inline(content, start + cursor + mark!.length, true)) + close;
                    cursor = end + mark!.length;
                    matched = true;
                    break;
                }

                if (!matched) {
                    html += decorated(text[cursor]!, start + cursor);
                    cursor++;
                }
            }

            return html;
        }

        const stack: Array<{ indent: number; tag: string }> = [];
        let html = '';
        const close = () => { html += '</li></' + stack.pop()!.tag + '>'; };

        let lineStart = 0;

        for (const line of source.split('\n')) {
            const currentStart = lineStart;
            const content = (text: string) => inline(text, currentStart + line.length - text.length);
            lineStart += line.length + 1;
            const list = /^( *)([-*]|\d+\.)\s+(.*)$/.exec(line);
            const indent = /^ */.exec(line)![0].length;

            if (list && !/^\s*(\*\s*){3,}$/.test(line)) {
                const tag = /^\d/.test(list[2]!) ? 'ol' : 'ul';

                while (stack.length && indent < stack.at(-1)!.indent) { close(); }

                if (stack.length && indent === stack.at(-1)!.indent && tag !== stack.at(-1)!.tag) { close(); }

                if (!stack.length || indent > stack.at(-1)!.indent) {
                    html += '<' + tag + (tag === 'ol' ? ' start="' + parseInt(list[2]!, 10) + '"' : '') + '>';
                    stack.push({ indent, tag });
                } else { html += '</li>'; }

                html += '<li>' + content(list[3]!);
                continue;
            }

            if (stack.length && line.trim() && indent > stack.at(-1)!.indent) {
                html += '<div>' + inline(line.trim(), currentStart + line.length - line.trimStart().length) + '</div>';
                continue;
            }

            while (stack.length) { close(); }

            const heading = /^(#{1,2})\s+(.*)$/.exec(line);

            if (heading) { html += '<h' + heading[1]!.length + '>' + content(heading[2]!) + '</h' + heading[1]!.length + '>'; } else if (/^\s*(\*\s*){3,}$/.test(line)) { html += '<hr' + (selected(currentStart, line.length) ? ' class="sample-highlight"' : '') + '>'; } else if (/^>\s?/.test(line)) { html += '<blockquote>' + content(line.replace(/^>\s?/, '')) + '</blockquote>'; } else { html += '<div>' + (line ? content(line) : '<br>') + '</div>'; }
        }

        while (stack.length) { close(); }

        return html.replace(/<\/mark><mark>/g, '');
    }
}

export const renderQQMarkdown = createMarkdown(safeHttpUrl, safeCommandUrl);
