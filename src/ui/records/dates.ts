export const datesUI = String.raw`
function initDates({ $, fieldError, requireField }) {
    function dateRange(id, unlimited = false) {
        const day = 86400000;
        const preset = $(id + 'Preset'), from = $(id + 'From'), to = $(id + 'To');
        const today = () => Math.floor((Date.now() + 8 * 3600000) / day) * day - 8 * 3600000;
        const date = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
        const sync = () => {
            const custom = preset.value === 'custom';
            $(id + 'Custom').hidden = !custom;
            from.disabled = to.disabled = !custom || preset.disabled;
            from.required = to.required = custom && !preset.disabled;

            if (!custom) {
                fieldError(from, '');
                fieldError(to, '');
            }

            if (custom && !from.value && !to.value) {
                from.value = date(today() - 6 * day);
                to.value = date(today());
            }
        };
        preset.addEventListener('change', sync);
        sync();

        return {
            reset: sync,
            enable(enabled) {
                $(id + 'Range').hidden = !enabled;
                preset.disabled = !enabled;
                sync();
            },
            read() {
                const current = today();

                if (preset.disabled) { return { from: current, to: current + day }; }

                if (unlimited && preset.value === 'all') { return {}; }

                let start, end;

                if (preset.value === 'custom') {
                    start = Date.parse(from.value + 'T00:00:00+08:00');
                    end = Date.parse(to.value + 'T00:00:00+08:00') + day;

                    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0
                        || date(start) !== from.value || date(end - day) !== to.value || end <= start) { requireField(to, '请选择有效的日期范围'); }
                } else {
                    const count = ({ today: 1, '7': 7, '30': 30 })[preset.value];

                    if (!count) { throw new Error('请选择日期范围'); }

                    start = current - (count - 1) * day;
                    end = current + day;
                }

                if (!unlimited && end - start > 31 * day) { requireField(to, '统计范围最多31天'); }

                return { from: start, to: end };
            }
        };
    }

    const claimDates = dateRange('claim', true);
    const recordDates = dateRange('record', true);
    const statsDates = dateRange('stats');

    return { claimDates, recordDates, statsDates };
}
`;
