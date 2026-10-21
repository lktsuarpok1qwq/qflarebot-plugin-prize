import { FIELDS } from './fields.js';
import type { MessageModule } from './fields.js';
import type { MessageConfiguration } from './config.js';
import { commandUrl, escapeMarkdown, renderTemplate } from './config.js';

// 固定样例只用于浏览器预览，不读账户、不取随机结果。
export function createTemplatePreview(fields: typeof FIELDS, helpers: { escapeMarkdown: typeof escapeMarkdown; renderTemplate: typeof renderTemplate; commandUrl: typeof commandUrl }) {
    const FIELDS = fields, { commandUrl, escapeMarkdown, renderTemplate } = helpers;

    return function previewText(module: MessageModule, config: MessageConfiguration, key: string, mode: string, scenario: string,
        markers: { start: string; end: string }): { text: string; root: string; hiddenActions?: string[] } {
        const fields = FIELDS[module];

        if (mode === 'layout') { return { text: config.replies[key]!, root: key }; }

        let root = key;
        const path = new Set<string>();

        while (fields[root]!.fragment) {
            if (path.has(root)) { throw new Error('模板片段循环'); }

            path.add(root);
            root = fields[root]!.fragment!.message;
        }

        const sample: Record<string, string> = {
            purchaseUrl: commandUrl('/抽奖 抽 demo'), probabilityUrl: commandUrl('/抽奖 概率 demo'), continueUrl: commandUrl('/抽奖 继续 Ddemo'), detailUrl: commandUrl('/兑奖 Pdemo'), claimUrl: commandUrl('/兑奖 领取 Pdemo'), detailsUrl: commandUrl('/兑奖 资料 Pdemo 0 ', false),
            command: '/抽奖', prizeCommand: '/兑奖', pointsCommand: '/积分', name: '示例活动', cost: '1.00', reward: '5.00', net: '4.00',
            id: 'Ddemo', state: '已完成', label: '积分奖', probability: '25.0000', time: '2026-10-01T12:00:00Z', expires: '2026-10-02 20:00:00', detailsVersion: '0',
            continueCommand: '/抽奖 继续 Ddemo', purchaseCommand: '/抽奖 抽 demo', nextCommand: scenario === 'last' ? '' : '/抽奖 翻页 示例游标', message: config.words.INSUFFICIENT_BALANCE || '积分不足', code: 'INSUFFICIENT_BALANCE', action: '申请已记录'
        };

        if (module === 'prize') {
            sample.name = '示例奖品';
            sample.id = 'Pdemo';
            sample.nextCommand = scenario === 'last' ? '' : '/兑奖 翻页 示例游标';
        }

        const selectedCondition = fields[key]!.fragment?.when;
        const condition = scenario === 'normal' ? selectedCondition : scenario;

        if (module === 'prize') { sample.state = condition === 'terminal' ? '已发放' : condition === 'claimed' || root === 'actionResult' ? '待发放' : '待申请'; }

        const compose = (target: string, ancestors: string[] = []): string => {
            if (ancestors.includes(target)) { throw new Error('模板片段循环'); }

            const field = fields[target]!;
            const values: Record<string, string> = {};

            for (const variable of field.variables) {
                if (target === 'detail' && variable === 'instructions' && condition === 'terminal') {
                    values[variable] = '';
                    continue;
                }

                const candidates = Object.entries(fields).filter(([, f]) => f.fragment?.message === target && f.fragment.variable === variable || f.fragment?.also?.some(use => use.message === target && use.variable === variable));
                let chosen = candidates.find(([, f]) => f.fragment?.when === condition) ?? candidates.find(([, f]) => !f.fragment?.when);

                if (candidates.some(([name]) => name === key) && ancestors.includes(root)) { chosen = candidates.find(([name]) => name === key); }

                values[variable] = chosen ? compose(chosen[0], ancestors.concat(target)) : (variable.endsWith('Url') ? sample[variable]! : escapeMarkdown(sample[variable] ?? (() => { throw new Error('缺少样例：' + variable); })()));
            }

            const text = renderTemplate(config.replies[target]!, values);

            return target === key && key !== root ? markers.start + text + markers.end : text;
        };

        const hiddenActions = module === 'prize' ? root === 'detail' ? condition === 'terminal' ? ['claim', 'details'] : [condition === 'claimed' ? 'claim' : 'details'] : root === 'list' && condition === 'empty' ? ['claim'] : [] : root === 'probability' && condition === 'empty' ? ['buy'] : [];

        return { text: compose(root), root, hiddenActions };
    }
}

export const previewText = createTemplatePreview(FIELDS, { commandUrl, escapeMarkdown, renderTemplate });
