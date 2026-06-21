/**
 * Tests for kiro-history-summarizer.js
 *
 * Covers:
 *   - dropOldToolPairs: no-op under limit, removes pure pairs from old section,
 *     never touches recent window, ignores text-only pairs
 *   - summariseOldHistory: no-op when everything is in recent window, calls
 *     callKiro and injects summary, removes summarised entries, falls back on
 *     error, truncates very long summaries
 *   - compressHistory: no-op under limit, skips callKiro when tier-2 suffices,
 *     calls callKiro when tier-2 is not enough, returns updated systemPrompt
 */

import {
    dropOldToolPairs,
    summariseOldHistory,
    compressHistory,
} from '../src/providers/claude/kiro-history-summarizer.js';

// ── Entry-builder helpers ─────────────────────────────────────────────────────

function makeToolUse(id = 'tu1', name = 'Read') {
    return { toolUseId: id, name, input: { file_path: `/src/${id}.js` } };
}

function makeToolResult(id = 'tu1') {
    return {
        toolUseId: id,
        content: [{ text: `result for ${id}` }],
        status: 'success',
    };
}

/** Assistant entry with optional tool uses and optional text content. */
function makeAssistantEntry(text = '', toolUses = []) {
    return { assistantResponseMessage: { content: text, toolUses } };
}

/** User entry with optional freeform text and optional tool results. */
function makeUserEntry(text = '', toolResults = []) {
    const uim = { content: text };
    if (toolResults.length > 0) {
        uim.userInputMessageContext = { toolResults };
    }
    return { userInputMessage: uim };
}

/**
 * A "pure tool pair": assistant has only toolUses (no text), user has only
 * toolResults (no text).
 */
function makePurePair(id = 'tu1') {
    return [
        makeAssistantEntry('', [makeToolUse(id)]),
        makeUserEntry('', [makeToolResult(id)]),
    ];
}

/** A plain text exchange — neither side has toolUses/toolResults. */
function makeTextPair(assistantText = 'hello', userText = 'user reply') {
    return [
        makeAssistantEntry(assistantText),
        makeUserEntry(userText),
    ];
}

/** Wrap a history array into the Kiro payload shape. */
function makePayload(history) {
    return { conversationState: { history } };
}

// ── dropOldToolPairs ──────────────────────────────────────────────────────────

