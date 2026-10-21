import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import type { MessageConfiguration } from './config.js';
import { commandUrl, escapeMarkdown, renderTemplate } from './config.js';

// 固定样例只用于浏览器预览，不读账户、不取随机结果。
export function createTemplatePreview(fields: typeof FIELDS, helpers: { escapeMarkdown: typeof escapeMarkdown; renderTemplate: typeof renderTemplate; commandUrl: typeof commandUrl }) {
    const FIELDS = fields, { commandUrl, escapeMarkdown, renderTemplate } = helpers;

    function previewText(module: MessageModule, config: MessageConfiguration, key: string, mode: string, scenario: string,
        markers: { start: string; end: string }): { text: string; root: string; hiddenActions?: string[] } {
        const fields = FIELDS[module];

        let root = key;
        const path = new Set<string>();

        while (fields[root]!.fragment) {
            if (path.has(root)) { throw new Error('模板片段循环'); }

            path.add(root);
            root = fields[root]!.fragment!.message;
        }

        const selectedCondition = fields[key]!.fragment?.when;
        const condition = scenario === 'normal' ? selectedCondition ?? (root === 'actionResult' ? 'claimed' : undefined) : scenario;
        const hiddenActions = new Set<string>();

        if (['empty', 'last'].includes(condition ?? '')) { hiddenActions.add('next'); }

        if (condition === 'group' || module === 'common' && root === 'privateOnly') {
            for (const action of ['claim', 'details', 'prizes', 'history', 'account']) { hiddenActions.add(action); }
        }

        if (module === 'prize' && ['detail', 'actionResult'].includes(root) || module === 'pool' && root === 'goodsWon') {
            if (condition === 'terminal' || condition === 'expired') {
                hiddenActions.add('claim');
                hiddenActions.add('details');
            } else { hiddenActions.add(condition === 'claimed' ? 'claim' : 'details'); }
        }

        if (module === 'prize' && root === 'list' && condition === 'empty') { hiddenActions.add('claim'); }

        if (module === 'pool' && root === 'probability' && condition === 'empty') { hiddenActions.add('buy'); }

        if (mode === 'layout') { return { text: config.replies[key]!, root: key, hiddenActions: [...hiddenActions] }; }

        const sampleDraw = 'D4845cd5fd64d48b4801f13a7c4959536', samplePrize = 'P4845cd5fd64d48b4801f13a7c4959536';
        const sample: Record<string, string> = {
            purchaseUrl: commandUrl('/抽奖 抽 demo 2', condition !== 'group'), probabilityUrl: commandUrl('/抽奖 奖项 demo', condition !== 'group'), continueUrl: commandUrl('/抽奖 继续 ' + sampleDraw), detailUrl: commandUrl('/兑奖 ' + samplePrize), claimUrl: commandUrl('/兑奖 领取 ' + samplePrize), detailsUrl: commandUrl('/兑奖 资料 ' + samplePrize + ' 0 ', false),
            command: '/抽奖', prizeCommand: '/兑奖', pointsCommand: '/积分', name: '示例活动', cost: '1', reward: '5', net: '4',
            id: sampleDraw, state: '已完成', label: '积分奖', icon: '🪙', probability: '25', time: '2026-10-01T12:00:00Z', expires: '2026-10-02 20:00:00', detailsVersion: '0',
            continueCommand: '/抽奖 继续 ' + sampleDraw, purchaseCommand: '/抽奖 抽 demo 2', nextCommand: scenario === 'last' ? '' : '/抽奖 翻页 示例游标', message: config.words.INSUFFICIENT_BALANCE || '积分不足', code: 'INSUFFICIENT_BALANCE', action: '申请已记录', notice: '',
            instructions: condition === 'group' ? renderTemplate(FIELDS.common.privateOnly!.text, { prizeCommand: '/兑奖 领取 ' + samplePrize }) : ''
        };

        if (module === 'pool' && root === 'activities') { sample.nextCommand = scenario === 'last' ? '' : '/抽奖 奖池 示例游标'; }

        if (module === 'prize') {
            sample.name = '示例奖品';
            sample.id = samplePrize;
            sample.nextCommand = scenario === 'last' ? '' : '/兑奖 翻页 示例游标';
        }

        if (module === 'pool' && root === 'probability') { sample.state = '开放中'; }

        if (module === 'pool' && (root === 'pending' || condition === 'pending')) { sample.state = condition === 'review' ? '等待管理员核查' : '处理中'; }

        if (module === 'prize' || root === 'goodsWon') { sample.state = condition === 'terminal' ? '已发放' : condition === 'expired' ? '已过期' : condition === 'claimed' ? '待发放' : '待领取'; }

        const compose = (target: string, ancestors: string[] = [], overrides: Record<string, string> = {}): string => {
            if (ancestors.includes(target)) { throw new Error('模板片段循环'); }

            const field = fields[target]!;
            const values: Record<string, string> = {};
            const data = { ...sample, ...overrides };

            for (const variable of field.variables) {
                if (['detail', 'actionResult'].includes(target) && variable === 'instructions' && ['terminal', 'expired'].includes(condition ?? '')
                    || target === 'item' && variable === 'claimAction' && ['claimed', 'terminal', 'expired'].includes(condition ?? '')) {
                    values[variable] = '';
                    continue;
                }

                if (target === 'goodsWon' && variable === 'instructions') {
                    values[variable] = sample.instructions!;
                    continue;
                }

                const candidates = Object.entries(fields).filter(([, f]) => f.fragment?.message === target && f.fragment.variable === variable || f.fragment?.also?.some(use => use.message === target && use.variable === variable));
                let chosen = candidates.find(([, f]) => f.fragment?.when === condition) ?? candidates.find(([, f]) => !f.fragment?.when);

                if (candidates.some(([name]) => name === key) && ancestors.includes(root)) { chosen = candidates.find(([name]) => name === key); }

                if (target === 'probability' && variable === 'items' && chosen?.[0] === 'probabilityItem') {
                    const awards: Array<Record<string, string>> = [
                        { label: '谢谢参与', icon: '🍀', reward: '0', probability: '35' },
                        { label: '小有收获', icon: '🪙', reward: '50', probability: '30' },
                        { label: '回本', icon: '🪙', reward: '100', probability: '20' },
                        { label: '虚拟礼物', icon: '🎁', reward: '0', rewardName: '纪念兑换券', probability: '10' },
                        { label: '特别大奖', icon: '📦', reward: '0', rewardName: '纪念奖品', probability: '5' }
                    ];
                    values[variable] = awards.map(award => compose('probabilityItem', ancestors.concat(target), award)).join(fields.probabilityItem!.fragment!.separator!);
                    continue;
                }

                if (target === 'probabilityItem' && variable === 'reward' && data.rewardName) {
                    values[variable] = escapeMarkdown(data.rewardName);
                    continue;
                }

                values[variable] = chosen ? compose(chosen[0], ancestors.concat(target), overrides) : (variable.endsWith('Url') ? data[variable]! : escapeMarkdown(data[variable] ?? (() => { throw new Error('缺少样例：' + variable); })()));
            }

            const text = renderTemplate(config.replies[target]!, values);

            return target === key && key !== root ? markers.start + text + markers.end : text;
        };

        return { text: compose(root), root, hiddenActions: [...hiddenActions] };
    }

    function scenarios(module: MessageModule, config: MessageConfiguration, key: string): Array<[string, string]> {
        const candidates = FIELDS[module][key]!.scenarios ?? [['normal', '默认']];
        const seen = new Set<string>();

        return candidates.filter(([scenario]) => {
            const result = previewText(module, config, key, 'sample', scenario, { start: '', end: '' });
            const rows = (config.buttons[result.root] ?? []).map(row => row.filter(item => !result.hiddenActions?.includes(item.action))).filter(row => row.length);
            const signature = JSON.stringify([result.text, rows]);

            if (seen.has(signature)) { return false; }

            seen.add(signature);

            return true;
        }) as Array<[string, string]>;
    }

    return Object.assign(previewText, { scenarios });
}

export const previewText = createTemplatePreview(FIELDS, { commandUrl, escapeMarkdown, renderTemplate });
