import { findByNameAll, findByProps, findByPropsAll } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative, url } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { findInReactTree } from "@vendetta/utils";

const BUILD = "1.0";
const IS_SPOILER = 1 << 3;
const IS_COMPONENTS_V2 = 1 << 15;
const LOCAL_UPDATE = Symbol("spoiler-everything.local-update");
const CONTROL_BASE = `https://spoiler.invalid/${Math.random().toString(36).slice(2)}/`;
const originals = new Map<string, any>();
const revealed = new Set<string>();
const stickerKeys = ["sticker_items", "stickerItems", "stickers", "sticker_ids", "stickerIds"];
let patches: (() => void)[] = [];
let active = false;
let rendererHooks = 0;
let linkHooks = 0;
let incomingAttachments = 0;
let renderedAttachments = 0;
let hiddenMedia = 0;

// MessageRecord has prototype methods/accessors that a plain spread loses.
function copyWith(value: any, updates: Record<string, any>) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, replacement] of Object.entries(updates)) {
        descriptors[key] = { value: replacement, enumerable: true, configurable: true, writable: true };
    }
    return Object.create(Object.getPrototypeOf(value), descriptors);
}

function messageKey(message: any) {
    const channel = message?.channel_id ?? message?.channelId;
    return channel && message?.id ? `${channel}/${message.id}` : undefined;
}

function isImage(attachment: any) {
    return typeof attachment?.content_type === "string"
        ? attachment.content_type.startsWith("image/")
        : /\.(?:png|jpe?g|gif|webp|avif|bmp|heic|heif)$/i.test(attachment?.filename ?? "");
}

function isVideo(attachment: any) {
    const type = attachment?.content_type ?? attachment?.contentType;
    return typeof type === "string" && type !== "application/octet-stream"
        ? type.startsWith("video/")
        : /\.(?:mp4|webm|mov|m4v|mkv|avi|ogv|3gp|3g2|mpeg|mpg)$/i.test(attachment?.filename ?? "");
}

function spoilerImage(attachment: any, incoming: boolean) {
    if (!isImage(attachment)) return attachment;
    if (incoming) incomingAttachments++;
    else renderedAttachments++;
    const filename = attachment.filename;
    return copyWith(attachment, {
        flags: (typeof attachment.flags === "number" ? attachment.flags : 0) | IS_SPOILER,
        spoiler: true,
        ...(typeof filename === "string" && !filename.startsWith("SPOILER_")
            ? { filename: `SPOILER_${filename}` } : {}),
    });
}

// Images keep native spoilers; videos, embeds and stickers use Show media.
// Audio, voice messages, documents, emojis and bot components stay visible.
function prepare(message: any, incoming: boolean, hide: boolean, depth = 0): { message: any; count: number } {
    if (!message || typeof message !== "object" || depth > 5) return { message, count: 0 };
    const updates: Record<string, any> = {};
    let count = 0;
    // V2 components can reference attached files. Preserve their complete
    // payload, including attachments and flags, so the bot UI stays intact.
    const componentMessage = Array.isArray(message.components) && message.components.length > 0
        && typeof message.flags === "number" && Boolean(message.flags & IS_COMPONENTS_V2);

    if (!componentMessage && Array.isArray(message.attachments) && message.attachments.length) {
        updates.attachments = message.attachments.map((attachment: any) => spoilerImage(attachment, incoming));
        if (hide) {
            const visible = updates.attachments.filter((attachment: any) => !isVideo(attachment));
            count += updates.attachments.length - visible.length;
            updates.attachments = visible;
        }
    }
    if (!componentMessage && hide && Array.isArray(message.embeds) && message.embeds.length) {
        count += message.embeds.length;
        updates.embeds = [];
    }
    for (const key of stickerKeys) {
        if (!componentMessage && hide && Array.isArray(message[key]) && message[key].length) {
            count += message[key].length;
            updates[key] = [];
        }
    }
    for (const key of ["referenced_message", "referencedMessage"]) {
        if (message[key]) {
            const result = prepare(message[key], incoming, hide, depth + 1);
            updates[key] = result.message;
            count += result.count;
        }
    }
    for (const key of ["message_snapshots", "messageSnapshots"]) {
        if (Array.isArray(message[key])) {
            updates[key] = message[key].map((snapshot: any) => {
                if (!snapshot?.message) return snapshot;
                const result = prepare(snapshot.message, incoming, hide, depth + 1);
                count += result.count;
                return copyWith(snapshot, { message: result.message });
            });
        }
    }
    return { message: Object.keys(updates).length ? copyWith(message, updates) : message, count };
}