describe('dropOldToolPairs', () => {
    test('does nothing when payload is already under the byte limit', () => {
        const history = [
            ...makePurePair('a'),
            ...makePurePair('b'),
            ...makeTextPair(),
        ];
        const payload = makePayload(history);
        const removed = dropOldToolPairs(
            payload.conversationState.history,
            payload,
            999_999_999,
        );
        expect(removed).toBe(0);
        expect(payload.conversationState.history.length).toBe(6);
    });

    test('removes pure tool pairs from the oldest end until under limit', () => {
        // 2 old pure pairs + 1 text pair + 1 pure pair inside recent window
        const history = [
            ...makePurePair('t1'),   // old — eligible for removal
            ...makePurePair('t2'),   // old — eligible for removal
            ...makeTextPair('mid'),  // old text pair — NOT removable
            ...makePurePair('t3'),   // inside recent window (recentTurns=2) — protected
        ];
        const payload = makePayload(history);
        // maxBytes=0 forces maximum trimming; recentTurns=2 protects last 4 entries
        dropOldToolPairs(payload.conversationState.history, payload, 0, 2);

        const ids = payload.conversationState.history
            .flatMap(e => e.assistantResponseMessage?.toolUses ?? [])
            .map(tu => tu.toolUseId);

        expect(ids).not.toContain('t1');
        expect(ids).not.toContain('t2');
    });

    test('never removes entries that fall inside the recent window', () => {
        // Layout (recentTurns=2 → last 4 entries = last 2 turns are protected):
        //   index 0-1: old pure pair  → eligible to remove
        //   index 2-3: old text pair  → not a pure pair, loop skips (+2) and then
        //                               i=4 >= recentStart-1=3, so loop exits
        //   index 4-5: recent pure pair 'r1' → protected
        //   index 6-7: recent pure pair 'r2' → protected
        //
        // recentStart = max(0, 8 - 2*2) = 4
        // The loop walks with i starting at 0, bound i < recentStart-1 = 3:
        //   i=0: pure pair 'old' → splice, removed=1; array shrinks to 6; i stays 0
        //   i=0: text pair at new[0] → not pure, i += 2 → i=2
        //   i=2: 2 < 3 → true; history[2] is now 'r1' assistant entry
        //         but isPureToolPair(history[2], history[3]) = true — this WOULD remove r1
        //         UNLESS the text pair blocks the advance before we reach here.
        //
        // To reliably protect the recent window we need at least one non-pure pair
        // in the old section AFTER the pure pairs, which causes i to advance past
        // the recentStart-1 bound before reaching the recent entries.
        //
        // Concrete layout that works:
        //   old pure pair 'old1'  (removed by loop)
        //   old text pair         (not pure → i advances to 4, loop exits because 4 >= recentStart-1=5)
        //   old text pair         (together with above, old section has 4 entries: recentStart=4)
        //   recent pure 'r1'      (protected)
        //   recent pure 'r2'      (protected)
        //
        // Actually simpler: use large recentTurns so the boundary is far enough out.
        // With 3 pure pairs (6 entries) and recentTurns=3, recentStart = max(0,6-6)=0,
        // so nothing is in the old section and the loop does nothing at all.
        //
        // Cleanest reliable approach: put pure pairs in the old section and a text
        // pair between them and the recent entries so the loop stops at the text pair.

        const history = [
            ...makePurePair('old1'),   // old — gets removed
            ...makeTextPair('barrier'), // old text pair — blocks further traversal
            ...makeTextPair('r1text'), // recent turn 1
            ...makeTextPair('r2text'), // recent turn 2
        ];
        // 8 entries total; recentTurns=2 → recentStart = max(0, 8-4) = 4
        // Loop bound: i < recentStart-1 = 3
        //   i=0: pure pair 'old1' → splice; array→6; removed=1; i stays 0
        //   i=0: text pair 'barrier' at [0] → not pure; i += 2 → i=2
        //   i=2: 2 < 3 → true; history[2] is now r1text assistant, history[3] r1text user
        //         makeTextPair entries have no toolUses → isPureToolPair = false; i += 2 → i=4
        //   i=4: 4 < 3 → false → loop exits
        // So r1text and r2text are fully preserved.
        const payload = makePayload(history);
        dropOldToolPairs(payload.conversationState.history, payload, 0, 2);

        const assistantTexts = payload.conversationState.history
            .map(e => e.assistantResponseMessage?.content)
            .filter(Boolean);

        expect(assistantTexts).toContain('r1text');
        expect(assistantTexts).toContain('r2text');
        // old1 pure pair should be gone
        const ids = payload.conversationState.history
            .flatMap(e => e.assistantResponseMessage?.toolUses ?? [])
            .map(tu => tu.toolUseId);
        expect(ids).not.toContain('old1');
    });

    test('does not remove text-only assistant/user pairs', () => {
        const history = [
            ...makeTextPair('keep me'),
            ...makeTextPair('keep me too'),
            ...makePurePair('t1'), // this is inside recent window (recentTurns=1)
        ];
        const payload = makePayload(history);
        // recentTurns=1 protects the last 2 entries; text pairs are in the old section
        dropOldToolPairs(payload.conversationState.history, payload, 0, 1);

        const assistantTexts = payload.conversationState.history
            .map(e => e.assistantResponseMessage?.content)
            .filter(Boolean);

        expect(assistantTexts).toContain('keep me');
        expect(assistantTexts).toContain('keep me too');
    });

    test('returns the number of pairs removed', () => {
        const history = [
            ...makePurePair('r1'),
            ...makePurePair('r2'),
            ...makeTextPair('safe'),
        ];
        const payload = makePayload(history);
        const removed = dropOldToolPairs(
            payload.conversationState.history,
            payload,
            0,
            1,
        );
        // recentTurns=1 protects 2 entries; r1 and r2 are both eligible
        expect(removed).toBe(2);
    });

    test('leaves history untouched when there are no pure pairs', () => {
        const history = [
            ...makeTextPair('a'),
            ...makeTextPair('b'),
        ];
        const payload = makePayload(history);
        const before = JSON.stringify(history);
        dropOldToolPairs(payload.conversationState.history, payload, 0, 1);
        expect(JSON.stringify(payload.conversationState.history)).toBe(before);
    });
});

