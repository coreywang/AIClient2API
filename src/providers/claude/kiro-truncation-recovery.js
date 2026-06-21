/**
 * Stream truncation recovery for Kiro API responses.
 *
 * When Kiro API truncates a large tool call payload or content mid-stream,
 * we inject a synthetic message so the model knows its output was cut off
 * and can adapt its approach instead of repeating the same operation.
 *
 * Ported from KiroProxy/kiro_proxy/truncation_recovery.py
 */
import logger from '../../utils/logger.js';

/**
 * Detect if a response was truncated using heuristics:
 * - Response ends mid-JSON (unbalanced braces/brackets)
 * - Response ends with incomplete markdown code block
 * - Tool call arguments are invalid JSON
 *
 * @param {string} responseText
 * @param {Array} toolCalls - array of tool call objects
 * @returns {boolean}
 */
export function detectTruncation(responseText, toolCalls) {
    if (!responseText && (!toolCalls || toolCalls.length === 0)) {
        return false;
    }

    if (responseText) {
        const openBraces = (responseText.match(/{/g) || []).length;
        const closeBraces = (responseText.match(/}/g) || []).length;
        const openBrackets = (responseText.match(/\[/g) || []).length;
        const closeBrackets = (responseText.match(/\]/g) || []).length;

        if (openBraces - closeBraces > 2 || openBrackets - closeBrackets > 2) {
            logger.debug('[Kiro] Truncation detected: unbalanced JSON braces/brackets');
            return true;
        }

        const backtickBlocks = (responseText.match(/```/g) || []).length;
        if (backtickBlocks % 2 !== 0) {
            logger.debug('[Kiro] Truncation detected: unclosed markdown code block');
            return true;
        }
    }

    for (const tc of (toolCalls || [])) {
        // Support both OpenAI format (function.arguments) and Kiro format (input)
        const args = tc?.function?.arguments ?? tc?.input ?? '';
        if (typeof args === 'string' && args.trim()) {
            try {
                JSON.parse(args);
            } catch {
                logger.debug(`[Kiro] Truncation detected: invalid JSON in tool call arguments for ${tc?.function?.name || tc?.name || 'unknown'}`);
                return true;
            }
        }
    }

    return false;
}

/**
 * Inject a truncation recovery message into the messages array if truncation was detected.
 * Modifies messages array in-place (appends to end).
 * Clears truncation state after injection.
 *
 * @param {Array} messages - OpenAI-format messages array
 * @param {{ wasTruncated: boolean, toolUseId: string|null, toolName: string|null }} truncationState
 * @returns {Array} the same messages array (modified in-place)
 */
export function injectTruncationRecovery(messages, truncationState) {
    if (!truncationState?.wasTruncated) {
        return messages;
    }

    if (truncationState.toolUseId) {
        // Tool call was truncated — inject a synthetic tool_result
        const content =
            '[API Limitation] Your tool call was truncated by the upstream API ' +
            'due to output size limits.\n\n' +
            'If the tool result below shows an error or unexpected behavior, ' +
            'this is likely a CONSEQUENCE of the truncation, not the root cause. ' +
            'The tool call itself was cut off before it could be fully transmitted.\n\n' +
            'Repeating the exact same operation will be truncated again. ' +
            'Consider adapting your approach.';

        messages.push({
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: truncationState.toolUseId,
                content,
                is_error: true,
            }],
            _noMerge: true,  // T4: skip adjacent-role merge logic in buildCodewhispererRequest
        });

        logger.warn(`[Kiro] Injected truncation recovery for tool '${truncationState.toolName || 'unknown'}' (id=${truncationState.toolUseId})`);
    } else {
        // Content (text) was truncated — inject a system notice
        const notice =
            '[System Notice] Your previous response was truncated by the upstream API ' +
            'due to output size limits. The content was cut off before completion. ' +
            'Please be aware of this limitation and consider shorter responses ' +
            'or breaking your output into smaller parts.';

        messages.push({
            role: 'user',
            content: notice,
            _noMerge: true,  // T4: skip adjacent-role merge logic in buildCodewhispererRequest
        });

        logger.warn('[Kiro] Injected truncation recovery notice (content truncation)');
    }

    // Clear state
    truncationState.wasTruncated = false;
    truncationState.toolUseId = null;
    truncationState.toolName = null;

    return messages;
}
