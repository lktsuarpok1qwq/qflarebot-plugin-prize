import { FIELDS } from './fields.js';
import type { MessageModule, TemplateField } from './fields.js';
import type { MessageButton, MessageConfiguration } from './config.js';

export type MessageCommands = Partial<Record<MessageButton['action'], string>>;
export interface PreviewMarkers { start: string; end: string; }
export interface RenderedButton { label: string; type: 'link' | 'command'; data: string; enter?: boolean; style: 0 | 1; personal: boolean; }
export interface MessageFacts { buyAllowed?: boolean; }

// 浏览器与发送端共用纯函数；不依赖 DOM、SDK 上下文或业务查询。
export function createMessageLayout(fields: typeof FIELDS) {
    // 只索引固定字段声明，不保存模板草稿或业务数据；首次展开时建立。
    let fragments: Map<string, Array<[string, TemplateField]>> | undefined;

    function fragmentCandidates(module: MessageModule, target: string, variable: string): Array<[string, TemplateField]> {
        if (!fragments) {
            fragments = new Map();

            for (const [scope, entries] of Object.entries(fields)) {
                for (const [name, field] of Object.entries(entries)) {
                    if (!field.fragment) { continue; }

                    const uses = [field.fragment, ...field.fragment.also ?? []];

                    for (const key of new Set(uses.map(use => scope + '/' + use.message + '/' + use.variable))) {
                        const candidates = fragments.get(key) ?? [];
                        candidates.push([name, field]);
                        fragments.set(key, candidates);
                    }
                }
            }
        }

        return fragments.get(module + '/' + target + '/' + variable) ?? [];
    }

    function finalizeMarkdown(source: string, markers?: PreviewMarkers): string {
        const clean = (line: string) => markers && (markers.start || markers.end) ? line.split(markers.start).join('').split(markers.end).join('') : line;
        const normalized = source.replace(/\r\n?/g, '\n');

        if (!clean(normalized).trim()) { return normalized; }

        const lines = normalized.split('\n'), output: string[] = [];
        const block = (line: string) => /^(?:#{1,2}\s|>\s?|\s*(?:[-*]|\d+\.)\s|\s*\*\s*\*\s*\*\s*$)/.test(clean(line));
        const placeholder = (line: string) => /^[ \t]*\u200b[ \t]*$/.test(clean(line));
        const list = (line: string) => /^( *)(?:[-*]|\d+\.)\s+/.exec(clean(line));
        const following = new Array<string>(lines.length);
        let upcoming = '';

        for (let index = lines.length - 1; index >= 0; index--) {
            following[index] = upcoming;

            if (clean(lines[index]!).trim()) { upcoming = lines[index]!; }
        }

        let listIndent: number | undefined;

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index]!;

            if (clean(line).trim()) {
                const item = list(line);

                if (item && !/^\s*(\*\s*){3,}$/.test(clean(line))) { listIndent = item[1]!.length; } else if (listIndent !== undefined && /^ */.exec(clean(line))![0].length < listIndent + 4) { listIndent = undefined; }

                output.push(line);
                continue;
            }

            const previous = lines[index - 1] ?? '', next = lines[index + 1] ?? '';

            // 只保留块与独立占位行之间的结构边界，正文中的零宽字符不吞掉用户空行。
            if (block(previous) && placeholder(next) || placeholder(previous) && block(next)) {
                output.push(line);
                continue;
            }

            const upcoming = following[index]!;
            const nextItem = list(upcoming);
            const withinList = listIndent !== undefined && (nextItem && nextItem[1]!.length >= listIndent || /^ */.exec(clean(upcoming))![0].length >= listIndent + 4);

            // 保留块结构的空行边界，用户要求的可见留白由独立占位行表达。
            if (!withinList && index > 0 && block(previous)) { output.push(''); }

            output.push((withinList ? ' '.repeat(Math.max(line.length, listIndent! + 4)) : line) + '\u200b');

            if (index + 1 < lines.length && block(next)) { output.push(''); }
        }

        return output.join('\n');
    }

    function separatorFor(module: MessageModule, config: MessageConfiguration, key: string): string {
        const separator = config.separators?.[key] ?? fields[module][key]?.fragment?.separator;

        if (separator === undefined) { throw new Error('TEMPLATE_LIST_SEPARATOR_MISSING:' + key); }

        return separator;
    }

    function joinItems(module: MessageModule, config: MessageConfiguration, key: string, items: string[]): string {
        return items.join(separatorFor(module, config, key));
    }

    function actionCommands(commands: MessageCommands, facts: MessageFacts): MessageCommands {
        const values = { ...commands };
        values.buy = facts.buyAllowed ? values.buy : '';

        return values;
    }

    function buttonRows(module: MessageModule, config: MessageConfiguration, key: string, commands: MessageCommands, scene: string, facts: MessageFacts): RenderedButton[][] {
        commands = actionCommands(commands, facts);

        return (config.buttons[key] ?? []).map(row => row.flatMap<RenderedButton>(item => {
            if (item.action === 'link') { return [{ label: item.label, type: 'link' as const, data: item.data!, style: 0 as const, personal: false }]; }

            const command = item.action === 'command' ? item.data : commands[item.action];
            const publicAction = ['pool', 'records', 'prizes', 'buy'].includes(item.action)
                || module === 'pool' && key === 'activities' && item.action === 'next';

            return command ? [{
                label: item.label, type: 'command' as const, data: command,
                enter: scene === 'group' ? false : item.enter,
                style: (['buy', 'next'].includes(item.action) ? 1 : 0) as 0 | 1, personal: !publicAction
            }] : [];
        })).filter(row => row.length);
    }

    return { finalizeMarkdown, separatorFor, joinItems, actionCommands, buttonRows, fragmentCandidates };
}

export const { finalizeMarkdown, separatorFor, joinItems, actionCommands, buttonRows, fragmentCandidates } = createMessageLayout(FIELDS);
