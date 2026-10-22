/**
 * Ledger — all DOM. No SillyTavern imports: the caller supplies settings, the
 * computed view, and callbacks, which keeps the same UI testable in the harness.
 */

import { FIELD_DEFAULTS, clone } from './state.js';

const ICONS = {
    layer: 'fa-layer-group',
    sync: 'fa-bolt',
    settings: 'fa-sliders',
    collapse: 'fa-chevron-left',
    history: 'fa-clock-rotate-left',
    back: 'fa-arrow-left',
    edit: 'fa-pen',
    lock: 'fa-lock',
    unlock: 'fa-lock-open',
    x: 'fa-xmark',
    up: 'fa-arrow-up',
    down: 'fa-arrow-down',
    trash: 'fa-trash-can',
    plus: 'fa-plus',
    check: 'fa-check',
};

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[character]));
}

function icon(name, extra = '') {
    return `<i class="fa-solid ${ICONS[name] ?? name} ${extra}" aria-hidden="true"></i>`;
}

function relTime(timestamp) {
    if (!timestamp) {
        return '';
    }
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 45) {
        return 'just now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    return `${Math.round(hours / 24)}d ago`;
}

function rangeLabel(from, to) {
    if (!to || to <= from) {
        return 'manual edit';
    }
    return from === 0 ? `#1–#${to}` : `#${from + 1}–#${to}`;
}

let inlineCollapsed = true;

export function setInlineCollapsed(value) {
    inlineCollapsed = Boolean(value);
}

export function getInlineCollapsed() {
    return inlineCollapsed;
}

/* --------------------------------------------------------------------- panel */