function transform(message: any, incoming: boolean, partial = false) {
    if (!message || typeof message !== "object") return message;
    const key = messageKey(message);
    const saved = key ? originals.get(key) : undefined;
    const isPlaceholder = typeof message.content === "string" && message.content.includes(CONTROL_BASE);
    // Gateway edits use raw data. Renderers must keep the normalized
    // MessageRecord, including its methods and normalized nested records.
    // A stored placeholder is already concealed; never replace it with the
    // raw original saved for the local MESSAGE_UPDATE reveal action.
    const source = partial && saved ? copyWith(saved, message)
        : incoming && isPlaceholder && saved ? saved : message;
    const show = Boolean(key && revealed.has(key));
    const result = prepare(source, incoming, !show);
    if (!key || (!result.count && !saved)) return result.message;
    // Rendering a revealed record must not overwrite a saved raw payload.
    if (!isPlaceholder && (incoming || !saved)) originals.set(key, source);
    if (show || !result.count) return result.message;
    hiddenMedia += result.count;
    const text = result.message.content ?? "";
    const control = `[Show media](${CONTROL_BASE}${key})`;
    return copyWith(result.message, { content: `${text}${text ? "\n" : ""}${control}` });
}

function transformMessages(messages: any): any {
    return Array.isArray(messages) ? messages.map(message => Array.isArray(message)
        ? transformMessages(message) : transform(message, true)) : messages;
}

function localUpdate(message: any) {
    const action = { type: "MESSAGE_UPDATE", message, [LOCAL_UPDATE]: true };
    const dispatch = () => FluxDispatcher.dispatch(action);
    if (FluxDispatcher.isDispatching?.()) FluxDispatcher.wait(dispatch);
    else dispatch();
}

function toggleMedia(key: string, show: boolean) {
    const original = originals.get(key);
    if (!original) return;
    if (show) revealed.add(key);
    else revealed.delete(key);
    localUpdate(show ? prepare(original, false, false).message : transform(original, false));
}

function controlKey(value: any, depth = 0): string | undefined {
    if (typeof value === "string" && value.startsWith(CONTROL_BASE)) {
        const key = value.slice(CONTROL_BASE.length).replace(/\/$/, "");
        return key;
    }
    if (!value || typeof value !== "object" || depth > 2) return;
    for (const field of ["url", "href", "target", "link", "nativeEvent"]) {
        const key = controlKey(value[field], depth + 1);
        if (key) return key;
    }
}

function patchLinks() {
    const targets: [any, string][] = [];
    // Current native message links enter handleClick({ href }) directly.
    // Patching only the legacy URL helpers does not intercept those taps.
    for (const target of new Set([url, ReactNative.Linking,
        ...findByPropsAll("openURL", "openDeeplink"), ...findByPropsAll("handleClick")])) {
        for (const method of ["handleClick", "openURL", "openDeeplink", "handleSupportedURL", "handleMessageLinking"]) {
            if (typeof target?.[method] === "function") targets.push([target, method]);
        }
    }
    for (const target of findByNameAll("handleContentLinking", false)) {
        if (typeof target?.default === "function") targets.push([target, "default"]);
    }
    const installed = new Map<any, Set<string>>();
    for (const [target, method] of targets) {
        const methods = installed.get(target) ?? new Set<string>();
        if (methods.has(method)) continue;
        methods.add(method);
        installed.set(target, methods);
        patches.push(instead(method, target, (args, original) => {
            const key = args.map(arg => controlKey(arg)).find(Boolean);
            if (key) { toggleMedia(key, true); return Promise.resolve(); }
            // Never navigate these local controls, even if a message was deleted.
            if (args.some(arg => typeof arg === "string" && arg.startsWith(CONTROL_BASE))) return Promise.resolve();
            return original(...args);
        }));
        linkHooks++;
    }
}