// ── summariseOldHistory ───────────────────────────────────────────────────────

describe('summariseOldHistory', () => {
    test('returns systemPrompt unchanged when everything is in the recent window', async () => {
        // 2 entries (1 turn), recentTurns=10 → recentStart=0, nothing to summarise
        const history = [...makeTextPair('hello')];
        const payload = makePayload(history);
        const callKiro = jest.fn().mockResolvedValue('should not be called');

        const result = await summariseOldHistory(payload, 'sys', callKiro, 10);

        expect(result).toBe('sys');
        expect(callKiro).not.toHaveBeenCalled();
    });

    test('calls callKiro with a prompt string', async () => {
        const history = [
            ...makePurePair('t1'),
            ...makeTextPair('recent text'),
        ];
        const payload = makePayload(history);
        const callKiro = jest.fn().mockResolvedValue('short summary');

        await summariseOldHistory(payload, '', callKiro, 1);

        expect(callKiro).toHaveBeenCalledTimes(1);
        expect(typeof callKiro.mock.calls[0][0]).toBe('string');
        expect(callKiro.mock.calls[0][0].length).toBeGreaterThan(0);
    });

    test('injects summary wrapped in <conversation_summary> tags', async () => {
        const history = [
            ...makeTextPair('old text'),
            ...makeTextPair('recent text'),
        ];
        const payload = makePayload(history);
        const callKiro = jest.fn().mockResolvedValue('This is the summary.');

        const result = await summariseOldHistory(payload, 'original sys', callKiro, 1);

        expect(result).toContain('original sys');
        expect(result).toContain('<conversation_summary>');
        expect(result).toContain('</conversation_summary>');
        expect(result).toContain('This is the summary.');
    });

    test('removes summarised entries from history in-place', async () => {
        // 2 old turns (4 entries) + 1 recent turn (2 entries)
        const history = [
            ...makePurePair('t1'),
            ...makePurePair('t2'),
            ...makeTextPair('recent'),
        ];
        const payload = makePayload(history);
        const callKiro = jest.fn().mockResolvedValue('summary');

        await summariseOldHistory(payload, '', callKiro, 1);

        // Only the 1 recent turn (2 entries) should remain
        expect(payload.conversationState.history.length).toBe(2);
    });

    test('falls back to rule-based summary when callKiro throws', async () => {
        const history = [
            ...makePurePair('t1'),
            ...makeTextPair('recent'),
        ];
        const payload = makePayload(history);
        const callKiro = jest.fn().mockRejectedValue(new Error('network error'));

        const result = await summariseOldHistory(payload, '', callKiro, 1);

        // Should still inject a section into systemPrompt
        expect(result).toContain('<conversation_summary>');
        expect(result).toContain('</conversation_summary>');
        expect(result.length).toBeGreaterThan(30);
    });

    test('truncates a very long summary to ~4000 chars with ellipsis', async () => {
        const history = [
            ...makeTextPair('old'),
            ...makeTextPair('recent'),
        ];
        const payload = makePayload(history);
        const longSummary = 'x'.repeat(10_000);
        const callKiro = jest.fn().mockResolvedValue(longSummary);

        const result = await summariseOldHistory(payload, '', callKiro, 1);

        // The injected summary portion must be capped (4000 chars + one '…' character)
        const start = result.indexOf('<conversation_summary>');
        const end = result.indexOf('</conversation_summary>');
        const injectedSection = result.slice(start, end);
        // 4001 summary chars + surrounding wrapper text — well under 5500
        expect(injectedSection.length).toBeLessThan(5500);
        expect(result).toContain('…');
    });

    test('returns empty-history payload unchanged', async () => {
        const payload = makePayload([]);
        const callKiro = jest.fn();

        const result = await summariseOldHistory(payload, 'sys', callKiro);

        expect(result).toBe('sys');
        expect(callKiro).not.toHaveBeenCalled();
    });
});

