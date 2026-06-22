jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
}));

import { KiroApiService } from '../src/providers/claude/claude-kiro.js';

describe('Kiro summary request construction', () => {
    test('builds summary calls as single-turn requests without normal chat scaffolding', async () => {
        const service = new KiroApiService({});
        const request = await service.buildCodewhispererRequest(
            [{ role: 'user', content: 'Summarize this old history.' }],
            'claude-sonnet-4-5',
            [{ name: 'Read', description: 'read files', input_schema: { type: 'object' } }],
            'normal system prompt',
            null,
            null,
            { summaryCall: true },
        );

        const current = request.conversationState.currentMessage.userInputMessage;

        expect(request.conversationState.history).toBeUndefined();
        expect(current.content).toBe('Summarize this old history.');
        expect(current.userInputMessageContext).toBeUndefined();
        expect(JSON.stringify(request)).not.toContain('CRITICAL_OVERRIDE');
        expect(JSON.stringify(request)).not.toContain('no_tool_available');
        expect(request._isPlaceholderOnly).toBe(false);
        expect(request._kiroToolNameMaps.fromKiroName('Read')).toBe('Read');
    });
});
