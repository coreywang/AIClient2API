import { createStreamErrorResponse } from '../src/utils/common.js';

function parseSse(payload) {
    const event = payload.match(/^event: (.+)$/m)?.[1];
    const data = payload.match(/^data: (.+)$/m)?.[1];
    return { event, data: JSON.parse(data) };
}

describe('createStreamErrorResponse', () => {
    test('emits OpenAI Responses stream errors in schema-valid event shape', () => {
        const payload = createStreamErrorResponse(
            Object.assign(new Error('invalid token'), { status: 403 }),
            'openaiResponses'
        );

        const { event, data } = parseSse(payload);
        expect(event).toBe('error');
        expect(data).toEqual({
            type: 'error',
            code: 'permission_error',
            message: 'invalid token',
            param: null,
            sequence_number: 0
        });
        expect(data.object).toBeUndefined();
        expect(data.error).toBeUndefined();
    });
});
