/**
 * Three-tier history compression for Kiro API requests.
 *
 * When conversation history grows too large, instead of blindly dropping
 * the oldest entries, we apply a three-tier strategy:
 *
 *   Tier 1 — RECENT:  keep the last RECENT_TURNS turns intact (never touched)
 *   Tier 2 — MIDDLE:  drop tool_use/tool_result pairs from oldest to newest
 *                     until payload fits, preserving text exchanges
 *   Tier 3 — SUMMARY: if still too large, compress everything outside Tier 1
 *                     into a text summary via a Kiro API call, injected into
 *                     the system prompt so no information is completely lost
 *
 * The summary call reuses the same Kiro credentials via the supplied
 * `callKiro(prompt)` callback, keeping dependencies minimal.
 */

import logger from '../../utils/logger.js';

// ── Tuning constants ────────────────────────────────────────────────────────

/** Number of most-recent history *pairs* (user+assistant) to always keep intact. */
const RECENT_TURNS = 6;

/** Hard cap on summary text length to avoid re-inflating the payload. */
const SUMMARY_MAX_CHARS = 4000;

/** Summaries shorter than this usually indicate a placeholder or empty reply. */
const SUMMARY_MIN_CHARS = 200;

/** System-prompt section wrapper for injected summaries. */
const SUMMARY_SECTION_START = '\n\n<conversation_summary>\n';
const SUMMARY_SECTION_END = '\n</conversation_summary>';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Payload byte size helper (mirrors kiro-payload-guard.js).
 */