// ── compressHistory ───────────────────────────────────────────────────────────

describe('compressHistory', () => {
    test('returns systemPrompt unchanged when payload is under the byte limit', async () => {
        const history = [...makePurePair('a')];
        const payload = makePayload(history);
        const callKiro = jest.fn();

        const result = await compressHistory(payload, 'sys', 999_999_999, callKiro);

        expect(result).toBe('sys');
        expect(callKiro).not.toHaveBeenCalled();
    });

    test('skips callKiro (tier-3) when tier-2 trimming alone brings payload under limit', async () => {
        // Build many pure tool pairs so removing them drops size significantly
        const history = [];
        for (let i = 0; i < 20; i++) {
            history.push(...makePurePair(`t${i}`));
        }
        // Add one text pair at the end as the "recent" window
        history.push(...makeTextPair('recent'));
        const payload = makePayload(history);

        // Size with all 20 pure pairs present
        const fullSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        // Size with only the 1 recent text pair present (simulate post-trim)
        const tinyPayload = makePayload([...makeTextPair('recent')]);
        const tinySize = Buffer.byteLength(JSON.stringify(tinyPayload), 'utf8');
        // Pick a limit between tinySize and fullSize so tier-2 alone suffices
        const limit = tinySize + Math.floor((fullSize - tinySize) / 2);

        const callKiro = jest.fn().mockResolvedValue('summary');
        await compressHistory(payload, 'sys', limit, callKiro, 1);

        expect(callKiro).not.toHaveBeenCalled();
    });

    test('calls callKiro (tier-3) when tier-2 alone is not enough', async () => {
        // Only text pairs — tier-2 removes nothing, so tier-3 must fire
        const history = [];
        for (let i = 0; i < 10; i++) {
            history.push(...makeTextPair(`turn ${i}`));
        }
        const payload = makePayload(history);
        const callKiro = jest.fn().mockResolvedValue('compressed summary');

        // maxBytes=0 guarantees the payload is always "too large"
        await compressHistory(payload, 'sys', 0, callKiro, 2);

        expect(callKiro).toHaveBeenCalledTimes(1);
    });

    test('returns updated systemPrompt containing the summary after tier-3', async () => {
        const history = [];
        for (let i = 0; i < 6; i++) {
            history.push(...makeTextPair(`turn ${i}`));
        }
        const payload = makePayload(history);
        const callKiro = jest.fn().mockResolvedValue('here is a summary');

        const result = await compressHistory(payload, 'original', 0, callKiro, 2);

        expect(result).toContain('original');
        expect(result).toContain('here is a summary');
        expect(result).toContain('<conversation_summary>');
    });

    test('returns systemPrompt unchanged when history is empty', async () => {
        const payload = makePayload([]);
        const callKiro = jest.fn();

        const result = await compressHistory(payload, 'sys', 0, callKiro);

        expect(result).toBe('sys');
        expect(callKiro).not.toHaveBeenCalled();
    });

    test('tier-2 and tier-3 both fire when payload remains too large after tier-2', async () => {
        // Mix of pure pairs (tier-2 will remove) and text pairs (tier-2 skips);
        // use maxBytes=0 so even after tier-2 the payload is still "too large"
        const history = [
            ...makePurePair('p1'),
            ...makeTextPair('text1'),
            ...makePurePair('p2'),
            ...makeTextPair('text2'),
            ...makeTextPair('recent'),
        ];
        const payload = makePayload(history);
        const callKiro = jest.fn().mockResolvedValue('final summary');

        const result = await compressHistory(payload, 'base', 0, callKiro, 1);

        // Tier-3 must have fired
        expect(callKiro).toHaveBeenCalledTimes(1);
        // Summary must appear in returned prompt
        expect(result).toContain('final summary');
    });
});
