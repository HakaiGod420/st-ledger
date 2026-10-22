/**
 * Ledger — a continuity tracker for SillyTavern.
 *
 * Reads the messages that have not been read yet, every N messages, and keeps
 * a small set of configurable fields (time, place, clothing, money, health …)
 * up to date. The values are rendered under the newest reply and can be sent
 * back into the prompt so the model stops contradicting itself.
 */

import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '../../../popup.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import * as stApp from '../../../../script.js';
import {
    LedgerParseError,
    buildInjectedText,
    buildScanPrompt,
    buildTranscript,
    parseScanResponse,
    renderStateText,
} from './src/prompt.js';
import {
    EXTENSION_FOLDER,
    EXTENSION_KEY,
    applyValues,
    createState,
    lastChangeAt,
    messageSignature,
    normalizeSettings,
    normalizeState,
    pendingCount,
    pushHistory,
    syncCursor,
} from './src/state.js';
import { buildInline, buildSettingsModal, createPanel, setInlineCollapsed } from './src/ui.js';

const LOG = '[Ledger]';
const INJECT_KEY = 'st-ledger-state';
const MENU_ICON = 'fa-layer-group';

/* ------------------------------------------------------------------ plumbing */

const settings = normalizeSettings(extension_settings[EXTENSION_KEY] ?? (extension_settings[EXTENSION_KEY] = {}));

let state = createState('');
let panel = null;
let openPopup = null;
let scanning = false;
let abortRequested = false;
let queued = false;
let scanProgress = null;
let autoTimer = null;
let booted = false;

function saveSettings() {
    try {
        stApp.saveSettingsDebounced?.();
    } catch (error) {
        console.warn(LOG, 'could not save settings', error);
    }
}

function toast(kind, text) {
    try {
        window.toastr?.[kind]?.(text, 'Ledger');
    } catch {
        /* toasts are cosmetic */
    }
}

function currentChatId() {
    const context = getContext();
    try {
        return String(context.getCurrentChatId?.() ?? context.chatId ?? '');
    } catch {
        return '';
    }
}

function chatMetadataBag() {
    // Builds differ: the current one exposes chatMetadata on the context, older
    // ones only keep the snake_case global. Accept whichever exists.
    const context = getContext();
    const bag = context.chatMetadata ?? window.chatMetadata ?? window.chat_metadata;
    return bag && typeof bag === 'object' ? bag : null;
}

function saveMetadata() {
    const context = getContext();
    const save = context.saveMetadataDebounced
        ?? context.saveMetadata
        ?? window.saveMetadataDebounced
        ?? window.saveMetadata;
    if (typeof save === 'function') {
        save();
        return;
    }
    saveSettings();
}

function persistState() {
    if (!state) {
        return;
    }
    const bag = chatMetadataBag();
    if (bag) {
        bag[EXTENSION_KEY] = state;
        try {
            saveMetadata();
        } catch (error) {
            console.warn(LOG, 'could not save chat metadata', error);
            saveSettings();
        }
        return;
    }
    settings.states = settings.states && typeof settings.states === 'object' ? settings.states : {};
    settings.states[state.chatId || 'default'] = state;
    saveSettings();
}

function loadState() {
    const chatId = currentChatId();
    const bag = chatMetadataBag();
    const raw = bag ? bag[EXTENSION_KEY] : settings.states?.[chatId || 'default'];
    state = normalizeState(raw, chatId);
    state.chatId = chatId;
    syncCursor(state, (getContext().chat ?? []));
}

/* --------------------------------------------------------------------- view */