function payloadBytes(payload) {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Return true if a history entry pair (assistant + following user) is a
 * pure tool exchange with no meaningful text on the assistant side.
 *
 * Kiro history layout:
 *   index i   → { assistantResponseMessage: { content, toolUses } }
 *   index i+1 → { userInputMessage: { userInputMessageContext: { toolResults } } }
 *
 * "Pure tool pair" = assistant has only toolUses (content is empty/whitespace)
 * and the following user message carries only toolResults (no freeform text).
 */
function isPureToolPair(assistantEntry, userEntry) {
    if (!assistantEntry || !userEntry) return false;

    const arm = assistantEntry.assistantResponseMessage;
    const uim = userEntry?.userInputMessage;
    if (!arm || !uim) return false;

    const assistantIsToolOnly =
        Array.isArray(arm.toolUses) &&
        arm.toolUses.length > 0 &&
        (!arm.content || arm.content.trim() === '');

    const userIsToolResultOnly =
        !!uim.userInputMessageContext?.toolResults?.length &&
        (!uim.content || uim.content.trim() === '');

    return assistantIsToolOnly && userIsToolResultOnly;
}

/**
 * Build a human-readable plain-text digest of the entries to be summarised.
 * This is the prompt we send to Kiro when requesting a summary.
 *
 * @param {Array} entries - Kiro history entries (may be assistant or user turns)
 * @returns {string}
 */
function buildSummaryPrompt(entries) {
    const lines = ['Below is a segment of a prior coding-assistant conversation. Produce a concise summary (max 400 words) that captures: files touched, key decisions made, errors encountered and how they were resolved, and the current overall goal. Output only the summary text, no preamble.\n'];

    for (const entry of entries) {
        const arm = entry.assistantResponseMessage;
        const uim = entry.userInputMessage;

        if (arm) {
            if (arm.content && arm.content.trim()) {
                lines.push(`[Assistant]: ${arm.content.trim().slice(0, 500)}`);
            }
            if (Array.isArray(arm.toolUses) && arm.toolUses.length > 0) {
                for (const tu of arm.toolUses) {
                    const inputPreview = JSON.stringify(tu.input ?? {}).slice(0, 200);
                    lines.push(`[Tool call]: ${tu.name}(${inputPreview})`);
                }
            }
        }

        if (uim) {
            if (uim.content && uim.content.trim()) {
                lines.push(`[User]: ${uim.content.trim().slice(0, 500)}`);
            }
            const toolResults = uim.userInputMessageContext?.toolResults;
            if (Array.isArray(toolResults) && toolResults.length > 0) {
                for (const tr of toolResults) {
                    const resultText = (tr.content?.[0]?.text ?? '').slice(0, 200);
                    lines.push(`[Tool result: ${tr.toolUseId}]: ${resultText}`);
                }
            }
        }
    }

    return lines.join('\n');
}

function isInvalidSummary(summaryText) {
    const text = (summaryText || '').trim();
    if (text.length < SUMMARY_MIN_CHARS) return true;

    const normalized = text.toLowerCase().replace(/\s+/g, ' ');
    const placeholderPatterns = [
        /^no content to summarize\.?$/,
        /^nothing to summarize\.?$/,
        /^there is no content to summarize\.?$/,
        /^i have no content to summarize\.?$/,
        /^no summary available\.?$/,
        /^summary unavailable\.?$/,
    ];

    return placeholderPatterns.some(pattern => pattern.test(normalized));
}

// ── Tier 2: drop pure tool pairs ─────────────────────────────────────────────

/**
 * Remove pure tool_use/tool_result pairs from the *oldest* part of history
 * (everything before the protected recent window) until payload fits under
 * maxBytes.  Modifies `history` in-place.
 *
 * Returns the number of pairs removed.
 */
export function dropOldToolPairs(history, payload, maxBytes, recentTurns = RECENT_TURNS) {
    // The recent window: last recentTurns*2 entries (each turn = assistant + user)
    const recentStart = Math.max(0, history.length - recentTurns * 2);
    let removed = 0;

    // Walk the eligible range from oldest to newest, looking for pairs to drop
    let i = 0;
    while (i < recentStart - 1 && payloadBytes(payload) > maxBytes) {
        // A pair is: assistantResponseMessage at i, userInputMessage at i+1
        if (isPureToolPair(history[i], history[i + 1])) {
            history.splice(i, 2);
            recentStart > 0 && (i = i); // recentStart shifts by 2 automatically since we spliced
            removed++;
            // Don't advance i — after splice the next pair is now at the same index
        } else {
            i += 2;
        }
    }

    if (removed > 0) {
        logger.info(`[Kiro] Tier-2 trim: dropped ${removed} pure tool pairs from old history`);
    }
    return removed;
}

// ── Tier 3: summarise + inject ────────────────────────────────────────────────

/**
 * Summarise history entries that fall outside the recent window by calling
 * Kiro, then inject the summary into systemPrompt and remove those entries
 * from history.
 *
 * @param {object} payload         - Full Kiro request payload (mutated in place)
 * @param {string} systemPrompt    - Current system prompt string
 * @param {Function} callKiro      - async (promptText: string) => summaryText: string
 * @param {number} recentTurns     - Number of recent turns to preserve
 * @returns {string}               - Updated system prompt (with summary appended)
 */
export async function summariseOldHistory(payload, systemPrompt, callKiro, recentTurns = RECENT_TURNS) {
    const history = payload?.conversationState?.history;
    if (!Array.isArray(history) || history.length === 0) return systemPrompt;

    const recentStart = Math.max(0, history.length - recentTurns * 2);
    if (recentStart === 0) {
        // Everything is already in the recent window — nothing to summarise
        return systemPrompt;
    }

    const toSummarise = history.slice(0, recentStart);
    logger.info(`[Kiro] Tier-3 summary: compressing ${toSummarise.length} old history entries via Kiro`);

    let summaryText = '';
    try {
        const prompt = buildSummaryPrompt(toSummarise);
        summaryText = await callKiro(prompt);
        if (isInvalidSummary(summaryText)) {
            logger.warn(`[Kiro] Tier-3 summary invalid (${(summaryText || '').trim().length} chars), using rule-based fallback`);
            summaryText = buildRuleBasedSummary(toSummarise);
        }
        // Truncate to hard cap
        if (summaryText.length > SUMMARY_MAX_CHARS) {
            summaryText = summaryText.slice(0, SUMMARY_MAX_CHARS) + '…';
        }
        logger.info(`[Kiro] Tier-3 summary generated: ${summaryText.length} chars`);
    } catch (err) {
        // Summary generation failed — fall back to a minimal rule-based digest
        logger.warn(`[Kiro] Tier-3 summary call failed (${err.message}), using rule-based fallback`);
        summaryText = buildRuleBasedSummary(toSummarise);
    }

    // Remove the summarised entries from history
    history.splice(0, recentStart);

    // Inject summary into system prompt
    const section = `${SUMMARY_SECTION_START}The following is a summary of earlier conversation history that has been compressed to save context space:\n\n${summaryText}${SUMMARY_SECTION_END}`;
    return (systemPrompt || '') + section;
}

// ── Fallback: rule-based summary ──────────────────────────────────────────────

/**
 * Build a minimal summary without calling the model.
 * Used as a fallback when the Kiro summary call fails.
 */
function buildRuleBasedSummary(entries) {
    const filesTouched = new Set();
    const toolsCalled = [];
    const textExchanges = [];

    for (const entry of entries) {
        const arm = entry.assistantResponseMessage;
        const uim = entry.userInputMessage;

        if (arm) {
            if (arm.content && arm.content.trim()) {
                textExchanges.push(arm.content.trim().slice(0, 120));
            }
            for (const tu of (arm.toolUses || [])) {
                toolsCalled.push(tu.name);
                // Heuristic: extract file paths from common tool inputs
                const inp = tu.input || {};
                const pathVal = inp.file_path || inp.path || inp.notebook_path || inp.file || '';
                if (pathVal) filesTouched.add(pathVal);
            }
        }

        if (uim && uim.content && uim.content.trim()) {
            textExchanges.push(`User: ${uim.content.trim().slice(0, 120)}`);
        }
    }

    const parts = [];
    if (filesTouched.size > 0) {
        parts.push(`Files referenced: ${[...filesTouched].join(', ')}`);
    }
    if (toolsCalled.length > 0) {
        const counts = {};
        for (const t of toolsCalled) counts[t] = (counts[t] || 0) + 1;
        parts.push(`Tools used: ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ')}`);
    }
    if (textExchanges.length > 0) {
        parts.push(`Key exchanges:\n${textExchanges.slice(-5).join('\n')}`);
    }

    return parts.length > 0
        ? parts.join('\n')
        : `[${entries.length} earlier history entries compressed]`;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Apply three-tier history compression to the payload if it exceeds maxBytes.
 *
 * Tier 1 is implicit — recentTurns entries at the tail are never touched.
 * Tier 2 drops pure tool pairs from the old section.
 * Tier 3 summarises remaining old entries via a Kiro call.
 *
 * @param {object}   payload       - Full Kiro request payload (mutated in place)
 * @param {string}   systemPrompt  - Current system prompt string
 * @param {number}   maxBytes      - Byte budget for the payload
 * @param {Function} callKiro      - async (prompt: string) => string
 * @param {number}   [recentTurns] - Override RECENT_TURNS
 * @returns {Promise<string>}      - Updated system prompt
 */
export async function compressHistory(payload, systemPrompt, maxBytes, callKiro, recentTurns = RECENT_TURNS) {
    const history = payload?.conversationState?.history;
    if (!Array.isArray(history) || history.length === 0) return systemPrompt;

    if (payloadBytes(payload) <= maxBytes) return systemPrompt;

    logger.info(`[Kiro] History compression triggered: ${payloadBytes(payload)} bytes > ${maxBytes} bytes`);

    // Tier 2 — drop pure tool pairs
    dropOldToolPairs(history, payload, maxBytes, recentTurns);

    if (payloadBytes(payload) <= maxBytes) {
        logger.info('[Kiro] Tier-2 trim sufficient, skipping summary');
        return systemPrompt;
    }

    // Tier 3 — summarise + inject
    const updatedSystemPrompt = await summariseOldHistory(payload, systemPrompt, callKiro, recentTurns);

    const afterBytes = payloadBytes(payload);
    logger.info(`[Kiro] After Tier-3 compression: ${afterBytes} bytes`);

    return updatedSystemPrompt;
}
