import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';

export interface EditorCommand { id: string; title: string; roots: string[]; }
export const EDITOR_COMMANDS: Record<MessageModule, EditorCommand[]> = {
    pool: [
        { id: 'pools', title: '/抽奖 [游标] · 奖池列表', roots: ['activities'] },
        { id: 'awards', title: '/抽奖 奖项 <奖池> · 奖项一览', roots: ['probability'] },
        { id: 'buy', title: '/抽奖 抽 <奖池> · 购买结果', roots: ['pending', 'refunded', 'settled', 'goodsWon'] },
        { id: 'records', title: '/抽奖 记录 [奖池ID] [游标] · 抽奖记录', roots: ['records'] },
        { id: 'help', title: '/抽奖 帮助 · 使用帮助', roots: ['help'] }
    ],
    prize: [
        { id: 'prizes', title: '/兑奖 [游标] · 全部兑奖记录', roots: ['list', 'help'] }
    ],
    common: [
        { id: 'draw', title: '/抽奖 · 通用提示', roots: ['error', 'accountRequired', 'privateOnly'] },
        { id: 'prize', title: '/兑奖 · 通用提示', roots: ['error', 'privateOnly'] }
    ]
};

// 同一个片段只有一份配置；命令只决定编辑入口、完整消息上下文与示例情景。
export function createEditorNavigation(fields: typeof FIELDS, commands: typeof EDITOR_COMMANDS) {
    function entries(module: MessageModule, command: string) {
        const entry = commands[module].find(item => item.id === command);

        if (!entry) { throw new Error('EDITOR_COMMAND_INVALID'); }

        const result: Array<{ key: string; root: string }> = [];
        const visit = (key: string, root: string, path: string[]) => {
            if (path.includes(key)) { throw new Error('模板片段循环'); }

            if (!result.some(item => item.key === key)) { result.push({ key, root }); }

            for (const [child, field] of Object.entries(fields[module])) {
                if ([field.fragment, ...field.fragment?.also ?? []].some(use => use?.message === key)) { visit(child, root, path.concat(key)); }
            }
        };
        entry.roots.forEach(root => visit(root, root, []));

        return result;
    }

    function context(module: MessageModule, command: string | undefined, key: string) {
        const entry = commands[module].find(item => item.id === command && entries(module, item.id).some(item => item.key === key))
            ?? commands[module].find(item => entries(module, item.id).some(item => item.key === key));

        if (!entry) { throw new Error('EDITOR_BRANCH_INVALID'); }

        return { ...entry, root: entries(module, entry.id).find(item => item.key === key)!.root };
    }

    function parent(module: MessageModule, command: string, key: string) {
        const root = context(module, command, key).root;
        const reachable = (target: string, seen = new Set<string>()): boolean => {
            if (target === root) { return true; }

            if (seen.has(target)) { return false; }

            seen.add(target);
            const fragment = fields[module][target]!.fragment;

            return [fragment, ...fragment?.also ?? []].some(use => use && reachable(use.message, seen));
        };
        const fragment = fields[module][key]!.fragment;

        return [fragment, ...fragment?.also ?? []].find(use => use && reachable(use.message))?.message;
    }

    return { entries, context, parent };
}

export const editorNavigation = createEditorNavigation(FIELDS, EDITOR_COMMANDS);