function buildView() {
    const context = getContext();
    const chat = context.chat ?? [];
    syncCursor(state, chat);

    const fields = settings.fields.map(field => ({
        ...field,
        value: String(state.values[field.id] ?? '').trim(),
        locked: Boolean(state.locks[field.id]),
        changedAt: lastChangeAt(state, field.id),
    }));

    const changedAt = {};
    for (const field of fields) {
        changedAt[field.id] = field.changedAt;
    }

    const existing = fields.filter(field => field.value);
    const injectedText = buildInjectedText({ template: settings.prompt.template, fields, values: state.values });

    return {
        settings,
        state,
        fields,
        changedAt,
        injectedText,
        total: chat.length,
        pending: pendingCount(state, chat),
        everyN: settings.everyN,
        chunkSize: settings.chunkSize,
        busy: scanning,
        progress: scanProgress,
        error: state.error,
        updatedAt: state.updatedAt,
        syncedAt: state.scannedAt,
        hasValues: existing.length > 0,
        characterName: context.name2 || context.characters?.[context.characterId]?.name || '',
        userName: context.name1 || 'User',
    };
}

function refresh({ inline = true } = {}) {
    const view = buildView();
    panel?.render(view);
    fitPanelToViewport();
    if (inline) {
        mountInline(view);
    }
    injectPrompt(view);
    return view;
}

/* -------------------------------------------------------------- inline block */

function mountInline(view) {
    document.querySelectorAll('.lgd-inline').forEach(node => node.remove());

    if (!settings.display.inline || !view.hasValues || !view.total) {
        return;
    }

    const element = buildInline(view);
    if (!element) {
        return;
    }

    const replies = [...document.querySelectorAll('#chat .mes:not([is_user="true"])')];
    const last = replies[replies.length - 1] ?? [...document.querySelectorAll('#chat .mes')].pop();
    if (!last) {
        return;
    }

    // Sit at the end of the message block, and reserve the strip that ST's
    // absolutely-positioned swipe counter and arrows live in, or they draw over
    // the last row of the block.
    const swipes = last.querySelector('.swipes-counter, .swipe_left, .swipe_right, .swipes-counter-container');
    element.classList.toggle('lgd-inline--swipes', Boolean(swipes));

    const block = last.querySelector('.mes_block') ?? last;
    block.append(element);
}

/* ------------------------------------------------------------------ injection */

let warnedInject = false;

function injectPrompt(view) {
    if (typeof stApp.setExtensionPrompt !== 'function') {
        if (!warnedInject && settings.prompt.inject) {
            console.warn(LOG, 'setExtensionPrompt is unavailable — the ledger will not reach the prompt');
            warnedInject = true;
        }
        return;
    }

    const types = stApp.extension_prompt_types ?? {};
    const inChat = types.IN_CHAT ?? 1;
    const inPrompt = types.IN_PROMPT ?? 0;

    if (!settings.prompt.inject || !view.injectedText) {
        try {
            stApp.setExtensionPrompt(INJECT_KEY, '', inChat, 0);
        } catch {
            /* nothing to clear */
        }
        return;
    }

    const position = settings.prompt.position === 'in_prompt' ? inPrompt : inChat;
    const depth = position === inChat ? settings.prompt.depth : 0;

    try {
        stApp.setExtensionPrompt(INJECT_KEY, view.injectedText, position, depth, false);
    } catch (error) {
        console.warn(LOG, 'could not inject the ledger', error);
    }
}

/* --------------------------------------------------------------------- scanning */

function friendlyError(error) {
    if (error instanceof LedgerParseError) {
        return error.message;
    }
    const message = String(error?.message ?? error ?? 'Unknown error');
    if (/abort|stop/i.test(message)) {
        return 'Scan stopped.';
    }
    return message.length > 180 ? `${message.slice(0, 180)}…` : message;
}

