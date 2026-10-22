/**
 * Ledger — settings, per-chat state, and the cursor bookkeeping that makes
 * "scan only what has not been scanned yet" reliable across edits, swipes and
 * deleted messages.
 *
 * Pure module: no SillyTavern imports, so it can be unit-tested in Node.
 */

export const EXTENSION_KEY = 'st-ledger';
export const EXTENSION_FOLDER = 'third-party/st-ledger';
export const HISTORY_LIMIT = 60;

export const FIELD_DEFAULTS = [
    {
        id: 'datetime',
        icon: '🕒',
        label: 'Date & time',
        hint: 'In-story date and time. Absolute when known ("October 14, 2026 — 21:47"), otherwise relative ("evening, day 3").',
        inline: true,
    },
    {
        id: 'location',
        icon: '📍',
        label: 'Location',
        hint: 'Where the scene is happening right now, as specifically as the messages allow.',
        inline: true,
    },
    {
        id: 'clothing',
        icon: '👕',
        label: 'Clothing',
        hint: 'What each person present is wearing. Prefix each outfit with the character name.',
        inline: true,
    },
    {
        id: 'money',
        icon: '💰',
        label: 'Money',
        hint: 'Cash on hand, account balances, debts, who owes whom, recent purchases.',
        inline: false,
    },
    {
        id: 'inventory',
        icon: '🎒',
        label: 'Inventory',
        hint: 'Items carried, bought, found, lost or given away. Only what is established.',
        inline: true,
    },
    {
        id: 'health',
        icon: '🩺',
        label: 'Health',
        hint: 'Injuries, illness, exhaustion, pain, physical condition of anyone present.',
        inline: false,
    },
    {
        id: 'pregnancy',
        icon: '🤰',
        label: 'Pregnancy',
        hint: 'Only if the story tracks it. Leave empty when it does not apply; do not guess.',
        inline: false,
    },
    {
        id: 'relationship',
        icon: '💞',
        label: 'Relationship',
        hint: 'Relationship status between the characters and any shift in it, including unspoken tension.',
        inline: false,
    },
];

export function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function randomId(prefix = 'field') {
    return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampInt(value, min, max, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, number));
}

/**
 * Normalises persisted settings in place, so `extension_settings` always holds
 * a complete, correctly typed object even after a version bump.
 */
export function normalizeSettings(raw) {
    const settings = raw && typeof raw === 'object' ? raw : {};

    settings.enabled = settings.enabled !== false;
    settings.autoUpdate = settings.autoUpdate !== false;
    settings.everyN = clampInt(settings.everyN, 1, 50, 4);
    settings.chunkSize = clampInt(settings.chunkSize, 4, 40, 12);
    settings.maxCharsPerMessage = clampInt(settings.maxCharsPerMessage, 200, 6000, 1200);
    settings.ignoreLegacyBlocks = settings.ignoreLegacyBlocks !== false;
    settings.toastOnUpdate = settings.toastOnUpdate === true;

    const rawFields = Array.isArray(settings.fields) ? settings.fields : [];
    const fields = rawFields
        .map(field => {
            if (!field || typeof field !== 'object') {
                return null;
            }
            const label = String(field.label ?? '').trim();
            if (!label) {
                return null;
            }
            return {
                id: String(field.id || randomId()).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || randomId(),
                icon: String(field.icon ?? '•').slice(0, 4),
                label: label.slice(0, 40),
                hint: String(field.hint ?? '').slice(0, 500),
                inline: field.inline !== false,
            };
        })
        .filter(Boolean);

    settings.fields = fields.length ? dedupeIds(fields) : clone(FIELD_DEFAULTS);

    const display = settings.display && typeof settings.display === 'object' ? settings.display : {};
    settings.display = {
        inline: display.inline !== false,
        style: display.style === 'list' ? 'list' : 'grid',
        startCollapsed: display.startCollapsed !== false,
        panelOpen: display.panelOpen !== false,
        showIcons: display.showIcons !== false,
        pos: display.pos && Number.isFinite(display.pos.x) && Number.isFinite(display.pos.y)
            ? { x: Math.round(display.pos.x), y: Math.round(display.pos.y) }
            : null,
    };

    const prompt = settings.prompt && typeof settings.prompt === 'object' ? settings.prompt : {};
    settings.prompt = {
        inject: prompt.inject !== false,
        position: prompt.position === 'in_prompt' ? 'in_prompt' : 'in_chat',
        depth: clampInt(prompt.depth, 0, 100, 2),
        template: typeof prompt.template === 'string' && prompt.template.trim()
            ? prompt.template.slice(0, 4000)
            : DEFAULT_PROMPT_TEMPLATE,
    };

    return settings;
}

export const DEFAULT_PROMPT_TEMPLATE = '[Current status — keep the scene consistent with this]\n{{state}}';