function patchMessageMenu() {
    const sheets = findByProps("openLazy", "hideActionSheet");
    const Row = findByProps("ActionSheetRow")?.ActionSheetRow ?? findByProps("ButtonRow")?.ButtonRow;
    if (!sheets || !Row) return;
    patches.push(before("openLazy", sheets, ([component, name, props]) => {
        const key = messageKey(props?.message);
        if (name !== "MessageLongPressActionSheet" || !key || !originals.has(key)) return;
        component.then((instance: any) => {
            if (!active) return;
            const unpatch = after("default", instance, (_, tree) => {
                React.useEffect(() => () => { unpatch(); }, []);
                const rows = findInReactTree(tree, (node: any) => Array.isArray(node)
                    && node.some(child => ["ActionSheetRow", "ButtonRow"].includes(child?.type?.name)));
                if (!rows || rows.some((row: any) => row?.key === "spoiler-everything-media")) return;
                rows.unshift(React.createElement(Row, {
                    key: "spoiler-everything-media",
                    label: revealed.has(key) ? "Hide media" : "Show media",
                    onPress: () => { sheets.hideActionSheet(); toggleMedia(key, !revealed.has(key)); },
                }));
            });
            patches.push(unpatch);
        });
    }));
}

function Diagnostics() {
    const [, refresh] = React.useState(0);
    React.useEffect(() => {
        const timer = setInterval(() => refresh((n: number) => n + 1), 1000);
        return () => clearInterval(timer);
    }, []);
    return React.createElement(ReactNative.View, { style: { padding: 20 } },
        React.createElement(ReactNative.Text, { style: { color: "#a8a8a8", fontSize: 16 } },
            `Always Spoiler Media ${BUILD}\n\nRenderer hooks: ${rendererHooks}\nReveal hooks: ${linkHooks}\nIncoming images processed: ${incomingAttachments}\nRendered images processed: ${renderedAttachments}\nOther media processed: ${hiddenMedia}\nRevealed messages: ${revealed.size}`));
}

export default {
    onLoad() {
        active = true;
        patchLinks();
        patchMessageMenu();
        if (typeof FluxDispatcher?.dispatch === "function") {
            patches.push(before("dispatch", FluxDispatcher, (args) => {
                const action = args[0];
                if (!action || action[LOCAL_UPDATE]) return;
                if (action.type === "MESSAGE_DELETE") {
                    const key = messageKey({ id: action.id ?? action.messageId, channel_id: action.channelId ?? action.channel_id });
                    if (key) { originals.delete(key); revealed.delete(key); }
                    return;
                }
                if (!(action.type === "MESSAGE_CREATE" || action.type === "MESSAGE_UPDATE"
                    || action.type?.startsWith("LOAD_MESSAGES_SUCCESS"))) return;
                const updates: Record<string, any> = {};
                if (action.message) {
                    const key = messageKey(action.message);
                    if (key && action.type === "MESSAGE_UPDATE"
                        && ["attachments", "embeds", "components", ...stickerKeys].some(field => field in action.message)) revealed.delete(key);
                    updates.message = transform(action.message, true, action.type === "MESSAGE_UPDATE");
                }
                if (Array.isArray(action.messages)) updates.messages = transformMessages(action.messages);
                if (Object.keys(updates).length) args[0] = copyWith(action, updates);
            }));
        }
        for (const factory of new Set(findByNameAll("createMessageContent", false))) {
            if (typeof factory?.default !== "function") continue;
            rendererHooks++;
            patches.push(before("default", factory, (args) => {
                const content = args?.[0];
                if (!content?.message) return;
                const message = transform(content.message, false);
                if (message === content.message) return;
                args[0] = copyWith(content, {
                    message,
                    options: content.options && typeof content.options === "object"
                        ? copyWith(content.options, { shouldObscureSpoiler: true })
                        : { shouldObscureSpoiler: true },
                });
            }));
        }
        if (!rendererHooks || !linkHooks) throw new Error("Always Spoiler Media: supported message/reveal hooks were not found.");
    },
    onUnload() {
        active = false;
        for (const unpatch of patches) unpatch();
        patches = [];
        // Remove local placeholder text and return cached media on disable.
        for (const message of originals.values()) localUpdate(message);
        originals.clear();
        revealed.clear();
        rendererHooks = 0;
        linkHooks = 0;
    },
    settings: Diagnostics,
};