async function syncOnce() {
    const context = getContext();
    const chat = context.chat ?? [];
    const start = state.cursor;
    const end = Math.min(chat.length, start + settings.chunkSize);

    if (end <= start) {
        return 0;
    }

    const transcript = buildTranscript(chat, start, end, {
        userName: context.name1 || 'User',
        maxChars: settings.maxCharsPerMessage,
        ignoreLegacy: settings.ignoreLegacyBlocks,
    });

    if (!transcript.trim()) {
        // Nothing readable in this window (system messages only) — advance the
        // cursor without spending a generation.
        state.cursor = end;
        state.tail = messageSignature(chat, end - 1);
        return end - start;
    }

    const prompt = buildScanPrompt({
        fields: settings.fields,
        values: state.values,
        transcript,
        from: start,
        to: end,
        userName: context.name1 || 'User',
        charName: context.name2 || context.characters?.[context.characterId]?.name || 'Character',
    });

    if (typeof stApp.generateQuietPrompt !== 'function') {
        throw new Error('This SillyTavern build has no quiet generation API.');
    }

    const raw = await stApp.generateQuietPrompt({
        quietPrompt: prompt,
        quietName: 'Ledger',
        responseLength: 600,
        skipWIAN: true,
        removeReasoning: true,
    });

    if (abortRequested) {
        return 0;
    }

    const parsed = parseScanResponse(raw);
    const changes = applyValues(state, parsed, settings.fields);
    const changedCount = Object.keys(changes).length;

    state.cursor = end;
    state.tail = messageSignature(chat, end - 1);
    state.scannedAt = Date.now();
    state.error = null;
    if (changedCount) {
        state.updatedAt = Date.now();
        pushHistory(state, { from: start, to: end, changes });
    }

    if (settings.toastOnUpdate && changedCount) {
        toast('success', `${changedCount} field${changedCount === 1 ? '' : 's'} updated`);
    }

    return end - start;
}

async function syncAllBatches() {
    const initial = pendingCount(state, (getContext().chat ?? []));
    scanProgress = { done: 0, total: initial };
    let guard = 0;

    while (guard++ < 80) {
        if (abortRequested) {
            break;
        }
        const before = state.cursor;
        const moved = await syncOnce();
        state.error = null;
        scanProgress.done = Math.min(initial, scanProgress.done + moved);
        refresh({ inline: false });

        if (!moved || state.cursor >= (getContext().chat ?? []).length) {
            break;
        }
        if (state.cursor === before) {
            break;
        }
    }
}

async function runScan(mode = 'auto') {
    if (!settings.enabled) {
        toast('info', 'The tracker is disabled in the extension settings.');
        return;
    }

    if (!settings.fields.length) {
        toast('info', 'Add at least one field in the tracker settings first.');
        return;
    }

    const chat = getContext().chat ?? [];
    if (!chat.length) {
        toast('info', 'Open a chat first.');
        return;
    }

    if (scanning) {
        queued = true;
        return;
    }

    scanning = true;
    abortRequested = false;
    state.error = null;
    scanProgress = mode === 'all' ? { done: 0, total: pendingCount(state, chat) } : null;
    refresh({ inline: false });

    try {
        if (mode === 'all') {
            await syncAllBatches();
        } else {
            await syncOnce();
        }
    } catch (error) {
        console.warn(LOG, 'scan failed', error);
        state.error = friendlyError(error);
    } finally {
        scanning = false;
        scanProgress = null;
        persistState();
        refresh();
        if (queued && !abortRequested) {
            queued = false;
            scheduleAutoScan('queued', true);
        }
    }
}

function scheduleAutoScan(reason = 'auto', force = false) {
    if (!settings.enabled || !settings.autoUpdate) {
        return;
    }
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
        if (scanning) {
            queued = true;
            return;
        }
        const pending = pendingCount(state, (getContext().chat ?? []));
        if (force ? pending > 0 : pending >= settings.everyN) {
            runScan('auto', reason);
        }
    }, 900);
}

/* ------------------------------------------------------------------- actions */

