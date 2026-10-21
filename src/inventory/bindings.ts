// 奖项上限为二十；使用公开 SDK 支持的标量 JSON 函数，不使用表值函数。
export function bindingExists(prize = '{prizes}'): string {
    const references = Array.from({ length: 20 }, (_, index) =>
        `json_extract(binding.rules,'$.awards[${index}].prizeId')=${prize}.id`).join(' OR ');

    return `EXISTS(SELECT 1 FROM {pools} binding WHERE binding.bot_id=${prize}.bot_id AND (${references}))`;
}
