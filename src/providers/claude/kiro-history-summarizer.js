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
const SUMMARY_MAX_CHARS = 6000;

/** Summaries shorter than this usually indicate a placeholder or empty reply. */
const SUMMARY_MIN_CHARS = 160;

/** Retry once with a stricter prompt before falling back to rule-based summary. */
const SUMMARY_MAX_ATTEMPTS = 2;

/** Keep the summarisation request itself bounded; old tool output is locally compacted first. */
const SUMMARY_PROMPT_MAX_CHARS = 28000;

/** Bounds for deterministic coding-memory material sent to the summary call. */
const PINNED_FACTS_MAX = 36;
const TOOL_DIGEST_MAX = 48;
const TRANSCRIPT_EXCERPTS_MAX = 64;
const TOOL_RESULT_PREVIEW_CHARS = 900;

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

function uniquePush(list, seen, value) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) return;
    seen.add(item);
    list.push(item);
}

function truncateMiddle(text, maxChars) {
    const value = String(text || '');
    if (value.length <= maxChars) return value;
    const head = Math.floor(maxChars * 0.6);
    const tail = Math.max(0, maxChars - head - 32);
    return `${value.slice(0, head)}\n...[truncated ${value.length - head - tail} chars]...\n${value.slice(-tail)}`;
}

function compactWhitespace(text) {
    return String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}

function extractPathCandidates(text) {
    const value = String(text || '');
    const matches = value.match(/(?:[A-Za-z]:\\[^\s"'`<>]+|(?:\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.+-]+)+(?:\.[A-Za-z0-9_-]+)?)/g) || [];
    return matches
        .map(item => item.replace(/[),.;:\]]+$/g, ''))
        .filter(item => item.length > 2 && !item.startsWith('http'));
}

function extractCommandCandidates(text) {
    const value = String(text || '');
    const commands = [];
    const commandPatterns = [
        /\b(?:npm|pnpm|yarn|node|npx|jest|vitest|pytest|python|python3|go|cargo|git|docker|docker-compose|kubectl|ssh|curl|rg|grep)\s+[^\n\r]+/g,
        /\$ ([^\n\r]+)/g,
    ];

    for (const pattern of commandPatterns) {
        for (const match of value.matchAll(pattern)) {
            commands.push((match[1] || match[0]).trim());
        }
    }
    return commands;
}

function extractHighSignalLines(text, maxLines = 12) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    const highSignal = lines.filter(line =>
        /\b(error|failed|failure|exception|timeout|timed out|fatal|warn|warning|assert|expected|received|cannot|denied|not found|exit code|status: [45]\d\d)\b/i.test(line)
    );
    const selected = highSignal.length > 0 ? highSignal : lines.slice(-maxLines);
    return selected.slice(0, maxLines);
}

function getToolResultText(toolResult) {
    const content = toolResult?.content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (part?.text) return part.text;
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (typeof content === 'string') return content;
    return '';
}

function summariseToolResult(toolResult) {
    const text = getToolResultText(toolResult);
    if (!text.trim()) return '[empty tool result]';

    const paths = [];
    const seenPaths = new Set();
    for (const pathCandidate of extractPathCandidates(text)) {
        uniquePush(paths, seenPaths, pathCandidate);
        if (paths.length >= 8) break;
    }

    const commands = [];
    const seenCommands = new Set();
    for (const command of extractCommandCandidates(text)) {
        uniquePush(commands, seenCommands, command);
        if (commands.length >= 6) break;
    }

    const highSignal = extractHighSignalLines(text, 10);
    const parts = [
        `status=${toolResult.status || 'unknown'}`,
        `chars=${text.length}`,
    ];
    if (paths.length > 0) parts.push(`paths=${paths.join(', ')}`);
    if (commands.length > 0) parts.push(`commands=${commands.join(' | ')}`);
    if (highSignal.length > 0) parts.push(`signal=${highSignal.join(' / ')}`);

    return truncateMiddle(parts.join('; '), TOOL_RESULT_PREVIEW_CHARS);
}

function summariseToolInput(toolUse) {
    const input = toolUse?.input || {};
    const parts = [];

    for (const key of ['file_path', 'path', 'notebook_path', 'file', 'cmd', 'command', 'pattern', 'query', 'url']) {
        if (input[key]) parts.push(`${key}=${String(input[key]).slice(0, 240)}`);
    }

    if (parts.length === 0) {
        const preview = JSON.stringify(input);
        if (preview && preview !== '{}') parts.push(truncateMiddle(preview, 360));
    }

    return parts.join(', ');
}