async function confirmSyncAll() {
    const pending = pendingCount(state, (getContext().chat ?? []));
    const batches = Math.ceil(pending / settings.chunkSize);

    if (batches <= 1) {
        return true;
    }

    try {
        const result = await callGenericPopup?.(
            `Read ${pending} messages in ${batches} batches? Each batch is one tracker generation.`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Sync all', cancelButton: 'Cancel' },
        );
        return Boolean(result);
    } catch {
        return true;
    }
}

function requestSync() {
    const pending = pendingCount(state, (getContext().chat ?? []));
    if (pending > settings.chunkSize) {
        confirmSyncAll().then(confirmed => {
            if (confirmed) {
                runScan('all');
            }
        });
        return;
    }
    runScan('auto');
}

function handleAction(detail) {
    switch (detail.type) {
        case 'sync':
            requestSync();
            break;
        case 'syncAll':
            confirmSyncAll().then(confirmed => {
                if (confirmed) {
                    runScan('all');
                }
            });
            break;
        case 'stop':
            abortRequested = true;
            try {
                getContext().stopGeneration?.();
            } catch {
                /* generation may already be over */
            }
            break;
        case 'settings':
            openSettings();
            break;
        case 'setValue': {
            const field = settings.fields.find(item => item.id === detail.id);
            if (!field) {
                break;
            }
            const next = String(detail.value ?? '').trim();
            const previous = state.values[detail.id] ?? '';
            if (next === previous) {
                break;
            }
            const changes = { [detail.id]: { from: previous, to: next } };
            if (next) {
                state.values[detail.id] = next.slice(0, 2000);
            } else {
                delete state.values[detail.id];
            }
            state.updatedAt = Date.now();
            pushHistory(state, { from: state.cursor, to: state.cursor, changes, reason: 'manual' });
            persistState();
            refresh();
            break;
        }
        case 'toggleLock':
            if (state.locks[detail.id]) {
                delete state.locks[detail.id];
            } else {
                state.locks[detail.id] = true;
            }
            persistState();
            refresh();
            break;
        case 'restore': {
            const entry = state.history[detail.index];
            if (!entry?.values) {
                break;
            }
            const before = JSON.parse(JSON.stringify(state.values));
            const restored = JSON.parse(JSON.stringify(entry.values));
            const diff = {};
            for (const key of new Set([...Object.keys(before), ...Object.keys(restored)])) {
                if ((before[key] ?? '') !== (restored[key] ?? '')) {
                    diff[key] = { from: before[key] ?? '', to: restored[key] ?? '' };
                }
            }
            state.values = restored;
            state.updatedAt = Date.now();
            pushHistory(state, { from: entry.from, to: entry.to, changes: diff, reason: 'restore' });
            persistState();
            refresh();
            toast('success', 'Restored an earlier ledger state');
            break;
        }
        case 'clear':
            state.values = {};
            state.history = [];
            state.cursor = 0;
            state.tail = '';
            state.updatedAt = 0;
            state.scannedAt = 0;
            state.error = null;
            persistState();
            refresh();
            toast('info', 'Ledger cleared — the next sync starts from the first message');
            break;
        case 'move':
            settings.display.pos = detail.pos;
            saveSettings();
            applyPanelPosition();
            break;
        default:
            break;
    }
}

/* --------------------------------------------------------------------- panel */

/**
 * On a phone the panel must end above SillyTavern's input bar. The bar's height
 * depends on the theme and on the number of quick-reply buttons, so measure it
 * rather than hardcoding an offset — a fixed `bottom` is what put the panel's
 * footer underneath the input.
 */
function fitPanelToViewport() {
    if (!panel) {
        return;
    }

    if (window.innerWidth > 720) {
        panel.el.style.maxHeight = '';
        return;
    }

    const top = 68;
    const form = document.getElementById('send_form') ?? document.getElementById('send_but')?.closest('form');
    const formTop = form?.getBoundingClientRect().top;
    const limit = Number.isFinite(formTop) && formTop > top + 200 ? formTop : window.innerHeight - 92;
    panel.el.style.maxHeight = `${Math.max(220, Math.round(limit - top - 12))}px`;
}