export function createPanel({ onAction }) {
    const el = document.createElement('aside');
    el.id = 'lgd-panel';
    el.className = 'lgd-panel';
    el.setAttribute('aria-label', 'Ledger status tracker');
    el.innerHTML = `
        <div class="lgd-head" data-grip>
            <div class="lgd-head-text">
                <div class="lgd-eyebrow">${icon('layer')} <span>Ledger</span></div>
                <div class="lgd-title" data-ref="title">No chat</div>
            </div>
            <div class="lgd-head-actions">
                <span class="lgd-badge" data-ref="badge" hidden>0</span>
                <button class="lgd-icon-btn" type="button" data-act="sync" title="Scan new messages" aria-label="Scan new messages">${icon('sync')}</button>
                <button class="lgd-icon-btn" type="button" data-act="settings" title="Ledger settings" aria-label="Ledger settings">${icon('settings')}</button>
                <button class="lgd-icon-btn" type="button" data-act="collapse" title="Minimise or open the panel" aria-label="Minimise or open the panel">${icon('collapse')}</button>
            </div>
        </div>
        <div class="lgd-status" data-ref="status"></div>
        <div class="lgd-progress" data-ref="progress"><span data-ref="bar"></span></div>
        <div class="lgd-body" data-ref="body"></div>
        <div class="lgd-foot">
            <button class="lgd-btn lgd-btn-primary" type="button" data-act="sync" data-ref="syncBtn">${icon('sync')} <span data-ref="syncLabel">Sync</span></button>
            <button class="lgd-btn" type="button" data-act="view" data-view="history" data-ref="histBtn">${icon('history')} History</button>
        </div>`;

    const state = { mode: 'fields', editingId: null, expandedHistory: new Set(), view: null, collapsed: false };

    const refs = {
        title: el.querySelector('[data-ref="title"]'),
        badge: el.querySelector('[data-ref="badge"]'),
        status: el.querySelector('[data-ref="status"]'),
        bar: el.querySelector('[data-ref="bar"]'),
        progress: el.querySelector('[data-ref="progress"]'),
        body: el.querySelector('[data-ref="body"]'),
        syncBtn: el.querySelector('[data-ref="syncBtn"]'),
        syncLabel: el.querySelector('[data-ref="syncLabel"]'),
        histBtn: el.querySelector('[data-ref="histBtn"]'),
    };

    const emit = detail => onAction(detail);

    el.addEventListener('click', event => {
        const target = event.target.closest('[data-act]');
        if (!target || !el.contains(target)) {
            return;
        }
        const act = target.dataset.act;
        const id = target.dataset.id;

        switch (act) {
            case 'sync':
                emit({ type: state.view?.busy ? 'stop' : 'sync' });
                break;
            case 'settings':
                emit({ type: 'settings' });
                break;
            case 'collapse':
                state.collapsed = !state.collapsed;
                render(state.view);
                break;
            case 'view':
                state.mode = target.dataset.view === 'history' ? 'history' : 'fields';
                state.editingId = null;
                render(state.view);
                break;
            case 'edit':
                state.editingId = id;
                render(state.view);
                break;
            case 'edit-cancel':
                state.editingId = null;
                render(state.view);
                break;
            case 'edit-save': {
                const field = el.querySelector(`[data-id="${id}"] [data-ref="edit"]`);
                emit({ type: 'setValue', id, value: field ? field.value : '' });
                state.editingId = null;
                render(state.view);
                break;
            }
            case 'lock':
                emit({ type: 'toggleLock', id });
                break;
            case 'hist-toggle': {
                const index = Number(target.dataset.index);
                if (state.expandedHistory.has(index)) {
                    state.expandedHistory.delete(index);
                } else {
                    state.expandedHistory.add(index);
                }
                render(state.view);
                break;
            }
            case 'restore':
                emit({ type: 'restore', index: Number(target.dataset.index) });
                break;
            case 'clear':
                emit({ type: 'clear' });
                break;
            case 'syncAll':
                emit({ type: 'syncAll' });
                break;
            default:
                break;
        }
    });

    el.addEventListener('keydown', event => {
        const area = event.target.closest('[data-ref="edit"]');
        if (!area) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            state.editingId = null;
            render(state.view);
        } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const id = area.closest('[data-id]')?.dataset.id;
            emit({ type: 'setValue', id, value: area.value });
            state.editingId = null;
            render(state.view);
        }
    });

    /* drag by the header (and open the panel if it is a plain tap) */
    const head = el.querySelector('[data-grip]');
    let drag = null;
    let suppressClick = false;

    head.addEventListener('click', event => {
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        if (event.target.closest('button') || !state.collapsed) {
            return;
        }
        state.collapsed = false;
        render(state.view);
    });
    head.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button') || window.innerWidth <= 720) {
            return;
        }
        suppressClick = false;
        const rect = el.getBoundingClientRect();
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, w: rect.width, h: rect.height };
        el.classList.add('is-dragging');
        el.style.left = `${rect.left}px`;
        el.style.top = `${rect.top}px`;
        el.style.right = 'auto';
        head.setPointerCapture(event.pointerId);
    });
    head.addEventListener('pointermove', event => {
        if (!drag) {
            return;
        }
        const x = Math.min(window.innerWidth - 120, Math.max(8, event.clientX - drag.dx));
        const y = Math.min(window.innerHeight - 80, Math.max(8, event.clientY - drag.dy));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
    });
    head.addEventListener('pointerup', event => {
        if (!drag) {
            return;
        }
        drag = null;
        el.classList.remove('is-dragging');
        suppressClick = true;
        head.releasePointerCapture?.(event.pointerId);
        emit({ type: 'move', pos: { x: Math.round(el.offsetLeft), y: Math.round(el.offsetTop) } });
    });

    function render(view) {
        state.view = view;
        if (!view) {
            return;
        }
        el.dataset.mode = state.mode;
        el.classList.toggle('is-collapsed', state.collapsed);
        el.classList.toggle('is-busy', Boolean(view.busy));
        el.classList.toggle('is-error', Boolean(view.error));

        refs.title.textContent = view.characterName || 'No chat';
        refs.status.innerHTML = renderStatus(view);
        refs.badge.hidden = !(state.collapsed && view.pending > 0);
        refs.badge.textContent = String(view.pending);

        const ratio = view.busy
            ? (view.progress ? view.progress.done / Math.max(1, view.progress.total) : 0)
            : Math.min(1, view.pending / Math.max(1, view.everyN));
        refs.bar.style.width = `${Math.round(ratio * 100)}%`;
        refs.progress.classList.toggle('is-indeterminate', Boolean(view.busy && !view.progress));

        refs.syncLabel.textContent = view.busy ? 'Stop' : view.pending > 0 ? `Sync ${view.pending}` : 'Sync';
        refs.syncBtn.classList.toggle('is-stop', Boolean(view.busy));

        // One button that swaps between the two views, so history always has a way back.
        const historyOpen = state.mode === 'history';
        refs.histBtn.dataset.view = historyOpen ? 'fields' : 'history';
        refs.histBtn.innerHTML = historyOpen ? `${icon('back')} Fields` : `${icon('history')} History`;
        refs.histBtn.classList.toggle('is-active', historyOpen);
        refs.histBtn.title = historyOpen ? 'Back to the ledger' : 'Show what changed and when';

        if (state.collapsed) {
            return;
        }

        refs.body.innerHTML = state.mode === 'history' ? renderHistory(view) : renderFields(view);

        const editArea = el.querySelector('[data-ref="edit"]');
        if (editArea) {
            editArea.value = view.state.values[state.editingId] ?? '';
            editArea.focus();
            editArea.setSelectionRange(editArea.value.length, editArea.value.length);
        }
    }

    function renderStatus(view) {
        if (view.error) {
            const waiting = view.pending > 0 ? ` · ${view.pending} message${view.pending === 1 ? '' : 's'} waiting` : '';
            return `<span class="lgd-dot is-error"></span><span class="lgd-status-text" title="${esc(view.error)}">${esc(view.error)}${waiting}</span>`;
        }
        if (view.busy) {
            const label = view.progress && view.progress.total > 0
                ? `Scanning ${Math.min(view.progress.done + 1, view.progress.total)} of ${view.progress.total} new messages…`
                : 'Reading the new messages…';
            return `<span class="lgd-dot is-busy"></span><span class="lgd-status-text">${label}</span>`;
        }
        if (view.pending > 0) {
            const next = Math.max(0, view.everyN - view.pending);
            const tail = !view.settings.autoUpdate
                ? 'auto-sync is off'
                : view.pending >= view.everyN
                    ? 'syncing shortly'
                    : `${next} until the next automatic sync`;
            return `<span class="lgd-dot is-pending"></span><span class="lgd-status-text">${view.pending} new message${view.pending === 1 ? '' : 's'} · ${tail}</span>`;
        }
        return `<span class="lgd-dot is-ok"></span><span class="lgd-status-text">In sync · ${view.total} message${view.total === 1 ? '' : 's'}${view.syncedAt ? ` · synced ${relTime(view.syncedAt)}` : ''}</span>`;
    }

    function renderFields(view) {
        const banner = view.pending > view.chunkSize
            ? `<div class="lgd-banner">
                   <span>${view.pending} messages waiting</span>
                   <button type="button" class="lgd-link" data-act="syncAll">Sync all</button>
               </div>`
            : '';

        if (!view.fields.length) {
            return `<div class="lgd-empty">
                    ${icon('layer')}
                    <p class="lgd-empty-title">No fields</p>
                    <p class="lgd-empty-note">The tracker has nothing to record. Add at least one field in the tracker settings.</p>
                    <button type="button" class="lgd-btn" data-act="settings">${icon('settings')} Add a field</button>
                </div>`;
        }

        const active = view.fields.filter(field => field.value);
        if (!active.length && !view.hasValues) {
            return `${banner}
                <div class="lgd-empty">
                    ${icon('layer')}
                    <p class="lgd-empty-title">No status yet</p>
                    <p class="lgd-empty-note">The tracker reads the chat and keeps what the story establishes: time, place, clothing, money, health, relationships — whichever fields you keep.</p>
                    <button type="button" class="lgd-btn lgd-btn-primary" data-act="sync">${icon('sync')} Scan this chat</button>
                </div>`;
        }

        return `${banner}<div class="lgd-fields">${view.fields.map(field => renderField(field, view)).join('')}</div>`;
    }

    function renderField(field, view) {
        const editing = state.editingId === field.id;
        const changedAt = view.changedAt[field.id] || 0;
        const fresh = changedAt && Date.now() - changedAt < 90_000;
        const locked = Boolean(view.state.locks[field.id]);

        return `
            <div class="lgd-field" data-id="${esc(field.id)}" data-changed="${fresh ? '1' : '0'}" data-empty="${field.value ? '0' : '1'}">
                <div class="lgd-field-top">
                    <span class="lgd-field-label">${field.icon ? `<span class="lgd-field-icon">${esc(field.icon)}</span>` : ''}${esc(field.label)}</span>
                    <span class="lgd-field-tools">
                        ${changedAt ? `<span class="lgd-age">${relTime(changedAt)}</span>` : ''}
                        <button type="button" class="lgd-mini" data-act="lock" data-id="${esc(field.id)}" title="${locked ? 'Locked — scans will not change it' : 'Lock this field against scans'}" aria-label="${locked ? 'Unlock field' : 'Lock field'}" aria-pressed="${locked}">${icon(locked ? 'lock' : 'unlock')}</button>
                        <button type="button" class="lgd-mini" data-act="edit" data-id="${esc(field.id)}" title="Edit this value" aria-label="Edit this value">${icon('edit')}</button>
                    </span>
                </div>
                ${editing
                    ? `<textarea class="lgd-edit" data-ref="edit" rows="3" aria-label="${esc(field.label)} value"></textarea>
                       <div class="lgd-edit-actions">
                           <button type="button" class="lgd-btn lgd-btn-small lgd-btn-primary" data-act="edit-save" data-id="${esc(field.id)}">Save</button>
                           <button type="button" class="lgd-btn lgd-btn-small" data-act="edit-cancel">Cancel</button>
                       </div>`
                    : `<div class="lgd-value" data-act="edit" data-id="${esc(field.id)}" role="button" tabindex="0" title="${field.value ? 'Click to edit' : 'Empty — click to write something'}">${field.value ? esc(field.value) : '<span class="lgd-muted">—</span>'}</div>`}
            </div>`;
    }

    function renderHistory(view) {
        const entries = [...view.state.history].reverse();
        const header = `
            <div class="lgd-hist-headline">
                <span>${entries.length} update${entries.length === 1 ? '' : 's'}</span>
                <button type="button" class="lgd-link lgd-danger" data-act="clear">Clear ledger</button>
            </div>`;

        if (!entries.length) {
            return `${header}<div class="lgd-empty lgd-empty-small">${icon('history')}<p class="lgd-empty-note">No updates yet. Every sync that changes something is recorded here, and you can roll back to any of them.</p></div>`;
        }

        const rows = entries.map((entry, reverseIndex) => {
            const index = view.state.history.length - 1 - reverseIndex;
            const open = state.expandedHistory.has(index);
            const changes = Object.entries(entry.changes || {});
            const labels = changes
                .slice(0, 3)
                .map(([key]) => view.fields.find(field => field.id === key)?.label ?? key)
                .join(', ');
            const more = changes.length > 3 ? ` +${changes.length - 3}` : '';

            return `
                <div class="lgd-hist" data-open="${open ? '1' : '0'}">
                    <button type="button" class="lgd-hist-row" data-act="hist-toggle" data-index="${index}">
                        <span class="lgd-hist-range">${esc(rangeLabel(entry.from, entry.to))}</span>
                        <span class="lgd-hist-what">${esc(labels)}${esc(more)}</span>
                        <span class="lgd-hist-when">${relTime(entry.at)}</span>
                        ${icon(open ? 'up' : 'down', 'lgd-hist-caret')}
                    </button>
                    ${open ? `<div class="lgd-hist-detail">
                        ${changes.map(([key, change]) => {
                            const label = view.fields.find(field => field.id === key)?.label ?? key;
                            return `<div class="lgd-diff">
                                <div class="lgd-diff-label">${esc(label)}</div>
                                ${change.from ? `<div class="lgd-diff-old">${esc(change.from)}</div>` : ''}
                                <div class="lgd-diff-new">${change.to ? esc(change.to) : '<span class="lgd-muted">cleared</span>'}</div>
                            </div>`;
                        }).join('')}
                        <button type="button" class="lgd-btn lgd-btn-small" data-act="restore" data-index="${index}">${icon('back')} Restore this state</button>
                    </div>` : ''}
                </div>`;
        }).join('');

        return `${header}<div class="lgd-hist-list">${rows}</div>`;
    }

    return {
        el,
        render,
        collapse: () => { state.collapsed = true; },
        expand: () => { state.collapsed = false; render(state.view); },
        isCollapsed: () => state.collapsed,
    };
}