function dedupeIds(fields) {
    const seen = new Set();
    for (const field of fields) {
        let id = field.id;
        let counter = 2;
        while (seen.has(id)) {
            id = `${field.id}-${counter++}`;
        }
        field.id = id;
        seen.add(id);
    }
    return fields;
}

/* ------------------------------------------------------------------ chat state */

export function createState(chatId) {
    return {
        chatId: chatId || '',
        cursor: 0,
        tail: '',
        values: {},
        locks: {},
        history: [],
        updatedAt: 0,
        scannedAt: 0,
        error: null,
    };
}

export function normalizeState(raw, chatId) {
    const state = raw && typeof raw === 'object' ? raw : {};
    const values = {};
    if (state.values && typeof state.values === 'object') {
        for (const [key, value] of Object.entries(state.values)) {
            if (typeof value === 'string') {
                values[key] = value.slice(0, 2000);
            }
        }
    }

    const locks = {};
    if (state.locks && typeof state.locks === 'object') {
        for (const [key, value] of Object.entries(state.locks)) {
            if (value) {
                locks[key] = true;
            }
        }
    }

    return {
        chatId: chatId || state.chatId || '',
        cursor: clampInt(state.cursor, 0, Number.MAX_SAFE_INTEGER, 0),
        tail: typeof state.tail === 'string' ? state.tail : '',
        values,
        locks,
        history: Array.isArray(state.history)
            ? state.history.filter(entry => entry && typeof entry === 'object').slice(-HISTORY_LIMIT)
            : [],
        updatedAt: Number(state.updatedAt) || 0,
        scannedAt: Number(state.scannedAt) || 0,
        error: state.error ? String(state.error).slice(0, 400) : null,
    };
}

function hashString(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index++) {
        hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(36);
}

/** Identity of one message; changes on edit, swipe or regenerate. */
export function messageSignature(chat, index) {
    const message = chat?.[index];
    if (!message) {
        return '';
    }
    const text = `${message.name ?? ''}|${message.is_user ? 1 : 0}|${message.mes ?? ''}`;
    return `${index}:${text.length}:${hashString(text)}`;
}

/**
 * Reconciles the cursor with the live chat before any scan or render.
 *  - the chat got shorter (deleted messages / new chat file) -> clamp
 *  - the last scanned message changed (edit, swipe) -> rewind one message so
 *    it is read again instead of being silently skipped
 */
export function syncCursor(state, chat) {
    const length = Array.isArray(chat) ? chat.length : 0;
    let note = null;

    if (state.cursor > length) {
        state.cursor = length;
        note = 'clamped';
    }

    if (!state.tail && state.cursor > 0) {
        state.tail = messageSignature(chat, state.cursor - 1);
    }

    if (state.cursor > 0 && state.cursor <= length) {
        const signature = messageSignature(chat, state.cursor - 1);
        if (state.tail && signature !== state.tail) {
            state.cursor = Math.max(0, state.cursor - 1);
            state.tail = state.cursor > 0 ? messageSignature(chat, state.cursor - 1) : '';
            note = 'rewound';
        }
    }

    return note;
}

export function pendingCount(state, chat) {
    return Math.max(0, (chat?.length ?? 0) - state.cursor);
}

/**
 * Applies parsed scan output. `null` means unchanged; `''` clears a field;
 * locked fields are never touched by a scan.
 */
export function applyValues(state, parsed, fields) {
    const known = new Set(fields.map(field => field.id));
    const changes = {};

    for (const [key, raw] of Object.entries(parsed || {})) {
        if (!known.has(key) || state.locks[key]) {
            continue;
        }
        const next = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
        const previous = state.values[key] ?? '';
        if (next === previous) {
            continue;
        }
        changes[key] = { from: previous, to: next };
        if (next) {
            state.values[key] = next.slice(0, 2000);
        } else {
            delete state.values[key];
        }
    }

    return changes;
}

export function pushHistory(state, { from, to, changes, reason = 'scan' }) {
    if (!changes || !Object.keys(changes).length) {
        return null;
    }
    const entry = {
        at: Date.now(),
        from: Math.max(0, from | 0),
        to: Math.max(0, to | 0),
        reason,
        changes,
        values: clone(state.values),
    };
    state.history.push(entry);
    if (state.history.length > HISTORY_LIMIT) {
        state.history.splice(0, state.history.length - HISTORY_LIMIT);
    }
    return entry;
}

export function lastChangeAt(state, fieldId) {
    for (let index = state.history.length - 1; index >= 0; index--) {
        const entry = state.history[index];
        if (entry?.changes && Object.prototype.hasOwnProperty.call(entry.changes, fieldId)) {
            return Number(entry.at) || 0;
        }
    }
    return 0;
}

export function stateLines(fields, values) {
    return fields
        .filter(field => values[field.id])
        .map(field => `${field.label}: ${values[field.id]}`)
        .join('\n');
}