function applyPanelPosition() {
    if (!panel) {
        return;
    }

    const pos = settings.display.pos;
    if (pos) {
        panel.el.style.left = `${pos.x}px`;
        panel.el.style.top = `${pos.y}px`;
        panel.el.style.right = 'auto';
        return;
    }

    // No saved position: dock beside the chat when the window has room for it,
    // otherwise fall back to the CSS default on the right edge.
    panel.el.style.left = '';
    panel.el.style.top = '';
    panel.el.style.right = '';

    const chat = document.getElementById('chat');
    const rect = chat?.getBoundingClientRect();
    const width = panel.el.offsetWidth || 296;
    if (rect && window.innerWidth - rect.right >= width + 24) {
        panel.el.style.left = `${Math.round(rect.right + 10)}px`;
        panel.el.style.right = 'auto';
    }
}

function ensurePanel() {
    if (panel) {
        return panel;
    }
    panel = createPanel({ onAction: handleAction });
    document.body.append(panel.el);
    applyPanelPosition();
    fitPanelToViewport();
    return panel;
}

/* --------------------------------------------------------------------- modal */

function openSettings() {
    if (openPopup) {
        return;
    }

    const content = buildSettingsModal({
        settings,
        view: buildView(),
        getView: () => buildView(),
        onChange: () => {
            saveSettings();
            refresh({ inline: true });
        },
        onClose: () => {
            const popup = openPopup;
            openPopup = null;
            try {
                popup?.complete?.(POPUP_RESULT.CANCELLED);
            } catch {
                /* already closed */
            }
            saveSettings();
            refresh();
        },
    });

    try {
        const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: false,
            cancelButton: false,
        });
        popup.dlg.classList.add('lgd-popup');
        openPopup = popup;
        popup.show().finally(() => {
            if (openPopup === popup) {
                openPopup = null;
            }
            saveSettings();
            refresh();
        });
    } catch (error) {
        console.error(LOG, 'could not open the settings dialog', error);
    }
}

/* ---------------------------------------------------------------- settings UI */

function initSettingsPanel() {
    const root = document.querySelector('.lgd-settings');
    if (!root) {
        return;
    }

    root.querySelector('#lgd-open')?.addEventListener('click', openSettings);

    const auto = root.querySelector('#lgd-auto');
    if (auto) {
        auto.checked = settings.autoUpdate;
        auto.addEventListener('change', () => {
            settings.autoUpdate = auto.checked;
            saveSettings();
            if (settings.autoUpdate) {
                scheduleAutoScan('settings');
            }
        });
    }

    const every = root.querySelector('#lgd-every');
    if (every) {
        every.value = String(settings.everyN);
        every.addEventListener('change', () => {
            settings.everyN = Math.min(50, Math.max(1, Number(every.value) || 4));
            every.value = String(settings.everyN);
            saveSettings();
            refresh();
        });
    }
}

function addWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('lgd-wand-item')) {
        return Boolean(menu);
    }

    const item = document.createElement('div');
    item.id = 'lgd-wand-item';
    item.className = 'lgd-wand-item';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.innerHTML = `
        <div class="extensionsMenuExtensionButton fa-solid ${MENU_ICON}" aria-hidden="true"></div>
        <span>Ledger</span>`;

    const trigger = () => {
        ensurePanel().expand();
        refresh();
    };

    item.addEventListener('click', trigger);
    item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            trigger();
        }
    });

    menu.append(item);
    return true;
}

function waitForWandMenu(attempt = 0) {
    if (addWandItem() || attempt > 60) {
        return;
    }
    window.setTimeout(() => waitForWandMenu(attempt + 1), 250);
}