function classifyUserFact(text) {
    const value = compactWhitespace(text);
    if (!value) return null;

    if (/(不要|别|不能|必须|一定|优先|主要|只|不要|never|must|should|only|do not|don't|prefer)/i.test(value)) {
        return `Constraint: ${truncateMiddle(value, 220)}`;
    }
    if (/(目标|任务|实现|修复|评估|部署|提交|推送|goal|task|implement|fix|evaluate|deploy|commit|push)/i.test(value)) {
        return `User goal: ${truncateMiddle(value, 220)}`;
    }
    return `User context: ${truncateMiddle(value, 180)}`;
}

function buildDeterministicCodingMemory(entries) {
    const pinnedFacts = [];
    const toolDigest = [];
    const transcript = [];
    const seenFacts = new Set();
    const seenTools = new Set();
    const seenTranscript = new Set();

    for (const entry of entries) {
        const arm = entry.assistantResponseMessage;
        const uim = entry.userInputMessage;

        if (arm) {
            if (arm.content && arm.content.trim()) {
                const assistantText = compactWhitespace(arm.content);
                if (/(decid|decision|fix|implemented|changed|updated|failed|error|commit|deploy|test|原因|结论|修复|实现|提交|部署|失败|错误)/i.test(assistantText)) {
                    uniquePush(pinnedFacts, seenFacts, `Assistant finding: ${truncateMiddle(assistantText, 220)}`);
                }
                uniquePush(transcript, seenTranscript, `[Assistant] ${truncateMiddle(assistantText, 280)}`);
            }

            if (Array.isArray(arm.toolUses)) {
                for (const tu of arm.toolUses) {
                    const inputSummary = summariseToolInput(tu);
                    const line = `[Tool call] ${tu.name || 'unknown'}${tu.toolUseId ? `#${tu.toolUseId}` : ''}${inputSummary ? `: ${inputSummary}` : ''}`;
                    uniquePush(toolDigest, seenTools, line);

                    for (const pathCandidate of extractPathCandidates(inputSummary)) {
                        uniquePush(pinnedFacts, seenFacts, `File referenced: ${pathCandidate}`);
                    }
                    for (const command of extractCommandCandidates(inputSummary)) {
                        uniquePush(pinnedFacts, seenFacts, `Command referenced: ${truncateMiddle(command, 180)}`);
                    }
                }
            }
        }

        if (uim) {
            if (uim.content && uim.content.trim()) {
                const userFact = classifyUserFact(uim.content);
                if (userFact) uniquePush(pinnedFacts, seenFacts, userFact);
                uniquePush(transcript, seenTranscript, `[User] ${truncateMiddle(compactWhitespace(uim.content), 280)}`);
            }

            const toolResults = uim.userInputMessageContext?.toolResults;
            if (Array.isArray(toolResults)) {
                for (const tr of toolResults) {
                    const resultSummary = summariseToolResult(tr);
                    uniquePush(toolDigest, seenTools, `[Tool result] ${tr.toolUseId || 'unknown'}: ${resultSummary}`);

                    for (const pathCandidate of extractPathCandidates(resultSummary)) {
                        uniquePush(pinnedFacts, seenFacts, `File referenced: ${pathCandidate}`);
                    }
                    if (/\b(error|failed|failure|exception|timeout|fatal|exit code|status: [45]\d\d)\b/i.test(resultSummary)) {
                        uniquePush(pinnedFacts, seenFacts, `Failure signal: ${truncateMiddle(resultSummary, 240)}`);
                    }
                }
            }
        }
    }

    return {
        pinnedFacts: pinnedFacts.slice(-PINNED_FACTS_MAX),
        toolDigest: toolDigest.slice(-TOOL_DIGEST_MAX),
        transcript: transcript.slice(-TRANSCRIPT_EXCERPTS_MAX),
        stats: {
            entries: entries.length,
            pinnedFacts: pinnedFacts.length,
            toolDigest: toolDigest.length,
            transcript: transcript.length,
        },
    };
}

function formatBulletSection(title, lines, emptyText = '- none observed') {
    const body = lines.length > 0
        ? lines.map(line => `- ${line}`).join('\n')
        : emptyText;
    return `${title}:\n${body}`;
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
function buildSummaryPrompt(entries, retryAttempt = 0) {
    const memory = buildDeterministicCodingMemory(entries);
    const lines = [
        retryAttempt > 0
            ? 'The previous coding memory was too short or generic. Rewrite it as dense structured working memory for a coding assistant. Preserve concrete file paths, commands, tests, errors, user constraints, decisions, current goal, and unresolved next steps. Output only the <coding_memory> block.\n'
            : 'Summarize this earlier coding-assistant conversation as durable structured working memory for the next assistant turn. Preserve facts that matter for programming: exact file paths, commands/tests, errors, user constraints, implementation decisions, deployment/commit state, and open TODOs. Do not invent details. Output only the <coding_memory> block.\n',
        'Use this exact structure and keep bullets compact:',
        '<coding_memory>',
        'User intent:',
        '- ...',
        'Hard constraints:',
        '- ...',
        'Repository facts:',
        '- ...',
        'Files touched:',
        '- path: reason/current state',
        'Decisions:',
        '- ...',
        'Failed attempts:',
        '- ...',
        'Commands/tests:',
        '- command -> result',
        'Open TODO:',
        '- ...',
        '</coding_memory>',
        '',
        `Deterministic extraction stats: entries=${memory.stats.entries}, pinnedFacts=${memory.stats.pinnedFacts}, toolEvents=${memory.stats.toolDigest}, transcriptExcerpts=${memory.stats.transcript}`,
        formatBulletSection('Pinned facts extracted locally', memory.pinnedFacts),
        formatBulletSection('Tool activity digest', memory.toolDigest),
        formatBulletSection('Compact chronological excerpts', memory.transcript),
    ];

    const prompt = truncateMiddle(lines.join('\n'), SUMMARY_PROMPT_MAX_CHARS);
    logger.info(
        `[Kiro] Tier-3 summary prompt compacted: ${entries.length} history entries -> ${prompt.length} chars ` +
        `(pinnedFacts=${memory.pinnedFacts.length}, toolEvents=${memory.toolDigest.length}, transcriptExcerpts=${memory.transcript.length})`
    );
    return prompt;
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
    let attempts = 0;
    let fallback = 'none';
    const startedAt = Date.now();
    try {
        for (let attempt = 0; attempt < SUMMARY_MAX_ATTEMPTS; attempt++) {
            attempts = attempt + 1;
            const prompt = buildSummaryPrompt(toSummarise, attempt);
            summaryText = await callKiro(prompt);
            if (!isInvalidSummary(summaryText)) break;
            logger.warn(`[Kiro] Tier-3 summary invalid on attempt ${attempt + 1} (${(summaryText || '').trim().length} chars)`);
        }
        if (isInvalidSummary(summaryText)) {
            logger.warn(`[Kiro] Tier-3 summary invalid (${(summaryText || '').trim().length} chars), using rule-based fallback`);
            fallback = 'invalid_summary';
            summaryText = buildRuleBasedSummary(toSummarise);
        }
        // Truncate to hard cap
        if (summaryText.length > SUMMARY_MAX_CHARS) {
            summaryText = summaryText.slice(0, SUMMARY_MAX_CHARS) + '…';
        }
    } catch (err) {
        // Summary generation failed — fall back to a minimal rule-based digest
        logger.warn(`[Kiro] Tier-3 summary call failed (${err.message}), using rule-based fallback`);
        fallback = 'call_failed';
        attempts = Math.max(attempts, 1);
        summaryText = buildRuleBasedSummary(toSummarise);
    }
    logger.info(
        `[Kiro] Tier-3 summary generated: ${summaryText.length} chars ` +
        `(attempts=${attempts}, durationMs=${Date.now() - startedAt}, fallback=${fallback})`
    );

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
    const memory = buildDeterministicCodingMemory(entries);
    return [
        '<coding_memory>',
        formatBulletSection('User intent', memory.pinnedFacts.filter(line => line.startsWith('User goal') || line.startsWith('User context')).slice(-8)),
        formatBulletSection('Hard constraints', memory.pinnedFacts.filter(line => line.startsWith('Constraint')).slice(-8)),
        formatBulletSection('Repository facts', memory.pinnedFacts.filter(line => line.startsWith('Assistant finding') || line.startsWith('Failure signal')).slice(-10)),
        formatBulletSection('Files touched', memory.pinnedFacts.filter(line => line.startsWith('File referenced')).slice(-12)),
        'Decisions:\n- See repository facts and compact excerpts; model summary was unavailable.',
        formatBulletSection('Failed attempts', memory.pinnedFacts.filter(line => line.startsWith('Failure signal')).slice(-8)),
        formatBulletSection('Commands/tests', memory.pinnedFacts.filter(line => line.startsWith('Command referenced')).slice(-8)),
        formatBulletSection('Open TODO', memory.transcript.slice(-8)),
        '</coding_memory>',
    ].join('\n');
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

    const beforeBytes = payloadBytes(payload);
    if (beforeBytes <= maxBytes) return systemPrompt;

    const beforeEntries = history.length;
    logger.info(`[Kiro] History compression triggered: ${beforeBytes} bytes > ${maxBytes} bytes (history entries: ${beforeEntries})`);

    // Tier 2 — drop pure tool pairs
    const droppedToolPairs = dropOldToolPairs(history, payload, maxBytes, recentTurns);
    const afterTier2Bytes = payloadBytes(payload);
    logger.info(
        `[Kiro] Tier-2 trim result: ${beforeBytes} -> ${afterTier2Bytes} bytes, ` +
        `${beforeEntries} -> ${history.length} history entries, dropped ${droppedToolPairs} pure tool pairs`
    );

    if (afterTier2Bytes <= maxBytes) {
        logger.info('[Kiro] Tier-2 trim sufficient, skipping summary');
        return systemPrompt;
    }

    // Tier 3 — summarise + inject
    const updatedSystemPrompt = await summariseOldHistory(payload, systemPrompt, callKiro, recentTurns);

    const afterBytes = payloadBytes(payload);
    logger.info(`[Kiro] After Tier-3 compression: ${afterTier2Bytes} -> ${afterBytes} bytes (${history.length} history entries)`);

    return updatedSystemPrompt;
}
