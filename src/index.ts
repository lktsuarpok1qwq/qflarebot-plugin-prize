import { definePlugin } from '@qqbot/sdk';
import { command } from './messages/commands.js';
import { routes } from './admin/routes.js';
import { maintenance } from './maintenance.js';
import { install, ready } from './storage/schema.js';
import { access } from './access.js';

export default definePlugin({
    name: 'prize', displayName: '奖品中心', description: '多奖池与私聊奖品中心', apiVersion: 4,
    permissions: ['db', 'admin'], depends: { 'points.wallet': '*' },
    configSchema: { type: 'object', properties: {} },
    hooks: { onInstall: install },
    commands: {
        '抽奖': { description: '查看奖池、抽奖、概率及本人记录', scenes: ['group', 'c2c'], handler: input => command(input, 'pool') },
        '兑奖': { description: '私聊查看中奖记录与申请兑奖', scenes: ['group', 'c2c'], handler: input => command(input, 'prize') }
    },
    ui: { path: '/ui/', title: '奖品中心' }, routes,
    cron: {
        'prize-maintenance': {
            cron: '*/10 * * * *', handler: async ({ ctx }) => {
                try {
                    await ready(ctx);
                    await maintenance(ctx);
                    await access(ctx);
                } catch { ctx.logger.warn('Prize preparation or maintenance pending; inspect runtime status'); }
            }
        }
    }
});
