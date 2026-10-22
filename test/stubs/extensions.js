// Stub of SillyTavern's scripts/extensions.js for the local harness.

export const extension_settings = {};

const chat = [
    {
        name: 'Kisa',
        is_user: false,
        is_system: false,
        send_date: Date.now() - 60000,
        mes: '*The train is late and the platform lights are buzzing.*\n\nKisa is sitting on the bench with her knees pulled up, scrunchie around her wrist. "You took your time," she says, without looking up. It is 21:47 on October 14, and the station is nearly empty.',
        extra: {},
    },
    {
        name: 'Kai',
        is_user: true,
        is_system: false,
        send_date: Date.now() - 50000,
        mes: '"The bus broke down," I say, dropping onto the bench beside her. My phone says 21:49.',
        extra: {},
    },
    {
        name: 'Kisa',
        is_user: false,
        is_system: false,
        send_date: Date.now() - 40000,
        mes: 'She pulls a transit card out of her shorts pocket and flicks it at me. "I have two rides left on this. You owe me one."\n\nShe is wearing a white crop top and high-waisted shorts, the lavender scrunchie still on her wrist, hair clip fighting a losing battle. She looks at the timetable, then at me, then away.',
        extra: {},
    },
    {
        name: 'Kai',
        is_user: true,
        is_system: false,
        send_date: Date.now() - 30000,
        mes: 'I catch the card. "I will pay you back on Friday."',
        extra: {},
    },
];

const chatMetadata = {};

const listeners = new Map();

export const eventSource = {
    on(type, handler) {
        if (!listeners.has(type)) {
            listeners.set(type, []);
        }
        listeners.get(type).push(handler);
    },
    emit(type, ...args) {
        (listeners.get(type) ?? []).forEach(handler => handler(...args));
    },
};

export const eventTypes = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_changed',
    CHARACTER_SELECTED: 'character_selected',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SENT: 'message_sent',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_UPDATED: 'message_updated',
    GENERATION_ENDED: 'generation_ended',
};

const characters = [
    {
        name: 'Kisa',
        avatar: 'kisa.png',
        description: 'A step-sibling sharing an apartment with the user. Keeps track of everything, admits nothing.',
        personality: 'Watchful, teasing, guarded.',
        scenario: 'A late train platform after a long day.',
    },
];

export function getContext() {
    return {
        characters,
        characterId: 0,
        chatId: 'harness-chat',
        chat,
        chatMetadata,
        name1: 'Kai',
        name2: 'Kisa',
        getCurrentChatId: () => 'harness-chat',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'harness' }),
        saveChat: async () => { },
        saveMetadataDebounced: () => {
            window.__metaSaves = (window.__metaSaves || 0) + 1;
        },
        saveMetadata: () => {
            window.__metaSaves = (window.__metaSaves || 0) + 1;
        },
        stopGeneration: () => {
            window.__stopped = true;
        },
        reloadCurrentChat: async () => { },
        addOneMessage: message => {
            window.__lastInserted = message.mes;
        },
        eventSource,
        eventTypes,
    };
}

export async function renderExtensionTemplateAsync(extensionName, templateId) {
    const response = await fetch(`./mirror/scripts/extensions/${extensionName}/${templateId}.html`);
    if (!response.ok) {
        throw new Error(`Template not found: ${templateId}`);
    }
    return response.text();
}
