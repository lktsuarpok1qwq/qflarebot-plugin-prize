import type { Claim } from '../contracts.js';
import { CLAIM_FIELDS } from '../contracts.js';

// 兑奖是同一购买行的独立读模型，写入始终直接作用于购买事实表。
export const claimColumns: Record<keyof Claim, string> = {
    bot_id: 'bot_id', id: 'claim_id', short_id: 'claim_short_id', draw_id: 'id', user_id: 'user_id', pool_id: 'pool_id',
    prize_id: 'claim_prize_id', award: 'claim_award', award_name: 'claim_award_name', created_at: 'claim_created_at',
    list_time: 'claim_list_time', state: 'claim_state', stock_state: 'claim_stock_state', obtained_at: 'claim_obtained_at',
    fulfilled_at: 'claim_fulfilled_at', cancelled_at: 'claim_cancelled_at', processed_at: 'claim_processed_at',
    version: 'claim_version', note: 'claim_note', admin_op: 'claim_admin_op', archive_id: 'claim_archive_id', archive_pending: 'claim_archive_pending'
};

export const claimView = `CREATE VIEW IF NOT EXISTS {claims} AS SELECT ${CLAIM_FIELDS.map(key => claimColumns[key] + ' AS ' + key).join(',')},
    state AS purchase_state FROM {draws} WHERE claim_id IS NOT NULL`;

export function claimSource(index: string): string {
    return `(SELECT ${CLAIM_FIELDS.map(key => claimColumns[key] + ' AS ' + key).join(',')},state AS purchase_state
        FROM {draws} INDEXED BY {${index}} WHERE claim_id IS NOT NULL${['claim_obtained', 'claim_user'].includes(index) ? ' AND claim_obtained_at IS NOT NULL' : ''})`;
}