function watchChatDom() {
    const chat = document.getElementById('chat');
    if (!chat || chat.dataset.lgdWatch) {
        return;
    }
    chat.dataset.lgdWatch = '1';

    let timer = null;
    new MutationObserver(() => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
            if (!settings.display.inline) {
                return;
            }
            if (!document.querySelector('#chat .mes')) {
                return;
            }
            if (!document.querySelector('.lgd-inline')) {
                refresh();
            }
        }, 350);
    }).observe(chat, { childList: true });
}

/* -------------------------------------------------------------------- events */

function onEvent(name, handler) {
    const context = getContext();
    const source = context.eventSource ?? window.eventSource;
    const types = context.eventTypes ?? window.event_types ?? {};
    const type = types[name];
    if (!source?.on || type === undefined) {
        return;
    }
    source.on(type, (...args) => {
        try {
            handler(...args);
        } catch (error) {
            console.error(LOG, `handler for ${name} failed`, error);
        }
    });
}

function registerEvents() {
    onEvent('CHAT_CHANGED', () => {
        loadState();
        setInlineCollapsed(settings.display.startCollapsed);
        refresh();
        ensurePanel();
    });

    onEvent('CHARACTER_SELECTED', () => refresh());

    for (const name of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'CHARACTER_MESSAGE_RENDERED']) {
        onEvent(name, () => {
            if (scanning) {
                return;
            }
            syncCursor(state, (getContext().chat ?? []));
            refresh();
            scheduleAutoScan(name);
        });
    }

    onEvent('GENERATION_ENDED', () => {
        if (scanning) {
            return;
        }
        scheduleAutoScan('generation');
    });

    for (const name of ['MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED']) {
        onEvent(name, () => {
            if (scanning) {
                return;
            }
            syncCursor(state, (getContext().chat ?? []));
            persistState();
            refresh();
            scheduleAutoScan(name, true);
        });
    }

    onEvent('MESSAGE_UPDATED', () => {
        syncCursor(state, (getContext().chat ?? []));
        refresh();
    });
}

/* ------------------------------------------------------------- slash command */

function registerSlashCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ledger',
        callback: async (_named, unnamed) => {
            const argument = String(unnamed ?? '').trim().toLowerCase();

            if (argument === 'scan') {
                await runScan('all');
                return '';
            }
            if (argument === 'clear') {
                handleAction({ type: 'clear' });
                return '';
            }
            if (argument === 'sync') {
                await runScan('auto');
                return '';
            }

            return renderStateText({
                fields: settings.fields,
                values: state.values,
                cursor: state.cursor,
                total: (getContext().chat ?? []).length,
            });
        },
        returns: 'the current ledger, or nothing for /ledger scan',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'optional: scan, sync or clear',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: `
            <div>Show or refresh the Ledger continuity tracker.</div>
            <div><code>/ledger</code> — print the current state</div>
            <div><code>/ledger scan</code> — read every unread message</div>
            <div><code>/ledger clear</code> — forget everything and start over</div>
        `,
    }));
}

/* ---------------------------------------------------------------------- boot */

async function bootstrap() {
    if (booted) {
        return;
    }
    booted = true;

    loadState();
    setInlineCollapsed(settings.display.startCollapsed);

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
        document.querySelector('#extensions_settings')?.insertAdjacentHTML('beforeend', html);
        initSettingsPanel();
    } catch (error) {
        console.error(LOG, 'could not render the settings panel', error);
    }

    ensurePanel();
    if (!settings.display.panelOpen || window.innerWidth <= 720) {
        // On a phone the panel starts as a pill: the chat has to stay readable.
        panel.collapse();
    }

    registerEvents();
    watchChatDom();
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
            applyPanelPosition();
            fitPanelToViewport();
        }, 180);
    });
    window.addEventListener('orientationchange', () => window.setTimeout(fitPanelToViewport, 260));
    waitForWandMenu();
    registerSlashCommand();
    refresh();
}

jQuery(() => {
    bootstrap().catch(error => console.error(LOG, 'failed to start', error));
});

export { settings };
