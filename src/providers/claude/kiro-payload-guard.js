/**
 * Payload size guard for Kiro API requests.
 *
 * Oversized Kiro payloads can fail with misleading upstream errors. The exact
 * upstream boundary is not treated as a fixed contract here; this module provides:
 * - Pre-flight size checking
 * - Auto-trimming of oldest non-tool history entries to fit under a local safety budget
 * - Orphaned toolResult repair after trimming
 *
 * Ported from KiroProxy/kiro_proxy/payload_guards.py
 */
import logger from '../../utils/logger.js';

const MAX_PAYLOAD_BYTES = 600000; // Local safety budget; tune from production evidence.
const AUTO_TRIM_PAYLOAD = true;   // auto-trim by default

/**
 * Return the serialized byte size of the payload as UTF-8 JSON.
 */
function checkPayloadSize(payload) {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Remove empty toolUses arrays in-place (Kiro quirk).
 */
function stripEmptyToolUses(history) {
    for (const entry of history) {
        const assistant = entry.assistantResponseMessage;
        if (assistant && Array.isArray(assistant.toolUses) && assistant.toolUses.length === 0) {
            delete assistant.toolUses;
        }
    }
}

function isToolHistoryEntry(entry) {
    const toolUses = entry?.assistantResponseMessage?.toolUses;
    if (Array.isArray(toolUses) && toolUses.length > 0) return true;

    const toolResults = entry?.userInputMessage?.userInputMessageContext?.toolResults;
    return Array.isArray(toolResults) && toolResults.length > 0;
}

/**
 * Ensure history starts with a userInputMessage entry.
 * Modifies history in-place.
 * Logs a warning if all entries were removed (T5 fix).
 */
export function alignToUserMessage(history) {
    const originalLen = history.length;
    while (history.length > 0 && !('userInputMessage' in history[0]) && !isToolHistoryEntry(history[0])) {
        history.shift();
    }
    if (history.length === 0 && originalLen > 0) {
        logger.warn('[Kiro] alignToUserMessage: all entries were non-user messages, history is now empty. This indicates an abnormal conversation structure.');
    }
}

/**
 * Remove orphaned toolResults that reference toolUseIds not present
 * in the preceding assistant message.
 * Modifies history in-place.
 */
export function repairOrphanedToolResults(history) {
    for (let i = 0; i < history.length; i++) {
        const userMsg = history[i].userInputMessage;
        if (!userMsg) continue;

        const ctx = userMsg.userInputMessageContext;
        if (!ctx || !Array.isArray(ctx.toolResults) || ctx.toolResults.length === 0) continue;

        // Collect toolUseIds from the preceding assistant message
        const prevToolUseIds = new Set();
        if (i > 0) {
            const prevAssistant = history[i - 1].assistantResponseMessage;
            if (prevAssistant) {
                for (const tu of (prevAssistant.toolUses || [])) {
                    if (tu.toolUseId) prevToolUseIds.add(tu.toolUseId);
                }
            }
        }

        if (prevToolUseIds.size > 0) {
            ctx.toolResults = ctx.toolResults.filter(tr => prevToolUseIds.has(tr.toolUseId));
            if (ctx.toolResults.length === 0) {
                delete ctx.toolResults;
            }
        } else {
            // No preceding assistant with tool uses — remove all tool results
            delete ctx.toolResults;
        }

        // Clean up empty context object
        if ('toolResults' in ctx === false && Object.keys(ctx).length === 0) {
            delete userMsg.userInputMessageContext;
        }
    }
}

/**
 * Trim oldest non-tool history entries to fit payload under size limit.
 * Modifies payload in-place.
 *
 * @param {object} payload - The full Kiro API request payload
 * @param {number} maxBytes - Maximum allowed bytes (default MAX_PAYLOAD_BYTES)
 * @returns {{ trimmed: boolean, originalBytes: number, finalBytes: number, originalEntries: number, finalEntries: number }}
 */
export function trimPayloadToLimit(payload, maxBytes = MAX_PAYLOAD_BYTES) {
    const history = payload?.conversationState?.history;
    if (!Array.isArray(history) || history.length === 0) {
        const size = checkPayloadSize(payload);
        return { trimmed: false, originalBytes: size, finalBytes: size, originalEntries: 0, finalEntries: 0 };
    }

    const originalEntries = history.length;
    const originalBytes = checkPayloadSize(payload);

    if (originalBytes <= maxBytes) {
        return { trimmed: false, originalBytes, finalBytes: originalBytes, originalEntries, finalEntries: originalEntries };
    }

    // Strip empty toolUses first (reduces size with no information loss)
    stripEmptyToolUses(history);

    // Trim oldest non-tool entries until under limit (keep at least 2 entries).
    // Tool call/results carry exact coding state, so keep them raw even if that
    // means the request remains above the local heuristic budget.
    while (history.length > 2 && checkPayloadSize(payload) > maxBytes) {
        const index = history.findIndex(entry => !isToolHistoryEntry(entry));
        if (index < 0) break;
        history.splice(index, 1);
    }

    // Ensure history starts with a user message
    alignToUserMessage(history);

    // Repair orphaned tool results after trimming
    repairOrphanedToolResults(history);

    const finalBytes = checkPayloadSize(payload);
    const finalEntries = history.length;

    if (originalEntries !== finalEntries) {
        logger.info(`[Kiro] Payload trimmed: ${originalBytes} -> ${finalBytes} bytes, ${originalEntries} -> ${finalEntries} history entries`);
    }

    return { trimmed: originalEntries !== finalEntries, originalBytes, finalBytes, originalEntries, finalEntries };
}

/**
 * Check payload size and optionally auto-trim.
 *
 * The byte limit is a local safety heuristic, not an authoritative Kiro API
 * contract. If trimming cannot bring the payload under the heuristic limit,
 * allow the request to continue and let Kiro return the real upstream result.
 *
 * @param {object} payload - The full Kiro API request payload
 * @returns {string|null} null; retained for backwards-compatible call sites
 */
export function guardPayload(payload) {
    const size = checkPayloadSize(payload);

    if (size <= MAX_PAYLOAD_BYTES) {
        return null;
    }

    if (AUTO_TRIM_PAYLOAD) {
        const stats = trimPayloadToLimit(payload, MAX_PAYLOAD_BYTES);
        if (stats.finalBytes > MAX_PAYLOAD_BYTES) {
            logger.warn(
                `[Kiro] Payload size (${stats.finalBytes} bytes) remains above local ` +
                `heuristic limit (${MAX_PAYLOAD_BYTES} bytes) after trimming; sending anyway`
            );
        }
        return null;
    }

    logger.warn(
        `[Kiro] Payload size (${size} bytes) exceeds local heuristic limit ` +
        `(${MAX_PAYLOAD_BYTES} bytes), but auto-trim is disabled; sending anyway`
    );
    return null;
}
