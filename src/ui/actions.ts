export const reloadIcon = '<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11a9 9 0 0 1 15-6l3 3M21 3v5h-5M21 13a9 9 0 0 1-15 6l-3-3M3 21v-5h5"/></svg>';
export const addIcon = '<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

export function loadButton(id: string, label: string, classes = ''): string {
    return `<button id="${id}" type="button" class="load-action primary ${classes}" data-load-action data-initial-label="${label}">${reloadIcon}<span data-load-label>${label}</span></button>`;
}
