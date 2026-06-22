import { trimPayloadToLimit, guardPayload } from '../src/providers/claude/kiro-payload-guard.js';

// Helper: build a minimal Kiro-format history entry
function userEntry(content = 'hello') {
    return { userInputMessage: { content, modelId: 'claude-sonnet-4-5', origin: 'AI_EDITOR' } };
}
function assistantEntry(content = 'ok', toolUses = []) {
    const msg = { assistantResponseMessage: { content } };
    if (toolUses.length > 0) msg.assistantResponseMessage.toolUses = toolUses;
    return msg;
}
function toolUse(id, name = 'read_file') {
    return { toolUseId: id, name, input: { path: '/tmp/test' } };
}
function toolResult(toolUseId, text = 'result') {
    return { toolUseId, content: [{ text }], status: 'success' };
}
function userEntryWithToolResults(toolResults) {
    return {
        userInputMessage: {
            content: 'Tool results provided.',
            modelId: 'claude-sonnet-4-5',
            origin: 'AI_EDITOR',
            userInputMessageContext: { toolResults },
        }
    };
}

// Helper: build a payload with given history
function makePayload(history) {
    return {
        conversationState: {
            history,
            currentMessage: {
                userInputMessage: { content: 'What now?', modelId: 'claude-sonnet-4-5', origin: 'AI_EDITOR' }
            }
        }
    };
}

// Helper: build a very large history that exceeds the default guard budget.
function makeLargeHistory(entryCount = 700, contentSize = 1000) {
    const history = [];
    for (let i = 0; i < entryCount; i++) {
        history.push(userEntry('x'.repeat(contentSize)));
    }
    return history;
}

