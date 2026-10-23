// 当前规则引用由同一规则保存事务维护，按商品索引读取。
export function bindingExists(prize = '{prizes}'): string {
    return `EXISTS(SELECT 1 FROM {pool_prizes} binding WHERE binding.bot_id=${prize}.bot_id AND binding.prize_id=${prize}.id)`;
}
