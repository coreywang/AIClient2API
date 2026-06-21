import {
    compactKiroToolsToBudget,
    createKiroPayloadTooLargeError,
    KIRO_TOOL_DESCRIPTION_MAX_CHARS,
    KIRO_TOOLS_CONTEXT_MAX_BYTES,
    sanitizeSchemaDescriptions,
    truncateText
} from '../src/providers/claude/kiro-tool-compactor.js';

function makeLargeTool(index) {
    return {
        name: `LargeTool${index}`,
        description: `Tool ${index} description. ${'very detailed usage notes '.repeat(900)}`,
        input_schema: {
            type: 'object',
            description: `Schema ${index}. ${'schema explanation '.repeat(400)}`,
            properties: {
                query: {
                    type: 'string',
                    description: `Query field ${index}. ${'query explanation '.repeat(300)}`,
                },
                options: {
                    type: 'object',
                    description: `Options field ${index}. ${'options explanation '.repeat(300)}`,
                    properties: {
                        mode: {
                            type: 'string',
                            description: `Mode field ${index}. ${'mode explanation '.repeat(300)}`,
                        }
                    }
                }
            }
        }
    };
}

describe('Kiro tool metadata compaction', () => {
    test('compacts large tool descriptions and schemas under the Kiro tools budget', async () => {
        const tools = Array.from({ length: 30 }, (_, index) => makeLargeTool(index));
        const kiroTools = tools.map(tool => ({
            toolSpecification: {
                name: tool.name,
                description: truncateText(tool.description, KIRO_TOOL_DESCRIPTION_MAX_CHARS),
                inputSchema: {
                    json: sanitizeSchemaDescriptions(tool.input_schema)
                }
            }
        }));
        compactKiroToolsToBudget(kiroTools);
        const toolsBytes = Buffer.byteLength(JSON.stringify({ tools: kiroTools }), 'utf8');

        expect(kiroTools).toHaveLength(tools.length);
        expect(toolsBytes).toBeLessThanOrEqual(KIRO_TOOLS_CONTEXT_MAX_BYTES);
        for (const tool of kiroTools) {
            expect(tool.toolSpecification.description.length).toBeLessThanOrEqual(2051);
        }
    });

    test('marks irreducible local payload errors as client errors without credential penalty', () => {
        const error = createKiroPayloadTooLargeError('Payload size (700000 bytes) exceeds Kiro API limit');

        expect(error.message).toContain('Payload size');
        expect(error.skipErrorCount).toBe(true);
        expect(error.response?.status).toBe(400);
        expect(error.shouldSwitchCredential).not.toBe(true);
    });
});