/* ------------------------------------------------------------- inline block */

export function buildInline(view) {
    const fields = view.fields.filter(field => field.inline && field.value);
    if (!fields.length) {
        return null;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'lgd-inline';
    wrapper.dataset.lgdFor = String(view.total - 1);
    const collapsed = inlineCollapsed;
    wrapper.classList.toggle('is-collapsed', collapsed);

    const preview = fields.slice(0, 2).map(field => field.value).join(' · ');
    const extra = fields.length - 2;

    wrapper.innerHTML = `
        <button type="button" class="lgd-inline-head" data-act="toggle" aria-expanded="${!collapsed}">
            <span class="lgd-inline-eyebrow">${icon('layer')} Ledger</span>
            <span class="lgd-inline-preview">${esc(preview)}</span>
            ${extra > 0 ? `<span class="lgd-inline-more">+${extra}</span>` : ''}
            <i class="fa-solid fa-chevron-right lgd-inline-caret" aria-hidden="true"></i>
        </button>
        <div class="lgd-inline-body">
            ${view.settings.display.style === 'list'
                ? `<div class="lgd-list">${fields.map(field => `
                        <div class="lgd-row">
                            <span class="lgd-row-label">${view.settings.display.showIcons && field.icon ? `<span class="lgd-field-icon">${esc(field.icon)}</span>` : ''}${esc(field.label)}</span>
                            <span class="lgd-row-value">${esc(field.value)}</span>
                        </div>`).join('')}</div>`
                : `<div class="lgd-grid">${fields.map(field => `
                        <div class="lgd-cell">
                            <span class="lgd-cell-label">${view.settings.display.showIcons && field.icon ? `<span class="lgd-field-icon">${esc(field.icon)}</span>` : ''}${esc(field.label)}</span>
                            <span class="lgd-cell-value">${esc(field.value)}</span>
                        </div>`).join('')}</div>`}
        </div>`;

    wrapper.querySelector('[data-act="toggle"]')?.addEventListener('click', event => {
        const next = !wrapper.classList.contains('is-collapsed');
        wrapper.classList.toggle('is-collapsed', next);
        setInlineCollapsed(next);
        event.currentTarget.setAttribute('aria-expanded', String(!next));
    });

    return wrapper;
}

/* --------------------------------------------------------------------- modal */

export function buildSettingsModal({ settings, view, getView, onChange, onClose }) {
    const root = document.createElement('div');
    root.className = 'lgd-modal';
    root.innerHTML = `
        <header class="lgd-modal-head">
            <div class="lgd-modal-titles">
                <div class="lgd-eyebrow">${icon('layer')} <span>Ledger</span></div>
                <h3 class="lgd-modal-title">Tracker settings</h3>
                <p class="lgd-modal-sub">${esc(view.characterName || 'No chat')} · tracked to message ${view.state.cursor} of ${view.total}</p>
            </div>
            <button type="button" class="lgd-icon-btn" data-act="close" aria-label="Close settings" title="Close">${icon('x')}</button>
        </header>
        <nav class="lgd-tabs" role="tablist">
            <button type="button" class="lgd-tab is-active" role="tab" data-tab="fields" aria-selected="true">Fields</button>
            <button type="button" class="lgd-tab" role="tab" data-tab="display" aria-selected="false">Display</button>
            <button type="button" class="lgd-tab" role="tab" data-tab="prompt" aria-selected="false">Prompt</button>
        </nav>
        <div class="lgd-modal-body" data-ref="body"></div>
        <footer class="lgd-modal-foot">
            <span class="lgd-note">Changes apply immediately. Closing keeps everything.</span>
            <button type="button" class="lgd-btn lgd-btn-primary" data-act="close">Done</button>
        </footer>`;

    const body = root.querySelector('[data-ref="body"]');
    let tab = 'fields';

    function paint() {
        if (typeof getView === 'function') {
            view = getView();
        }
        root.querySelectorAll('.lgd-tab').forEach(button => {
            const active = button.dataset.tab === tab;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
        });
        body.innerHTML = tab === 'fields' ? fieldsTab() : tab === 'display' ? displayTab() : promptTab();
    }

    function update(mutate, rerender = false) {
        mutate();
        onChange();
        if (rerender) {
            paint();
        }
    }

    function fieldsTab() {
        return `
            <p class="lgd-note lgd-note-top">One field per value the tracker should maintain. The hint is the instruction the model reads — say what belongs in the field, not what is happening in the story.</p>
            <div class="lgd-frows">
                ${settings.fields.map((field, index) => `
                    <div class="lgd-frow" data-id="${esc(field.id)}" data-index="${index}">
                        <div class="lgd-frow-top">
                            <input class="lgd-input lgd-input-icon" data-k="icon" value="${esc(field.icon)}" maxlength="4" aria-label="Icon" title="Emoji or short glyph">
                            <input class="lgd-input lgd-input-label" data-k="label" value="${esc(field.label)}" aria-label="Field label" placeholder="Label">
                            <button type="button" class="lgd-chip-toggle" data-act="toggle-inline" data-id="${esc(field.id)}" aria-pressed="${field.inline ? 'true' : 'false'}" title="Show this field in the block under the reply">Inline</button>
                            <span class="lgd-frow-move">
                                <button type="button" class="lgd-mini" data-act="move-up" data-id="${esc(field.id)}" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button>
                                <button type="button" class="lgd-mini" data-act="move-down" data-id="${esc(field.id)}" aria-label="Move down" ${index === settings.fields.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
                            </span>
                            <button type="button" class="lgd-mini lgd-danger" data-act="delete-field" data-id="${esc(field.id)}" aria-label="Delete field" title="Delete field">${icon('trash')}</button>
                        </div>
                        <textarea class="lgd-input lgd-input-hint" data-k="hint" rows="2" aria-label="Field hint" placeholder="What should the tracker record here?">${esc(field.hint)}</textarea>
                    </div>`).join('')}
            </div>
            <div class="lgd-frow-actions">
                <button type="button" class="lgd-btn" data-act="add-field">${icon('plus')} Add field</button>
                <button type="button" class="lgd-link" data-act="reset-fields">Reset to defaults</button>
            </div>`;
    }

    function displayTab() {
        return `
            <div class="lgd-group">
                <div class="lgd-group-title">Under the last reply</div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Show the status block</div><div class="lgd-switch-note">A compact block under the newest message. Nothing is added to the message text, so exports and edits stay clean.</div></div>
                    <button type="button" class="lgd-switch" role="switch" data-act="toggle-inline-display" aria-checked="${settings.display.inline}" data-on="${settings.display.inline}"><span></span></button>
                </div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Start collapsed</div><div class="lgd-switch-note">One line plus a chevron; expands on click.</div></div>
                    <button type="button" class="lgd-switch" role="switch" data-act="toggle-collapsed" aria-checked="${settings.display.startCollapsed}" data-on="${settings.display.startCollapsed}"><span></span></button>
                </div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Show field icons</div><div class="lgd-switch-note">The emoji from each field, next to its label.</div></div>
                    <button type="button" class="lgd-switch" role="switch" data-act="toggle-icons" aria-checked="${settings.display.showIcons}" data-on="${settings.display.showIcons}"><span></span></button>
                </div>
                <div class="lgd-switch-row lgd-switch-row-block">
                    <div><div class="lgd-switch-label">Layout</div><div class="lgd-switch-note">Grid is a two-column HUD; list keeps long values on their own line.</div></div>
                    <div class="lgd-seg" role="group" aria-label="Block layout">
                        <button type="button" data-act="style" data-style="grid" class="${settings.display.style === 'grid' ? 'is-active' : ''}">Grid</button>
                        <button type="button" data-act="style" data-style="list" class="${settings.display.style === 'list' ? 'is-active' : ''}">List</button>
                    </div>
                </div>
            </div>
            <div class="lgd-group">
                <div class="lgd-group-title">Panel</div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Open on load</div><div class="lgd-switch-note">Otherwise it waits as a small pill in the corner.</div></div>
                    <button type="button" class="lgd-switch" role="switch" data-act="toggle-panel-open" aria-checked="${settings.display.panelOpen}" data-on="${settings.display.panelOpen}"><span></span></button>
                </div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Panel position</div><div class="lgd-switch-note">Drag the panel by its header at any time.</div></div>
                    <button type="button" class="lgd-btn lgd-btn-small" data-act="reset-pos">Reset position</button>
                </div>
            </div>`;
    }

    function promptTab() {
        const preview = view.injectedText || '(empty — nothing is sent until a field has a value)';
        return `
            <div class="lgd-group">
                <div class="lgd-group-title">Sending the ledger to the model</div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Inject into the prompt</div><div class="lgd-switch-note">The tracked facts travel with every generation, so the story stays consistent without re-reading old messages.</div></div>
                    <button type="button" class="lgd-switch" role="switch" data-act="toggle-inject" aria-checked="${settings.prompt.inject}" data-on="${settings.prompt.inject}"><span></span></button>
                </div>
                <div class="lgd-switch-row lgd-switch-row-block">
                    <div><div class="lgd-switch-label">Position</div><div class="lgd-switch-note">In chat places it inside the history at a fixed depth; in prompt puts it in the system block.</div></div>
                    <div class="lgd-seg" role="group" aria-label="Injection position">
                        <button type="button" data-act="position" data-position="in_chat" class="${settings.prompt.position === 'in_chat' ? 'is-active' : ''}">In chat</button>
                        <button type="button" data-act="position" data-position="in_prompt" class="${settings.prompt.position === 'in_prompt' ? 'is-active' : ''}">In prompt</button>
                    </div>
                </div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Depth</div><div class="lgd-switch-note">How many messages from the end the block sits.</div></div>
                    <input class="lgd-input lgd-input-number" type="number" min="0" max="100" step="1" data-k="depth" value="${settings.prompt.depth}" aria-label="Injection depth">
                </div>
                <label class="lgd-field-label-block">
                    <span class="lgd-switch-label">Template</span>
                    <span class="lgd-switch-note">Use <code>{{state}}</code> where the values go. Keep it short — it is sent on every turn.</span>
                    <textarea class="lgd-input lgd-textarea" data-k="template" rows="4" aria-label="Injection template">${esc(settings.prompt.template)}</textarea>
                </label>
                <div class="lgd-preview"><div class="lgd-preview-title">What the model receives</div><pre class="lgd-pre">${esc(preview)}</pre></div>
            </div>
            <div class="lgd-group">
                <div class="lgd-group-title">Scanning</div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Ignore old status blocks</div><div class="lgd-switch-note">Drops a trailing “Current Status” dump from message text before scanning, so old prompt-made blocks cannot anchor new values.</div></div>
                    <button type="button" class="lgd-switch" role="switch" data-act="toggle-legacy" aria-checked="${settings.ignoreLegacyBlocks}" data-on="${settings.ignoreLegacyBlocks}"><span></span></button>
                </div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Messages per batch</div><div class="lgd-switch-note">Long chats are read in batches of this size.</div></div>
                    <input class="lgd-input lgd-input-number" type="number" min="4" max="40" step="1" data-k="chunkSize" value="${settings.chunkSize}" aria-label="Messages per batch">
                </div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Characters per message</div><div class="lgd-switch-note">Longer messages are trimmed before they are sent to the tracker.</div></div>
                    <input class="lgd-input lgd-input-number" type="number" min="200" max="6000" step="100" data-k="maxChars" value="${settings.maxCharsPerMessage}" aria-label="Characters per message">
                </div>
                <div class="lgd-switch-row">
                    <div><div class="lgd-switch-label">Toast after an update</div><div class="lgd-switch-note">A small notification when a sync changed something.</div></div>
                    <button type="button" class="lgd-switch" role="switch" data-act="toggle-toast" aria-checked="${settings.toastOnUpdate}" data-on="${settings.toastOnUpdate}"><span></span></button>
                </div>
            </div>`;
    }

    root.addEventListener('click', event => {
        const target = event.target.closest('[data-act]');
        if (!target) {
            return;
        }
        const act = target.dataset.act;

        if (act === 'close') {
            onClose?.();
            return;
        }

        if (act === 'tabs' || target.classList.contains('lgd-tab')) {
            return;
        }

        switch (act) {
            case 'toggle-inline': {
                const field = settings.fields.find(item => item.id === target.dataset.id);
                if (field) {
                    update(() => { field.inline = !field.inline; }, true);
                }
                return;
            }
            case 'move-up':
            case 'move-down': {
                const index = settings.fields.findIndex(item => item.id === target.dataset.id);
                const swap = act === 'move-up' ? index - 1 : index + 1;
                if (index >= 0 && swap >= 0 && swap < settings.fields.length) {
                    update(() => {
                        const [field] = settings.fields.splice(index, 1);
                        settings.fields.splice(swap, 0, field);
                    }, true);
                }
                return;
            }
            case 'delete-field':
                update(() => {
                    settings.fields = settings.fields.filter(item => item.id !== target.dataset.id);
                    if (!settings.fields.length) {
                        settings.fields = [];
                    }
                }, true);
                return;
            case 'add-field':
                update(() => {
                    settings.fields.push({
                        id: `field-${Math.random().toString(36).slice(2, 7)}`,
                        icon: '✳️',
                        label: 'New field',
                        hint: '',
                        inline: true,
                    });
                }, true);
                return;
            case 'reset-fields':
                update(() => { settings.fields = clone(FIELD_DEFAULTS); }, true);
                return;
            case 'toggle-inline-display':
                update(() => { settings.display.inline = !settings.display.inline; }, true);
                return;
            case 'toggle-collapsed':
                update(() => { settings.display.startCollapsed = !settings.display.startCollapsed; }, true);
                return;
            case 'toggle-icons':
                update(() => { settings.display.showIcons = !settings.display.showIcons; }, true);
                return;
            case 'toggle-panel-open':
                update(() => { settings.display.panelOpen = !settings.display.panelOpen; }, true);
                return;
            case 'style':
                update(() => { settings.display.style = target.dataset.style; }, true);
                return;
            case 'reset-pos':
                update(() => { settings.display.pos = null; }, true);
                return;
            case 'toggle-inject':
                update(() => { settings.prompt.inject = !settings.prompt.inject; }, true);
                return;
            case 'position':
                update(() => { settings.prompt.position = target.dataset.position; }, true);
                return;
            case 'toggle-legacy':
                update(() => { settings.ignoreLegacyBlocks = !settings.ignoreLegacyBlocks; }, true);
                return;
            case 'toggle-toast':
                update(() => { settings.toastOnUpdate = !settings.toastOnUpdate; }, true);
                return;
            default:
                return;
        }
    });

    root.addEventListener('input', event => {
        const input = event.target.closest('[data-k]');
        if (!input) {
            return;
        }
        const key = input.dataset.k;

        if (key === 'depth') {
            settings.prompt.depth = Math.min(100, Math.max(0, Number(input.value) || 0));
        } else if (key === 'template') {
            settings.prompt.template = input.value;
            const preview = root.querySelector('.lgd-pre');
            if (preview) {
                const fresh = typeof getView === 'function' ? getView() : view;
                preview.textContent = fresh.injectedText || '(empty — nothing is sent until a field has a value)';
            }
        } else if (key === 'chunkSize') {
            settings.chunkSize = Math.min(40, Math.max(4, Number(input.value) || 4));
        } else if (key === 'maxChars') {
            settings.maxCharsPerMessage = Math.min(6000, Math.max(200, Number(input.value) || 1200));
        } else {
            const row = input.closest('[data-id]');
            const field = settings.fields.find(item => item.id === row?.dataset.id);
            if (field && ['icon', 'label', 'hint'].includes(key)) {
                field[key] = input.value;
            }
        }
        onChange();
    });

    root.querySelectorAll('.lgd-tab').forEach(button => {
        button.addEventListener('click', () => {
            tab = button.dataset.tab;
            paint();
        });
    });

    paint();
    return root;
}