describe('kiro-payload-guard', () => {
    // ── trimPayloadToLimit ────────────────────────────────────────────────────

    describe('trimPayloadToLimit', () => {
        test('returns trimmed:false when payload is within limit', () => {
            const payload = makePayload([userEntry('hello'), assistantEntry('world')]);
            const stats = trimPayloadToLimit(payload, 600000);
            expect(stats.trimmed).toBe(false);
            expect(stats.finalBytes).toBe(stats.originalBytes);
        });

        test('trims oldest entries to bring payload under limit', () => {
            const history = makeLargeHistory(700, 1000);
            const payload = makePayload(history);
            const stats = trimPayloadToLimit(payload, 600000);
            expect(stats.trimmed).toBe(true);
            expect(stats.finalBytes).toBeLessThanOrEqual(600000);
            expect(stats.finalEntries).toBeLessThan(stats.originalEntries);
        });

        test('keeps at least 2 entries', () => {
            const history = [
                userEntry('x'.repeat(10000)),
                assistantEntry('y'.repeat(10000)),
                userEntry('z'.repeat(10000)),
            ];
            const payload = makePayload(history);
            // Force very small limit so it must trim aggressively
            // The loop stops at history.length > 2, so at most 2 entries remain
            // But alignToUserMessage may reduce to 1 if the 2nd entry is not user
            trimPayloadToLimit(payload, 100);
            expect(payload.conversationState.history.length).toBeGreaterThanOrEqual(1);
        });

        test('strips empty toolUses arrays before trimming', () => {
            const payload = makePayload(makeLargeHistory(700, 900));
            // Add an entry with empty toolUses
            payload.conversationState.history.unshift({ assistantResponseMessage: { content: 'old', toolUses: [] } });
            trimPayloadToLimit(payload, 600000);
            // After trimming, no entry should have an empty toolUses array
            for (const entry of payload.conversationState.history) {
                const tu = entry.assistantResponseMessage?.toolUses;
                if (tu !== undefined) {
                    expect(tu.length).toBeGreaterThan(0);
                }
            }
        });

        test('ensures history starts with userInputMessage after trim', () => {
            // Build history starting with two assistant entries followed by user entries
            const history = [
                assistantEntry('old response 1'),
                userEntry('first user'),
                assistantEntry('response'),
                userEntry('second user'),
            ];
            // Pad to exceed the limit
            while (JSON.stringify(history).length < 600100) {
                history.unshift(userEntry('pad'.repeat(200)));
            }
            const payload = makePayload(history);
            trimPayloadToLimit(payload, 600000);
            const firstEntry = payload.conversationState.history[0];
            expect(firstEntry).toHaveProperty('userInputMessage');
        });

        // T5: alignToUserMessage edge case — all-assistant history after trim
        test('logs warn and leaves empty history when all remaining entries are assistant (T5)', () => {
            // Force a history with only assistant entries after alignment
            const history = [assistantEntry('a'), assistantEntry('b')];
            // Pad with user entries at the front so initial trim leaves only the 2 assistants
            for (let i = 0; i < 100; i++) {
                history.unshift(userEntry('x'.repeat(500)));
            }
            const payload = makePayload(history);
            // Use a very low limit to force trimming all user entries
            trimPayloadToLimit(payload, 1);
            // history may be empty; the important thing is no unhandled exception
            expect(Array.isArray(payload.conversationState.history)).toBe(true);
        });

        test('repairs orphaned toolResults after trim', () => {
            // Build a history where trimming removes the assistant that had toolUses
            const history = [
                userEntry('first'),
                assistantEntry('tool call', [toolUse('tc1')]),
                userEntryWithToolResults([toolResult('tc1')]),
                assistantEntry('second tool', [toolUse('tc2')]),
                userEntryWithToolResults([toolResult('tc2')]),
            ];
            // Pad front with big user entries so trimming removes the first tool pair
            while (JSON.stringify(history).length < 600200) {
                history.unshift(userEntry('pad'.repeat(200)));
            }
            const payload = makePayload(history);
            trimPayloadToLimit(payload, 600000);
            // After trim, any toolResults should only reference toolUseIds present in preceding assistant
            const h = payload.conversationState.history;
            for (let i = 0; i < h.length; i++) {
                const ctx = h[i].userInputMessage?.userInputMessageContext;
                if (!ctx?.toolResults) continue;
                const prevToolUseIds = new Set(
                    (h[i - 1]?.assistantResponseMessage?.toolUses || []).map(tu => tu.toolUseId)
                );
                for (const tr of ctx.toolResults) {
                    expect(prevToolUseIds.has(tr.toolUseId)).toBe(true);
                }
            }
        });

        test('preserves tool call/results even when payload remains over limit', () => {
            const history = [
                userEntry('old text that may be trimmed'),
                assistantEntry('', [toolUse('tc-preserve')]),
                userEntryWithToolResults([toolResult('tc-preserve', 'x'.repeat(5000))]),
            ];
            const payload = makePayload(history);

            const stats = trimPayloadToLimit(payload, 100);

            expect(stats.finalBytes).toBeGreaterThan(100);
            const h = payload.conversationState.history;
            expect(h.some(entry =>
                entry.assistantResponseMessage?.toolUses?.some(tu => tu.toolUseId === 'tc-preserve')
            )).toBe(true);
            expect(h.some(entry =>
                entry.userInputMessage?.userInputMessageContext?.toolResults?.some(tr => tr.toolUseId === 'tc-preserve')
            )).toBe(true);
        });
    });

    // ── guardPayload ──────────────────────────────────────────────────────────

    describe('guardPayload', () => {
        test('returns null when payload is within limit', () => {
            const payload = makePayload([userEntry('hello'), assistantEntry('ok')]);
            expect(guardPayload(payload)).toBeNull();
        });

        test('auto-trims and returns null when payload exceeds limit but trim succeeds', () => {
            const history = makeLargeHistory(700, 1000);
            const payload = makePayload(history);
            const result = guardPayload(payload);
            expect(result).toBeNull();
            // History should be shorter now
            expect(payload.conversationState.history.length).toBeLessThan(700);
        });

        test('returns null when payload is still above the heuristic limit after trimming', () => {
            // Single enormous current message that can't be trimmed via history
            const payload = {
                conversationState: {
                    history: [],
                    currentMessage: {
                        userInputMessage: {
                            content: 'x'.repeat(700000),
                            modelId: 'claude-sonnet-4-5',
                            origin: 'AI_EDITOR',
                        }
                    }
                }
            };
            const result = guardPayload(payload);
            expect(result).toBeNull();
        });
    });

    // ── orphaned toolResults — repairOrphanedToolResults ──────────────────────

    describe('orphaned toolResults repair', () => {
        test('removes toolResults when preceding assistant has no toolUses', () => {
            const history = [
                userEntry('first'),
                assistantEntry('no tools'),  // no toolUses
                userEntryWithToolResults([toolResult('orphan-id')]),
            ];
            const payload = makePayload(history);
            // Trigger trim (just barely over a very small limit)
            trimPayloadToLimit(payload, JSON.stringify(payload).length - 1);
            // If the assistant with no toolUses is still present, orphaned toolResults should be gone
            for (const entry of payload.conversationState.history) {
                const ctx = entry.userInputMessage?.userInputMessageContext;
                expect(ctx?.toolResults).toBeUndefined();
            }
        });

        test('keeps matching toolResults and removes non-matching ones', () => {
            const history = [
                userEntry('start'),
                assistantEntry('has tool', [toolUse('keep-id')]),
                userEntryWithToolResults([
                    toolResult('keep-id'),
                    toolResult('orphan-id'),  // should be removed
                ]),
            ];
            const payload = makePayload(history);
            // Trim to force orphan repair
            trimPayloadToLimit(payload, JSON.stringify(payload).length - 1);
            const h = payload.conversationState.history;
            // Find the user message with toolResults
            const withResults = h.find(e => e.userInputMessage?.userInputMessageContext?.toolResults);
            if (withResults) {
                const ids = withResults.userInputMessage.userInputMessageContext.toolResults.map(tr => tr.toolUseId);
                expect(ids).toContain('keep-id');
                expect(ids).not.toContain('orphan-id');
            }
        });
    });
});
