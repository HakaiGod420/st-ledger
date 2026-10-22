/**
 * Ledger — prompt construction and tolerant parsing.
 *
 * The model is asked for a sentinel-delimited JSON object rather than a JSON
 * schema: jsonSchema forces an extraction pass on some backends and breaks on
 * small/local models, while a sentinel is just text.
 */

export const SENTINEL_OPEN = '<<<LEDGER>>>';
export const SENTINEL_CLOSE = '<<<END>>>';

export class LedgerParseError extends Error {
    constructor(message, raw = '') {
        super(message);
        this.name = 'LedgerParseError';
        this.raw = raw;
    }
}

/**
 * Older setups append a "Current Status" block to the reply text itself. Those
 * lines are the model's own leftovers, not story, and they anchor every later
 * scan to stale values — so drop the trailing block when it looks like one.
 */
export function stripLegacyBlocks(text) {
    if (!text) {
        return '';
    }
    const match = text.match(/(?:^|\n)\s*(?:[>*-]\s*)*(?:📋|🗒️|📊|📌)?\s*\*{0,2}\s*(?:current\s+status|status\s*block|state\s*block)\s*\*{0,2}/i);
    if (!match || match.index === 0) {
        return text;
    }
    const tail = text.slice(match.index);
    const looksLikeDump = /(?:date\s*(?:&|and)\s*time|location|inventory|clothing|relationship)\s*\*{0,2}\s*:/i.test(tail);
    return looksLikeDump ? text.slice(0, match.index).trim() : text;
}

function cleanMessageText(text, maxChars) {
    let value = String(text ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (value.length > maxChars) {
        value = `${value.slice(0, maxChars).trimEnd()}…`;
    }
    return value;
}

export function buildTranscript(chat, from, to, { userName = 'User', maxChars = 1200, ignoreLegacy = true, charBudget = 12000 } = {}) {
    const messages = [];
    let used = 0;

    for (let index = Math.max(0, from); index < Math.min(to, chat?.length ?? 0); index++) {
        const message = chat[index];
        if (!message || message.is_system || message.extra?.hidden) {
            continue;
        }
        let text = cleanMessageText(message.mes, maxChars);
        if (ignoreLegacy) {
            text = cleanMessageText(stripLegacyBlocks(text), maxChars);
        }
        if (!text) {
            continue;
        }
        const speaker = message.is_user ? (userName || 'User') : (message.name || 'Character');
        const line = `#${index + 1} ${message.is_user ? 'USER' : 'CHAR'} ${speaker}: ${text}`;
        if (used + line.length > charBudget && messages.length) {
            messages.push(`… ${to - index} later message(s) omitted from this batch`);
            break;
        }
        used += line.length;
        messages.push(line);
    }

    return messages.join('\n\n');
}

export function buildScanPrompt({ fields, values, transcript, from, to, userName = 'User', charName = 'Character' }) {
    const fieldLines = fields
        .map(field => `- ${field.id} — ${field.label}${field.hint ? ` — ${field.hint}` : ''}`)
        .join('\n');

    const current = {};
    for (const field of fields) {
        if (values[field.id]) {
            current[field.id] = values[field.id];
        }
    }

    return [
        `You are the continuity ledger for a roleplay between ${userName} and ${charName}.`,
        'You read new messages and keep a small structured record of established facts.',
        '',
        'FIELDS',
        fieldLines,
        '',
        'CURRENT LEDGER',
        Object.keys(current).length ? JSON.stringify(current, null, 0) : '(empty)',
        '',
        `NEW MESSAGES (#${from + 1}–#${to})`,
        transcript,
        '',
        'TASK',
        'Update the ledger using only the new messages above.',
        '',
        'OUTPUT RULES',
        `- Reply with exactly one JSON object between ${SENTINEL_OPEN} and ${SENTINEL_CLOSE}, and nothing else.`,
        '- Keys must be field ids from FIELDS. No other keys, no nesting.',
        '- Include a field only when the new messages change it or establish it for the first time. Omit every unchanged field.',
        '- Values are compact factual strings of at most 200 characters, third person, with the character name when it matters.',
        '- Use "" only to clear a field that the new messages make unknown (not to restate an empty field).',
        '- Never invent details, never copy lines out of this instruction, never narrate.',
        '- If nothing changed, output {}.',
        '',
        'EXAMPLE',
        SENTINEL_OPEN,
        '{"location":"Night bus, upper deck","money":"Kai: 12 credits left, owes Mira 40"}',
        SENTINEL_CLOSE,
    ].join('\n');
}

function tryJson(body) {
    const attempts = [
        body,
        body.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"),
        body.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'),
        body.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"').replace(/([{,]\s*)'([^']*)'\s*:/g, '$1"$2":'),
    ];

    for (const attempt of attempts) {
        try {
            const parsed = JSON.parse(attempt);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            // next attempt
        }
    }
    return null;
}

/**
 * Extracts the JSON object from a model reply. Throws LedgerParseError with a
 * message worth showing in the panel — a silent empty result is worse than an
 * error, because the cursor would move and the messages would be lost.
 */
export function parseScanResponse(raw) {
    const text = String(raw ?? '');
    let body = '';

    const openIndex = text.indexOf(SENTINEL_OPEN);
    if (openIndex !== -1) {
        const closeIndex = text.indexOf(SENTINEL_CLOSE, openIndex + SENTINEL_OPEN.length);
        body = text.slice(openIndex + SENTINEL_OPEN.length, closeIndex === -1 ? undefined : closeIndex);
    } else {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        body = start !== -1 && end > start ? text.slice(start, end + 1) : '';
    }

    body = body.replace(/```(?:json)?/gi, '').trim();
    if (!body) {
        throw new LedgerParseError('The tracker replied without a status block.', text);
    }

    const parsed = tryJson(body);
    if (!parsed) {
        throw new LedgerParseError('The tracker reply was not valid JSON — nothing was applied.', text);
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('_') || key === 'changes') {
            continue;
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed.length) {
                cleaned[key] = trimmed.slice(0, 2000);
            } else {
                cleaned[key] = '';
            }
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            cleaned[key] = String(value);
        } else if (value === null) {
            cleaned[key] = '';
        }
    }

    return cleaned;
}

export function buildInjectedText({ template, fields, values }) {
    const body = fields
        .filter(field => values[field.id])
        .map(field => `${field.label}: ${values[field.id]}`)
        .join('\n');

    if (!body) {
        return '';
    }

    const pattern = template && template.includes('{{state}}') ? template : `{{state}}`;
    return pattern.replace(/\{\{state\}\}/g, body).trim();
}

/** Plain-text rendering, used by the /ledger slash command. */
export function renderStateText({ fields, values, cursor, total }) {
    const body = fields
        .filter(field => values[field.id])
        .map(field => `${field.icon ? `${field.icon} ` : ''}${field.label}: ${values[field.id]}`)
        .join('\n');
    return body ? `${body}\n\n(scanned to message ${cursor} of ${total})` : `Ledger is empty — scanned to message ${cursor} of ${total}.`;
}
