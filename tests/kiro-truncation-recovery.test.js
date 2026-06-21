import { detectTruncation, injectTruncationRecovery } from '../src/providers/claude/kiro-truncation-recovery.js';

describe('kiro-truncation-recovery', () => {
    // ── detectTruncation ──────────────────────────────────────────────────────

    describe('detectTruncation', () => {
        test('returns false for empty inputs', () => {
            expect(detectTruncation('', [])).toBe(false);
            expect(detectTruncation(null, null)).toBe(false);
            expect(detectTruncation(undefined, undefined)).toBe(false);
        });

        test('returns false for balanced text', () => {
            expect(detectTruncation('Hello world', [])).toBe(false);
            expect(detectTruncation('{"key": "value"}', [])).toBe(false);
            expect(detectTruncation('```js\ncode\n```', [])).toBe(false);
        });

        test('returns false when brace diff is exactly 2 (threshold is > 2)', () => {
            // {{{ has 3 open, 1 close = diff 2 — should NOT trigger
            expect(detectTruncation('{{{x}', [])).toBe(false);
        });

        test('returns true when brace diff exceeds 2', () => {
            // {{{{ has 4 open, 1 close = diff 3 — should trigger
            expect(detectTruncation('{{{{x}', [])).toBe(true);
        });

        test('returns true for unbalanced brackets (diff > 2)', () => {
            expect(detectTruncation('[[[[x]', [])).toBe(true);
        });

        test('returns true for odd number of backtick code blocks', () => {
            // One opening ``` with no closing
            expect(detectTruncation('Some text\n```js\ncode here', [])).toBe(true);
        });

        test('returns false for even backtick code blocks', () => {
            expect(detectTruncation('```js\ncode\n```\n\nmore text', [])).toBe(false);
        });

        test('returns true for tool call with invalid JSON arguments', () => {
            const toolCalls = [{ function: { name: 'read_file', arguments: '{invalid json' } }];
            expect(detectTruncation('', toolCalls)).toBe(true);
        });

        test('returns false for tool call with valid JSON arguments', () => {
            const toolCalls = [{ function: { name: 'read_file', arguments: '{"path": "/tmp/file"}' } }];
            expect(detectTruncation('', toolCalls)).toBe(false);
        });

        test('supports Kiro-format tool calls with input field', () => {
            const toolCalls = [{ name: 'write_file', input: '{broken' }];
            expect(detectTruncation('', toolCalls)).toBe(true);
        });

        test('returns false for tool calls with empty arguments', () => {
            const toolCalls = [{ function: { name: 'no_args', arguments: '' } }];
            expect(detectTruncation('some response', toolCalls)).toBe(false);
        });

        test('returns false for tool calls with object arguments (not string)', () => {
            const toolCalls = [{ function: { name: 'test', arguments: { path: '/tmp' } } }];
            expect(detectTruncation('response', toolCalls)).toBe(false);
        });
    });

    // ── injectTruncationRecovery ──────────────────────────────────────────────

    describe('injectTruncationRecovery', () => {
        test('does not modify messages when wasTruncated is false', () => {
            const messages = [{ role: 'user', content: 'hello' }];
            const state = { wasTruncated: false, toolUseId: null, toolName: null };
            const result = injectTruncationRecovery(messages, state);
            expect(result.length).toBe(1);
        });

        test('does not modify messages when truncationState is null/undefined', () => {
            const messages = [{ role: 'user', content: 'hello' }];
            expect(injectTruncationRecovery(messages, null).length).toBe(1);
            expect(injectTruncationRecovery(messages, undefined).length).toBe(1);
        });

        test('injects tool_result message when toolUseId is set', () => {
            const messages = [{ role: 'user', content: 'hello' }];
            const state = { wasTruncated: true, toolUseId: 'tool-123', toolName: 'read_file' };
            injectTruncationRecovery(messages, state);
            expect(messages.length).toBe(2);
            const injected = messages[1];
            expect(injected.role).toBe('user');
            expect(Array.isArray(injected.content)).toBe(true);
            expect(injected.content[0].type).toBe('tool_result');
            expect(injected.content[0].tool_use_id).toBe('tool-123');
            expect(injected.content[0].is_error).toBe(true);
        });

        test('injects text notice message when toolUseId is null (content truncation)', () => {
            const messages = [{ role: 'user', content: 'hello' }];
            const state = { wasTruncated: true, toolUseId: null, toolName: null };
            injectTruncationRecovery(messages, state);
            expect(messages.length).toBe(2);
            const injected = messages[1];
            expect(injected.role).toBe('user');
            expect(typeof injected.content).toBe('string');
            expect(injected.content).toContain('[System Notice]');
        });

        test('clears truncation state after injection', () => {
            const messages = [{ role: 'user', content: 'hello' }];
            const state = { wasTruncated: true, toolUseId: 'tc-1', toolName: 'test' };
            injectTruncationRecovery(messages, state);
            expect(state.wasTruncated).toBe(false);
            expect(state.toolUseId).toBeNull();
            expect(state.toolName).toBeNull();
        });

        // T4: injected message must have _noMerge to skip adjacent-role merge
        test('injected message has _noMerge flag (T4)', () => {
            const messages = [{ role: 'user', content: 'hello' }];
            const state = { wasTruncated: true, toolUseId: null, toolName: null };
            injectTruncationRecovery(messages, state);
            expect(messages[1]._noMerge).toBe(true);
        });

        test('tool_result injection also has _noMerge flag (T4)', () => {
            const messages = [{ role: 'user', content: 'hello' }];
            const state = { wasTruncated: true, toolUseId: 'tc-1', toolName: 'tool' };
            injectTruncationRecovery(messages, state);
            expect(messages[1]._noMerge).toBe(true);
        });

        test('returns the same messages array', () => {
            const messages = [{ role: 'user', content: 'hello' }];
            const state = { wasTruncated: true, toolUseId: null, toolName: null };
            const result = injectTruncationRecovery(messages, state);
            expect(result).toBe(messages);
        });
    });
});
