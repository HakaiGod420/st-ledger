// Stub of SillyTavern's script.js exports used by the extension.

import { extension_settings } from './scripts/extensions.js';

export function saveSettingsDebounced() {
    window.__saved = JSON.parse(JSON.stringify(extension_settings));
}

export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

export function setExtensionPrompt(key, value, position, depth, scan = false, role = 0) {
    const injection = { key, value, position, depth, scan, role };
    window.__injection = injection;
    window.__injections = window.__injections ?? [];
    window.__injections.push(injection);
}

/** Deterministic values derived from the message numbers in the prompt. */
function ledgerFor(prompt) {
    const numbers = [...prompt.matchAll(/^#(\d+) /gm)].map(match => Number(match[1]));
    const last = numbers.length ? Math.max(...numbers) : 0;

    const values = {
        datetime: `October 14, 2026 — 21:${String(50 + last).padStart(2, '0')}`,
        location: `Train station platform, ${last > 3 ? 'north end of the bench' : 'seat by the timetable'}`,
        clothing: 'Kisa — white crop top, high-waisted shorts, lavender scrunchie on her wrist, hair clip; Kai — grey hoodie, wet sneakers',
        inventory: 'Phone, keys, wallet, transit card (two rides left)',
        health: 'Both healthy, just tired',
        relationship: last > 5
            ? 'Step-siblings sharing an apartment; Kisa keeps score, the tension is no longer subtle'
            : 'Step-siblings sharing an apartment. Once close, now distant, but Kisa tracks Kai\'s movements more than she admits.',
    };

    if (last > 6) {
        values.money = 'Kai owes Kisa one transit ride, promised for Friday';
    }

    return values;
}

export async function generateQuietPrompt({ quietPrompt = '', responseLength = null } = {}) {
    window.__lastPrompt = quietPrompt;
    window.__lastMode = 'quiet';
    window.__lastResponseLength = responseLength;
    window.__calls = (window.__calls ?? 0) + 1;

    await new Promise(resolve => setTimeout(resolve, 650));

    if (window.__failNext) {
        window.__failNext = false;
        return 'Sure — here is a quick summary: everything looks consistent so far, nothing to change.';
    }
    if (window.__abortScan) {
        window.__abortScan = false;
        throw new Error('Generation stopped by user');
    }

    const values = ledgerFor(quietPrompt);
    return `<<<LEDGER>>>\n${JSON.stringify(values)}\n<<<END>>>`;
}

export async function generateRaw({ prompt = '' } = {}) {
    window.__lastRawPrompt = prompt;
    window.__lastMode = 'raw';
    await new Promise(resolve => setTimeout(resolve, 650));
    return `<<<LEDGER>>>\n${JSON.stringify(ledgerFor(prompt))}\n<<<END>>>`;
}
